//! The typed Rust <-> TS boundary.
//!
//! Every command and event the app uses is declared here once. `pnpm ipc`
//! regenerates `src/ipc.ts` from it with tauri-specta, and the
//! `ipc_ts_is_up_to_date` test fails when the two drift apart.
//! The full list this grows into is docs/ARCHITECTURE.md §2.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tauri_specta::{collect_commands, collect_events, Builder, Event};
use tokio_util::sync::CancellationToken;

use crate::session::recovery::{self, Recovered};
use crate::session::{
    AudioLevels, AudioPeaks, CaptureStatus, RecordingState, SessionError, StartOptions,
};
use crate::state::AppState;
use crate::store::{MapPatch, MapRows, MeetingInfo, NewMeeting};
use crate::stt::models::{self, Downloader};

/// `segment:final` — one finished utterance of the meeting transcript.
///
/// Times are milliseconds from the start of the meeting. `source` is
/// `laptop`, `system` or `phone:{participant_id}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SegmentFinal {
    pub id: String,
    pub meeting_id: String,
    pub t0_ms: u32,
    pub t1_ms: u32,
    pub speaker_label: String,
    pub source: String,
    pub text: String,
    pub confidence: f32,
}

/// `model:download` — progress of a speech model download. Sizes are bytes,
/// as `f64` so they cross to TypeScript as numbers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ModelDownload {
    pub model_id: String,
    pub bytes: f64,
    pub total: f64,
    /// True on the last event: installed, cancelled or failed.
    pub done: bool,
    /// Why it stopped, when it did not finish.
    pub error: Option<String>,
}

// The derive would name an event `segment-final`; the architecture names
// events `domain:name`, so the trait is implemented by hand.
macro_rules! event {
    ($type:ty, $name:literal) => {
        impl tauri_specta::Event for $type {
            const NAME: &'static str = $name;
        }
    };
}

event!(SegmentFinal, "segment:final");
event!(RecordingState, "recording:state");
event!(AudioLevels, "audio:levels");
event!(AudioPeaks, "audio:peaks");
event!(CaptureStatus, "capture:status");
event!(ModelDownload, "model:download");

/// Why a command failed, in a form the UI can act on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, thiserror::Error)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum AppError {
    #[error("no microphone was found")]
    NoMicrophone,
    #[error("audio could not be captured: {0}")]
    Capture(String),
    #[error("a meeting is already being recorded")]
    Busy,
    #[error("no meeting is being recorded")]
    NotRecording,
    #[error("not found")]
    NotFound,
    #[error("the meeting has already been recorded")]
    AlreadyRecorded,
    #[error("storage error: {0}")]
    Storage(String),
}

impl From<SessionError> for AppError {
    fn from(error: SessionError) -> Self {
        use crate::audio::capture::CaptureError;
        match error {
            SessionError::Busy => AppError::Busy,
            SessionError::NotRecording => AppError::NotRecording,
            SessionError::NotFound => AppError::NotFound,
            SessionError::AlreadyRecorded => AppError::AlreadyRecorded,
            SessionError::Capture(CaptureError::NoMicrophone) => AppError::NoMicrophone,
            SessionError::Capture(error) => AppError::Capture(error.to_string()),
            SessionError::Storage(detail) => AppError::Storage(detail),
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        AppError::Storage(error.to_string())
    }
}

type CommandResult<T> = Result<T, AppError>;

/// Name and version of the running app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

#[tauri::command]
#[specta::specta]
pub fn app_info(app: tauri::AppHandle) -> AppInfo {
    let package = app.package_info();
    AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
    }
}

// ---- meetings -------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn create_meeting(
    state: State<'_, AppState>,
    meeting: NewMeeting,
) -> CommandResult<MeetingInfo> {
    let id = crate::session::new_id("m");
    Ok(state.store.create_meeting(&id, &meeting).await?)
}

/// Every meeting, newest first.
#[tauri::command]
#[specta::specta]
pub async fn list_meetings(state: State<'_, AppState>) -> CommandResult<Vec<MeetingInfo>> {
    Ok(state.store.meetings().await?)
}

#[tauri::command]
#[specta::specta]
pub async fn get_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
) -> CommandResult<MeetingInfo> {
    state
        .store
        .meeting(&meeting_id)
        .await?
        .ok_or(AppError::NotFound)
}

// ---- recording ------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn start(
    state: State<'_, AppState>,
    meeting_id: String,
    options: StartOptions,
) -> CommandResult<RecordingState> {
    Ok(state.session.start(&meeting_id, options).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn pause(state: State<'_, AppState>) -> CommandResult<RecordingState> {
    Ok(state.session.pause().await?)
}

#[tauri::command]
#[specta::specta]
pub async fn resume(state: State<'_, AppState>) -> CommandResult<RecordingState> {
    Ok(state.session.resume().await?)
}

/// Ends the meeting. Returns once its last words are transcribed and saved.
#[tauri::command]
#[specta::specta]
pub async fn stop(state: State<'_, AppState>) -> CommandResult<RecordingState> {
    Ok(state.session.stop().await?)
}

#[tauri::command]
#[specta::specta]
pub async fn recording_state(state: State<'_, AppState>) -> CommandResult<RecordingState> {
    Ok(state.session.state().await)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Devices {
    pub microphones: Vec<String>,
    /// `None` when the PC has no microphone.
    pub default_microphone: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn list_devices(state: State<'_, AppState>) -> CommandResult<Devices> {
    let source = state.deps.source.clone();
    // Device enumeration talks to the audio service: keep it off the runtime.
    tokio::task::spawn_blocking(move || Devices {
        microphones: source.microphones(),
        default_microphone: source.default_microphone(),
    })
    .await
    .map_err(|error| AppError::Capture(error.to_string()))
}

// ---- speech models ----------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ModelInfo {
    pub id: String,
    pub title: String,
    pub languages: String,
    pub licence: String,
    pub bytes: f64,
    pub installed: bool,
    /// A download of this model is running.
    pub downloading: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn list_models(state: State<'_, AppState>) -> CommandResult<Vec<ModelInfo>> {
    let downloading = state.downloads.lock().await;
    Ok(models::CATALOGUE
        .iter()
        .map(|spec| ModelInfo {
            id: spec.id.to_string(),
            title: spec.title.to_string(),
            languages: spec.languages.to_string(),
            licence: spec.licence.to_string(),
            bytes: spec.total_bytes() as f64,
            installed: models::is_installed(&state.data_dir, spec),
            downloading: downloading.contains_key(spec.id),
        })
        .collect())
}

/// Starts downloading a model and returns at once; `model:download` events
/// carry the progress and the outcome.
#[tauri::command]
#[specta::specta]
pub async fn download_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    model_id: String,
) -> CommandResult<()> {
    let spec = models::spec(&model_id).ok_or(AppError::NotFound)?;
    let cancel = CancellationToken::new();
    {
        let mut downloads = state.downloads.lock().await;
        if downloads.contains_key(spec.id) {
            return Ok(());
        }
        downloads.insert(spec.id.to_string(), cancel.clone());
    }
    let data_dir = state.data_dir.clone();
    let downloads = state.downloads.clone();
    tauri::async_runtime::spawn(async move {
        let mut last = Instant::now() - Duration::from_secs(1);
        let progress_app = app.clone();
        let result = Downloader::default()
            .download(spec, &data_dir, &cancel, |progress| {
                // At most five events a second.
                if last.elapsed() >= Duration::from_millis(200) {
                    last = Instant::now();
                    let _ = ModelDownload {
                        model_id: spec.id.to_string(),
                        bytes: progress.bytes as f64,
                        total: progress.total as f64,
                        done: false,
                        error: None,
                    }
                    .emit(&progress_app);
                }
            })
            .await;
        downloads.lock().await.remove(spec.id);
        if let Err(error) = &result {
            log::warn!("model download stopped: {error}");
        }
        let total = spec.total_bytes() as f64;
        let _ = ModelDownload {
            model_id: spec.id.to_string(),
            bytes: if result.is_ok() { total } else { 0.0 },
            total,
            done: true,
            error: result.err().map(|error| error.to_string()),
        }
        .emit(&app);
    });
    Ok(())
}

/// Stops a download. What has arrived is kept, and the next download of the
/// same model carries on from there.
#[tauri::command]
#[specta::specta]
pub async fn cancel_download(state: State<'_, AppState>, model_id: String) -> CommandResult<()> {
    if let Some(cancel) = state.downloads.lock().await.get(&model_id) {
        cancel.cancel();
    }
    Ok(())
}

// ---- transcript -------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn get_segments(
    state: State<'_, AppState>,
    meeting_id: String,
) -> CommandResult<Vec<SegmentFinal>> {
    Ok(state.store.segments(&meeting_id).await?)
}

/// Full-text search of the transcript: one meeting, or every meeting when
/// `meeting_id` is null.
#[tauri::command]
#[specta::specta]
pub async fn search_segments(
    state: State<'_, AppState>,
    meeting_id: Option<String>,
    query: String,
) -> CommandResult<Vec<SegmentFinal>> {
    Ok(state
        .store
        .search_segments(meeting_id.as_deref(), &query, 200)
        .await?)
}

// ---- the map ----------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn map_load(state: State<'_, AppState>, meeting_id: String) -> CommandResult<MapRows> {
    Ok(state.store.map_load(&meeting_id).await?)
}

/// Saves one commit of the map engine, in one transaction.
#[tauri::command]
#[specta::specta]
pub async fn map_save(state: State<'_, AppState>, patch: MapPatch) -> CommandResult<()> {
    Ok(state.store.map_save(&patch).await?)
}

// ---- recovery ---------------------------------------------------------------

/// Meetings that were being recorded when the app last died.
#[tauri::command]
#[specta::specta]
pub async fn unfinished_meetings(state: State<'_, AppState>) -> CommandResult<Vec<MeetingInfo>> {
    let recording = state.session.state().await.meeting_id;
    Ok(state
        .store
        .meetings()
        .await?
        .into_iter()
        .filter(|meeting| meeting.is_unfinished() && Some(&meeting.id) != recording.as_ref())
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn recover_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
    model_id: String,
) -> CommandResult<Recovered> {
    if state.session.is_active(&meeting_id).await {
        return Err(AppError::Busy);
    }
    Ok(recovery::recover(&state.deps, &meeting_id, &model_id).await?)
}

/// All commands and events, collected once for both the invoke handler and
/// the TypeScript export.
pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            app_info,
            create_meeting,
            list_meetings,
            get_meeting,
            start,
            pause,
            resume,
            stop,
            recording_state,
            list_devices,
            list_models,
            download_model,
            cancel_download,
            get_segments,
            search_segments,
            map_load,
            map_save,
            unfinished_meetings,
            recover_meeting,
        ])
        .events(collect_events![
            SegmentFinal,
            RecordingState,
            AudioLevels,
            AudioPeaks,
            CaptureStatus,
            ModelDownload,
        ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where the generated bindings live, relative to this crate.
    const IPC_TS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/ipc.ts");

    const IPC_TS_HEADER: &str =
        "// @ts-nocheck\n// Generated by tauri-specta from src-tauri/src/ipc.rs. Do not edit: run `pnpm ipc`.\n\n";

    fn ipc_ts() -> String {
        builder()
            .export_str(specta_typescript::Typescript::default().header(IPC_TS_HEADER))
            .expect("the ipc types must be exportable to TypeScript")
    }

    /// Regenerates `src/ipc.ts`. Ignored so a normal test run never writes
    /// into the source tree; run it with `pnpm ipc`.
    #[test]
    #[ignore]
    fn export_ipc() {
        std::fs::write(IPC_TS, ipc_ts()).expect("src/ipc.ts must be writable");
    }

    #[test]
    fn ipc_ts_is_up_to_date() {
        let on_disk = std::fs::read_to_string(IPC_TS).expect("src/ipc.ts must exist");
        assert_eq!(
            on_disk.replace("\r\n", "\n"),
            ipc_ts().replace("\r\n", "\n"),
            "src/ipc.ts is stale: run `pnpm ipc` and commit the result"
        );
    }

    #[test]
    fn events_use_the_architecture_names() {
        assert_eq!(<SegmentFinal as tauri_specta::Event>::NAME, "segment:final");
        assert_eq!(
            <RecordingState as tauri_specta::Event>::NAME,
            "recording:state"
        );
        assert_eq!(<AudioLevels as tauri_specta::Event>::NAME, "audio:levels");
        assert_eq!(
            <ModelDownload as tauri_specta::Event>::NAME,
            "model:download"
        );
    }

    #[test]
    fn segment_final_serializes_with_the_architecture_field_names() {
        let segment = SegmentFinal {
            id: "s001".into(),
            meeting_id: "m_1".into(),
            t0_ms: 0,
            t1_ms: 7800,
            speaker_label: "Matt".into(),
            source: "laptop".into(),
            text: "Okay let's start.".into(),
            confidence: 1.0,
        };
        let json = serde_json::to_value(&segment).expect("serializable");
        let mut keys: Vec<&str> = json
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "confidence",
                "id",
                "meeting_id",
                "source",
                "speaker_label",
                "t0_ms",
                "t1_ms",
                "text"
            ]
        );
    }

    #[test]
    fn a_missing_microphone_reaches_the_ui_as_its_own_error() {
        use crate::audio::capture::CaptureError;
        let error: AppError = SessionError::Capture(CaptureError::NoMicrophone).into();
        assert_eq!(error, AppError::NoMicrophone);
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            r#"{"kind":"no_microphone"}"#
        );
        let error: AppError = SessionError::Storage("disk full".into()).into();
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            r#"{"kind":"storage","detail":"disk full"}"#
        );
    }
}
