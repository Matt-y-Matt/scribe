//! Audio: capture, utterance cutting, levels, and the recording on disk.
//!
//! Everything downstream of capture works on 16 kHz mono `f32`, in windows of
//! [`WINDOW`] samples (32 ms, one Silero VAD step). The meeting clock is the
//! number of samples processed, so a segment's times and the audio files
//! always agree.

pub mod capture;
pub mod echo;
pub mod levels;
pub mod peaks;
pub mod playback;
pub mod vad;
pub mod writer;

pub const SAMPLE_RATE: u32 = 16_000;
/// Samples per processing window: 32 ms.
pub const WINDOW: usize = 512;

/// Where a stretch of audio came from (ARCHITECTURE §2, `segment:final`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceKind {
    /// The laptop microphone, after echo cancellation.
    Laptop,
    /// System audio, captured by WASAPI loopback.
    System,
}

impl SourceKind {
    pub const ALL: [SourceKind; 2] = [SourceKind::Laptop, SourceKind::System];

    /// The `source` value of a segment, and the audio folder's name.
    pub const fn id(self) -> &'static str {
        match self {
            SourceKind::Laptop => "laptop",
            SourceKind::System => "system",
        }
    }

    /// What the transcript calls the speaker until speakers have names
    /// (DECISIONS 2026-11-19).
    pub const fn label(self) -> &'static str {
        match self {
            SourceKind::Laptop => "Room",
            SourceKind::System => "System audio",
        }
    }
}

/// Milliseconds of audio in `samples` at 16 kHz.
pub const fn ms_of_samples(samples: u64) -> u32 {
    (samples * 1000 / SAMPLE_RATE as u64) as u32
}

pub const fn samples_of_ms(ms: u32) -> u64 {
    ms as u64 * SAMPLE_RATE as u64 / 1000
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}
