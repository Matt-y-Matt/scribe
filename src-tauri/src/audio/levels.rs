//! Level meters (PRD F2.4): one RMS value per source, at most 20 times a
//! second, however often capture delivers audio.

use super::{rms, SAMPLE_RATE};

/// Samples per reading: 50 ms, so readings never come faster than 20 Hz.
const PERIOD: usize = SAMPLE_RATE as usize / 20;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reading {
    pub laptop: f32,
    pub system: f32,
}

#[derive(Default)]
pub struct LevelMeter {
    laptop: Vec<f32>,
    system: Vec<f32>,
}

impl LevelMeter {
    /// Takes the same stretch of both sources; `system` is empty when
    /// loopback is off. Returns a reading once 50 ms has gathered.
    pub fn push(&mut self, laptop: &[f32], system: &[f32]) -> Option<Reading> {
        self.laptop.extend_from_slice(laptop);
        self.system.extend_from_slice(system);
        if self.laptop.len() < PERIOD {
            return None;
        }
        let reading = Reading {
            laptop: rms(&self.laptop),
            system: rms(&self.system),
        };
        self.laptop.clear();
        self.system.clear();
        Some(reading)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::WINDOW;

    #[test]
    fn readings_come_at_most_20_times_a_second() {
        let mut meter = LevelMeter::default();
        let window = vec![0.5f32; WINDOW];
        // One second of audio in 32 ms windows.
        let readings = (0..SAMPLE_RATE as usize / WINDOW)
            .filter_map(|_| meter.push(&window, &window))
            .count();
        assert!((10..=20).contains(&readings), "{readings} readings in 1 s");
    }

    #[test]
    fn a_reading_is_the_rms_of_what_was_heard() {
        let mut meter = LevelMeter::default();
        let loud = vec![0.5f32; PERIOD];
        let reading = meter.push(&loud, &[]).expect("50 ms gives a reading");
        assert!((reading.laptop - 0.5).abs() < 1e-6);
        assert_eq!(reading.system, 0.0);
    }
}
