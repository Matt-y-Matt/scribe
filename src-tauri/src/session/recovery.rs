//! Recovery of a meeting that was being recorded when the app died
//! (PRD F1.4, BUILD_PLAN M2 task 6).
//!
//! What a kill leaves behind: a meeting with a start and no end, audio files
//! whose last chunk may be cut short, segments saved up to the last one
//! transcribed, a map saved up to its last commit, and a peaks file that may
//! be behind. Recovery repairs the audio, rebuilds the peaks from it,
//! transcribes what was said after the last saved segment, and closes the
//! meeting at the end of its audio. It deletes nothing.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::{audio_dir, new_id, peaks_path, storage, SessionDeps, SessionError};
use crate::audio::peaks::PeakMeter;
use crate::audio::vad::{CutterConfig, Segmenter};
use crate::audio::writer::{read_samples, repair_dir, CHUNK_SAMPLES};
use crate::audio::{ms_of_samples, samples_of_ms, SourceKind};
use crate::ipc::SegmentFinal;
use crate::stt::Transcriber;

/// The most audio recovery will transcribe per source. A meeting recorded
/// with no speech model has no segments at all; transcribing an hour of it
/// here would hold the app for minutes with no way to cancel.
const MAX_TAIL_MS: u32 = 120_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Recovered {
    pub meeting_id: String,
    /// Length of the audio that was saved.
    pub duration_ms: u32,
    /// Segments transcribed from audio the app had not got to.
    pub segments_added: u32,
}

/// Reads both sources of a recording and writes its waveform peaks afresh.
/// Returns how many peaks there are.
pub fn rebuild_peaks(data_dir: &Path, meeting_id: &str, samples: u64) -> std::io::Result<u32> {
    let laptop = audio_dir(data_dir, meeting_id, SourceKind::Laptop);
    let system = audio_dir(data_dir, meeting_id, SourceKind::System);
    let mut meter = PeakMeter::default();
    let mut peaks = Vec::new();
    let mut position = 0u64;
    while position < samples {
        let count = (samples - position).min(CHUNK_SAMPLES as u64) as usize;
        let a = read_samples(&laptop, position, count);
        let b = read_samples(&system, position, count);
        if a.is_empty() && b.is_empty() {
            break;
        }
        meter.push(&a, &b, &mut peaks);
        position += count as u64;
    }
    // A meeting killed before its first frame has no folder yet.
    std::fs::create_dir_all(super::meeting_dir(data_dir, meeting_id))?;
    std::fs::write(peaks_path(data_dir, meeting_id), &peaks)?;
    Ok(peaks.len() as u32)
}

/// Finds and transcribes the speech in one source's audio from `from_ms` on.
fn transcribe_tail(
    deps: &SessionDeps,
    meeting_id: &str,
    source: SourceKind,
    from_ms: u32,
    samples: u64,
    transcriber: &dyn Transcriber,
) -> Vec<SegmentFinal> {
    let end_ms = ms_of_samples(samples);
    let from_ms = from_ms.max(end_ms.saturating_sub(MAX_TAIL_MS));
    let start = samples_of_ms(from_ms);
    if start >= samples {
        return Vec::new();
    }
    let audio = read_samples(
        &audio_dir(&deps.data_dir, meeting_id, source),
        start,
        (samples - start) as usize,
    );
    let mut segmenter = Segmenter::new((deps.detector)(), CutterConfig::default());
    let mut utterances = Vec::new();
    segmenter.push(&audio, &mut utterances);
    segmenter.flush(&mut utterances);

    utterances
        .into_iter()
        .filter_map(|utterance| {
            let transcript = transcriber.transcribe(&utterance.samples);
            (!transcript.text.is_empty()).then(|| SegmentFinal {
                id: new_id("s"),
                meeting_id: meeting_id.to_string(),
                t0_ms: from_ms + utterance.t0_ms,
                t1_ms: from_ms + utterance.t1_ms,
                speaker_label: source.label().to_string(),
                source: source.id().to_string(),
                text: transcript.text,
                confidence: transcript.confidence,
            })
        })
        .collect()
}

/// Recovers `meeting_id`. `model_id` names the speech model to transcribe
/// the unheard tail with; without it installed the audio is still recovered.
pub async fn recover(
    deps: &SessionDeps,
    meeting_id: &str,
    model_id: &str,
) -> Result<Recovered, SessionError> {
    let meeting = deps
        .store
        .meeting(meeting_id)
        .await
        .map_err(storage)?
        .ok_or(SessionError::NotFound)?;
    if !meeting.is_unfinished() {
        return Err(SessionError::AlreadyRecorded);
    }

    let work = {
        let deps = deps.clone();
        let (meeting_id, model_id) = (meeting_id.to_string(), model_id.to_string());
        let last_ends = [
            deps.store
                .last_segment_end(&meeting_id, Some(SourceKind::Laptop.id()))
                .await
                .map_err(storage)?,
            deps.store
                .last_segment_end(&meeting_id, Some(SourceKind::System.id()))
                .await
                .map_err(storage)?,
        ];
        // Reading an hour of audio and running the recogniser are blocking
        // work: keep them off the async runtime.
        tokio::task::spawn_blocking(move || -> std::io::Result<(u64, Vec<SegmentFinal>)> {
            let mut lengths = [0u64; 2];
            for (index, source) in SourceKind::ALL.into_iter().enumerate() {
                lengths[index] = repair_dir(&audio_dir(&deps.data_dir, &meeting_id, source))?;
            }
            let samples = lengths[0].max(lengths[1]);
            rebuild_peaks(&deps.data_dir, &meeting_id, samples)?;

            let transcriber: Option<Arc<dyn Transcriber>> = (deps.transcriber)(&model_id).ok();
            let mut segments = Vec::new();
            if let Some(transcriber) = transcriber {
                for (index, source) in SourceKind::ALL.into_iter().enumerate() {
                    segments.extend(transcribe_tail(
                        &deps,
                        &meeting_id,
                        source,
                        last_ends[index],
                        lengths[index],
                        transcriber.as_ref(),
                    ));
                }
            }
            Ok((samples, segments))
        })
    };
    let (samples, segments) = work.await.map_err(storage)?.map_err(storage)?;

    for segment in &segments {
        deps.store.insert_segment(segment).await.map_err(storage)?;
    }
    let duration_ms = ms_of_samples(samples);
    deps.store
        .mark_ended(meeting_id, duration_ms)
        .await
        .map_err(storage)?;
    log::info!(
        "meeting recovered: {duration_ms} ms of audio, {} segments added",
        segments.len()
    );
    Ok(Recovered {
        meeting_id: meeting_id.to_string(),
        duration_ms,
        segments_added: segments.len() as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::super::testing::*;
    use super::*;
    use crate::audio::writer::{chunk_path, ChunkWriter};
    use crate::audio::SAMPLE_RATE;

    fn tone(ms: u32, loud: bool) -> Vec<f32> {
        (0..samples_of_ms(ms) as usize)
            .map(|i| {
                if loud {
                    0.3 * (i as f32 * 0.1).sin()
                } else {
                    0.0
                }
            })
            .collect()
    }

    /// Leaves on disk what a kill 14 s into a meeting leaves: a first
    /// utterance that was transcribed, a second that was not, and a last
    /// audio file cut off in the middle of a sample.
    async fn killed_meeting(rig: &Rig) {
        meeting(&rig.store, "m_1").await;
        rig.store.mark_started("m_1", false).await.unwrap();
        let dir = audio_dir(&rig.data_dir, "m_1", SourceKind::Laptop);
        let mut writer = ChunkWriter::create(&dir).unwrap();
        for (ms, loud) in [(3_000, true), (2_000, false), (4_000, true), (5_000, false)] {
            writer.write(&tone(ms, loud)).unwrap();
        }
        writer.flush().unwrap();
        std::mem::forget(writer);
        // 13.5 s reached the disk.
        let last = chunk_path(&dir, 1);
        let keep = 44 + 2 * (3 * SAMPLE_RATE as u64 + SAMPLE_RATE as u64 / 2) + 1;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&last)
            .unwrap()
            .set_len(keep)
            .unwrap();

        rig.store
            .insert_segment(&SegmentFinal {
                id: "s_first".into(),
                meeting_id: "m_1".into(),
                t0_ms: 0,
                t1_ms: 3_200,
                speaker_label: "Room".into(),
                source: "laptop".into(),
                text: "heard before the kill".into(),
                confidence: 1.0,
            })
            .await
            .unwrap();
    }

    fn deps(rig: &Rig, with_model: bool) -> SessionDeps {
        SessionDeps {
            data_dir: rig.data_dir.clone(),
            store: rig.store.clone(),
            source: rig.source.clone(),
            events: rig.events.clone(),
            detector: Arc::new(|| Box::new(crate::audio::vad::EnergyDetector { floor_rms: 0.01 })),
            transcriber: Arc::new(move |_| {
                if with_model {
                    Ok(Arc::new(CountingTranscriber) as Arc<dyn Transcriber>)
                } else {
                    Err(crate::stt::SttError::NotInstalled)
                }
            }),
            mute_system: rig.mute_system.clone(),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_killed_meeting_comes_back_with_its_audio_and_its_unheard_tail() {
        let rig = rig("recover", true).await;
        killed_meeting(&rig).await;
        assert!(rig
            .store
            .meeting("m_1")
            .await
            .unwrap()
            .unwrap()
            .is_unfinished());

        let recovered = recover(&deps(&rig, true), "m_1", "test").await.unwrap();
        assert_eq!(recovered.duration_ms, 13_500);
        assert_eq!(recovered.segments_added, 1);

        let meeting = rig.store.meeting("m_1").await.unwrap().unwrap();
        assert!(!meeting.is_unfinished());
        assert_eq!(meeting.duration_ms, 13_500);

        // The segment from before the kill is untouched; the utterance after
        // it has been transcribed, at its place in the recording.
        let segments = rig.store.segments("m_1").await.unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].id, "s_first");
        assert!(segments[1].t0_ms.abs_diff(5_000) < 250, "{segments:?}");
        assert!(segments[1].t1_ms.abs_diff(9_200) < 250, "{segments:?}");

        // 13.5 s of peaks, and the last file is a valid WAV again.
        assert_eq!(
            std::fs::read(peaks_path(&rig.data_dir, "m_1"))
                .unwrap()
                .len(),
            270
        );
        let last = chunk_path(&audio_dir(&rig.data_dir, "m_1", SourceKind::Laptop), 1);
        assert_eq!(hound::WavReader::open(last).unwrap().len(), 56_000);

        // A recovered meeting is finished: it is not recovered twice.
        assert_eq!(
            recover(&deps(&rig, true), "m_1", "test").await,
            Err(SessionError::AlreadyRecorded)
        );
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_a_model_the_audio_is_recovered_and_nothing_is_transcribed() {
        let rig = rig("recover-nomodel", false).await;
        killed_meeting(&rig).await;

        let recovered = recover(&deps(&rig, false), "m_1", "test").await.unwrap();
        assert_eq!(recovered.duration_ms, 13_500);
        assert_eq!(recovered.segments_added, 0);
        assert_eq!(rig.store.segments("m_1").await.unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_meeting_killed_before_any_audio_was_saved_is_closed_empty() {
        let rig = rig("recover-empty", true).await;
        meeting(&rig.store, "m_1").await;
        rig.store.mark_started("m_1", true).await.unwrap();

        let recovered = recover(&deps(&rig, true), "m_1", "test").await.unwrap();
        assert_eq!((recovered.duration_ms, recovered.segments_added), (0, 0));
        assert!(!rig
            .store
            .meeting("m_1")
            .await
            .unwrap()
            .unwrap()
            .is_unfinished());
        assert_eq!(
            recover(&deps(&rig, true), "m_none", "test").await,
            Err(SessionError::NotFound)
        );
        let _ = std::fs::remove_dir_all(&rig.data_dir);
    }
}
