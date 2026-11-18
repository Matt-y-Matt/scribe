//! Where the audio comes from.
//!
//! [`DeviceSource`] is the real thing: the vendored `audio-actual` crate
//! opens the microphone and the WASAPI loopback, resamples both to 16 kHz and
//! cancels the echo of the speakers in the microphone. [`FileSource`] plays
//! WAV files at the speed of a meeting, so the rest of the pipeline can be
//! tested and soaked without a room. Capture itself is not rewritten here.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anlg_audio::{CaptureChannel, CaptureEvent};
use audio_actual::{AudioInput, AudioOutput, CaptureConfig};
use tokio::sync::mpsc;

use super::{SourceKind, SAMPLE_RATE, WINDOW};

#[derive(Debug, Clone, PartialEq)]
pub enum CaptureMsg {
    Frame(Frame),
    /// A source started or stopped delivering audio (a device was unplugged,
    /// or came back).
    Status {
        source: SourceKind,
        ok: bool,
    },
    /// The source has nothing more to give: a file source reached its end.
    Ended,
}

/// One window of the meeting: the same 32 ms from each source.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub laptop: Vec<f32>,
    /// `None` when loopback is off.
    pub system: Option<Vec<f32>>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CaptureError {
    #[error("no microphone was found")]
    NoMicrophone,
    #[error("the microphone could not be opened: {0}")]
    Microphone(String),
    #[error("system audio could not be captured: {0}")]
    System(String),
    #[error("the test audio file could not be read: {0}")]
    File(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CaptureOptions {
    /// A device name from [`Source::microphones`]; `None` is the default one.
    pub microphone: Option<String>,
    /// Also capture what the PC plays.
    pub loopback: bool,
}

/// An open capture. Dropping it closes the devices.
pub struct Capture {
    pub frames: mpsc::Receiver<CaptureMsg>,
    _keep: Box<dyn Send>,
}

pub trait Source: Send + Sync {
    fn microphones(&self) -> Vec<String>;
    fn default_microphone(&self) -> Option<String>;
    /// Must be called on the tokio runtime.
    fn open(&self, options: &CaptureOptions) -> Result<Capture, CaptureError>;
}

/// The microphone and system audio of this PC.
pub struct DeviceSource;

struct DeviceGuard {
    task: tokio::task::JoinHandle<()>,
    /// Dropping the sender ends the silence that keeps loopback delivering.
    _silence: Option<std::sync::mpsc::Sender<()>>,
}

impl Drop for DeviceGuard {
    fn drop(&mut self) {
        // The task owns the capture stream; ending it closes the devices.
        self.task.abort();
    }
}

fn to_window(samples: &[f32]) -> Vec<f32> {
    let mut window = samples.to_vec();
    window.resize(WINDOW, 0.0);
    window
}

impl Source for DeviceSource {
    fn microphones(&self) -> Vec<String> {
        AudioInput::list_mic_devices()
    }

    fn default_microphone(&self) -> Option<String> {
        let name = AudioInput::get_default_device_name();
        self.microphones().contains(&name).then_some(name)
    }

    fn open(&self, options: &CaptureOptions) -> Result<Capture, CaptureError> {
        if self.microphones().is_empty() {
            return Err(CaptureError::NoMicrophone);
        }
        let loopback = options.loopback;
        let mut stream = if loopback {
            AudioInput::from_mic_and_speaker(CaptureConfig {
                sample_rate: SAMPLE_RATE,
                chunk_size: WINDOW,
                mic_device: options.microphone.clone(),
                enable_aec: true,
            })
        } else {
            AudioInput::from_mic_capture(options.microphone.clone(), SAMPLE_RATE, WINDOW)
        }
        .map_err(|error| CaptureError::Microphone(error.to_string()))?;

        let (tx, rx) = mpsc::channel(64);
        let task = tokio::spawn(async move {
            while let Some(event) = stream.next_event().await {
                let message = match event {
                    Ok(CaptureEvent::Frame(frame) | CaptureEvent::Gap(frame)) => {
                        CaptureMsg::Frame(Frame {
                            laptop: to_window(&frame.preferred_mic()),
                            system: loopback.then(|| to_window(&frame.raw_speaker)),
                        })
                    }
                    Ok(CaptureEvent::ChannelReady { channel, .. }) => CaptureMsg::Status {
                        source: source_of(channel),
                        ok: true,
                    },
                    Ok(CaptureEvent::ChannelFailed { channel, .. }) => CaptureMsg::Status {
                        source: source_of(channel),
                        ok: false,
                    },
                    Err(error) => {
                        log::warn!("capture error: {error}");
                        continue;
                    }
                };
                if tx.send(message).await.is_err() {
                    break;
                }
            }
            let _ = tx.send(CaptureMsg::Ended).await;
        });

        Ok(Capture {
            frames: rx,
            _keep: Box::new(DeviceGuard {
                task,
                // WASAPI loopback hands over nothing while the output device
                // is idle, which would stall the microphone it is joined to.
                _silence: loopback.then(AudioOutput::silence),
            }),
        })
    }
}

fn source_of(channel: CaptureChannel) -> SourceKind {
    match channel {
        CaptureChannel::Mic => SourceKind::Laptop,
        CaptureChannel::Speaker => SourceKind::System,
    }
}

/// Plays WAV files (16 kHz, mono, 16-bit) as if they were being heard now.
#[derive(Debug, Clone)]
pub struct FileSource {
    pub laptop: PathBuf,
    /// A second file, played as system audio when loopback is on.
    pub system: Option<PathBuf>,
    /// 1.0 is the speed of a meeting; 0.0 is as fast as the pipeline takes it.
    pub speed: f32,
    /// Start again at the end, for a soak test.
    pub repeat: bool,
}

pub fn read_wav(path: &Path) -> Result<Vec<f32>, CaptureError> {
    let fail = |error: String| CaptureError::File(error);
    let mut reader = hound::WavReader::open(path).map_err(|error| fail(error.to_string()))?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE || spec.channels != 1 || spec.bits_per_sample != 16 {
        return Err(fail(format!(
            "expected 16 kHz mono 16-bit, got {} Hz, {} channel(s), {} bit",
            spec.sample_rate, spec.channels, spec.bits_per_sample
        )));
    }
    reader
        .samples::<i16>()
        .map(|sample| sample.map(|value| value as f32 / i16::MAX as f32))
        .collect::<Result<Vec<f32>, _>>()
        .map_err(|error| fail(error.to_string()))
}

impl Source for FileSource {
    fn microphones(&self) -> Vec<String> {
        vec!["Test audio file".to_string()]
    }

    fn default_microphone(&self) -> Option<String> {
        self.microphones().into_iter().next()
    }

    fn open(&self, options: &CaptureOptions) -> Result<Capture, CaptureError> {
        let laptop = read_wav(&self.laptop)?;
        let system = match (&self.system, options.loopback) {
            (Some(path), true) => Some(read_wav(path)?),
            (None, true) => Some(Vec::new()),
            (_, false) => None,
        };
        let (speed, repeat) = (self.speed, self.repeat);
        let (tx, rx) = mpsc::channel(64);
        let task = tokio::spawn(async move {
            let window_time = Duration::from_secs_f64(WINDOW as f64 / SAMPLE_RATE as f64);
            let mut tick = (speed > 0.0).then(|| {
                let mut tick = tokio::time::interval(window_time.div_f32(speed));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
                tick
            });
            let window_at = |samples: &[f32], index: usize| {
                let start = (index * WINDOW).min(samples.len());
                let end = (start + WINDOW).min(samples.len());
                to_window(&samples[start..end])
            };
            let windows = laptop.len().div_ceil(WINDOW).max(1);
            let mut index = 0usize;
            loop {
                if index == windows {
                    if !repeat {
                        break;
                    }
                    index = 0;
                }
                if let Some(tick) = tick.as_mut() {
                    tick.tick().await;
                }
                let frame = Frame {
                    laptop: window_at(&laptop, index),
                    // A shorter system file plays once and then stays silent
                    // for the rest of each pass.
                    system: system.as_ref().map(|samples| window_at(samples, index)),
                };
                if tx.send(CaptureMsg::Frame(frame)).await.is_err() {
                    return;
                }
                index += 1;
            }
            let _ = tx.send(CaptureMsg::Ended).await;
        });
        Ok(Capture {
            frames: rx,
            _keep: Box::new(AbortOnDrop(task)),
        })
    }
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_wav(name: &str, samples: &[f32]) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("scribe-capture-{name}-{}.wav", std::process::id()));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for &sample in samples {
            writer
                .write_sample((sample * i16::MAX as f32) as i16)
                .unwrap();
        }
        writer.finalize().unwrap();
        path
    }

    async fn drain(mut capture: Capture) -> Vec<CaptureMsg> {
        let mut messages = Vec::new();
        while let Some(message) = capture.frames.recv().await {
            let ended = message == CaptureMsg::Ended;
            messages.push(message);
            if ended {
                break;
            }
        }
        messages
    }

    #[tokio::test]
    async fn a_file_plays_as_whole_windows_and_then_ends() {
        // 2.5 windows: the last one is padded with silence.
        let path = write_wav("windows", &vec![0.25; WINDOW * 5 / 2]);
        let source = FileSource {
            laptop: path.clone(),
            system: None,
            speed: 0.0,
            repeat: false,
        };
        let messages = drain(source.open(&CaptureOptions::default()).unwrap()).await;
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[3], CaptureMsg::Ended);
        let CaptureMsg::Frame(last) = &messages[2] else {
            panic!("expected a frame");
        };
        assert_eq!(last.laptop.len(), WINDOW);
        assert!(last.laptop[WINDOW / 2 - 1] > 0.2);
        assert_eq!(last.laptop[WINDOW / 2], 0.0);
        assert_eq!(last.system, None);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn with_loopback_every_frame_carries_system_audio() {
        let laptop = write_wav("laptop", &vec![0.1; WINDOW * 3]);
        let system = write_wav("system", &vec![0.5; WINDOW]);
        let source = FileSource {
            laptop: laptop.clone(),
            system: Some(system.clone()),
            speed: 0.0,
            repeat: false,
        };
        let options = CaptureOptions {
            microphone: None,
            loopback: true,
        };
        let messages = drain(source.open(&options).unwrap()).await;
        let frames: Vec<&Frame> = messages
            .iter()
            .filter_map(|message| match message {
                CaptureMsg::Frame(frame) => Some(frame),
                _ => None,
            })
            .collect();
        assert_eq!(frames.len(), 3);
        assert!(frames[0].system.as_ref().unwrap()[0] > 0.4);
        // Past the end of the shorter file there is silence, not a missing
        // source: both recordings stay the same length.
        assert_eq!(frames[2].system.as_ref().unwrap(), &vec![0.0; WINDOW]);
        std::fs::remove_file(laptop).unwrap();
        std::fs::remove_file(system).unwrap();
    }

    #[tokio::test]
    async fn a_file_in_the_wrong_format_is_refused() {
        let path =
            std::env::temp_dir().join(format!("scribe-capture-44k-{}.wav", std::process::id()));
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        hound::WavWriter::create(&path, spec)
            .unwrap()
            .finalize()
            .unwrap();
        let source = FileSource {
            laptop: path.clone(),
            system: None,
            speed: 0.0,
            repeat: false,
        };
        assert!(matches!(
            source.open(&CaptureOptions::default()),
            Err(CaptureError::File(_))
        ));
        std::fs::remove_file(path).unwrap();
    }
}
