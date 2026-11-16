//! Scribe's Rust core. Modules arrive with their milestone
//! (docs/BUILD_PLAN.md): `audio`, `stt`, `session`, `store` in M2, `scribe`
//! in M3, `phones` in M4, `dispatch` in M5.

mod ipc;

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
            log::info!("Scribe {} starting", app.package_info().version);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Scribe");
}
