//! Scribe's Rust core (docs/ARCHITECTURE.md §2). `audio`, `stt`, `session`
//! and `store` arrived in M2; `scribe` comes in M3, `phones` in M4,
//! `dispatch` in M5.

pub mod audio;
pub mod ipc;
pub mod session;
mod state;
pub mod store;
pub mod stt;

use tauri::Manager;

/// Builds the log plugin. Rule: nothing at info level or above may contain
/// transcript text, audio paths or API keys (CLAUDE.md, rules that never bend).
fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_log::{Target, TargetKind};

    tauri_plugin_log::Builder::new()
        .level(if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        })
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir { file_name: None }),
        ])
        .build()
}

/// Application entry point.
pub fn run() {
    let ipc = ipc::builder();

    tauri::Builder::default()
        // Must be registered first: a second launch focuses the running window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(log_plugin())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(ipc.invoke_handler())
        .setup(move |app| {
            ipc.mount_events(app);
            // Recordings and models are large and belong to this PC, so they
            // live under %LOCALAPPDATA%, not in the roaming profile.
            let data_dir = app.path().app_local_data_dir()?;
            let state =
                tauri::async_runtime::block_on(state::AppState::open(app.handle(), data_dir))
                    .map_err(Box::<dyn std::error::Error>::from)?;
            app.manage(state);
            log::info!("Scribe {} starting", app.package_info().version);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Scribe");
}
