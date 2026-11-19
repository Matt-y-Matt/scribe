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

use crate::audio::playback::PlaybackState;
use crate::audio::SourceKind;
use crate::session::cleanup::{self, Cleaned};
use crate::session::recovery::{self, Recovered};
use crate::session::{
    audio_dir, peaks_path, AudioLevels, AudioPeaks, CaptureStatus, RecState, RecordingState,
    SessionError, StartOptions,
};
use crate::state::AppState;
use crate::store::{Highlight, MapPatch, MapRows, MeetingInfo, NewMeeting, OpenAction, Summary};
use crate::stt::models::{self, Downloader};
use crate::stt::{default_threads, LocalSherpa, Transcriber};
use std::sync::Arc;

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

/// `transcript:cleanup` — progress of the clean-up pass over a finished
/// meeting's transcript: lines heard again so far, of how many.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TranscriptCleanup {
    pub meeting_id: String,
    pub done: u32,
    pub total: u32,
}

event!(SegmentFinal, "segment:final");
event!(TranscriptCleanup, "transcript:cleanup");
event!(RecordingState, "recording:state");
event!(AudioLevels, "audio:levels");
event!(AudioPeaks, "audio:peaks");
event!(CaptureStatus, "capture:status");
event!(ModelDownload, "model:download");
event!(PlaybackState, "playback:state");

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
    #[error("the local AI did not answer: {0}")]
    LocalAi(String),
    #[error("the speech model is not installed")]
    ModelMissing,
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

/// Gives a meeting a new title.
#[tauri::command]
#[specta::specta]
pub async fn rename_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
    title: String,
) -> CommandResult<MeetingInfo> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Storage("a meeting needs a title".into()));
    }
    state
        .store
        .rename_meeting(&meeting_id, title)
        .await?
        .ok_or(AppError::NotFound)
}

/// Deletes a meeting for good: its recording first, then everything the
/// database holds about it. A meeting being recorded, or having its
/// transcript cleaned up, is refused (`busy`).
#[tauri::command]
#[specta::specta]
pub async fn delete_meeting(state: State<'_, AppState>, meeting_id: String) -> CommandResult<()> {
    if state.session.is_active(&meeting_id).await
        || state.cleaning.lock().await.as_deref() == Some(meeting_id.as_str())
    {
        return Err(AppError::Busy);
    }
    state
        .store
        .meeting(&meeting_id)
        .await?
        .ok_or(AppError::NotFound)?;
    // Its files may be open for playing.
    state.playback.stop();
    // The audio goes first: if anything is left behind by a failure, it is
    // a meeting in the list with no sound, not sound with no meeting.
    crate::session::remove_meeting_files(&state.data_dir, &meeting_id)
        .map_err(|error| AppError::Storage(error.to_string()))?;
    state.store.delete_meeting(&meeting_id).await?;
    Ok(())
}

/// The meeting's written summary; empty until the end screen writes one.
#[tauri::command]
#[specta::specta]
pub async fn get_summary(state: State<'_, AppState>, meeting_id: String) -> CommandResult<Summary> {
    Ok(state.store.summary(&meeting_id).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn save_summary(
    state: State<'_, AppState>,
    meeting_id: String,
    summary: Summary,
) -> CommandResult<()> {
    Ok(state.store.save_summary(&meeting_id, &summary).await?)
}

/// A name Windows accepts for a file, from a title a person typed: the
/// characters a path may not hold become spaces, and an empty result becomes
/// "Summary". Nothing here can name a folder.
pub(crate) fn safe_file_name(wanted: &str) -> String {
    let cleaned: String = wanted
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    // A word of dots alone is a way up a folder; it is dropped.
    let words: Vec<&str> = cleaned
        .split_whitespace()
        .filter(|word| !word.chars().all(|c| c == '.'))
        .collect();
    let name = words.join(" ");
    // Windows drops a trailing dot or space, so they are not offered.
    let name = name.trim_end_matches(['.', ' ']);
    let (stem, extension) = match name.rfind('.') {
        Some(at) if name.len() - at <= 10 => name.split_at(at),
        _ => (name, ""),
    };
    let stem: String = stem.chars().take(120).collect();
    let stem = stem.trim_end();
    if stem.is_empty() {
        return format!("Summary{extension}");
    }
    format!("{stem}{extension}")
}

/// Asks where to save a text file and writes it there. The place is chosen
/// by the person in Windows' own Save dialog, never by the page. Returns the
/// path written, or nothing when the dialog was closed.
#[tauri::command]
#[specta::specta]
pub async fn save_text_as(
    app: tauri::AppHandle,
    file_name: String,
    text: String,
) -> CommandResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    let name = safe_file_name(&file_name);
    let mut dialog = app.dialog().file().set_file_name(&name);
    if let Some(extension) = std::path::Path::new(&name)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        let kind = if extension.eq_ignore_ascii_case("md") {
            "Markdown"
        } else {
            "Text"
        };
        dialog = dialog.add_filter(kind, &[extension]);
    }
    // Blocking is right here: a command runs off the main thread, and the
    // dialog is the only thing the person can do until it closes.
    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| AppError::Storage(error.to_string()))?;
    tokio::fs::write(&path, text)
        .await
        .map_err(|error| AppError::Storage(error.to_string()))?;
    Ok(Some(path.display().to_string()))
}

/// Every action not yet marked done, across meetings, oldest first.
#[tauri::command]
#[specta::specta]
pub async fn open_actions(state: State<'_, AppState>) -> CommandResult<Vec<OpenAction>> {
    Ok(state.store.open_actions().await?)
}

/// Marks an action done, or open again, without its meeting being open.
#[tauri::command]
#[specta::specta]
pub async fn set_card_done(
    state: State<'_, AppState>,
    card_id: String,
    done: bool,
) -> CommandResult<()> {
    Ok(state.store.set_card_done(&card_id, done).await?)
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
    /// Fast enough for a live meeting; otherwise it cleans up after Stop.
    pub live: bool,
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
            live: spec.live,
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

/// Hears a finished meeting's transcript again with the clean-up model and
/// saves the lines it heard better (session/cleanup.rs). Takes minutes:
/// `transcript:cleanup` events carry the progress. Refused while a meeting
/// is being recorded, which needs the processor more, and while another
/// clean-up is running.
#[tauri::command]
#[specta::specta]
pub async fn clean_transcript(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
) -> CommandResult<Cleaned> {
    let recording = state.session.state().await;
    if matches!(recording.state, RecState::Recording | RecState::Paused) {
        return Err(AppError::Busy);
    }
    let meeting = state
        .store
        .meeting(&meeting_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if meeting.is_unfinished() {
        return Err(AppError::Busy);
    }
    // Loaded on its own, not through the session's one-model cache: that
    // would put Parakeet out, and the next Start would wait to load it again.
    // Dropped when the pass is done.
    let spec = models::spec(models::CLEANUP_MODEL).ok_or(AppError::ModelMissing)?;
    let data_dir = state.data_dir.clone();
    let transcriber: Arc<dyn Transcriber> = Arc::new(
        tokio::task::spawn_blocking(move || {
            LocalSherpa::load(spec, &data_dir, default_threads(), "cpu")
        })
        .await
        .map_err(|error| AppError::Storage(error.to_string()))?
        .map_err(|_| AppError::ModelMissing)?,
    );
    {
        let mut running = state.cleaning.lock().await;
        if running.is_some() {
            return Err(AppError::Busy);
        }
        *running = Some(meeting_id.clone());
    }
    let last = std::sync::Mutex::new(Instant::now() - Duration::from_secs(1));
    let id = meeting_id.clone();
    let progress_app = app.clone();
    let result = cleanup::clean(
        &state.store,
        &state.data_dir,
        &meeting_id,
        transcriber,
        move |done, total| {
            let mut last = last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            // At most two events a second, and always the last one.
            if done == total || last.elapsed() >= Duration::from_millis(500) {
                *last = Instant::now();
                let _ = TranscriptCleanup {
                    meeting_id: id.clone(),
                    done,
                    total,
                }
                .emit(&progress_app);
            }
        },
    )
    .await;
    *state.cleaning.lock().await = None;
    result.map_err(AppError::Storage)
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

// ---- timeline ---------------------------------------------------------------

/// The waveform of a meeting so far: 20 peaks per second, each 0–255.
#[tauri::command]
#[specta::specta]
pub async fn get_peaks(state: State<'_, AppState>, meeting_id: String) -> CommandResult<Vec<u8>> {
    let path = peaks_path(&state.data_dir, &meeting_id);
    match tokio::fs::read(path).await {
        Ok(peaks) => Ok(peaks),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(AppError::Storage(error.to_string())),
    }
}

fn recording_dirs(state: &AppState, meeting_id: &str) -> Vec<std::path::PathBuf> {
    SourceKind::ALL
        .into_iter()
        .map(|source| audio_dir(&state.data_dir, meeting_id, source))
        .collect()
}

/// Plays the recording from a point to its end.
#[tauri::command]
#[specta::specta]
pub async fn seek_play(
    state: State<'_, AppState>,
    meeting_id: String,
    t_ms: u32,
) -> CommandResult<()> {
    state
        .playback
        .play(&meeting_id, recording_dirs(&state, &meeting_id), t_ms, None);
    Ok(())
}

/// Plays one span of the recording: a segment, a card, a highlight.
#[tauri::command]
#[specta::specta]
pub async fn play_span(
    state: State<'_, AppState>,
    meeting_id: String,
    t0_ms: u32,
    t1_ms: u32,
) -> CommandResult<()> {
    state.playback.play(
        &meeting_id,
        recording_dirs(&state, &meeting_id),
        t0_ms,
        Some(t1_ms.max(t0_ms)),
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn stop_playback(state: State<'_, AppState>) -> CommandResult<()> {
    state.playback.stop();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn list_highlights(
    state: State<'_, AppState>,
    meeting_id: String,
) -> CommandResult<Vec<Highlight>> {
    Ok(state.store.highlights(&meeting_id).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn save_highlight(state: State<'_, AppState>, highlight: Highlight) -> CommandResult<()> {
    Ok(state.store.save_highlight(&highlight).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_highlight(
    state: State<'_, AppState>,
    highlight_id: String,
) -> CommandResult<()> {
    Ok(state.store.delete_highlight(&highlight_id).await?)
}

// ---- local AI ---------------------------------------------------------------

/// Ollama on this PC. The address is fixed here, so the webview cannot use
/// this command to reach any other host.
const OLLAMA_CHAT_URL: &str = "http://127.0.0.1:11434/api/chat";

/// Sends one chat request to the Ollama running on this PC and returns its
/// reply, both as Ollama's own JSON. The structurer calls this instead of
/// fetching from the webview: the webview keeps a content security policy
/// with no network access, and Ollama refuses the installed app's origin.
#[tauri::command]
#[specta::specta]
pub async fn ollama_chat(state: State<'_, AppState>, body: String) -> CommandResult<String> {
    let response = state
        .http
        .post(OLLAMA_CHAT_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .timeout(Duration::from_secs(180))
        .body(body)
        .send()
        .await
        .map_err(|error| AppError::LocalAi(error.without_url().to_string()))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| AppError::LocalAi(error.without_url().to_string()))?;
    if !status.is_success() {
        // Ollama's own error line (model missing, out of memory); never ours.
        let detail: String = text.chars().take(200).collect();
        return Err(AppError::LocalAi(format!(
            "Ollama answered {status}: {detail}"
        )));
    }
    Ok(text)
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
            rename_meeting,
            delete_meeting,
            get_summary,
            save_summary,
            save_text_as,
            open_actions,
            set_card_done,
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
            clean_transcript,
            map_load,
            map_save,
            get_peaks,
            seek_play,
            play_span,
            stop_playback,
            list_highlights,
            save_highlight,
            delete_highlight,
            ollama_chat,
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
            PlaybackState,
            TranscriptCleanup,
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
    fn a_title_becomes_a_file_name_windows_accepts() {
        assert_eq!(
            safe_file_name("Custore weekly 2026-11-19.md"),
            "Custore weekly 2026-11-19.md"
        );
        assert_eq!(
            safe_file_name("Q4: prices / stock? \"final\".md"),
            "Q4 prices stock final.md"
        );
        // No folder can be named, here or above.
        assert_eq!(safe_file_name("..\\..\\Windows\\x.md"), "Windows x.md");
        assert_eq!(safe_file_name("   "), "Summary");
        assert_eq!(safe_file_name(".md"), "Summary.md");
        assert_eq!(safe_file_name(&"a".repeat(300)).chars().count(), 120);
        // A long title keeps its extension.
        let long = safe_file_name(&format!("{}.md", "a".repeat(300)));
        assert_eq!(long.chars().count(), 123);
        assert!(long.ends_with(".md"));
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
