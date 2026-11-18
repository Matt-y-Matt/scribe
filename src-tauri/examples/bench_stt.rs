//! Speech-to-text bench (BUILD_PLAN M2 task 7, TEST_PLAN §1).
//!
//! Cuts a WAV into utterances exactly as a meeting would (Silero VAD and the
//! cutter), transcribes each one, and prints how long that took against how
//! long the speech was. Run it through `scripts/bench_stt.ps1`, which also
//! reports peak memory.
//!
//! `bench_stt --wav <file> --data <app data folder> [--model <id>] [--threads 2,4,6] [--provider cpu] [--text]`

use std::path::PathBuf;
use std::time::Instant;

use scribe_lib::audio::capture::read_wav;
use scribe_lib::audio::vad::{CutterConfig, Segmenter, SileroDetector};
use scribe_lib::audio::SAMPLE_RATE;
use scribe_lib::stt::models::{self, DEFAULT_MODEL};
use scribe_lib::stt::{LocalSherpa, Transcriber};

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1).cloned())
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() - 1) as f64 * fraction).round() as usize]
}

fn main() {
    let wav = PathBuf::from(arg("--wav").expect("--wav <file>"));
    let data = PathBuf::from(arg("--data").expect("--data <app data folder>"));
    let model = arg("--model").unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let provider = arg("--provider").unwrap_or_else(|| "cpu".to_string());
    let threads: Vec<i32> = arg("--threads")
        .unwrap_or_else(|| "2,4,6".to_string())
        .split(',')
        .filter_map(|value| value.trim().parse().ok())
        .collect();
    let show_text = std::env::args().any(|value| value == "--text");

    let spec = models::spec(&model).expect("a model id from the catalogue");
    let samples = read_wav(&wav).expect("a 16 kHz mono 16-bit WAV");
    let audio_s = samples.len() as f64 / SAMPLE_RATE as f64;

    let started = Instant::now();
    let mut segmenter = Segmenter::new(
        Box::new(SileroDetector::new().expect("the Silero VAD loads")),
        CutterConfig::default(),
    );
    let mut utterances = Vec::new();
    for piece in samples.chunks(512) {
        segmenter.push(piece, &mut utterances);
    }
    segmenter.flush(&mut utterances);
    let vad_s = started.elapsed().as_secs_f64();
    let speech_s: f64 = utterances
        .iter()
        .map(|utterance| (utterance.t1_ms - utterance.t0_ms) as f64 / 1000.0)
        .sum();
    let longest_s = utterances
        .iter()
        .map(|utterance| (utterance.t1_ms - utterance.t0_ms) as f64 / 1000.0)
        .fold(0.0, f64::max);

    println!("model      {} ({})", spec.title, spec.id);
    println!("audio      {audio_s:.1} s, {speech_s:.1} s of speech in {} utterances, longest {longest_s:.1} s", utterances.len());
    println!(
        "vad        {vad_s:.2} s for the whole file (RTF {:.4})",
        vad_s / audio_s
    );
    println!();
    println!("threads  load s   decode s   RTF     median ms   p95 ms   max ms");

    for &count in &threads {
        let load = Instant::now();
        let recognizer = match LocalSherpa::load(spec, &data, count, &provider) {
            Ok(recognizer) => recognizer,
            Err(error) => {
                println!("{count:>7}  {error}");
                continue;
            }
        };
        let load_s = load.elapsed().as_secs_f64();
        // The first decode pays for lazy initialisation; keep it out of the numbers.
        if let Some(first) = utterances.first() {
            recognizer.transcribe(&first.samples);
        }

        let mut times_ms = Vec::with_capacity(utterances.len());
        let mut texts = Vec::new();
        let decode = Instant::now();
        for utterance in &utterances {
            let one = Instant::now();
            let transcript = recognizer.transcribe(&utterance.samples);
            times_ms.push(one.elapsed().as_secs_f64() * 1000.0);
            texts.push((utterance.t0_ms, transcript.text));
        }
        let decode_s = decode.elapsed().as_secs_f64();
        times_ms.sort_by(f64::total_cmp);
        println!(
            "{count:>7}  {load_s:>6.2}   {decode_s:>8.2}   {:.4}  {:>9.0}   {:>6.0}   {:>6.0}",
            decode_s / speech_s,
            percentile(&times_ms, 0.5),
            percentile(&times_ms, 0.95),
            percentile(&times_ms, 1.0),
        );
        if show_text && count == *threads.last().unwrap_or(&count) {
            println!();
            for (t0_ms, text) in texts {
                println!("{:7.1}s  {text}", t0_ms as f64 / 1000.0);
            }
        }
    }
}
