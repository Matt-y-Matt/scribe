//! Runs a meeting through the real session without the app window: capture
//! (a WAV played at meeting speed, or this PC's devices), the Silero VAD,
//! the speech model, the recording on disk and SQLite.
//!
//!   soak --data <folder> --wav <file> [--system-wav <file>] [--minutes 60] [--speed 1]
//!   soak --data <folder> --devices [--no-loopback] [--minutes 5]
//!   soak --data <folder> --recover
//!
//! It prints one line a minute (meeting clock, segments, recogniser lag) and
//! the session's own statistics at the end. Kill it from outside and run it
//! again with `--recover` to exercise crash recovery. `--data` should be a
//! scratch folder: the model is read from `--models` (default: the app's own
//! data folder) and nothing else of the app's is touched.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use scribe_lib::audio::capture::{DeviceSource, FileSource, Source};
use scribe_lib::audio::vad::SileroDetector;
use scribe_lib::ipc::SegmentFinal;
use scribe_lib::session::recovery::recover;
use scribe_lib::session::{
    meeting_dir, new_id, AudioLevels, AudioPeaks, CaptureStatus, Events, RecState, RecordingState,
    Session, SessionDeps, StartOptions,
};
use scribe_lib::store::{MeetingMode, NewMeeting, Store};
use scribe_lib::stt::models::{self, DEFAULT_MODEL};
use scribe_lib::stt::{default_threads, LocalSherpa, Transcriber};

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1).cloned())
}

fn flag(name: &str) -> bool {
    std::env::args().any(|value| value == name)
}

#[derive(Default)]
struct Counters {
    segments: AtomicU32,
    words: AtomicU32,
    last_end_ms: AtomicU32,
    peaks: AtomicU32,
    lost: Mutex<Vec<String>>,
    show_text: AtomicBool,
}

impl Events for Counters {
    fn recording_state(&self, _state: RecordingState) {}
    fn levels(&self, _levels: AudioLevels) {}
    fn segment(&self, segment: SegmentFinal) {
        self.segments.fetch_add(1, Ordering::Relaxed);
        self.words.fetch_add(
            segment.text.split_whitespace().count() as u32,
            Ordering::Relaxed,
        );
        self.last_end_ms.fetch_max(segment.t1_ms, Ordering::Relaxed);
        if self.show_text.load(Ordering::Relaxed) {
            println!(
                "    {:>8.1}s {:<6} {}",
                segment.t0_ms as f32 / 1000.0,
                segment.source,
                segment.text
            );
        }
    }
    fn peaks(&self, peaks: AudioPeaks) {
        self.peaks
            .fetch_add(peaks.peaks.len() as u32, Ordering::Relaxed);
    }
    fn capture_status(&self, status: CaptureStatus) {
        let line = format!(
            "{} {}",
            status.source,
            if status.ok { "ready" } else { "lost" }
        );
        println!("  capture: {line}");
        self.lost.lock().unwrap().push(line);
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let data = PathBuf::from(arg("--data").expect("--data <scratch folder>"));
    let models_dir = arg("--models").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA"))
            .join("co.custore.scribe")
    });
    let model_id = arg("--model").unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let minutes: f64 = arg("--minutes").and_then(|v| v.parse().ok()).unwrap_or(1.0);
    let loopback = !flag("--no-loopback") && (flag("--devices") || arg("--system-wav").is_some());

    std::fs::create_dir_all(&data).expect("the data folder can be created");
    let store = Store::open(&data.join("scribe.db"))
        .await
        .expect("the database opens");
    let counters = Arc::new(Counters::default());
    counters.show_text.store(flag("--text"), Ordering::Relaxed);

    let source: Arc<dyn Source> = if flag("--devices") {
        Arc::new(DeviceSource)
    } else {
        Arc::new(FileSource {
            laptop: PathBuf::from(arg("--wav").unwrap_or_default()),
            system: arg("--system-wav").map(PathBuf::from),
            speed: arg("--speed").and_then(|v| v.parse().ok()).unwrap_or(1.0),
            repeat: true,
        })
    };
    let deps = SessionDeps {
        data_dir: data.clone(),
        store: store.clone(),
        source,
        events: counters.clone(),
        detector: Arc::new(|| Box::new(SileroDetector::new().expect("the Silero VAD loads"))),
        transcriber: Arc::new(move |id| {
            let spec = models::spec(id).ok_or(scribe_lib::stt::SttError::NotInstalled)?;
            let model = LocalSherpa::load(spec, &models_dir, default_threads(), "cpu")?;
            Ok(Arc::new(model) as Arc<dyn Transcriber>)
        }),
        mute_system: Arc::default(),
    };

    if flag("--recover") {
        let unfinished: Vec<_> = store
            .meetings()
            .await
            .expect("meetings can be listed")
            .into_iter()
            .filter(|meeting| meeting.is_unfinished())
            .collect();
        println!("{} unfinished meeting(s)", unfinished.len());
        for meeting in unfinished {
            let before = store.segments(&meeting.id).await.unwrap().len();
            let started = Instant::now();
            match recover(&deps, &meeting.id, &model_id).await {
                Ok(recovered) => println!(
                    "recovered {}: {:.1} s of audio, {} segments before the kill, {} added, in {:.1} s",
                    meeting.id,
                    recovered.duration_ms as f64 / 1000.0,
                    before,
                    recovered.segments_added,
                    started.elapsed().as_secs_f64()
                ),
                Err(error) => println!("could not recover {}: {error}", meeting.id),
            }
        }
        return;
    }

    let id = new_id("m");
    store
        .create_meeting(
            &id,
            &NewMeeting {
                title: "Soak".into(),
                agenda: vec!["A".into(), "B".into(), "C".into()],
                mode: MeetingMode::Group,
                participants: vec![],
            },
        )
        .await
        .expect("the meeting is created");
    let session = Session::new(deps);
    let options = StartOptions {
        microphone: None,
        loopback,
        model_id,
    };
    if let Err(error) = session.start(&id, options).await {
        println!("could not start: {error}");
        std::process::exit(2);
    }
    println!("meeting {id} in {}", meeting_dir(&data, &id).display());
    println!("  minute   clock s   segments   words   behind s");

    let started = Instant::now();
    let total = Duration::from_secs_f64(minutes * 60.0);
    let mut minute = 0u32;
    while started.elapsed() < total {
        let next = (Duration::from_secs(60) * (minute + 1)).min(total);
        tokio::time::sleep(next.saturating_sub(started.elapsed())).await;
        minute += 1;
        let state = session.state().await;
        if state.state != RecState::Recording {
            break;
        }
        // How far the transcript trails the clock: small means the
        // recogniser keeps up.
        let behind = state
            .elapsed_ms
            .saturating_sub(counters.last_end_ms.load(Ordering::Relaxed));
        println!(
            "  {minute:>6}   {:>7.1}   {:>8}   {:>5}   {:>8.1}",
            state.elapsed_ms as f64 / 1000.0,
            counters.segments.load(Ordering::Relaxed),
            counters.words.load(Ordering::Relaxed),
            behind as f64 / 1000.0
        );
    }

    let stopping = Instant::now();
    let stopped = session.stop().await.expect("the meeting stops");
    println!(
        "stopped at {:.1} s on the meeting clock ({:.1} s to finish the last utterances)",
        stopped.elapsed_ms as f64 / 1000.0,
        stopping.elapsed().as_secs_f64()
    );
    let stats =
        std::fs::read_to_string(meeting_dir(&data, &id).join("stats.json")).unwrap_or_default();
    println!("{stats}");
    println!("peaks sent: {}", counters.peaks.load(Ordering::Relaxed));
}
