// When the structurer runs, docs/ARCHITECTURE.md §3.2:
//
//   (silence ≥ 2 s && newWords ≥ 25) || (elapsedSinceRun ≥ 45 s && newWords ≥ 25)
//
// Both are measured on the meeting clock, from segment timestamps, so a replay
// at 10× fires at the same points in the meeting as a live session. A segment
// arrives when its utterance ends; the silence before it is the gap back to
// the end of the one before.

export const SILENCE_MS = 2_000
export const MAX_WAIT_MS = 45_000
export const MIN_NEW_WORDS = 25

export interface TriggerState {
  /** Meeting time of the last trigger; the meeting starts at 0. */
  lastRunMs: number
  /** Words heard since then. */
  newWords: number
  /** End of the latest segment, or null before the first. */
  lastEndMs: number | null
}

export interface TimedSegment {
  t0_ms: number
  t1_ms: number
  text: string
}

export type TriggerDecision =
  /** Nothing to do yet. */
  | { fire: null; state: TriggerState }
  /**
   * The room went quiet before this segment. The run is due at `atMs` and
   * covers what came before; this segment starts the next batch.
   */
  | { fire: 'silence'; atMs: number; state: TriggerState }
  /** Enough time has passed. The run covers this segment too. */
  | { fire: 'elapsed'; atMs: number; state: TriggerState }

export const initialTrigger = (): TriggerState => ({
  lastRunMs: 0,
  newWords: 0,
  lastEndMs: null,
})

export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/** Feeds one final segment to the trigger and says whether a run is due. */
export function onSegment(
  state: TriggerState,
  segment: TimedSegment
): TriggerDecision {
  const words = countWords(segment.text)
  const lastEndMs = Math.max(segment.t1_ms, state.lastEndMs ?? 0)

  const silence = state.lastEndMs === null ? 0 : segment.t0_ms - state.lastEndMs
  if (silence >= SILENCE_MS && state.newWords >= MIN_NEW_WORDS) {
    const atMs = (state.lastEndMs ?? 0) + SILENCE_MS
    return {
      fire: 'silence',
      atMs,
      state: { lastRunMs: atMs, newWords: words, lastEndMs },
    }
  }

  const newWords = state.newWords + words
  if (
    segment.t1_ms - state.lastRunMs >= MAX_WAIT_MS &&
    newWords >= MIN_NEW_WORDS
  ) {
    return {
      fire: 'elapsed',
      atMs: segment.t1_ms,
      state: { lastRunMs: segment.t1_ms, newWords: 0, lastEndMs },
    }
  }

  return { fire: null, state: { ...state, newWords, lastEndMs } }
}

/** After a run that took everything heard so far: start counting afresh. */
export function afterRun(state: TriggerState, atMs: number): TriggerState {
  return { ...state, lastRunMs: Math.max(state.lastRunMs, atMs), newWords: 0 }
}
