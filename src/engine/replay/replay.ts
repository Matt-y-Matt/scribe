import type { SegmentFinal } from '../../ipc'
import { toSegmentFinal, type FixtureSegment } from './fixture'

/**
 * Whatever receives a meeting's transcript. During a live meeting the Rust
 * core feeds it; during a replay this harness does. M0 ships a console sink
 * (`scripts/replay.ts`); the map engine becomes one in M1.
 */
export interface SegmentSink {
  segmentFinal(event: SegmentFinal): void
  end?(summary: ReplaySummary): void
}

/** Wall-clock time, injectable so tests do not have to wait. */
export interface ReplayClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export interface ReplayOptions {
  /** Playback speed; 10 plays a ten-minute meeting in one. Default 1. */
  speed?: number
  meetingId?: string
  clock?: ReplayClock
  signal?: AbortSignal
}

export interface ReplaySummary {
  segments: number
  /** Meeting time covered, in ms. */
  meetingMs: number
  /** Wall time the replay took, in ms. */
  wallMs: number
  speed: number
}

export const REPLAY_MEETING_ID = 'm_replay'

const systemClock: ReplayClock = {
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/**
 * Plays a transcript into a sink without audio. A segment is emitted at the
 * moment it would have become final, the end of its utterance, divided by the
 * speed. Emission is scheduled against the start of the replay, so the gaps
 * between utterances keep their length and a slow sink cannot stretch them.
 */
export async function replay(
  segments: readonly FixtureSegment[],
  sink: SegmentSink,
  options: ReplayOptions = {}
): Promise<ReplaySummary> {
  const {
    speed = 1,
    meetingId = REPLAY_MEETING_ID,
    clock = systemClock,
    signal,
  } = options

  if (!Number.isFinite(speed) || speed <= 0) {
    throw new RangeError(`speed must be a positive number, got ${speed}`)
  }

  const start = clock.now()
  let meetingMs = 0

  for (const segment of segments) {
    signal?.throwIfAborted()
    const event = toSegmentFinal(segment, meetingId)
    const wait = start + event.t1_ms / speed - clock.now()
    if (wait > 0) await clock.sleep(wait)
    signal?.throwIfAborted()

    sink.segmentFinal(event)
    meetingMs = Math.max(meetingMs, event.t1_ms)
  }

  const summary: ReplaySummary = {
    segments: segments.length,
    meetingMs,
    wallMs: Math.round(clock.now() - start),
    speed,
  }
  sink.end?.(summary)
  return summary
}
