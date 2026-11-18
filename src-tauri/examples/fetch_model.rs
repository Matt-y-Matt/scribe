//! Downloads a speech model with the app's own downloader, outside the app.
//!
//! `cargo run --manifest-path src-tauri/Cargo.toml --example fetch_model -- --data <app data folder> [--model <id>]`
//!
//! Stop it with Ctrl+C and run it again: it carries on from the `.part` file.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use scribe_lib::stt::models::{self, Downloader, DEFAULT_MODEL};
use tokio_util::sync::CancellationToken;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1).cloned())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let data = PathBuf::from(arg("--data").expect("--data <app data folder>"));
    let model = arg("--model").unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let spec = models::spec(&model).expect("a model id from the catalogue");

    if models::is_installed(&data, spec) {
        println!("{} is already installed", spec.title);
        return;
    }
    println!(
        "{}: {:.0} MB from huggingface.co/{}",
        spec.title,
        spec.total_bytes() as f64 / 1e6,
        spec.repo
    );
    let mut last = Instant::now() - Duration::from_secs(10);
    let result = Downloader::default()
        .download(spec, &data, &CancellationToken::new(), |progress| {
            if last.elapsed() >= Duration::from_secs(5) || progress.bytes == progress.total {
                println!(
                    "  {:6.1} / {:.1} MB",
                    progress.bytes as f64 / 1e6,
                    progress.total as f64 / 1e6
                );
                last = Instant::now();
            }
        })
        .await;
    match result {
        Ok(()) => println!("installed in {}", models::model_dir(&data, spec).display()),
        Err(error) => {
            eprintln!("failed: {error}");
            std::process::exit(1);
        }
    }
}
