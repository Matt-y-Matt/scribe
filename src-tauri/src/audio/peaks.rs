//! Waveform peaks for the timeline: one byte per 50 ms, the loudest sample
//! of either source. An hour of meeting is 72 kB.

use super::SAMPLE_RATE;

/// Peaks per second of audio.
pub const PEAKS_PER_SECOND: u32 = 20;
const PERIOD: usize = (SAMPLE_RATE / PEAKS_PER_SECOND) as usize;

#[derive(Default)]
pub struct PeakMeter {
    max: f32,
    count: usize,
}

impl PeakMeter {
    /// Takes the same stretch of both sources and appends every peak that
    /// became complete to `out`.
    pub fn push(&mut self, laptop: &[f32], system: &[f32], out: &mut Vec<u8>) {
        for index in 0..laptop.len().max(system.len()) {
            let a = laptop.get(index).copied().unwrap_or(0.0).abs();
            let b = system.get(index).copied().unwrap_or(0.0).abs();
            self.max = self.max.max(a).max(b);
            self.count += 1;
            if self.count == PERIOD {
                out.push(to_byte(self.max));
                self.max = 0.0;
                self.count = 0;
            }
        }
    }
}

fn to_byte(peak: f32) -> u8 {
    (peak.clamp(0.0, 1.0) * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_second_gives_twenty_peaks() {
        let mut meter = PeakMeter::default();
        let mut out = Vec::new();
        let quiet = vec![0.1f32; SAMPLE_RATE as usize];
        for piece in quiet.chunks(512) {
            meter.push(piece, &[], &mut out);
        }
        assert_eq!(out.len(), 20);
        assert!(out.iter().all(|&peak| peak == 26));
    }

    #[test]
    fn a_peak_is_the_loudest_sample_of_either_source() {
        let mut meter = PeakMeter::default();
        let mut out = Vec::new();
        let mut laptop = vec![0.0f32; PERIOD];
        let mut system = vec![0.0f32; PERIOD];
        laptop[10] = -0.5;
        system[700] = 2.0; // clipped input still fits a byte
        meter.push(&laptop, &system, &mut out);
        assert_eq!(out, [255]);
    }
}
