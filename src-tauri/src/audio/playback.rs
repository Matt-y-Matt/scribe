//! Plays a meeting's recording from any point (PRD F8.1, F3.3).
//!
//! The recording is the 10 s chunk files, read as they are needed, so a seek
//! is a file open and playback works on a meeting that is still being
//! recorded. Both sources are mixed. One thread owns the output device.

use std::num::NonZero;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;

use super::writer::read_samples;
use super::{ms_of_samples, samples_of_ms, SAMPLE_RATE};

/// `playback:state` — where the playhead is, about ten times a second while
/// playing, and once when playing stops.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PlaybackState {
    pub meeting_id: String,
    pub playing: bool,
    pub t_ms: u32,
}

/// Samples read from disk at a time: half a second.
const BLOCK: usize = SAMPLE_RATE as usize / 2;

/// The mixed audio of a recording from `position`, as an endless-until-done
/// stream of samples for the output device.
pub struct ChunkSource {
    dirs: Vec<PathBuf>,
    /// Next sample to read from disk.
    position: u64,
    end: Option<u64>,
    block: Vec<f32>,
    offset: usize,
    /// Samples handed to the device so far, for the playhead.
    played: Arc<AtomicU64>,
    done: Arc<AtomicBool>,
}

impl ChunkSource {
    pub fn new(dirs: Vec<PathBuf>, from: u64, end: Option<u64>) -> Self {
        Self {
            dirs,
            position: from,
            end,
            block: Vec::new(),
            offset: 0,
            played: Arc::new(AtomicU64::new(from)),
            done: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn playhead(&self) -> Arc<AtomicU64> {
        self.played.clone()
    }

    pub fn done(&self) -> Arc<AtomicBool> {
        self.done.clone()
    }

    fn refill(&mut self) -> bool {
        let want = match self.end {
            Some(end) => (end.saturating_sub(self.position)).min(BLOCK as u64) as usize,
            None => BLOCK,
        };
        self.block.clear();
        self.offset = 0;
        if want == 0 {
            return false;
        }
        for dir in &self.dirs {
            let samples = read_samples(dir, self.position, want);
            if samples.len() > self.block.len() {
                self.block.resize(samples.len(), 0.0);
            }
            for (mixed, sample) in self.block.iter_mut().zip(&samples) {
                *mixed = (*mixed + sample).clamp(-1.0, 1.0);
            }
        }
        self.position += self.block.len() as u64;
        !self.block.is_empty()
    }
}

impl Iterator for ChunkSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.offset >= self.block.len() && !self.refill() {
            self.done.store(true, Ordering::Relaxed);
            return None;
        }
        let sample = self.block[self.offset];
        self.offset += 1;
        self.played.fetch_add(1, Ordering::Relaxed);
        Some(sample)
    }
}

impl rodio::Source for ChunkSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> rodio::ChannelCount {
        NonZero::<u16>::MIN
    }

    fn sample_rate(&self) -> rodio::SampleRate {
        NonZero::new(SAMPLE_RATE).unwrap_or(NonZero::<u32>::MIN)
    }

    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

enum Command {
    Play {
        meeting_id: String,
        dirs: Vec<PathBuf>,
        from_ms: u32,
        to_ms: Option<u32>,
    },
    Stop,
}

struct Playing {
    meeting_id: String,
    player: rodio::Player,
    playhead: Arc<AtomicU64>,
    done: Arc<AtomicBool>,
}

/// The app's one player.
pub struct Playback {
    commands: Mutex<mpsc::Sender<Command>>,
}

impl Playback {
    /// Starts the playback thread. `on_state` hears the playhead;
    /// `playing_flag` is true for as long as sound is coming out, so a live
    /// meeting can keep its own playback out of the transcript.
    pub fn spawn(
        on_state: impl Fn(PlaybackState) + Send + 'static,
        playing_flag: Arc<AtomicBool>,
    ) -> Self {
        let (commands, inbox) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("scribe-playback".into())
            .spawn(move || run(inbox, on_state, playing_flag));
        if let Err(error) = spawned {
            log::error!("the playback thread did not start: {error}");
        }
        Self {
            commands: Mutex::new(commands),
        }
    }

    fn send(&self, command: Command) {
        let commands = self
            .commands
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = commands.send(command);
    }

    /// Plays the recording in `dirs` (one folder per source) from `from_ms`,
    /// to `to_ms` or to its end. Replaces whatever is playing.
    pub fn play(&self, meeting_id: &str, dirs: Vec<PathBuf>, from_ms: u32, to_ms: Option<u32>) {
        self.send(Command::Play {
            meeting_id: meeting_id.to_string(),
            dirs,
            from_ms,
            to_ms,
        });
    }

    pub fn stop(&self) {
        self.send(Command::Stop);
    }
}

fn run(
    inbox: mpsc::Receiver<Command>,
    on_state: impl Fn(PlaybackState),
    playing_flag: Arc<AtomicBool>,
) {
    // Opened on the first play and kept: opening a device takes far longer
    // than a seek may (PRD F8.1: under 200 ms).
    let mut device: Option<rodio::stream::MixerDeviceSink> = None;
    let mut playing: Option<Playing> = None;

    let stop = |playing: &mut Option<Playing>| {
        if let Some(was) = playing.take() {
            was.player.stop();
            playing_flag.store(false, Ordering::Relaxed);
            on_state(PlaybackState {
                meeting_id: was.meeting_id,
                playing: false,
                t_ms: ms_of_samples(was.playhead.load(Ordering::Relaxed)),
            });
        }
    };

    loop {
        match inbox.recv_timeout(Duration::from_millis(100)) {
            Ok(Command::Play {
                meeting_id,
                dirs,
                from_ms,
                to_ms,
            }) => {
                let asked = Instant::now();
                stop(&mut playing);
                if device.is_none() {
                    device = anlg_audio_utils::open_default_playback_sink()
                        .map_err(|error| log::error!("no output device for playback: {error}"))
                        .ok();
                }
                let Some(device) = device.as_ref() else {
                    on_state(PlaybackState {
                        meeting_id,
                        playing: false,
                        t_ms: from_ms,
                    });
                    continue;
                };
                let source =
                    ChunkSource::new(dirs, samples_of_ms(from_ms), to_ms.map(samples_of_ms));
                let (playhead, done) = (source.playhead(), source.done());
                let player = rodio::Player::connect_new(device.mixer());
                player.append(source);
                playing_flag.store(true, Ordering::Relaxed);
                log::info!("playback started in {} ms", asked.elapsed().as_millis());
                on_state(PlaybackState {
                    meeting_id: meeting_id.clone(),
                    playing: true,
                    t_ms: from_ms,
                });
                playing = Some(Playing {
                    meeting_id,
                    player,
                    playhead,
                    done,
                });
            }
            Ok(Command::Stop) => stop(&mut playing),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let Some(now) = playing.as_ref() else {
                    continue;
                };
                if now.done.load(Ordering::Relaxed) && now.player.empty() {
                    stop(&mut playing);
                } else {
                    on_state(PlaybackState {
                        meeting_id: now.meeting_id.clone(),
                        playing: true,
                        t_ms: ms_of_samples(now.playhead.load(Ordering::Relaxed)),
                    });
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::writer::ChunkWriter;

    fn recording(name: &str, value: f32, seconds: usize) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("scribe-playback-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut writer = ChunkWriter::create(&dir).unwrap();
        writer
            .write(&vec![value; seconds * SAMPLE_RATE as usize])
            .unwrap();
        writer.finish().unwrap();
        dir
    }

    #[test]
    fn a_span_plays_from_its_start_to_its_end_across_files() {
        let dir = recording("span", 0.25, 25);
        // 9.5 s to 11 s: from the first file into the second.
        let source = ChunkSource::new(
            vec![dir.clone()],
            samples_of_ms(9_500),
            Some(samples_of_ms(11_000)),
        );
        let (playhead, done) = (source.playhead(), source.done());
        let samples: Vec<f32> = source.collect();
        assert_eq!(samples.len(), 24_000);
        assert!(samples.iter().all(|sample| (sample - 0.25).abs() < 1e-3));
        assert_eq!(ms_of_samples(playhead.load(Ordering::Relaxed)), 11_000);
        assert!(done.load(Ordering::Relaxed));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn playing_to_the_end_stops_at_the_end_of_the_recording() {
        let dir = recording("end", 0.25, 12);
        let source = ChunkSource::new(vec![dir.clone()], samples_of_ms(10_000), None);
        assert_eq!(source.count(), 2 * SAMPLE_RATE as usize);
        // A seek past the end plays nothing.
        assert_eq!(
            ChunkSource::new(vec![dir.clone()], samples_of_ms(60_000), None).count(),
            0
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn both_sources_are_mixed_and_a_missing_one_is_silence() {
        let laptop = recording("mix-laptop", 0.25, 2);
        let system = recording("mix-system", 0.5, 1);
        let missing = std::env::temp_dir().join("scribe-playback-no-such-folder");
        let source = ChunkSource::new(vec![laptop.clone(), system.clone(), missing], 0, None);
        let samples: Vec<f32> = source.collect();
        assert_eq!(samples.len(), 2 * SAMPLE_RATE as usize);
        assert!(
            (samples[100] - 0.75).abs() < 1e-3,
            "both sources in the first second"
        );
        assert!(
            (samples[20_000] - 0.25).abs() < 1e-3,
            "then the longer one alone"
        );
        std::fs::remove_dir_all(laptop).unwrap();
        std::fs::remove_dir_all(system).unwrap();
    }
}
