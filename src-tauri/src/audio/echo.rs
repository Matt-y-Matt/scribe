//! Keeps the speakers out of the room's transcript (PRD F2.2, TEST_PLAN §4.3).
//!
//! The vendored echo canceller needs about ten seconds of system audio to
//! settle, and now and then lets a fragment through afterwards. What gets
//! through reaches the cutter as a microphone utterance, and would be
//! transcribed a second time as `Room`. This guard looks at each microphone
//! utterance next to the system audio of the same moment and drops the ones
//! that are the speakers and not a person:
//!
//! - the microphone's loudness rises and falls with the system audio's
//!   (what leaks before the canceller has settled), or
//! - the microphone is far quieter than the system audio (what is left of an
//!   echo once it has).
//!
//! It only ever acts while system audio is playing, so a meeting in a room
//! with nothing coming from the PC is never touched. The thresholds come from
//! recordings on the reference PC (docs/NOTES.md, M2): leaked echo
//! correlated at 0.79 to 0.91 and a talker over the speakers at 0.61 at most;
//! residual echo sat 41 dB or more under the system audio and a quiet,
//! distant talker 32 to 38 dB under it.
//!
//! What it does not catch: echo the canceller has half removed. That is 19
//! to 34 dB under the system audio with a loudness pattern that follows it
//! only loosely (0.25 to 0.56), which is also what a quiet person talking
//! over the speakers looks like, and dropping a person is worse than
//! keeping a garbled fragment. Comparing the two signals band by band was
//! tried and does not separate them either.

use std::collections::VecDeque;

use super::SAMPLE_RATE;

/// Loudness is compared in 20 ms steps.
const STEP: usize = SAMPLE_RATE as usize / 50;
/// The speakers reach the microphone a little after the loopback hears them;
/// capture aligns the two to within a few steps either way.
const EARLIEST_STEPS: i64 = -3;
const LATEST_STEPS: i64 = 8;
/// Below this the PC is not playing anything worth guarding against.
const SYSTEM_ACTIVE_DB: f32 = -50.0;
/// The microphone follows the system audio this closely: it is the speakers.
const ECHO_CORRELATION: f32 = 0.70;
/// The microphone is this far under the system audio: it is what the
/// canceller left of the speakers.
const ECHO_BELOW_DB: f32 = 40.0;
/// Shorter than this there is too little loudness pattern to compare.
const MIN_STEPS: usize = 25;

fn db(samples: &[f32]) -> f32 {
    20.0 * super::rms(samples).max(1e-9).log10()
}

fn loudness(samples: &[f32]) -> Vec<f32> {
    samples.chunks_exact(STEP).map(super::rms).collect()
}

/// Pearson correlation of two equally long series; 0 when either is flat.
fn correlation(a: &[f32], b: &[f32]) -> f32 {
    let count = a.len().min(b.len());
    if count == 0 {
        return 0.0;
    }
    let mean = |series: &[f32]| series[..count].iter().sum::<f32>() / count as f32;
    let (mean_a, mean_b) = (mean(a), mean(b));
    let (mut ab, mut aa, mut bb) = (0.0f32, 0.0f32, 0.0f32);
    for index in 0..count {
        let (x, y) = (a[index] - mean_a, b[index] - mean_b);
        ab += x * y;
        aa += x * x;
        bb += y * y;
    }
    if aa <= f32::EPSILON || bb <= f32::EPSILON {
        return 0.0;
    }
    ab / (aa * bb).sqrt()
}

/// The last half minute of system audio, by its place in the meeting.
pub struct SystemHistory {
    /// Meeting position of the first sample held.
    start: u64,
    samples: VecDeque<f32>,
    capacity: usize,
}

impl SystemHistory {
    /// Holds a little more than the longest utterance.
    pub fn new() -> Self {
        Self::with_seconds(35)
    }

    pub fn with_seconds(seconds: usize) -> Self {
        Self {
            start: 0,
            samples: VecDeque::new(),
            capacity: seconds * SAMPLE_RATE as usize,
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        self.samples.extend(samples);
        let over = self.samples.len().saturating_sub(self.capacity);
        if over > 0 {
            self.samples.drain(..over);
            self.start += over as u64;
        }
    }

    /// The system audio from `from` for `count` samples; silence wherever
    /// the history does not reach (before the meeting, not yet heard).
    fn span(&self, from: i64, count: usize) -> Vec<f32> {
        (0..count as i64)
            .map(|offset| {
                let index = from + offset - self.start as i64;
                if index < 0 {
                    return 0.0;
                }
                self.samples.get(index as usize).copied().unwrap_or(0.0)
            })
            .collect()
    }
}

impl Default for SystemHistory {
    fn default() -> Self {
        Self::new()
    }
}

/// What the guard measured for one microphone utterance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EchoCheck {
    /// How closely the microphone's loudness follows the system audio's, at
    /// the best alignment: 1 is the same pattern.
    pub correlation: f32,
    /// How far the microphone is under the system audio, in dB.
    pub below_db: f32,
    pub system_db: f32,
    /// The utterance is the speakers, not a person.
    pub echo: bool,
}

/// Judges a microphone utterance that started at `start_sample`.
pub fn check(microphone: &[f32], system: &SystemHistory, start_sample: u64) -> EchoCheck {
    let same_moment = system.span(start_sample as i64, microphone.len());
    let system_db = db(&same_moment);
    let below_db = system_db - db(microphone);
    if system_db < SYSTEM_ACTIVE_DB {
        return EchoCheck {
            correlation: 0.0,
            below_db,
            system_db,
            echo: false,
        };
    }

    let ours = loudness(microphone);
    let mut best = 0.0f32;
    if ours.len() >= MIN_STEPS {
        for shift in EARLIEST_STEPS..=LATEST_STEPS {
            // The system audio `shift` steps before the microphone's.
            let from = start_sample as i64 - shift * STEP as i64;
            let theirs = loudness(&system.span(from, microphone.len()));
            best = best.max(correlation(&ours, &theirs));
        }
    }
    EchoCheck {
        correlation: best,
        below_db,
        system_db,
        echo: best >= ECHO_CORRELATION || below_db >= ECHO_BELOW_DB,
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;

    /// Something with the loudness pattern of speech: noise that swells and
    /// fades a few times a second. The same `seed` gives the same signal.
    pub fn speechlike(seed: u32, ms: u32, level: f32) -> Vec<f32> {
        let mut state = seed.wrapping_mul(2_654_435_761).max(1);
        let mut next = move || {
            // xorshift: plain, repeatable noise.
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state as f32 / u32::MAX as f32) * 2.0 - 1.0
        };
        let count = (ms as usize * SAMPLE_RATE as usize) / 1000;
        // A new loudness every 120 ms, as syllables come.
        let syllable = SAMPLE_RATE as usize * 120 / 1000;
        let mut loudness = 0.0f32;
        (0..count)
            .map(|index| {
                if index % syllable == 0 {
                    loudness = 0.1 + 0.9 * next().abs();
                }
                level * loudness * next()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::speechlike;
    use super::*;

    fn history(system: &[f32]) -> SystemHistory {
        let mut history = SystemHistory::new();
        for piece in system.chunks(512) {
            history.push(piece);
        }
        history
    }

    fn delayed(signal: &[f32], ms: usize, gain: f32) -> Vec<f32> {
        let shift = ms * SAMPLE_RATE as usize / 1000;
        (0..signal.len())
            .map(|index| {
                if index >= shift {
                    gain * signal[index - shift]
                } else {
                    0.0
                }
            })
            .collect()
    }

    fn mixed(a: &[f32], b: &[f32]) -> Vec<f32> {
        a.iter().zip(b).map(|(x, y)| x + y).collect()
    }

    #[test]
    fn the_speakers_heard_by_the_microphone_are_echo() {
        let system = speechlike(1, 4_000, 0.3);
        // What the room does to it: later and quieter.
        for (delay_ms, gain) in [(0, 0.1), (40, 0.08), (120, 0.05)] {
            let microphone = delayed(&system, delay_ms, gain);
            let result = check(&microphone, &history(&system), 0);
            assert!(result.echo, "delay {delay_ms} ms: {result:?}");
            assert!(result.correlation > 0.9, "delay {delay_ms} ms: {result:?}");
        }
    }

    #[test]
    fn a_person_talking_over_the_speakers_is_not_echo() {
        let system = speechlike(1, 4_000, 0.3);
        for seed in 2..12 {
            let talker = speechlike(seed, 4_000, 0.06);
            let result = check(&talker, &history(&system), 0);
            assert!(!result.echo, "talker {seed}: {result:?}");
        }
    }

    #[test]
    fn a_person_talking_with_some_echo_left_under_them_is_not_echo() {
        let system = speechlike(1, 4_000, 0.3);
        let residue = delayed(&system, 40, 0.004);
        let microphone = mixed(&speechlike(7, 4_000, 0.06), &residue);
        let result = check(&microphone, &history(&system), 0);
        assert!(!result.echo, "{result:?}");
    }

    #[test]
    fn what_the_canceller_leaves_of_the_speakers_is_echo() {
        // 45 dB under the system audio, and its pattern smeared by the
        // canceller: only the level gives it away.
        let system = speechlike(1, 2_000, 0.3);
        let residue = speechlike(9, 2_000, 0.3 * 10f32.powf(-45.0 / 20.0));
        let result = check(&residue, &history(&system), 0);
        assert!(result.echo, "{result:?}");
        assert!(result.below_db > 40.0);
    }

    #[test]
    fn a_quiet_person_far_from_the_microphone_is_kept() {
        // 30 dB under the system audio: quiet, and still a person.
        let system = speechlike(1, 3_000, 0.3);
        let talker = speechlike(5, 3_000, 0.3 * 10f32.powf(-30.0 / 20.0));
        assert!(!check(&talker, &history(&system), 0).echo);
    }

    #[test]
    fn with_nothing_playing_the_guard_never_acts() {
        let silence = vec![0.0f32; 4 * SAMPLE_RATE as usize];
        for level in [0.3, 0.01, 0.0005] {
            let talker = speechlike(3, 4_000, level);
            let result = check(&talker, &history(&silence), 0);
            assert!(!result.echo, "level {level}: {result:?}");
        }
        // And with no system history at all: loopback is off.
        assert!(!check(&speechlike(3, 2_000, 0.001), &SystemHistory::new(), 0).echo);
    }

    #[test]
    fn an_utterance_is_judged_against_its_own_moment() {
        // The PC played something ten seconds ago and is silent now.
        let mut system = speechlike(1, 4_000, 0.3);
        system.extend(vec![0.0f32; 10 * SAMPLE_RATE as usize]);
        let earlier = delayed(&speechlike(1, 4_000, 0.3), 40, 0.1);
        assert!(check(&earlier, &history(&system), 0).echo);
        // The same sound now is not an echo of anything.
        let start = 8 * SAMPLE_RATE as u64;
        assert!(!check(&earlier, &history(&system), start).echo);
    }

    #[test]
    fn the_history_keeps_the_last_seconds_and_knows_where_they_were() {
        let mut history = SystemHistory::with_seconds(1);
        let ramp: Vec<f32> = (0..3 * SAMPLE_RATE).map(|index| index as f32).collect();
        for piece in ramp.chunks(512) {
            history.push(piece);
        }
        // The last second is there, at its place in the meeting.
        let from = 2 * SAMPLE_RATE as i64 + 100;
        assert_eq!(
            history.span(from, 3),
            [from as f32, from as f32 + 1.0, from as f32 + 2.0]
        );
        // What has been forgotten, and what has not been heard yet, is silence.
        assert_eq!(history.span(10, 2), [0.0, 0.0]);
        assert_eq!(history.span(3 * SAMPLE_RATE as i64 - 1, 3)[1..], [0.0, 0.0]);
        assert_eq!(history.span(-2, 3)[..2], [0.0, 0.0]);
    }
}
