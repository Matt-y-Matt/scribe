//! The transcript cleaned up after Stop, by a second speech model.
//!
//! Parakeet keeps up with a meeting; Qwen3-ASR does not, but hears whole
//! sentences better: on the first real call it wrote "Chinese New Year"
//! where Parakeet wrote "high cost chin years all" (docs/NOTES.md,
//! 2026-11-20). So once a meeting is over, each line of its transcript is
//! heard again from the recording, at the times the live model gave it, and
//! the new text replaces the old where it can be trusted:
//!
//! - the line is at least two seconds long: on shorter clips Qwen3-ASR
//!   often makes something up;
//! - the new text is in Latin script: given English it sometimes answers in
//!   Chinese, and the model has no setting to stop that;
//! - it is not far longer than the time allows, nor than what the live
//!   model heard: a made-up sentence is, and so is the other side of a call
//!   coming through the microphone, which Qwen3-ASR hears where Parakeet
//!   lets it go;
//! - it still has most of the live line's words: a better hearing of the
//!   same sentence, not another one. A live line too short to compare
//!   against stands.
//!
//! On the Edwin call these rules took 156 of the 196 lines Qwen3-ASR heard
//! differently and refused 39, nearly all of them made up or leaked.
//!
//! Lines keep their ids and times, so the map's cards still point at them,
//! and the live text is kept beside the new one. Nothing is deleted.

use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::audio_dir;
use crate::audio::writer::read_samples;
use crate::audio::{samples_of_ms, SourceKind};
use crate::ipc::SegmentFinal;
use crate::store::Store;
use crate::stt::Transcriber;

/// Shorter than this, the live text stands.
const MIN_MS: u32 = 2_000;
/// Fast speech is about four words a second; more than this is invented.
const MAX_WORDS_PER_S: f32 = 5.0;
/// Audio either side of the line, so a cut-off first or last word is heard.
const PAD_MS: u32 = 150;
/// The share of the live line's words the new text must still have (by
/// their first three letters: "years" is heard again as "Year").
const MIN_KEPT: f32 = 0.4;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Cleaned {
    pub meeting_id: String,
    /// Lines heard again.
    pub lines: u32,
    /// Lines whose text changed.
    pub changed: u32,
}

/// True for a character of a script the meeting is not held in: Chinese,
/// Japanese, Korean, and the replacement character a broken decode leaves.
fn foreign(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF | 0x2E80..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F | 0xFF00..=0xFFEF | 0x20000..=0x2FA1F)
        || c == '\u{FFFD}'
}

/// Spelled-out letters as the word people write: "S V G" is "SVG", and
/// "P N G P D F" is "PNG PDF". A run of letters is joined when it is two to
/// four long, or cut into threes when it divides by three; any other run is
/// left as it was, since where its words end cannot be told.
pub fn join_letters(text: &str) -> String {
    fn flush(run: &mut Vec<char>, tail: &str, out: &mut Vec<String>) {
        if run.is_empty() {
            return;
        }
        let letters: String = run.iter().collect();
        let mut words: Vec<String> = if run.len() <= 4 {
            vec![letters]
        } else if run.len() % 3 == 0 {
            run.chunks(3).map(|chunk| chunk.iter().collect()).collect()
        } else {
            run.iter().map(|c| c.to_string()).collect()
        };
        if let Some(last) = words.last_mut() {
            last.push_str(tail);
        }
        out.extend(words);
        run.clear();
    }

    let mut out = Vec::new();
    let mut run: Vec<char> = Vec::new();
    for word in text.split(' ') {
        let core = word.trim_end_matches([',', '.', '?', '!', ';', ':']);
        let mut chars = core.chars();
        // A single capital. "I" starts no run of its own: it is a word.
        let letter = match (chars.next(), chars.next()) {
            (Some(c), None) if c.is_ascii_uppercase() && (c != 'I' || !run.is_empty()) => Some(c),
            _ => None,
        };
        match letter {
            Some(c) => {
                run.push(c);
                // Punctuation after a letter ends its run.
                if core.len() < word.len() {
                    flush(&mut run, &word[core.len()..], &mut out);
                }
            }
            None => {
                flush(&mut run, "", &mut out);
                out.push(word.to_string());
            }
        }
    }
    flush(&mut run, "", &mut out);
    out.join(" ")
}

/// The text a line should have: the second model's where it can be trusted,
/// otherwise `None` and the live text stands.
pub fn choose(live: &str, heard: &str, length_ms: u32) -> Option<String> {
    let heard = join_letters(heard.trim());
    if heard.is_empty() || length_ms < MIN_MS || heard.chars().any(foreign) {
        return None;
    }
    let count = |text: &str| text.split_whitespace().count();
    let words = count(&heard);
    if words as f32 > MAX_WORDS_PER_S * length_ms as f32 / 1000.0 + 2.0 {
        return None;
    }
    // Far more than the live model heard is the other side of a call coming
    // through the microphone, or a sentence made up to fill a pause.
    if words > count(live) * 2 + 4 {
        return None;
    }
    // A better hearing of the same words, not other words. Where the live
    // line has too little to compare against, it stands.
    let said = content_words(live);
    if said.len() < 2 {
        return None;
    }
    let heard_stems: Vec<String> = content_words(&heard)
        .into_iter()
        .map(|word| word.chars().take(3).collect())
        .collect();
    let kept = said
        .iter()
        .filter(|word| heard_stems.contains(&word.chars().take(3).collect()))
        .count();
    if (kept as f32) < MIN_KEPT * said.len() as f32 {
        return None;
    }
    (heard != live.trim()).then_some(heard)
}

/// The words of a line that carry meaning: three letters or more, and not
/// the filler every line has.
fn content_words(text: &str) -> Vec<String> {
    const FILLER: &[&str] = &[
        "yeah", "yes", "yep", "okay", "uh", "um", "mm", "hmm", "like", "so", "and", "but", "the",
        "that", "this", "then", "just", "you", "know", "really",
    ];
    text.to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .filter(|word| word.chars().count() >= 3 && !FILLER.contains(word))
        .map(str::to_string)
        .collect()
}

fn source_of(segment: &SegmentFinal) -> Option<SourceKind> {
    SourceKind::ALL
        .into_iter()
        .find(|source| source.id() == segment.source)
}

/// Hears every line of `segments` again from the recording in `data_dir`
/// and returns the lines whose text should change. Blocking: run it off the
/// async runtime. `progress` hears how many lines are done, of how many.
pub fn clean_lines(
    data_dir: &Path,
    segments: &[SegmentFinal],
    transcriber: &dyn Transcriber,
    progress: &dyn Fn(u32, u32),
) -> Vec<(String, String)> {
    let total = segments.len() as u32;
    let mut changes = Vec::new();
    for (index, segment) in segments.iter().enumerate() {
        progress(index as u32, total);
        let length_ms = segment.t1_ms.saturating_sub(segment.t0_ms);
        // Not worth hearing again: the live text would stand anyway.
        if length_ms < MIN_MS {
            continue;
        }
        let Some(source) = source_of(segment) else {
            continue;
        };
        let start_ms = segment.t0_ms.saturating_sub(PAD_MS);
        let end_ms = segment.t1_ms + PAD_MS;
        let samples = read_samples(
            &audio_dir(data_dir, &segment.meeting_id, source),
            samples_of_ms(start_ms),
            (samples_of_ms(end_ms) - samples_of_ms(start_ms)) as usize,
        );
        if samples.is_empty() {
            continue;
        }
        let heard = transcriber.transcribe(&samples).text;
        if let Some(text) = choose(&segment.text, &heard, length_ms) {
            changes.push((segment.id.clone(), text));
        }
    }
    progress(total, total);
    changes
}

/// Cleans up the transcript of `meeting_id` and saves it.
pub async fn clean(
    store: &Store,
    data_dir: &Path,
    meeting_id: &str,
    transcriber: std::sync::Arc<dyn Transcriber>,
    progress: impl Fn(u32, u32) + Send + 'static,
) -> Result<Cleaned, String> {
    let segments = store
        .segments(meeting_id)
        .await
        .map_err(|error| error.to_string())?;
    let lines = segments.len() as u32;
    let data_dir = data_dir.to_path_buf();
    let changes = tokio::task::spawn_blocking(move || {
        clean_lines(&data_dir, &segments, transcriber.as_ref(), &progress)
    })
    .await
    .map_err(|error| error.to_string())?;
    store
        .clean_segments(meeting_id, &changes)
        .await
        .map_err(|error| error.to_string())?;
    log::info!(
        "transcript cleaned: {} of {lines} lines changed",
        changes.len()
    );
    Ok(Cleaned {
        meeting_id: meeting_id.to_string(),
        lines,
        changed: changes.len() as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_whole_sentence_heard_better_replaces_the_live_one() {
        assert_eq!(
            choose(
                "Uh my be uh might be high cost chin years all.",
                "Uh, might be hard because Chinese New Year also.",
                6_000
            ),
            Some("Uh, might be hard because Chinese New Year also.".to_string())
        );
    }

    #[test]
    fn the_live_text_stands_where_the_second_model_is_not_to_be_trusted() {
        // Too short.
        assert_eq!(
            choose(
                "You can only make it by January.",
                "Yeah, but I just think that.",
                1_700
            ),
            None
        );
        // Another script.
        assert_eq!(choose("Okay, we'll cut it.", "我给你摸摸。", 2_500), None);
        assert_eq!(choose("I don't get it.", "我 don't get it.", 3_000), None);
        assert_eq!(choose("Yeah.", "\u{FFFD}", 3_000), None);
        // Far more words than two seconds hold.
        assert_eq!(
            choose(
                "Okay.",
                "So that feature will still be okay because we are taking it from their visuals",
                2_100
            ),
            None
        );
        // Nothing heard, or nothing different.
        assert_eq!(choose("Okay.", "  ", 3_000), None);
        assert_eq!(choose("Same words.", "Same words.", 3_000), None);
        // The other side of the call, heard through the microphone.
        assert_eq!(
            choose(
                "Oh.",
                "No, the the generation also is from like the German or whatever.",
                3_700
            ),
            None
        );
        // Other words altogether.
        assert_eq!(
            choose("Like a marker thing.", "It's like a virtual office.", 2_700),
            None
        );
        // A sentence tacked on: far more than the live model heard.
        assert_eq!(
            choose(
                "Looking at manufacturers.",
                "Then they actually outsource everything, so we don't have to look at manufacturers.",
                9_100
            ),
            None
        );
    }

    #[test]
    fn a_better_hearing_of_the_same_words_is_taken() {
        assert_eq!(
            choose(
                "Not having to salt through.",
                "Not having to sort through.",
                2_200
            ),
            Some("Not having to sort through.".to_string())
        );
        assert_eq!(
            choose("Hump it or whatever.", "Homepage or whatever.", 2_600),
            Some("Homepage or whatever.".to_string())
        );
    }

    #[test]
    fn spelled_out_letters_are_written_as_one_word() {
        assert_eq!(
            join_letters("upload in the P N G P D F, but not S V G files"),
            "upload in the PNG PDF, but not SVG files"
        );
        assert_eq!(join_letters("the A I prompt"), "the AI prompt");
        assert_eq!(join_letters("I think A is fine"), "I think A is fine");
        assert_eq!(join_letters("S V G."), "SVG.");
        assert_eq!(join_letters("P D F, or S V G?"), "PDF, or SVG?");
        // Five letters: where the words end cannot be told.
        assert_eq!(join_letters("A B C D E"), "A B C D E");
    }
}
