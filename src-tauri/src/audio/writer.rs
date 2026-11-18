//! The recording on disk (PRD F1.4): 10 s WAV files per source, 16 kHz mono
//! 16-bit, named by their place in the meeting (`000000.wav` is 0–10 s).
//!
//! The header of the file being written is brought up to date once a second,
//! so a killed process loses at most the last second, and [`repair_dir`]
//! recovers even that much when the bytes reached the disk.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use super::SAMPLE_RATE;

pub const CHUNK_SECONDS: u32 = 10;
pub const CHUNK_SAMPLES: usize = (SAMPLE_RATE * CHUNK_SECONDS) as usize;
const FLUSH_SAMPLES: usize = SAMPLE_RATE as usize;
/// hound writes the plain 44-byte PCM header for 16-bit mono.
const HEADER_BYTES: u64 = 44;

const SPEC: hound::WavSpec = hound::WavSpec {
    channels: 1,
    sample_rate: SAMPLE_RATE,
    bits_per_sample: 16,
    sample_format: hound::SampleFormat::Int,
};

fn other(error: hound::Error) -> io::Error {
    match error {
        hound::Error::IoError(error) => error,
        error => io::Error::other(error),
    }
}

pub fn chunk_path(dir: &Path, index: u32) -> PathBuf {
    dir.join(format!("{index:06}.wav"))
}

fn to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

/// Writes one source's audio as consecutive 10 s files.
pub struct ChunkWriter {
    dir: PathBuf,
    index: u32,
    in_chunk: usize,
    since_flush: usize,
    writer: Option<hound::WavWriter<BufWriter<File>>>,
}

impl ChunkWriter {
    /// Starts a recording in `dir`, which must not hold one already.
    pub fn create(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        if !chunk_files(dir)?.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "the audio folder already holds a recording",
            ));
        }
        Ok(Self {
            dir: dir.to_path_buf(),
            index: 0,
            in_chunk: 0,
            since_flush: 0,
            writer: None,
        })
    }

    pub fn write(&mut self, mut samples: &[f32]) -> io::Result<()> {
        while !samples.is_empty() {
            if self.writer.is_none() {
                let path = chunk_path(&self.dir, self.index);
                self.writer = Some(hound::WavWriter::create(path, SPEC).map_err(other)?);
            }
            let Some(writer) = self.writer.as_mut() else {
                unreachable!("the writer was opened above");
            };
            let room = CHUNK_SAMPLES - self.in_chunk;
            let (now, rest) = samples.split_at(samples.len().min(room));
            for &sample in now {
                writer.write_sample(to_i16(sample)).map_err(other)?;
            }
            self.in_chunk += now.len();
            self.since_flush += now.len();
            samples = rest;

            if self.in_chunk == CHUNK_SAMPLES {
                if let Some(writer) = self.writer.take() {
                    writer.finalize().map_err(other)?;
                }
                self.index += 1;
                self.in_chunk = 0;
                self.since_flush = 0;
            } else if self.since_flush >= FLUSH_SAMPLES {
                writer.flush().map_err(other)?;
                self.since_flush = 0;
            }
        }
        Ok(())
    }

    /// Makes what has been written so far safe on disk, at a pause.
    pub fn flush(&mut self) -> io::Result<()> {
        if let Some(writer) = self.writer.as_mut() {
            writer.flush().map_err(other)?;
            self.since_flush = 0;
        }
        Ok(())
    }

    pub fn finish(mut self) -> io::Result<()> {
        match self.writer.take() {
            Some(writer) => writer.finalize().map_err(other),
            None => Ok(()),
        }
    }
}

/// The chunk files of a source, in meeting order.
pub fn chunk_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "wav"))
        .collect();
    files.sort();
    Ok(files)
}

/// Samples of audio in one chunk file, going by its size, not its header.
fn samples_in(path: &Path) -> io::Result<u64> {
    Ok(fs::metadata(path)?.len().saturating_sub(HEADER_BYTES) / 2)
}

/// Samples recorded in `dir`. Every chunk but the last is full.
pub fn recorded_samples(dir: &Path) -> io::Result<u64> {
    let files = chunk_files(dir)?;
    let Some(last) = files.last() else {
        return Ok(0);
    };
    Ok((files.len() as u64 - 1) * CHUNK_SAMPLES as u64 + samples_in(last)?)
}

/// Puts a source's recording right after a kill: the last file's header is
/// made to match the bytes that reached the disk, and a file too short to
/// hold a header is removed. Returns the samples recorded.
pub fn repair_dir(dir: &Path) -> io::Result<u64> {
    let files = chunk_files(dir)?;
    if let Some(last) = files.last() {
        let length = fs::metadata(last)?.len();
        if length < HEADER_BYTES {
            fs::remove_file(last)?;
        } else {
            repair_header(last, length)?;
        }
    }
    recorded_samples(dir)
}

fn repair_header(path: &Path, length: u64) -> io::Result<()> {
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let mut header = [0u8; HEADER_BYTES as usize];
    file.read_exact(&mut header)?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" || &header[36..40] != b"data" {
        // Not a header this writer made: leave the file as it is.
        return Ok(());
    }
    // Whole 16-bit samples only.
    let data = (length - HEADER_BYTES) & !1;
    let written = u32::from_le_bytes([header[40], header[41], header[42], header[43]]) as u64;
    if written == data && length == HEADER_BYTES + data {
        return Ok(());
    }
    file.set_len(HEADER_BYTES + data)?;
    file.seek(SeekFrom::Start(4))?;
    file.write_all(&((36 + data) as u32).to_le_bytes())?;
    file.seek(SeekFrom::Start(40))?;
    file.write_all(&(data as u32).to_le_bytes())?;
    file.sync_all()
}

/// Reads `count` samples of a source from `start`. Stops early at the end of
/// the recording; a file that cannot be read counts as silence.
pub fn read_samples(dir: &Path, start: u64, count: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(count);
    let mut position = start;
    let end = start + count as u64;
    while position < end {
        let index = (position / CHUNK_SAMPLES as u64) as u32;
        let offset = (position % CHUNK_SAMPLES as u64) as u32;
        let want = ((CHUNK_SAMPLES as u64 - offset as u64).min(end - position)) as usize;
        let path = chunk_path(dir, index);
        if !path.exists() {
            break;
        }
        let before = out.len();
        if let Ok(mut reader) = hound::WavReader::open(&path) {
            if reader.seek(offset).is_ok() {
                out.extend(
                    reader
                        .samples::<i16>()
                        .take(want)
                        .map_while(Result::ok)
                        .map(|sample| sample as f32 / i16::MAX as f32),
                );
            }
        }
        let got = out.len() - before;
        if got < want {
            // The last chunk, or one still being written: no more to read.
            break;
        }
        position += got as u64;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("scribe-writer-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn ramp(samples: usize) -> Vec<f32> {
        (0..samples).map(|i| (i % 1000) as f32 / 2000.0).collect()
    }

    #[test]
    fn audio_is_split_into_10_s_files() {
        let dir = temp_dir("split");
        let mut writer = ChunkWriter::create(&dir).unwrap();
        // 25 s, in the 32 ms pieces capture delivers.
        for piece in ramp(25 * SAMPLE_RATE as usize).chunks(512) {
            writer.write(piece).unwrap();
        }
        writer.finish().unwrap();

        let files = chunk_files(&dir).unwrap();
        assert_eq!(files.len(), 3);
        assert_eq!(hound::WavReader::open(&files[0]).unwrap().len(), 160_000);
        assert_eq!(hound::WavReader::open(&files[2]).unwrap().len(), 80_000);
        assert_eq!(recorded_samples(&dir).unwrap(), 25 * SAMPLE_RATE as u64);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_span_reads_back_across_file_boundaries() {
        let dir = temp_dir("read");
        let signal = ramp(25 * SAMPLE_RATE as usize);
        let mut writer = ChunkWriter::create(&dir).unwrap();
        writer.write(&signal).unwrap();
        writer.finish().unwrap();

        // 9.5 s to 10.5 s crosses from the first file into the second.
        let start = 152_000usize;
        let read = read_samples(&dir, start as u64, 16_000);
        assert_eq!(read.len(), 16_000);
        for (index, sample) in read.iter().enumerate() {
            assert!((sample - signal[start + index]).abs() < 1e-3);
        }
        // Past the end there is nothing.
        assert_eq!(read_samples(&dir, 24 * 16_000, 32_000).len(), 16_000);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_cut_short_mid_write_is_repaired() {
        let dir = temp_dir("repair");
        let mut writer = ChunkWriter::create(&dir).unwrap();
        writer.write(&ramp(13 * SAMPLE_RATE as usize)).unwrap();
        // A kill: the writer is never finished, and the last file ends in the
        // middle of a sample, 2.5 s in, with a header that says 3 s.
        writer.flush().unwrap();
        std::mem::forget(writer);
        let last = chunk_path(&dir, 1);
        let cut = HEADER_BYTES + 2 * 40_000 + 1;
        OpenOptions::new()
            .write(true)
            .open(&last)
            .unwrap()
            .set_len(cut)
            .unwrap();

        let samples = repair_dir(&dir).unwrap();
        assert_eq!(samples, 160_000 + 40_000);
        // The repaired file is a valid WAV of exactly what is left.
        assert_eq!(hound::WavReader::open(&last).unwrap().len(), 40_000);
        assert_eq!(read_samples(&dir, 0, 300_000).len(), 200_000);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_header_behind_the_data_is_brought_up_to_date() {
        let dir = temp_dir("stale");
        fs::create_dir_all(&dir).unwrap();
        let path = chunk_path(&dir, 0);
        // A header that still says "no samples", then one second of audio:
        // what a kill between two header updates leaves.
        let mut writer = hound::WavWriter::create(&path, SPEC).unwrap();
        writer.flush().unwrap();
        std::mem::forget(writer);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(&vec![1u8; 2 * 16_000]).unwrap();
        drop(file);
        assert_eq!(hound::WavReader::open(&path).unwrap().len(), 0);

        assert_eq!(repair_dir(&dir).unwrap(), 16_000);
        assert_eq!(hound::WavReader::open(&path).unwrap().len(), 16_000);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_with_no_header_yet_is_removed() {
        let dir = temp_dir("stub");
        let mut writer = ChunkWriter::create(&dir).unwrap();
        writer.write(&ramp(CHUNK_SAMPLES)).unwrap();
        writer.finish().unwrap();
        fs::write(chunk_path(&dir, 1), b"RIFF").unwrap();

        assert_eq!(repair_dir(&dir).unwrap(), CHUNK_SAMPLES as u64);
        assert_eq!(chunk_files(&dir).unwrap().len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_with_a_recording_is_not_written_over() {
        let dir = temp_dir("taken");
        let mut writer = ChunkWriter::create(&dir).unwrap();
        writer.write(&ramp(1_000)).unwrap();
        writer.finish().unwrap();
        assert!(ChunkWriter::create(&dir).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
