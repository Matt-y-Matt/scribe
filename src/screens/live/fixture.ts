import { acceptSuggestion } from '@/engine/actions'
import { applyOps } from '@/engine/apply'
import { countingSource } from '@/engine/ids'
import { cardsIn, openSuggestions, type MapState } from '@/engine/model'
import { createMockReleaser, parseMockOps } from '@/engine/providers/mock'
import { storeForFixture } from '@/engine/replay/engine'
import {
  parseFixtureJsonl,
  parseFixtureMeta,
  toSegmentFinal,
} from '@/engine/replay/fixture'
import type { MapStore } from '@/engine/store'
import { buildInput } from '@/engine/structurer'
import type { SegmentFinal } from '@/ipc'
import metaText from '../../../fixtures/meeting-custore-weekly.meta.json?raw'
import transcript from '../../../fixtures/meeting-custore-weekly.jsonl?raw'
import mockOps from '../../../fixtures/meeting-custore-weekly.mock-ops.json?raw'

// The live screen's fixture states: the golden meeting replayed through the
// engine with the MockProvider, stopped where a screen state needs it. This
// is the same map the golden test scores, so what the screenshots show is
// what the engine builds.

export interface FixtureOptions {
  /** Stop after this segment. Default: the whole meeting. */
  until?: string
  /** Pin the topic with this title once this segment has been heard. */
  pins?: Record<string, string>
  /** Raise the ghosts of the `live-ghost` state at the end. */
  ghosts?: boolean
}

/** When the host tapped Pin in the fixture meeting: as the talk moved on. */
export const FIXTURE_PINS = {
  'Office aircon': 's026',
  'Christmas pop-up': 's042',
}

const topicNamed = (state: MapState, title: string) =>
  Object.values(state.topics).find(
    topic => topic.kind === 'topic' && topic.title === title
  )

export function fixtureStore(options: FixtureOptions = {}): MapStore {
  const meta = parseFixtureMeta(metaText)
  const store = storeForFixture(meta, 'm_fixture', countingSource())
  const release = createMockReleaser(parseMockOps(mockOps))
  const heard = new Map<string, SegmentFinal>()

  for (const row of parseFixtureJsonl(transcript)) {
    const segment = toSegmentFinal(row, 'm_fixture')
    heard.set(segment.id, segment)
    store.tick(segment.t1_ms)
    // One segment per run: the mock gives the same map however it is batched.
    const input = buildInput(store.getState(), [], [segment], segment.t1_ms)
    applyOps(store, release(input), { tMs: segment.t1_ms, segments: heard })

    for (const [title, at] of Object.entries(options.pins ?? {})) {
      if (at !== segment.id) continue
      const pin = openSuggestions(store.getState()).find(
        ({ payload }) => payload.kind === 'pin' && payload.title === title
      )
      if (pin) acceptSuggestion(store, pin.id)
    }
    if (segment.id === options.until) break
  }

  if (options.ghosts) {
    const state = store.getState()
    const pricing = topicNamed(state, 'Pricing')
    const names = topicNamed(state, 'Name embroidery')
    const [aboutNames] = names ? cardsIn(state, names.id) : []
    applyOps(
      store,
      [
        {
          op: 'suggest_move',
          card_id: aboutNames?.id,
          to_topic_id: pricing?.id,
          reason: 'It changes the quote',
        },
        {
          op: 'suggest_merge',
          topic_id: names?.id,
          into_topic_id: pricing?.id,
          reason: 'Both are about what goes in the CLA quote',
        },
      ],
      { tMs: store.now, segments: heard }
    )
  }
  return store
}
