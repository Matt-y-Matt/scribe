//! Two speech models on the same audio, utterance by utterance.
//!
//! Cuts a stretch of a recorded meeting into utterances exactly as a meeting
//! would (Silero VAD and the cutter), transcribes each one with Parakeet
//! (the catalogue's default) and with Qwen3-ASR, and prints both texts side
//! by side with the time each took. For reading which one heard better; it
//! scores nothing by itself.
//!
//! `compare_stt --chunks <meeting audio folder> [--from 0] [--to 999]
//!  --data <app data folder> --qwen <Qwen3-ASR folder> [--threads 4] [--json]`
//!
//! The chunks are the meeting's own 10-second WAV files (`000117.wav`…);
//! `--from` and `--to` are chunk numbers, both included.

use std::path::{Path, PathBuf};
use std::time::Instant;

use scribe_lib::audio::capture::read_wav;
use scribe_lib::audio::vad::{CutterConfig, Segmenter, SileroDetector};
use scribe_lib::audio::SAMPLE_RATE;
use scribe_lib::stt::models::{self, DEFAULT_MODEL};
use scribe_lib::stt::{LocalSherpa, Transcriber};
use sherpa_onnx::{OfflineQwen3ASRModelConfig, OfflineRecognizer, OfflineRecognizerConfig};

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1).cloned())
}

fn qwen(dir: &Path, threads: i32) -> OfflineRecognizer {
    let file = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.qwen3_asr = OfflineQwen3ASRModelConfig {
        conv_frontend: file("conv_frontend.onnx"),
        encoder: file("encoder.int8.onnx"),
        decoder: file("decoder.int8.onnx"),
        tokenizer: file("tokenizer"),
        // A 30-second utterance is well under this many tokens.
        max_new_tokens: 512,
        ..Default::default()
    };
    config.model_config.tokens = Some(String::new());
    config.model_config.num_threads = threads;
    config.model_config.provider = Some("cpu".to_string());
    config.model_config.debug = false;
    OfflineRecognizer::create(&config).expect("Qwen3-ASR loads")
}

fn transcribe(recognizer: &OfflineRecognizer, samples: &[f32]) -> String {
    let stream = recognizer.create_stream();
    stream.accept_waveform(SAMPLE_RATE as i32, samples);
    recognizer.decode(&stream);
    stream
        .get_result()
        .map(|result| result.text.trim().to_string())
        .unwrap_or_default()
}

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    let chunks = PathBuf::from(arg("--chunks").expect("--chunks <folder>"));
    let from: usize = arg("--from").and_then(|v| v.parse().ok()).unwrap_or(0);
    let to: usize = arg("--to")
        .and_then(|v| v.parse().ok())
        .unwrap_or(usize::MAX);
    let data = PathBuf::from(arg("--data").expect("--data <app data folder>"));
    let qwen_dir = PathBuf::from(arg("--qwen").expect("--qwen <folder>"));
    let threads: i32 = arg("--threads").and_then(|v| v.parse().ok()).unwrap_or(4);
    let json = std::env::args().any(|value| value == "--json");

    let mut samples = Vec::new();
    let mut index = from;
    while index <= to {
        let path = chunks.join(format!("{index:06}.wav"));
        if !path.exists() {
            break;
        }
        samples.extend(read_wav(&path).expect("a meeting chunk"));
        index += 1;
    }
    // Times are printed from the start of the meeting, not of the stretch.
    let offset_ms = from as u64 * 10_000;

    let mut segmenter = Segmenter::new(
        Box::new(SileroDetector::new().expect("the Silero VAD loads")),
        CutterConfig::default(),
    );
    let mut utterances = Vec::new();
    for piece in samples.chunks(512) {
        segmenter.push(piece, &mut utterances);
    }
    segmenter.flush(&mut utterances);

    let spec = models::spec(DEFAULT_MODEL).expect("the default model");
    let parakeet = LocalSherpa::load(spec, &data, threads, "cpu").expect("Parakeet loads");
    let qwen = qwen(&qwen_dir, threads);
    // The first decode of each pays for lazy initialisation.
    if let Some(first) = utterances.first() {
        parakeet.transcribe(&first.samples);
        transcribe(&qwen, &first.samples);
    }

    let (mut speech_s, mut parakeet_s, mut qwen_s) = (0.0f64, 0.0f64, 0.0f64);
    for utterance in &utterances {
        let length_s = (utterance.t1_ms - utterance.t0_ms) as f64 / 1000.0;
        speech_s += length_s;
        let clock = Instant::now();
        let p = parakeet.transcribe(&utterance.samples).text;
        let p_ms = clock.elapsed().as_secs_f64() * 1000.0;
        let clock = Instant::now();
        let q = transcribe(&qwen, &utterance.samples);
        let q_ms = clock.elapsed().as_secs_f64() * 1000.0;
        parakeet_s += p_ms / 1000.0;
        qwen_s += q_ms / 1000.0;
        let t0 = (offset_ms + u64::from(utterance.t0_ms)) as f64 / 1000.0;
        if json {
            println!(
                "{{\"t0\":{t0:.1},\"len\":{length_s:.1},\"parakeet\":{},\"qwen\":{},\"p_ms\":{p_ms:.0},\"q_ms\":{q_ms:.0}}}",
                json_string(&p),
                json_string(&q)
            );
        } else {
            let (m, s) = ((t0 / 60.0) as u64, t0 % 60.0);
            println!("{m:02}:{s:04.1} ({length_s:.1}s)");
            println!("  parakeet  {p}");
            println!("  qwen3     {q}");
        }
    }
    eprintln!(
        "{} utterances, {speech_s:.0} s of speech; parakeet {parakeet_s:.1} s (RTF {:.2}), qwen3 {qwen_s:.1} s (RTF {:.2}), {threads} threads",
        utterances.len(),
        parakeet_s / speech_s,
        qwen_s / speech_s
    );
}
