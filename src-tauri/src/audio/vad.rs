//! Cuts a stream of 16 kHz audio into utterances (PRD F2.3).
//!
//! The speech/no-speech decision per 32 ms window comes from a
//! [`SpeechDetector`]: Silero through the vendored `vad` crate in the app, a
//! plain energy gate in tests. Where an utterance starts and ends is decided
//! here: 700 ms of silence ends one, none is longer than 30 s, and one that
//! has run past 10 s is cut at the next 300 ms pause so a long speech does not
//! keep its text back.

use super::{ms_of_samples, WINDOW};

/// Says how likely a window of [`WINDOW`] samples is to be speech, 0 to 1.
pub trait SpeechDetector: Send {
    fn probability(&mut self, window: &[f32]) -> f32;
    /// Forgets what it has heard, for the start of a new stretch of audio.
    fn reset(&mut self);
}

/// Silero VAD v6.2 from the vendored `vad` crate.
pub struct SileroDetector {
    model: vad::silero_onnx::SileroVad,
}

impl SileroDetector {
    pub fn new() -> Result<Self, String> {
        vad::silero_onnx::SileroVad::new_embedded()
            .map(|model| Self { model })
            .map_err(|error| error.to_string())
    }
}

impl SpeechDetector for SileroDetector {
    fn probability(&mut self, window: &[f32]) -> f32 {
        let view = ndarray::ArrayView1::from(window);
        // A failed inference is treated as silence: the meeting keeps
        // recording and the next window is tried again.
        self.model
            .process_chunk(&view, super::SAMPLE_RATE)
            .unwrap_or(0.0)
    }

    fn reset(&mut self) {
        self.model.reset_states();
    }
}

/// Speech when the window is louder than a floor. For tests, and for a PC
/// where the Silero model will not load.
pub struct EnergyDetector {
    pub floor_rms: f32,
}

impl SpeechDetector for EnergyDetector {
    fn probability(&mut self, window: &[f32]) -> f32 {
        if super::rms(window) > self.floor_rms {
            1.0
        } else {
            0.0
        }
    }

    fn reset(&mut self) {}
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CutterConfig {
    /// A window at or above this starts speech.
    pub start_probability: f32,
    /// A window below this counts towards the closing silence.
    pub end_probability: f32,
    /// Silence that ends an utterance.
    pub end_silence_ms: u32,
    /// No utterance is longer than this.
    pub max_ms: u32,
    /// Past this length the utterance ends at the next short pause.
    pub soft_max_ms: u32,
    pub soft_silence_ms: u32,
    /// Audio kept from before the first speech window, so a soft first
    /// consonant is not lost.
    pub lead_ms: u32,
    /// Silence kept after the last speech window.
    pub tail_ms: u32,
    /// Shorter bursts are dropped: a cough, a key press.
    pub min_speech_ms: u32,
}

impl Default for CutterConfig {
    fn default() -> Self {
        Self {
            start_probability: 0.5,
            end_probability: 0.35,
            end_silence_ms: 700,
            max_ms: 30_000,
            soft_max_ms: 10_000,
            soft_silence_ms: 300,
            lead_ms: 192,
            tail_ms: 192,
            min_speech_ms: 250,
        }
    }
}

/// One stretch of speech, on the clock of the stream it was cut from.
#[derive(Debug, Clone, PartialEq)]
pub struct Utterance {
    pub t0_ms: u32,
    pub t1_ms: u32,
    /// Silence the cutter waited through before it closed the utterance:
    /// how long ago the speech really ended when this was handed over.
    pub closing_silence_ms: u32,
    pub samples: Vec<f32>,
}

const fn windows_for(ms: u32) -> usize {
    // Rounded up, so "700 ms" is never less than 700 ms of windows.
    (ms as usize * super::SAMPLE_RATE as usize).div_ceil(1000 * WINDOW)
}

struct Open {
    /// Index of the utterance's first sample in the stream.
    start_sample: u64,
    samples: Vec<f32>,
    speech_windows: usize,
    /// Windows of silence since the last speech window.
    silence_run: usize,
}

/// Turns windows and their speech probabilities into utterances.
pub struct Cutter {
    config: CutterConfig,
    /// The last few windows heard while idle, for the lead-in.
    lead: std::collections::VecDeque<Vec<f32>>,
    open: Option<Open>,
    /// Samples pushed so far.
    position: u64,
}

impl Cutter {
    pub fn new(config: CutterConfig) -> Self {
        Self {
            config,
            lead: std::collections::VecDeque::new(),
            open: None,
            position: 0,
        }
    }

    /// True while an utterance is being collected.
    pub fn in_speech(&self) -> bool {
        self.open.is_some()
    }

    /// Feeds one window. Returns the utterance this window closed, if any.
    pub fn push(&mut self, window: &[f32], probability: f32) -> Option<Utterance> {
        let window_start = self.position;
        self.position += window.len() as u64;
        let config = self.config;

        let Some(open) = self.open.as_mut() else {
            if probability >= config.start_probability {
                let lead_samples: usize = self.lead.iter().map(Vec::len).sum();
                let mut samples = Vec::with_capacity(lead_samples + window.len());
                for kept in self.lead.drain(..) {
                    samples.extend_from_slice(&kept);
                }
                samples.extend_from_slice(window);
                self.open = Some(Open {
                    start_sample: window_start - lead_samples as u64,
                    samples,
                    speech_windows: 1,
                    silence_run: 0,
                });
            } else {
                self.lead.push_back(window.to_vec());
                while self.lead.len() > windows_for(config.lead_ms) {
                    self.lead.pop_front();
                }
            }
            return None;
        };

        open.samples.extend_from_slice(window);
        if probability >= config.end_probability {
            open.speech_windows += 1;
            open.silence_run = 0;
        } else {
            open.silence_run += 1;
        }

        let length_ms = ms_of_samples(open.samples.len() as u64);
        let ended = open.silence_run >= windows_for(config.end_silence_ms);
        let soft = length_ms >= config.soft_max_ms
            && open.silence_run >= windows_for(config.soft_silence_ms);
        let full = length_ms >= config.max_ms;
        if ended || soft || full {
            return self.close();
        }
        None
    }

    /// Ends the open utterance, if any: on pause, on stop, when a source goes
    /// quiet for good.
    pub fn flush(&mut self) -> Option<Utterance> {
        self.close()
    }

    fn close(&mut self) -> Option<Utterance> {
        let mut open = self.open.take()?;
        self.lead.clear();

        let closing_silence_ms = ms_of_samples((open.silence_run * WINDOW) as u64);
        // Keep a short tail of the closing silence and drop the rest.
        let tail = windows_for(self.config.tail_ms);
        if open.silence_run > tail {
            let drop = (open.silence_run - tail) * WINDOW;
            open.samples
                .truncate(open.samples.len().saturating_sub(drop));
        }
        if ms_of_samples((open.speech_windows * WINDOW) as u64) < self.config.min_speech_ms {
            return None;
        }
        Some(Utterance {
            t0_ms: ms_of_samples(open.start_sample),
            t1_ms: ms_of_samples(open.start_sample + open.samples.len() as u64),
            closing_silence_ms,
            samples: open.samples,
        })
    }
}

/// A detector and a cutter for one audio source. Takes samples in any amount
/// and works in whole windows.
pub struct Segmenter {
    detector: Box<dyn SpeechDetector>,
    cutter: Cutter,
    pending: Vec<f32>,
}

impl Segmenter {
    pub fn new(detector: Box<dyn SpeechDetector>, config: CutterConfig) -> Self {
        Self {
            detector,
            cutter: Cutter::new(config),
            pending: Vec::with_capacity(WINDOW * 2),
        }
    }

    pub fn in_speech(&self) -> bool {
        self.cutter.in_speech()
    }

    pub fn push(&mut self, samples: &[f32], out: &mut Vec<Utterance>) {
        self.pending.extend_from_slice(samples);
        let mut offset = 0;
        while self.pending.len() - offset >= WINDOW {
            let window = &self.pending[offset..offset + WINDOW];
            let probability = self.detector.probability(window);
            if let Some(utterance) = self.cutter.push(window, probability) {
                out.push(utterance);
            }
            offset += WINDOW;
        }
        self.pending.drain(..offset);
    }

    /// Ends the open utterance and forgets the detector's state. The clock
    /// keeps running, so a resumed meeting carries on from where it paused.
    pub fn flush(&mut self, out: &mut Vec<Utterance>) {
        if let Some(utterance) = self.cutter.flush() {
            out.push(utterance);
        }
        self.detector.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::SAMPLE_RATE;

    /// A 220 Hz tone, loud enough for the energy gate.
    fn tone(ms: u32) -> Vec<f32> {
        let samples = (ms as usize * SAMPLE_RATE as usize) / 1000;
        (0..samples)
            .map(|i| 0.3 * (i as f32 * 220.0 * std::f32::consts::TAU / SAMPLE_RATE as f32).sin())
            .collect()
    }

    fn silence(ms: u32) -> Vec<f32> {
        vec![0.0; (ms as usize * SAMPLE_RATE as usize) / 1000]
    }

    fn cut(signal: &[f32]) -> Vec<Utterance> {
        let mut segmenter = Segmenter::new(
            Box::new(EnergyDetector { floor_rms: 0.01 }),
            CutterConfig::default(),
        );
        let mut out = Vec::new();
        // Uneven pieces, as a capture device delivers them.
        for piece in signal.chunks(700) {
            segmenter.push(piece, &mut out);
        }
        segmenter.flush(&mut out);
        out
    }

    fn near(actual: u32, expected: u32) -> bool {
        actual.abs_diff(expected) <= 2 * 32
    }

    #[test]
    fn a_40_s_signal_with_gaps_becomes_the_expected_utterances() {
        // 40 s: speech 0–5, gap 1 s, speech 6–14, gap 0.4 s (too short to
        // cut), speech 14.4–20, gap 2 s, speech 22–39, silence to 40.
        // Three utterances: 0–5, 6–20, 22–39.
        let signal = [
            tone(5_000),
            silence(1_000),
            tone(8_000),
            silence(400),
            tone(5_600),
            silence(2_000),
            tone(17_000),
            silence(1_000),
        ]
        .concat();
        assert_eq!(signal.len(), 40 * SAMPLE_RATE as usize);

        let utterances = cut(&signal);
        let spans: Vec<(u32, u32)> = utterances.iter().map(|u| (u.t0_ms, u.t1_ms)).collect();
        assert_eq!(spans.len(), 3, "{spans:?}");

        // The 400 ms gap does not end the second utterance.
        assert!(
            near(spans[0].0, 0) && near(spans[0].1, 5_000 + 192),
            "{spans:?}"
        );
        assert!(
            near(spans[1].0, 6_000 - 192) && near(spans[1].1, 20_000 + 192),
            "{spans:?}"
        );
        // 17 s of speech passes the 10 s soft limit without a pause to cut
        // at, so it runs to its own end.
        assert!(
            near(spans[2].0, 22_000 - 192) && near(spans[2].1, 39_000 + 192),
            "{spans:?}"
        );
        // Nothing overlaps and time only moves forward.
        assert!(
            spans.windows(2).all(|pair| pair[0].1 <= pair[1].0),
            "{spans:?}"
        );
    }

    #[test]
    fn no_utterance_is_longer_than_30_s() {
        let utterances = cut(&tone(75_000));
        assert_eq!(utterances.len(), 3);
        for utterance in &utterances {
            assert!(utterance.t1_ms - utterance.t0_ms <= 30_000 + 32);
        }
        // Cut back to back: no audio is lost between the pieces.
        assert_eq!(utterances[0].t1_ms, utterances[1].t0_ms);
        assert_eq!(utterances[1].t1_ms, utterances[2].t0_ms);
        let total: usize = utterances.iter().map(|u| u.samples.len()).sum();
        assert!(total.abs_diff(75 * SAMPLE_RATE as usize) <= WINDOW);
    }

    #[test]
    fn past_10_s_a_300_ms_pause_is_enough_to_cut() {
        let signal = [tone(16_000), silence(400), tone(3_000), silence(1_000)].concat();
        let utterances = cut(&signal);
        assert_eq!(utterances.len(), 2);
        assert!(near(utterances[0].t1_ms, 16_000 + 192));
        // The lead-in is what is left of the pause after the cut.
        assert!((16_300..=16_400).contains(&utterances[1].t0_ms));
    }

    #[test]
    fn silence_of_700_ms_or_more_ends_an_utterance() {
        let signal = [tone(2_000), silence(800), tone(2_000), silence(1_000)].concat();
        assert_eq!(cut(&signal).len(), 2);
        let signal = [tone(2_000), silence(600), tone(2_000), silence(1_000)].concat();
        assert_eq!(cut(&signal).len(), 1);
    }

    #[test]
    fn a_short_burst_is_dropped() {
        let signal = [silence(500), tone(120), silence(1_500)].concat();
        assert!(cut(&signal).is_empty());
    }

    #[test]
    fn flush_ends_the_open_utterance_and_the_clock_carries_on() {
        let mut segmenter = Segmenter::new(
            Box::new(EnergyDetector { floor_rms: 0.01 }),
            CutterConfig::default(),
        );
        let mut out = Vec::new();
        segmenter.push(&tone(1_024), &mut out);
        assert!(segmenter.in_speech());
        segmenter.flush(&mut out);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].t0_ms, out[0].t1_ms), (0, 1_024));

        segmenter.push(&tone(1_024), &mut out);
        segmenter.flush(&mut out);
        assert_eq!(out[1].t0_ms, 1_024);
    }
}
