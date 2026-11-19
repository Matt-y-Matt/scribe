import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Highlight, OpenAction, RecState, SegmentFinal } from '@/ipc'

// What the live screen knows about the meeting besides its map: whether it
// is being recorded, the transcript, the levels, the waveform, playback.
// The app fills this from the Rust core's events (LiveMeeting.tsx); the
// `?screen=` fixtures and the tests fill it by hand. The parts of the screen
// read it with selectors and act through `SessionActions`.

export interface SessionState {
  meetingId: string
  title: string
  rec: RecState
  /** The meeting clock. In review, the length of the recording. */
  elapsedMs: number
  /** A finished meeting, opened to read and play back (UI_SPEC §3.4). */
  review: boolean
  /**
   * What a finished meeting shows: its map and recording, or the end screen
   * (UI_SPEC §3.3), which Stop goes to.
   */
  view: 'map' | 'wrap'
  /** Created and never recorded: opened from the list, not from Start. */
  notStarted: boolean
  /** Recording could not start: the PC has no microphone. */
  noMic: boolean
  /** The microphone stopped delivering audio mid-meeting. */
  micLost: boolean
  /** No speech model: the meeting is recorded, the transcript is off. */
  modelMissing: boolean
  /**
   * The model that writes the map did not answer the last time it was
   * asked. The meeting is still recorded and transcribed.
   */
  notesOff: boolean
  /** System audio is being recorded too. */
  loopback: boolean
  segments: readonly SegmentFinal[]
  levels: { laptop: number; system: number }
  /** 20 per second of meeting, each 0–255. */
  peaks: readonly number[]
  playback: { playing: boolean; tMs: number }
  highlights: readonly Highlight[]
  /**
   * Actions still open from earlier meetings with this meeting's title:
   * what the host reads out first. Empty in review.
   */
  lastTime: readonly OpenAction[]
  /** The ones of those ticked done since this meeting was opened. */
  lastTimeDone: readonly string[]
  /** The notes of a finished meeting being written again: lines read so far. */
  rebuilding: { done: number; of: number } | null
}

export interface SessionActions {
  pause(): void
  resume(): void
  stop(): void
  /** Start recording: a first time, or again once a microphone is there. */
  retry(): void
  /** Full-text search of this meeting's transcript. */
  search(query: string): Promise<SegmentFinal[]>
  /** Play the recording from `tMs` to its end. */
  seekPlay(tMs: number): void
  /** Play one span: a segment, a card, a highlight. */
  playSpan(t0Ms: number, t1Ms: number): void
  stopPlayback(): void
  addHighlight(t0Ms: number, t1Ms: number, label: string): void
  removeHighlight(highlightId: string): void
  openSettings(tab: 'audio' | 'speech'): void
  /** Marks an action from an earlier meeting done, or open again. */
  setDone(cardId: string, done: boolean): void
  /** To the end screen: confirm who owes what, write the summary. */
  wrapUp(): void
  /** Back from the end screen to the map and the recording. */
  showMap(): void
  /** Back to Home. */
  leave(): void
  /**
   * A finished meeting: take out the notes the model made and have it read
   * the transcript again, with the note-taker as it is now.
   */
  rebuild(): void
}

export type SessionStore = StoreApi<SessionState>

export const emptySession = (
  meetingId: string,
  title: string
): SessionState => ({
  meetingId,
  title,
  rec: 'idle',
  elapsedMs: 0,
  review: false,
  view: 'map',
  notStarted: false,
  noMic: false,
  micLost: false,
  modelMissing: false,
  notesOff: false,
  loopback: false,
  segments: [],
  levels: { laptop: 0, system: 0 },
  peaks: [],
  playback: { playing: false, tMs: 0 },
  highlights: [],
  lastTime: [],
  lastTimeDone: [],
  rebuilding: null,
})

export function createSessionStore(initial: SessionState): SessionStore {
  return createStore<SessionState>(() => initial)
}

/** Adds a segment in meeting order; two sources may finish out of order. */
export function withSegment(
  segments: readonly SegmentFinal[],
  segment: SegmentFinal
): readonly SegmentFinal[] {
  if (segments.some(known => known.id === segment.id)) return segments
  const last = segments[segments.length - 1]
  if (!last || last.t0_ms <= segment.t0_ms) return [...segments, segment]
  const at = segments.findIndex(known => known.t0_ms > segment.t0_ms)
  return [...segments.slice(0, at), segment, ...segments.slice(at)]
}

/** Lays a batch of peaks into the waveform at its place. */
export function withPeaks(
  peaks: readonly number[],
  from: number,
  batch: readonly number[]
): readonly number[] {
  if (from === peaks.length) return [...peaks, ...batch]
  const next = peaks.slice(0, from)
  // A batch that starts past the end leaves a gap of silence before it.
  while (next.length < from) next.push(0)
  return [...next, ...batch]
}

const noop = () => undefined

/** Actions that do nothing, for screens with no core behind them. */
export const idleActions: SessionActions = {
  pause: noop,
  resume: noop,
  stop: noop,
  retry: noop,
  search: async () => [],
  seekPlay: noop,
  playSpan: noop,
  stopPlayback: noop,
  addHighlight: noop,
  removeHighlight: noop,
  openSettings: noop,
  setDone: noop,
  wrapUp: noop,
  showMap: noop,
  leave: noop,
  rebuild: noop,
}
