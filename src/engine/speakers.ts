import type { SegmentFinal } from '../ipc'
import { toTurns, type Turn } from './turns'

// Who is speaking, as far as the app can tell without voiceprints (those are
// v1.1). The core labels a line by where it was heard: `Room` for this PC's
// microphone, `System audio` for what the PC plays. A model cannot give an
// action to "Room", so where the meeting's own facts settle it, the label
// becomes a name before the note-taker and the summary read the line:
//
// - on a call (system audio recorded) the microphone is the person at this
//   PC, who is the first name on the meeting's list of people;
// - if exactly one other person is listed, the system audio is that person;
// - with nobody else listed in the room, the microphone is the one person.
//
// Anything else stays as the core labelled it. The transcript on screen and
// in the database is not touched.

export interface SpeakerNames {
  laptop?: string
  system?: string
}

export function speakerNames(
  participants: readonly string[],
  loopback: boolean
): SpeakerNames {
  const [first, second] = participants
  if (!first) return {}
  if (loopback) {
    return participants.length === 2
      ? { laptop: first, system: second }
      : { laptop: first }
  }
  return participants.length === 1 ? { laptop: first } : {}
}

/** The segment with its speaker named, when the meeting's facts name them. */
export function named(
  segment: SegmentFinal,
  names: SpeakerNames
): SegmentFinal {
  const name =
    segment.source === 'laptop'
      ? names.laptop
      : segment.source === 'system'
        ? names.system
        : undefined
  return name ? { ...segment, speaker_label: name } : segment
}

/** A meeting's transcript as turns, with the speakers named where known. */
export function meetingTurns(
  segments: readonly SegmentFinal[],
  names: SpeakerNames
): Turn[] {
  return toTurns(
    segments.map(segment => ({
      id: segment.id,
      t0: segment.t0_ms,
      t1: segment.t1_ms,
      speaker: named(segment, names).speaker_label,
      source: segment.source,
      text: segment.text,
    }))
  )
}
