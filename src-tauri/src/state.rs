//! What the running app holds: the data folder, the store, the session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tauri_specta::Event;
use tokio_util::sync::CancellationToken;

use crate::audio::capture::{DeviceSource, FileSource, Source};
use crate::audio::playback::Playback;
use crate::audio::vad::{EnergyDetector, SileroDetector, SpeechDetector};
use crate::ipc::SegmentFinal;
use crate::session::{
    AudioLevels, AudioPeaks, CaptureStatus, Events, RecordingState, Session, SessionDeps,
};
use crate::store::Store;
use crate::stt::{default_threads, models, LocalSherpa, SttError, Transcriber};

pub struct AppState {
    /// `%LOCALAPPDATA%\co.custore.scribe`: the database, the recordings and
    /// the speech models.
    pub data_dir: PathBuf,
    pub store: Store,
    pub session: Session,
    pub deps: SessionDeps,
    /// Running model downloads, by model id.
    pub downloads: Arc<tokio::sync::Mutex<HashMap<String, CancellationToken>>>,
    pub playback: Playback,
    /// For the one local HTTP call the core makes: Ollama on this PC.
    pub http: reqwest::Client,
}

/// Sends the session's news to the webview as typed Tauri events.
struct TauriEvents(tauri::AppHandle);

impl Events for TauriEvents {
    fn recording_state(&self, state: RecordingState) {
        let _ = state.emit(&self.0);
    }
    fn levels(&self, levels: AudioLevels) {
        let _ = levels.emit(&self.0);
    }
    fn segment(&self, segment: SegmentFinal) {
        let _ = segment.emit(&self.0);
    }
    fn peaks(&self, peaks: AudioPeaks) {
        let _ = peaks.emit(&self.0);
    }
    fn capture_status(&self, status: CaptureStatus) {
        let _ = status.emit(&self.0);
    }
}

/// The microphone and loopback of this PC. A debug build started with
/// `SCRIBE_TEST_AUDIO=<wav>` plays that file as the microphone instead, in a
/// loop (and `SCRIBE_TEST_AUDIO_SYSTEM=<wav>` as system audio), so capture,
/// transcription and recovery can be exercised without a room.
fn audio_source() -> Arc<dyn Source> {
    if cfg!(debug_assertions) {
        if let Some(laptop) = std::env::var_os("SCRIBE_TEST_AUDIO") {
            log::warn!("test audio is standing in for the microphone");
            return Arc::new(FileSource {
                laptop: laptop.into(),
                system: std::env::var_os("SCRIBE_TEST_AUDIO_SYSTEM").map(Into::into),
                speed: 1.0,
                repeat: true,
            });
        }
    }
    Arc::new(DeviceSource)
}

fn detector() -> Box<dyn SpeechDetector> {
    match SileroDetector::new() {
        Ok(detector) => Box::new(detector),
        Err(error) => {
            log::error!("the voice activity model did not load, using loudness instead: {error}");
            Box::new(EnergyDetector { floor_rms: 0.01 })
        }
    }
}

/// The speech model last used, kept loaded: reading 650 MB from disk takes
/// seconds, and the second meeting of the day should not wait for it.
type LoadedModel = Mutex<Option<(String, Arc<dyn Transcriber>)>>;

fn load_model(
    loaded: &LoadedModel,
    data_dir: &Path,
    model_id: &str,
) -> Result<Arc<dyn Transcriber>, SttError> {
    let mut loaded = loaded
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((id, model)) = loaded.as_ref() {
        if id == model_id {
            return Ok(model.clone());
        }
    }
    let spec = models::spec(model_id).ok_or(SttError::NotInstalled)?;
    let model: Arc<dyn Transcriber> =
        Arc::new(LocalSherpa::load(spec, data_dir, default_threads(), "cpu")?);
    *loaded = Some((model_id.to_string(), model.clone()));
    Ok(model)
}

impl AppState {
    pub async fn open(app: &tauri::AppHandle, data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        let store = Store::open(&data_dir.join("scribe.db"))
            .await
            .map_err(|error| error.to_string())?;
        let models_dir = data_dir.clone();
        let loaded = LoadedModel::default();
        // True while the recording is being played back: the session then
        // keeps system audio out of the transcript.
        let playing = Arc::new(AtomicBool::new(false));
        let playback = {
            let app = app.clone();
            Playback::spawn(
                move |state| {
                    let _ = state.emit(&app);
                },
                playing.clone(),
            )
        };
        let deps = SessionDeps {
            data_dir: data_dir.clone(),
            store: store.clone(),
            source: audio_source(),
            events: Arc::new(TauriEvents(app.clone())),
            detector: Arc::new(detector),
            transcriber: Arc::new(move |model_id| load_model(&loaded, &models_dir, model_id)),
            mute_system: playing,
        };
        Ok(Self {
            data_dir,
            store,
            session: Session::new(deps.clone()),
            deps,
            downloads: Arc::default(),
            playback,
            http: reqwest::Client::new(),
        })
    }
}
