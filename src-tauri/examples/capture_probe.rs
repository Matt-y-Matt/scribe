//! Opens the microphone and the system-audio loopback and prints levels twice
//! a second and every utterance the cutter finds: the whole chain of M2 step 1
//! (capture, resample, echo cancellation, VAD, utterances) with nothing else.
//!
//! `cargo run --manifest-path src-tauri/Cargo.toml --example capture_probe -- [seconds] [--no-loopback]`
//!
//! It also asks sherpa-onnx for its version: the vendored crates run their
//! models on ONNX Runtime through `ort`, sherpa-onnx carries its own copy,
//! and this proves both link into one program.

use std::time::{Duration, Instant};

use scribe_lib::audio::capture::{CaptureMsg, CaptureOptions, DeviceSource, Source};
use scribe_lib::audio::vad::{CutterConfig, Segmenter, SileroDetector, Utterance};
use scribe_lib::audio::{rms, SourceKind};

fn dbfs(value: f32) -> f32 {
    20.0 * value.max(1e-6).log10()
}

fn segmenter() -> Segmenter {
    let detector = SileroDetector::new().expect("the Silero VAD loads");
    Segmenter::new(Box::new(detector), CutterConfig::default())
}

fn report(source: SourceKind, utterances: &mut Vec<Utterance>) {
    for utterance in utterances.drain(..) {
        println!(
            "  utterance  {:<6}  {:6.2}s – {:6.2}s",
            source.id(),
            utterance.t0_ms as f32 / 1000.0,
            utterance.t1_ms as f32 / 1000.0
        );
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let seconds: u64 = args.iter().find_map(|arg| arg.parse().ok()).unwrap_or(10);
    let loopback = !args.iter().any(|arg| arg == "--no-loopback");

    println!("sherpa-onnx {}", sherpa_onnx::version());
    let source = DeviceSource;
    println!("default microphone: {:?}", source.default_microphone());
    for name in source.microphones() {
        println!("  microphone: {name}");
    }

    let mut capture = source
        .open(&CaptureOptions {
            microphone: None,
            loopback,
        })
        .expect("capture opens");

    let (mut laptop, mut system) = (segmenter(), segmenter());
    let mut found = Vec::new();
    let started = Instant::now();
    let mut last_print = Instant::now();
    let mut frames = 0u32;
    let (mut laptop_peak, mut system_peak) = (0f32, 0f32);

    while started.elapsed() < Duration::from_secs(seconds) {
        let message = tokio::time::timeout(Duration::from_secs(2), capture.frames.recv()).await;
        match message {
            Ok(Some(CaptureMsg::Frame(frame))) => {
                frames += 1;
                laptop_peak = laptop_peak.max(rms(&frame.laptop));
                laptop.push(&frame.laptop, &mut found);
                report(SourceKind::Laptop, &mut found);
                if let Some(samples) = &frame.system {
                    system_peak = system_peak.max(rms(samples));
                    system.push(samples, &mut found);
                    report(SourceKind::System, &mut found);
                }
            }
            Ok(Some(CaptureMsg::Status { source, ok })) => {
                println!("{} {}", source.id(), if ok { "ready" } else { "lost" });
            }
            Ok(Some(CaptureMsg::Ended)) | Ok(None) => break,
            Err(_) => println!("no audio for 2 s"),
        }
        if last_print.elapsed() >= Duration::from_millis(500) {
            println!(
                "{:5.1}s  frames {frames:4}  laptop {:6.1} dBFS  system {:6.1} dBFS",
                started.elapsed().as_secs_f32(),
                dbfs(laptop_peak),
                dbfs(system_peak),
            );
            (laptop_peak, system_peak) = (0.0, 0.0);
            last_print = Instant::now();
        }
    }
    laptop.flush(&mut found);
    report(SourceKind::Laptop, &mut found);
    system.flush(&mut found);
    report(SourceKind::System, &mut found);
}
