//! The meeting session (ARCHITECTURE §2): idle → recording → paused →
//! stopped. It owns the meeting clock, turns captured audio into the
//! recording on disk, levels, waveform peaks and utterances, hands the
//! utterances to speech-to-text, and saves and announces each segment.
//!
//! The meeting clock counts audio, not wall time: it is the number of samples
//! processed, so it stops while paused and a segment's times always match the
//! audio files.

pub mod recovery;

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::{mpsc, oneshot};

use crate::audio::capture::{Capture, CaptureError, CaptureMsg, CaptureOptions, Frame, Source};
use crate::audio::echo::{self, SystemHistory};
use crate::audio::levels::LevelMeter;
use crate::audio::peaks::PeakMeter;
use crate::audio::vad::{CutterConfig, Segmenter, SpeechDetector, Utterance};
use crate::audio::writer::ChunkWriter;
use crate::audio::{ms_of_samples, samples_of_ms, SourceKind};
use crate::ipc::SegmentFinal;
use crate::store::Store;
use crate::stt::{SttError, Transcriber};

/// What the session tells the UI. The app sends these as Tauri events; tests
/// collect them.
pub trait Events: Send + Sync + 'static {
    fn recording_state(&self, state: RecordingState);
    fn levels(&self, levels: AudioLevels);
    fn segment(&self, segment: SegmentFinal);
    fn peaks(&self, peaks: AudioPeaks);
    fn capture_status(&self, status: CaptureStatus);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum RecState {
    Idle,
    Recording,
    Paused,
    Stopped,
}

/// `recording:state`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct RecordingState {
    /// `None` while idle.
    pub meeting_id: Option<String>,
    pub state: RecState,
    /// The meeting clock.
    pub elapsed_ms: u32,
    /// False when there is no speech model to transcribe with: the meeting
    /// is recorded and the transcript is off (PRD F3.4).
    pub transcribing: bool,
}

impl RecordingState {
    pub fn idle() -> Self {
        Self {
            meeting_id: None,
            state: RecState::Idle,
            elapsed_ms: 0,
            transcribing: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SourceLevel {
    /// `laptop` or `system`.
    pub id: String,
    pub rms: f32,
}

/// `audio:levels`, at most 20 times a second.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AudioLevels {
    pub sources: Vec<SourceLevel>,
}

/// `audio:peaks` — the next stretch of the waveform, 20 peaks per second of
/// meeting, each 0–255.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AudioPeaks {
    pub meeting_id: String,
    /// Index of the first peak in this batch.
    pub from: u32,
    pub peaks: Vec<u8>,
}

/// `capture:status` — a source stopped or started delivering audio.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct CaptureStatus {
    /// `laptop` or `system`.
    pub source: String,
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StartOptions {
    /// A name from `list_devices`; `None` is the default microphone.
    pub microphone: Option<String>,
    /// Also record and transcribe what the PC plays.
    pub loopback: bool,
    /// A model id from the catalogue.
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SessionError {
    #[error("a meeting is already being recorded")]
    Busy,
    #[error("no meeting is being recorded")]
    NotRecording,
    #[error("the meeting was not found")]
    NotFound,
    #[error("the meeting has already been recorded")]
    AlreadyRecorded,
    #[error(transparent)]
    Capture(#[from] CaptureError),
    #[error("storage error: {0}")]
    Storage(String),
}

pub type DetectorFactory = Arc<dyn Fn() -> Box<dyn SpeechDetector> + Send + Sync>;
/// Loads the speech model with the given id. Slow: called off the audio path.
pub type TranscriberFactory =
    Arc<dyn Fn(&str) -> Result<Arc<dyn Transcriber>, SttError> + Send + Sync>;

#[derive(Clone)]
pub struct SessionDeps {
    pub data_dir: PathBuf,
    pub store: Store,
    pub source: Arc<dyn Source>,
    pub events: Arc<dyn Events>,
    pub detector: DetectorFactory,
    pub transcriber: TranscriberFactory,
    /// Set while the app plays the recording back during a live meeting:
    /// system audio is then not transcribed, or the meeting would hear and
    /// transcribe itself.
    pub mute_system: Arc<AtomicBool>,
}

pub fn meeting_dir(data_dir: &Path, meeting_id: &str) -> PathBuf {
    data_dir.join("meetings").join(meeting_id)
}

pub fn audio_dir(data_dir: &Path, meeting_id: &str, source: SourceKind) -> PathBuf {
    meeting_dir(data_dir, meeting_id)
        .join("audio")
        .join(source.id())
}

pub fn peaks_path(data_dir: &Path, meeting_id: &str) -> PathBuf {
    meeting_dir(data_dir, meeting_id).join("peaks.u8")
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", ulid::Ulid::new())
}

fn storage(error: impl std::fmt::Display) -> SessionError {
    SessionError::Storage(error.to_string())
}

/// One utterance on its way to speech-to-text.
struct Job {
    source: SourceKind,
    utterance: Utterance,
    /// When the cutter closed it.
    closed: Instant,
}

/// How the session did, written next to the recording when it stops. Numbers
/// only: never text (CLAUDE.md rule 6).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionStats {
    pub segments: u32,
    pub speech_ms: u64,
    pub decode_ms: u64,
    /// From the end of speech to the segment being on screen: the cutter's
    /// closing silence, the wait for the recogniser, and the recognition.
    pub latency_median_ms: u32,
    pub latency_p95_ms: u32,
    pub latency_max_ms: u32,
    /// Microphone utterances dropped as the speakers' echo (audio/echo.rs).
    #[serde(default)]
    pub echoes_dropped: u32,
}

#[derive(Default)]
struct StatsLog {
    latencies_ms: Vec<u32>,
    speech_ms: u64,
    decode_ms: u64,
}

impl StatsLog {
    fn summary(&self) -> SessionStats {
        let mut sorted = self.latencies_ms.clone();
        sorted.sort_unstable();
        let at = |fraction: f64| -> u32 {
            if sorted.is_empty() {
                return 0;
            }
            sorted[((sorted.len() - 1) as f64 * fraction).round() as usize]
        };
        SessionStats {
            segments: sorted.len() as u32,
            speech_ms: self.speech_ms,
            decode_ms: self.decode_ms,
            latency_median_ms: at(0.5),
            latency_p95_ms: at(0.95),
            latency_max_ms: at(1.0),
            echoes_dropped: 0,
        }
    }
}

/// What the run loop and the commands both see.
struct Shared {
    meeting_id: String,
    state: Mutex<RecState>,
    samples: AtomicU64,
    transcribing: AtomicBool,
    stats: Mutex<StatsLog>,
    echoes_dropped: AtomicU32,
}

impl Shared {
    fn snapshot(&self) -> RecordingState {
        RecordingState {
            meeting_id: Some(self.meeting_id.clone()),
            state: *self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            elapsed_ms: ms_of_samples(self.samples.load(Ordering::Relaxed)),
            transcribing: self.transcribing.load(Ordering::Relaxed),
        }
    }

    fn set(&self, state: RecState) {
        *self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = state;
    }
}

enum Control {
    Pause(oneshot::Sender<()>),
    Resume(oneshot::Sender<Result<(), SessionError>>),
    Stop(oneshot::Sender<()>),
}

struct Active {
    control: mpsc::Sender<Control>,
    shared: Arc<Shared>,
    task: tokio::task::JoinHandle<()>,
}

pub struct Session {
    deps: SessionDeps,
    active: tokio::sync::Mutex<Option<Active>>,
}

/// Everything that happens to a frame of audio.
struct Pipeline {
    shared: Arc<Shared>,
    events: Arc<dyn Events>,
    mute_system: Arc<AtomicBool>,
    laptop_writer: ChunkWriter,
    system_writer: Option<ChunkWriter>,
    laptop_cut: Segmenter,
    system_cut: Option<Segmenter>,
    /// The system audio of the last half minute, to tell the speakers' echo
    /// in the microphone from a person. `None` when loopback is off.
    system_heard: Option<SystemHistory>,
    levels: LevelMeter,
    peaks: PeakMeter,
    peak_batch: Vec<u8>,
    peaks_sent: u32,
    peaks_file: Option<File>,
    laptop_jobs: std::sync::mpsc::Sender<Job>,
    system_jobs: Option<std::sync::mpsc::Sender<Job>>,
    found: Vec<Utterance>,
    disk_failed: bool,
}

impl Pipeline {
    fn disk(&mut self, result: std::io::Result<()>) {
        if let Err(error) = result {
            if !self.disk_failed {
                // Once: a full disk would otherwise log 30 times a second.
                log::error!("the recording could not be written: {error}");
                self.disk_failed = true;
            }
        }
    }

    fn on_frame(&mut self, frame: &Frame) {
        let system: &[f32] = frame.system.as_deref().unwrap_or(&[]);

        let written = self.laptop_writer.write(&frame.laptop);
        self.disk(written);
        if let Some(writer) = self.system_writer.as_mut() {
            let written = writer.write(system);
            self.disk(written);
        }

        if let Some(reading) = self.levels.push(&frame.laptop, system) {
            let mut sources = vec![SourceLevel {
                id: SourceKind::Laptop.id().to_string(),
                rms: reading.laptop,
            }];
            if frame.system.is_some() {
                sources.push(SourceLevel {
                    id: SourceKind::System.id().to_string(),
                    rms: reading.system,
                });
            }
            self.events.levels(AudioLevels { sources });
        }

        self.peaks.push(&frame.laptop, system, &mut self.peak_batch);
        if self.peak_batch.len() >= crate::audio::peaks::PEAKS_PER_SECOND as usize {
            self.send_peaks();
        }

        if let Some(heard) = self.system_heard.as_mut() {
            heard.push(system);
        }
        self.laptop_cut.push(&frame.laptop, &mut self.found);
        self.drop_echoes();
        Self::queue(&self.laptop_jobs, SourceKind::Laptop, &mut self.found);
        if let (Some(cut), Some(jobs)) = (self.system_cut.as_mut(), self.system_jobs.as_ref()) {
            cut.push(system, &mut self.found);
            if self.mute_system.load(Ordering::Relaxed) {
                self.found.clear();
            }
            Self::queue(jobs, SourceKind::System, &mut self.found);
        }

        self.shared
            .samples
            .fetch_add(frame.laptop.len() as u64, Ordering::Relaxed);
    }

    /// Takes out the microphone utterances that are the speakers and not a
    /// person, before they cost a recognition and show up twice.
    fn drop_echoes(&mut self) {
        let Some(heard) = self.system_heard.as_ref() else {
            return;
        };
        let before = self.found.len();
        self.found.retain(|utterance| {
            let judged = echo::check(&utterance.samples, heard, samples_of_ms(utterance.t0_ms));
            if judged.echo {
                log::debug!(
                    "echo dropped at {} ms: correlation {:.2}, {:.0} dB under the system audio",
                    utterance.t0_ms,
                    judged.correlation,
                    judged.below_db
                );
            }
            !judged.echo
        });
        let dropped = (before - self.found.len()) as u32;
        if dropped > 0 {
            self.shared
                .echoes_dropped
                .fetch_add(dropped, Ordering::Relaxed);
        }
    }

    fn queue(jobs: &std::sync::mpsc::Sender<Job>, source: SourceKind, found: &mut Vec<Utterance>) {
        for utterance in found.drain(..) {
            let _ = jobs.send(Job {
                source,
                utterance,
                closed: Instant::now(),
            });
        }
    }

    fn send_peaks(&mut self) {
        if self.peak_batch.is_empty() {
            return;
        }
        let peaks = std::mem::take(&mut self.peak_batch);
        if let Some(file) = self.peaks_file.as_mut() {
            let written = file.write_all(&peaks);
            self.disk(written);
        }
        let from = self.peaks_sent;
        self.peaks_sent += peaks.len() as u32;
        self.events.peaks(AudioPeaks {
            meeting_id: self.shared.meeting_id.clone(),
            from,
            peaks,
        });
    }

    /// At a pause, and at the end: nothing half-heard is left behind.
    fn settle(&mut self) {
        self.laptop_cut.flush(&mut self.found);
        self.drop_echoes();
        Self::queue(&self.laptop_jobs, SourceKind::Laptop, &mut self.found);
        if let (Some(cut), Some(jobs)) = (self.system_cut.as_mut(), self.system_jobs.as_ref()) {
            cut.flush(&mut self.found);
            Self::queue(jobs, SourceKind::System, &mut self.found);
        }
        self.send_peaks();
        let flushed = self.laptop_writer.flush();
        self.disk(flushed);
        if let Some(writer) = self.system_writer.as_mut() {
            let flushed = writer.flush();
            self.disk(flushed);
        }
    }

    fn finish(mut self) {
        self.settle();
        let finished = self.laptop_writer.finish();
        if let Err(error) = finished {
            log::error!("the recording could not be closed: {error}");
        }
        if let Some(writer) = self.system_writer {
            if let Err(error) = writer.finish() {
                log::error!("the recording could not be closed: {error}");
            }
        }
        // Dropping the job senders lets the recogniser threads run dry.
    }
}

/// Transcribes one source's utterances in order, saves each segment and
/// announces it. Ends when the pipeline hangs up.
fn transcribe_jobs(
    jobs: std::sync::mpsc::Receiver<Job>,
    transcriber: Option<Arc<dyn Transcriber>>,
    shared: Arc<Shared>,
    store: Store,
    events: Arc<dyn Events>,
    runtime: tokio::runtime::Handle,
) {
    for job in jobs {
        let Some(transcriber) = transcriber.as_ref() else {
            continue;
        };
        let started = Instant::now();
        let transcript = transcriber.transcribe(&job.utterance.samples);
        let decode_ms = started.elapsed().as_millis() as u64;
        if transcript.text.is_empty() {
            continue;
        }
        let segment = SegmentFinal {
            id: new_id("s"),
            meeting_id: shared.meeting_id.clone(),
            t0_ms: job.utterance.t0_ms,
            t1_ms: job.utterance.t1_ms,
            speaker_label: job.source.label().to_string(),
            source: job.source.id().to_string(),
            text: transcript.text,
            confidence: transcript.confidence,
        };
        if let Err(error) = runtime.block_on(store.insert_segment(&segment)) {
            log::error!("a segment could not be saved: {error}");
        }
        events.segment(segment);

        let latency =
            job.utterance.closing_silence_ms as u64 + job.closed.elapsed().as_millis() as u64;
        let mut stats = shared
            .stats
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        stats.latencies_ms.push(latency.min(u32::MAX as u64) as u32);
        stats.speech_ms += (job.utterance.t1_ms - job.utterance.t0_ms) as u64;
        stats.decode_ms += decode_ms;
    }
}

impl Session {
    pub fn new(deps: SessionDeps) -> Self {
        Self {
            deps,
            active: tokio::sync::Mutex::new(None),
        }
    }

    /// The state of the meeting being recorded, or idle.
    pub async fn state(&self) -> RecordingState {
        match self.active.lock().await.as_ref() {
            Some(active) if !active.task.is_finished() => active.shared.snapshot(),
            _ => RecordingState::idle(),
        }
    }

    /// True while a meeting is being recorded or is paused.
    pub async fn is_active(&self, meeting_id: &str) -> bool {
        self.state().await.meeting_id.as_deref() == Some(meeting_id)
    }

    pub async fn start(
        &self,
        meeting_id: &str,
        options: StartOptions,
    ) -> Result<RecordingState, SessionError> {
        let mut active = self.active.lock().await;
        if active
            .as_ref()
            .is_some_and(|active| !active.task.is_finished())
        {
            return Err(SessionError::Busy);
        }
        let deps = self.deps.clone();
        let meeting = deps
            .store
            .meeting(meeting_id)
            .await
            .map_err(storage)?
            .ok_or(SessionError::NotFound)?;
        if meeting.started_at_ms.is_some() {
            return Err(SessionError::AlreadyRecorded);
        }

        let capture_options = CaptureOptions {
            microphone: options.microphone.clone(),
            loopback: options.loopback,
        };
        // Open the devices first: with no microphone nothing is created.
        let capture = deps.source.open(&capture_options)?;

        let laptop_writer =
            ChunkWriter::create(&audio_dir(&deps.data_dir, meeting_id, SourceKind::Laptop))
                .map_err(storage)?;
        let system_writer = if options.loopback {
            Some(
                ChunkWriter::create(&audio_dir(&deps.data_dir, meeting_id, SourceKind::System))
                    .map_err(storage)?,
            )
        } else {
            None
        };
        let peaks_file = File::create(peaks_path(&deps.data_dir, meeting_id)).map_err(storage)?;
        deps.store
            .mark_started(meeting_id, options.loopback)
            .await
            .map_err(storage)?;

        let shared = Arc::new(Shared {
            meeting_id: meeting_id.to_string(),
            state: Mutex::new(RecState::Recording),
            samples: AtomicU64::new(0),
            transcribing: AtomicBool::new(false),
            stats: Mutex::new(StatsLog::default()),
            echoes_dropped: AtomicU32::new(0),
        });

        // Speech-to-text runs on its own threads: one loads the model, then
        // each source gets a thread, so a long stretch of system audio never
        // holds up what was said in the room.
        let (laptop_jobs, laptop_rx) = std::sync::mpsc::channel();
        let (system_jobs, system_rx) = if options.loopback {
            let (tx, rx) = std::sync::mpsc::channel();
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let (drained_tx, drained_rx) = oneshot::channel();
        {
            let (shared, store, events) = (shared.clone(), deps.store.clone(), deps.events.clone());
            let factory = deps.transcriber.clone();
            let model_id = options.model_id.clone();
            let runtime = tokio::runtime::Handle::current();
            std::thread::Builder::new()
                .name("scribe-stt".into())
                .spawn(move || {
                    let transcriber = match factory(&model_id) {
                        Ok(transcriber) => Some(transcriber),
                        Err(error) => {
                            log::warn!("transcript off: {error}");
                            None
                        }
                    };
                    shared
                        .transcribing
                        .store(transcriber.is_some(), Ordering::Relaxed);
                    events.recording_state(shared.snapshot());

                    let system = system_rx.map(|jobs| {
                        let (transcriber, shared) = (transcriber.clone(), shared.clone());
                        let (store, events, runtime) =
                            (store.clone(), events.clone(), runtime.clone());
                        std::thread::spawn(move || {
                            transcribe_jobs(jobs, transcriber, shared, store, events, runtime)
                        })
                    });
                    transcribe_jobs(laptop_rx, transcriber, shared, store, events, runtime);
                    if let Some(system) = system {
                        let _ = system.join();
                    }
                    let _ = drained_tx.send(());
                })
                .map_err(storage)?;
        }

        let pipeline = Pipeline {
            shared: shared.clone(),
            events: deps.events.clone(),
            mute_system: deps.mute_system.clone(),
            laptop_writer,
            system_writer,
            laptop_cut: Segmenter::new((deps.detector)(), CutterConfig::default()),
            system_cut: options
                .loopback
                .then(|| Segmenter::new((deps.detector)(), CutterConfig::default())),
            system_heard: options.loopback.then(SystemHistory::new),
            levels: LevelMeter::default(),
            peaks: PeakMeter::default(),
            peak_batch: Vec::new(),
            peaks_sent: 0,
            peaks_file: Some(peaks_file),
            laptop_jobs,
            system_jobs,
            found: Vec::new(),
            disk_failed: false,
        };

        let (control, control_rx) = mpsc::channel(4);
        let task = tokio::spawn(run(
            deps,
            shared.clone(),
            pipeline,
            capture,
            capture_options,
            control_rx,
            drained_rx,
        ));
        let state = shared.snapshot();
        self.deps.events.recording_state(state.clone());
        *active = Some(Active {
            control,
            shared,
            task,
        });
        Ok(state)
    }

    async fn send<T>(
        &self,
        message: impl FnOnce(oneshot::Sender<T>) -> Control,
    ) -> Result<(T, RecordingState), SessionError> {
        let active = self.active.lock().await;
        let active = active.as_ref().ok_or(SessionError::NotRecording)?;
        let (reply, answer) = oneshot::channel();
        active
            .control
            .send(message(reply))
            .await
            .map_err(|_| SessionError::NotRecording)?;
        let answer = answer.await.map_err(|_| SessionError::NotRecording)?;
        Ok((answer, active.shared.snapshot()))
    }

    /// Stops all capture. The clock stops with it.
    pub async fn pause(&self) -> Result<RecordingState, SessionError> {
        Ok(self.send(Control::Pause).await?.1)
    }

    pub async fn resume(&self) -> Result<RecordingState, SessionError> {
        let (opened, state) = self.send(Control::Resume).await?;
        opened?;
        Ok(state)
    }

    /// Ends the meeting. Returns once the last utterance has been
    /// transcribed and saved.
    pub async fn stop(&self) -> Result<RecordingState, SessionError> {
        let state = self.send(Control::Stop).await?.1;
        if let Some(active) = self.active.lock().await.take() {
            let _ = active.task.await;
        }
        Ok(state)
    }
}

/// Takes in what capture had already delivered, so a pause or a stop loses
/// nothing that was heard before it.
fn drain(capture: &mut Capture, pipeline: &mut Pipeline) {
    while let Ok(message) = capture.frames.try_recv() {
        match message {
            CaptureMsg::Frame(frame) => pipeline.on_frame(&frame),
            CaptureMsg::Status { source, ok } => pipeline.events.capture_status(CaptureStatus {
                source: source.id().to_string(),
                ok,
            }),
            CaptureMsg::Ended => {}
        }
    }
}

async fn next_message(capture: &mut Option<Capture>) -> Option<CaptureMsg> {
    match capture.as_mut() {
        Some(capture) => capture.frames.recv().await,
        // Paused: nothing arrives until the capture is opened again.
        None => std::future::pending().await,
    }
}

async fn run(
    deps: SessionDeps,
    shared: Arc<Shared>,
    mut pipeline: Pipeline,
    capture: Capture,
    capture_options: CaptureOptions,
    mut control: mpsc::Receiver<Control>,
    drained: oneshot::Receiver<()>,
) {
    let mut capture = Some(capture);
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ticks = 0u32;
    let mut stopping: Option<oneshot::Sender<()>> = None;

    loop {
        tokio::select! {
            message = next_message(&mut capture) => match message {
                Some(CaptureMsg::Frame(frame)) => pipeline.on_frame(&frame),
                Some(CaptureMsg::Status { source, ok }) => {
                    deps.events.capture_status(CaptureStatus { source: source.id().to_string(), ok });
                }
                // A file source reached its end: the meeting is over.
                Some(CaptureMsg::Ended) | None => break,
            },
            command = control.recv() => match command {
                Some(Control::Pause(reply)) => {
                    if let Some(mut open) = capture.take() {
                        drain(&mut open, &mut pipeline);
                        drop(open);
                        pipeline.settle();
                        shared.set(RecState::Paused);
                        deps.events.recording_state(shared.snapshot());
                    }
                    let _ = reply.send(());
                }
                Some(Control::Resume(reply)) => {
                    let opened = if capture.is_some() {
                        Ok(())
                    } else {
                        deps.source.open(&capture_options).map(|opened| {
                            capture = Some(opened);
                            shared.set(RecState::Recording);
                            deps.events.recording_state(shared.snapshot());
                        })
                    };
                    let _ = reply.send(opened.map_err(SessionError::from));
                }
                Some(Control::Stop(reply)) => {
                    stopping = Some(reply);
                    break;
                }
                None => break,
            },
            _ = tick.tick() => {
                ticks += 1;
                let state = shared.snapshot();
                // Every 10 s the length so far is saved, for the meetings
                // list and for a recovery that finds no audio to measure.
                if ticks % 10 == 0 && state.state == RecState::Recording {
                    if let Err(error) = deps.store.set_duration(&shared.meeting_id, state.elapsed_ms).await {
                        log::error!("the meeting's length could not be saved: {error}");
                    }
                }
                deps.events.recording_state(state);
            }
        }
    }

    // Close the devices, finish the files, and wait for the recogniser to
    // work through what is left before calling the meeting stopped.
    if let Some(mut open) = capture.take() {
        drain(&mut open, &mut pipeline);
    }
    pipeline.finish();
    let _ = drained.await;

    let duration_ms = ms_of_samples(shared.samples.load(Ordering::Relaxed));
    if let Err(error) = deps.store.mark_ended(&shared.meeting_id, duration_ms).await {
        log::error!("the meeting's end could not be saved: {error}");
    }
    let mut stats = shared
        .stats
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .summary();
    stats.echoes_dropped = shared.echoes_dropped.load(Ordering::Relaxed);
    log::info!(
        "meeting stopped: {duration_ms} ms, {} segments, latency median {} ms, p95 {} ms, max {} ms, {} echoes dropped",
        stats.segments,
        stats.latency_median_ms,
        stats.latency_p95_ms,
        stats.latency_max_ms,
        stats.echoes_dropped
    );
    if let Ok(json) = serde_json::to_string_pretty(&stats) {
        let _ = std::fs::write(
            meeting_dir(&deps.data_dir, &shared.meeting_id).join("stats.json"),
            json,
        );
    }
    shared.set(RecState::Stopped);
    deps.events.recording_state(shared.snapshot());
    if let Some(reply) = stopping {
        let _ = reply.send(());
    }
}

#[cfg(test)]
pub mod testing {
    //! Stand-ins for the microphone, the speech model and the UI.

    use super::*;
    use crate::audio::vad::EnergyDetector;
    use crate::audio::WINDOW;
    use crate::stt::Transcript;

    /// Collects what the session announced.
    #[derive(Default)]
    pub struct Recorded {
        pub states: Mutex<Vec<RecordingState>>,
        pub segments: Mutex<Vec<SegmentFinal>>,
        pub peaks: Mutex<Vec<AudioPeaks>>,
        pub levels: Mutex<Vec<AudioLevels>>,
        pub statuses: Mutex<Vec<CaptureStatus>>,
    }

    impl Events for Recorded {
        fn recording_state(&self, state: RecordingState) {
            self.states.lock().unwrap().push(state);
        }
        fn levels(&self, levels: AudioLevels) {
            self.levels.lock().unwrap().push(levels);
        }
        fn segment(&self, segment: SegmentFinal) {
            self.segments.lock().unwrap().push(segment);
        }
        fn peaks(&self, peaks: AudioPeaks) {
            self.peaks.lock().unwrap().push(peaks);
        }
        fn capture_status(&self, status: CaptureStatus) {
            self.statuses.lock().unwrap().push(status);
        }
    }

    /// A microphone the test feeds by hand.
    #[derive(Default)]
    pub struct HandSource {
        feed: Mutex<Option<mpsc::Sender<CaptureMsg>>>,
        pub opened: AtomicU64,
        pub missing: AtomicBool,
    }

    impl HandSource {
        /// Sends `ms` of a loud tone or of silence, in whole windows.
        pub async fn play(&self, ms: u32, loud: bool, system: bool) {
            let feed = self
                .feed
                .lock()
                .unwrap()
                .clone()
                .expect("the capture is open");
            let windows = (crate::audio::samples_of_ms(ms) as usize).div_ceil(WINDOW);
            for index in 0..windows {
                let window: Vec<f32> = (0..WINDOW)
                    .map(|i| {
                        if loud {
                            0.3 * ((index * WINDOW + i) as f32 * 0.1).sin()
                        } else {
                            0.0
                        }
                    })
                    .collect();
                let frame = Frame {
                    laptop: window.clone(),
                    system: system.then_some(window),
                };
                feed.send(CaptureMsg::Frame(frame))
                    .await
                    .expect("the session is listening");
            }
        }

        /// Sends these samples, in whole windows; `system` is the system
        /// audio of the same moment, padded with silence if it is shorter.
        pub async fn play_signals(&self, laptop: &[f32], system: Option<&[f32]>) {
            let feed = self
                .feed
                .lock()
                .unwrap()
                .clone()
                .expect("the capture is open");
            let window = |samples: &[f32], index: usize| -> Vec<f32> {
                let start = (index * WINDOW).min(samples.len());
                let mut piece = samples[start..(start + WINDOW).min(samples.len())].to_vec();
                piece.resize(WINDOW, 0.0);
                piece
            };
            for index in 0..laptop.len().div_ceil(WINDOW) {
                let frame = Frame {
                    laptop: window(laptop, index),
                    system: system.map(|samples| window(samples, index)),
                };
                feed.send(CaptureMsg::Frame(frame))
                    .await
                    .expect("the session is listening");
            }
        }

        pub async fn send(&self, message: CaptureMsg) {
            let feed = self
                .feed
                .lock()
                .unwrap()
                .clone()
                .expect("the capture is open");
            feed.send(message).await.expect("the session is listening");
        }
    }

    impl Source for HandSource {
        fn microphones(&self) -> Vec<String> {
            vec!["Hand".into()]
        }
        fn default_microphone(&self) -> Option<String> {
            Some("Hand".into())
        }
        fn open(&self, _options: &CaptureOptions) -> Result<Capture, CaptureError> {
            if self.missing.load(Ordering::Relaxed) {
                return Err(CaptureError::NoMicrophone);
            }
            let (tx, rx) = mpsc::channel(4096);
            *self.feed.lock().unwrap() = Some(tx);
            self.opened.fetch_add(1, Ordering::Relaxed);
            Ok(Capture::new(rx, ()))
        }
    }

    /// Says how long each utterance was instead of what was said.
    pub struct CountingTranscriber;

    impl Transcriber for CountingTranscriber {
        fn transcribe(&self, samples: &[f32]) -> Transcript {
            Transcript {
                text: format!("{} ms of speech", ms_of_samples(samples.len() as u64)),
                confidence: 1.0,
            }
        }
    }

    pub struct Rig {
        pub session: Session,
        pub store: Store,
        pub source: Arc<HandSource>,
        pub events: Arc<Recorded>,
        pub data_dir: PathBuf,
        pub mute_system: Arc<AtomicBool>,
    }

    pub async fn rig(name: &str, with_model: bool) -> Rig {
        let data_dir =
            std::env::temp_dir().join(format!("scribe-session-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).unwrap();
        let store = Store::in_memory().await.unwrap();
        let source = Arc::new(HandSource::default());
        let events = Arc::new(Recorded::default());
        let mute_system = Arc::new(AtomicBool::new(false));
        let session = Session::new(SessionDeps {
            data_dir: data_dir.clone(),
            store: store.clone(),
            source: source.clone(),
            events: events.clone(),
            detector: Arc::new(|| Box::new(EnergyDetector { floor_rms: 0.01 })),
            transcriber: Arc::new(move |_| {
                if with_model {
                    Ok(Arc::new(CountingTranscriber) as Arc<dyn Transcriber>)
                } else {
                    Err(SttError::NotInstalled)
                }
            }),
            mute_system: mute_system.clone(),
        });
        Rig {
            session,
            store,
            source,
            events,
            data_dir,
            mute_system,
        }
    }

    pub fn options(loopback: bool) -> StartOptions {
        StartOptions {
            microphone: None,
            loopback,
            model_id: "test".into(),
        }
    }

    pub async fn meeting(store: &Store, id: &str) {
        store
            .create_meeting(
                id,
                &crate::store::NewMeeting {
                    title: "Bench".into(),
                    agenda: vec![],
                    mode: crate::store::MeetingMode::Group,
                    participants: vec![],
                },
            )
            .await
            .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::audio::writer::recorded_samples;
    use crate::audio::SAMPLE_RATE;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_meeting_is_recorded_transcribed_and_stopped() {
        let rig = rig("basic", true).await;
        meeting(&rig.store, "m_1").await;
        assert_eq!(rig.session.state().await, RecordingState::idle());

        let started = rig.session.start("m_1", options(false)).await.unwrap();
        assert_eq!(started.state, RecState::Recording);
        assert!(rig.session.is_active("m_1").await);

        // Two utterances with a pause between them, then the end.
        rig.source.play(2_000, true, false).await;
        rig.source.play(1_500, false, false).await;
        rig.source.play(3_000, true, false).await;
        rig.source.play(1_000, false, false).await;
        let stopped = rig.session.stop().await.unwrap();
        assert_eq!(stopped.state, RecState::Stopped);
        assert_eq!(rig.session.state().await, RecordingState::idle());

        // The clock is the audio: 236 windows (7.552 s) in, on disk, and in
        // the peaks.
        let on_disk =
            recorded_samples(&audio_dir(&rig.data_dir, "m_1", SourceKind::Laptop)).unwrap();
        assert_eq!(on_disk, 7_552 * SAMPLE_RATE as u64 / 1000);
        assert_eq!(stopped.elapsed_ms, 7_552);
        let peaks: usize = rig
            .events
            .peaks
            .lock()
            .unwrap()
            .iter()
            .map(|batch| batch.peaks.len())
            .sum();
        assert_eq!(peaks, 151);
        assert_eq!(
            std::fs::read(peaks_path(&rig.data_dir, "m_1"))
                .unwrap()
                .len(),
            151
        );

        // Each utterance became a segment, saved and announced, with times
        // that point into the recording.
        let saved = rig.store.segments("m_1").await.unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(*rig.events.segments.lock().unwrap(), saved);
        assert!(
            saved[0].t0_ms < 100 && saved[0].t1_ms.abs_diff(2_200) < 100,
            "{saved:?}"
        );
        assert!(
            saved[1].t0_ms.abs_diff(3_300) < 100 && saved[1].t1_ms.abs_diff(6_700) < 100,
            "{saved:?}"
        );
        assert_eq!(saved[0].source, "laptop");
        assert_eq!(saved[0].speaker_label, "Room");
        assert!(saved[0].id.starts_with("s_"));

        let ended = rig.store.meeting("m_1").await.unwrap().unwrap();
        assert!(!ended.is_unfinished());
        assert_eq!(ended.duration_ms, 7_552);
        assert!(meeting_dir(&rig.data_dir, "m_1")
            .join("stats.json")
            .exists());
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pause_stops_capture_and_the_clock_and_resume_carries_on() {
        let rig = rig("pause", true).await;
        meeting(&rig.store, "m_1").await;
        rig.session.start("m_1", options(false)).await.unwrap();
        rig.source.play(2_000, true, false).await;

        let paused = rig.session.pause().await.unwrap();
        assert_eq!(paused.state, RecState::Paused);
        // The open utterance was closed by the pause, not lost. The
        // recogniser thread may still be starting on a slow machine.
        for _ in 0..500 {
            if !rig.events.segments.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(rig.events.segments.lock().unwrap().len(), 1);
        let at_pause = rig.session.state().await.elapsed_ms;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            rig.session.state().await.elapsed_ms,
            at_pause,
            "the clock stands still"
        );

        let resumed = rig.session.resume().await.unwrap();
        assert_eq!(resumed.state, RecState::Recording);
        assert_eq!(
            rig.source.opened.load(Ordering::Relaxed),
            2,
            "capture was reopened"
        );
        rig.source.play(1_000, true, false).await;
        let stopped = rig.session.stop().await.unwrap();
        assert!(stopped.elapsed_ms.abs_diff(3_000) < 100);

        let saved = rig.store.segments("m_1").await.unwrap();
        assert_eq!(saved.len(), 2);
        // The second utterance starts where the first one ended on the clock.
        assert!(saved[1].t0_ms.abs_diff(at_pause) < 100, "{saved:?}");
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_loopback_both_sources_are_recorded_and_labelled() {
        use crate::audio::echo::testing::speechlike;
        let rig = rig("loopback", true).await;
        meeting(&rig.store, "m_1").await;
        rig.session.start("m_1", options(true)).await.unwrap();
        // Someone in the room and someone on the call, both for 2 s, saying
        // different things; then a second of quiet.
        let mut room = speechlike(7, 2_000, 0.1);
        room.extend(vec![0.0f32; 16_000]);
        let mut call = speechlike(1, 2_000, 0.3);
        call.extend(vec![0.0f32; 16_000]);
        rig.source.play_signals(&room, Some(&call)).await;
        rig.session.stop().await.unwrap();

        for source in SourceKind::ALL {
            let samples = recorded_samples(&audio_dir(&rig.data_dir, "m_1", source)).unwrap();
            assert_eq!(samples, 3_008 * 16, "{source:?}");
        }
        let mut found: Vec<(String, String)> = rig
            .store
            .segments("m_1")
            .await
            .unwrap()
            .into_iter()
            .map(|segment| (segment.source, segment.speaker_label))
            .collect();
        found.sort();
        assert_eq!(
            found,
            [
                ("laptop".to_string(), "Room".to_string()),
                ("system".to_string(), "System audio".to_string())
            ]
        );
        assert!(rig.store.meeting("m_1").await.unwrap().unwrap().loopback);
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn system_audio_is_not_transcribed_while_the_recording_plays_back() {
        let rig = rig("mute", true).await;
        meeting(&rig.store, "m_1").await;
        rig.session.start("m_1", options(true)).await.unwrap();
        use crate::audio::echo::testing::speechlike;
        rig.mute_system.store(true, Ordering::Relaxed);
        // The room talks while the PC plays the recording back.
        let mut room = speechlike(7, 2_000, 0.1);
        room.extend(vec![0.0f32; 16_000]);
        let mut played = speechlike(1, 2_000, 0.3);
        played.extend(vec![0.0f32; 16_000]);
        rig.source.play_signals(&room, Some(&played)).await;
        rig.session.stop().await.unwrap();

        let sources: Vec<String> = rig
            .store
            .segments("m_1")
            .await
            .unwrap()
            .into_iter()
            .map(|segment| segment.source)
            .collect();
        assert_eq!(sources, ["laptop"]);
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_a_model_the_meeting_is_recorded_and_the_transcript_is_off() {
        let rig = rig("nomodel", false).await;
        meeting(&rig.store, "m_1").await;
        rig.session.start("m_1", options(false)).await.unwrap();
        rig.source.play(2_000, true, false).await;
        rig.source.play(1_000, false, false).await;
        let stopped = rig.session.stop().await.unwrap();

        assert!(!stopped.transcribing);
        assert!(rig.store.segments("m_1").await.unwrap().is_empty());
        let on_disk =
            recorded_samples(&audio_dir(&rig.data_dir, "m_1", SourceKind::Laptop)).unwrap();
        assert_eq!(on_disk, 3_040 * 16);
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_no_microphone_nothing_is_started() {
        let rig = rig("nomic", true).await;
        meeting(&rig.store, "m_1").await;
        rig.source.missing.store(true, Ordering::Relaxed);

        let result = rig.session.start("m_1", options(false)).await;
        assert_eq!(
            result,
            Err(SessionError::Capture(CaptureError::NoMicrophone))
        );
        assert_eq!(rig.session.state().await, RecordingState::idle());
        // The meeting can still be started once a microphone is there.
        assert_eq!(
            rig.store
                .meeting("m_1")
                .await
                .unwrap()
                .unwrap()
                .started_at_ms,
            None
        );
        rig.source.missing.store(false, Ordering::Relaxed);
        rig.session.start("m_1", options(false)).await.unwrap();
        rig.session.stop().await.unwrap();
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_meeting_at_a_time_and_each_meeting_once() {
        let rig = rig("busy", true).await;
        meeting(&rig.store, "m_1").await;
        meeting(&rig.store, "m_2").await;
        assert_eq!(rig.session.pause().await, Err(SessionError::NotRecording));
        assert_eq!(
            rig.session.start("m_none", options(false)).await,
            Err(SessionError::NotFound)
        );

        rig.session.start("m_1", options(false)).await.unwrap();
        assert_eq!(
            rig.session.start("m_2", options(false)).await,
            Err(SessionError::Busy)
        );
        rig.session.stop().await.unwrap();
        assert_eq!(
            rig.session.start("m_1", options(false)).await,
            Err(SessionError::AlreadyRecorded)
        );
        rig.session.start("m_2", options(false)).await.unwrap();
        rig.session.stop().await.unwrap();
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_lost_microphone_is_announced() {
        let rig = rig("lost", true).await;
        meeting(&rig.store, "m_1").await;
        rig.session.start("m_1", options(false)).await.unwrap();
        rig.source
            .send(CaptureMsg::Status {
                source: SourceKind::Laptop,
                ok: false,
            })
            .await;
        rig.session.stop().await.unwrap();
        assert_eq!(
            *rig.events.statuses.lock().unwrap(),
            [CaptureStatus {
                source: "laptop".into(),
                ok: false
            }]
        );
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    fn stats_of(rig: &Rig) -> SessionStats {
        let json =
            std::fs::read_to_string(meeting_dir(&rig.data_dir, "m_1").join("stats.json")).unwrap();
        serde_json::from_str(&json).unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_speakers_heard_by_the_microphone_are_not_transcribed_twice() {
        use crate::audio::echo::testing::speechlike;
        let rig = rig("echo", true).await;
        meeting(&rig.store, "m_1").await;
        rig.session.start("m_1", options(true)).await.unwrap();

        // The PC plays 3 s of speech; the microphone hears it 40 ms later
        // and quieter. Then a second and a half of quiet.
        let mut system = speechlike(1, 3_000, 0.3);
        system.extend(vec![0.0f32; 24_000]);
        let echo: Vec<f32> = (0..system.len())
            .map(|index| {
                if index >= 640 {
                    0.3 * system[index - 640]
                } else {
                    0.0
                }
            })
            .collect();
        rig.source.play_signals(&echo, Some(&system)).await;
        rig.session.stop().await.unwrap();

        let sources: Vec<String> = rig
            .store
            .segments("m_1")
            .await
            .unwrap()
            .into_iter()
            .map(|segment| segment.source)
            .collect();
        assert_eq!(sources, ["system"], "the echo is not a second speaker");
        assert_eq!(stats_of(&rig).echoes_dropped, 1);
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_person_talking_over_the_speakers_is_still_transcribed() {
        use crate::audio::echo::testing::speechlike;
        let rig = rig("talkover", true).await;
        meeting(&rig.store, "m_1").await;
        rig.session.start("m_1", options(true)).await.unwrap();

        let mut system = speechlike(1, 3_000, 0.3);
        system.extend(vec![0.0f32; 24_000]);
        let mut talker = speechlike(7, 3_000, 0.1);
        talker.extend(vec![0.0f32; 24_000]);
        rig.source.play_signals(&talker, Some(&system)).await;
        rig.session.stop().await.unwrap();

        let mut sources: Vec<String> = rig
            .store
            .segments("m_1")
            .await
            .unwrap()
            .into_iter()
            .map(|segment| segment.source)
            .collect();
        sources.sort();
        sources.dedup();
        assert_eq!(sources, ["laptop", "system"]);
        assert_eq!(stats_of(&rig).echoes_dropped, 0);
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    #[test]
    fn stats_are_the_median_the_95th_percentile_and_the_worst() {
        let log = StatsLog {
            latencies_ms: (1..=100).rev().map(|n| n * 10).collect(),
            speech_ms: 60_000,
            decode_ms: 12_000,
        };
        let stats = log.summary();
        assert_eq!(stats.segments, 100);
        assert_eq!(
            (
                stats.latency_median_ms,
                stats.latency_p95_ms,
                stats.latency_max_ms
            ),
            (510, 950, 1_000)
        );
    }
}
