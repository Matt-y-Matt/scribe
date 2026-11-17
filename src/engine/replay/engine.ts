import type { IdSource } from '../ids'
import type { StructurerProvider } from '../providers/types'
import { MapStore } from '../store'
import { Structurer, type RunRecord } from '../structurer'
import type { FixtureMeta, FixtureSegment } from './fixture'
import {
  replay,
  REPLAY_MEETING_ID,
  type ReplayOptions,
  type ReplaySummary,
  type SegmentSink,
} from './replay'

// The map engine as a replay sink: the fixture plays into the structurer the
// way the Rust core will feed it in a live meeting, and the result is the map
// that meeting would have produced.

export interface EngineReplayOptions extends ReplayOptions {
  ids?: IdSource
  /**
   * Play as fast as the structurer allows, waiting for each run to finish
   * before the next segment. Every run then gets exactly the batch its
   * trigger asked for, as in a live meeting with a model that keeps up.
   * `speed` and `clock` are ignored.
   */
  paced?: boolean
  /** A second sink that hears the same segments, e.g. the console. */
  also?: SegmentSink
  onRun?: (run: RunRecord) => void
  log?: (message: string, context: Record<string, unknown>) => void
}

export interface EngineReplay {
  store: MapStore
  structurer: Structurer
  summary: ReplaySummary
}

/** A new, empty map for the meeting a fixture describes. */
export function storeForFixture(
  meta: FixtureMeta,
  meetingId: string = REPLAY_MEETING_ID,
  ids?: IdSource
): MapStore {
  return new MapStore({
    meeting: {
      id: meetingId,
      title: meta.title,
      mode: meta.mode,
      participants: meta.participants,
    },
    agenda: meta.agenda,
    ids,
  })
}

/** Plays a fixture through the structurer and waits for its last run. */
export async function replayIntoEngine(
  segments: readonly FixtureSegment[],
  meta: FixtureMeta,
  provider: StructurerProvider,
  options: EngineReplayOptions = {}
): Promise<EngineReplay> {
  const { ids, also, onRun, log, paced, ...replayOptions } = options
  const store = storeForFixture(meta, replayOptions.meetingId, ids)
  const structurer = new Structurer({ store, provider, onRun, log })

  const summary = await replay(
    segments,
    {
      segmentFinal(event) {
        also?.segmentFinal(event)
        structurer.segmentFinal(event)
      },
      end(done) {
        structurer.end()
        also?.end?.(done)
      },
    },
    paced
      ? {
          ...replayOptions,
          // Never ahead of schedule, so the replay asks to wait before every
          // segment, and waiting means letting the structurer finish.
          clock: { now: () => 0, sleep: () => structurer.idle() },
        }
      : replayOptions
  )
  await structurer.idle()
  return { store, structurer, summary }
}
