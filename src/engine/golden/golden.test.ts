// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { countingSource } from '../ids'
import { ADDITIVE_OPS, cardsIn, headersOf, topicsUnder } from '../model'
import { createMockProvider, parseMockOps } from '../providers/mock'
import type { StructurerInput, StructurerProvider } from '../providers/types'
import { replayIntoEngine } from '../replay/engine'
import { parseFixtureJsonl, parseFixtureMeta } from '../replay/fixture'
import { instantClock } from '../testing'
import {
  acceptPinSuggestions,
  formatScore,
  parseExpected,
  scoreGolden,
} from './score'

// The golden replay test, docs/TEST_PLAN.md §2 (the M1 gate): the fixture
// meeting replayed at 10× through the engine with the MockProvider, scored
// against the answer key. `pnpm golden --provider <name>` runs the same
// scoring against a real model.

const NAME = 'meeting-custore-weekly'
const read = (suffix: string) =>
  readFileSync(
    new URL(`../../../fixtures/${NAME}${suffix}`, import.meta.url),
    'utf8'
  )
const segments = parseFixtureJsonl(read('.jsonl'))
const meta = parseFixtureMeta(read('.meta.json'))
const expected = parseExpected(read('.expected.json'))
const mock = () => createMockProvider(parseMockOps(read('.mock-ops.json')))

const play = (provider: StructurerProvider) =>
  replayIntoEngine(segments, meta, provider, {
    speed: 10,
    clock: instantClock(),
    ids: countingSource(),
  })

/** The map as text, to compare two replays whatever their ids are. */
function outline(store: Awaited<ReturnType<typeof play>>['store']) {
  const state = store.getState()
  return headersOf(state).map(header => ({
    header: header.title,
    topics: topicsUnder(state, header.id).map(topic => ({
      title: topic.title,
      cards: cardsIn(state, topic.id).map(
        card => `${card.kind} ${card.owner ?? '-'} ${card.text}`
      ),
    })),
  }))
}

describe('golden replay, MockProvider', () => {
  it('passes the M1 gate', async () => {
    const { store, structurer } = await play(mock())

    // Nothing is pinned until someone confirms.
    expect(
      Object.values(store.getState().topics).filter(
        topic => topic.status === 'pinned'
      )
    ).toEqual([])
    expect(acceptPinSuggestions(store)).toBe(2)

    const score = scoreGolden(store, expected)
    expect(formatScore(score, 'mock')).toMatchInlineSnapshot(`
      "Golden replay — mock: PASS
        topic coverage  5/5  (cla 14/15, suppliers 6/6, designer 6/6, aircon 3/3, popup 1/1)
        card match      17/17 = 100%
        wrong owners    0
        pins            aircon: suggested, pinned at end; popup: suggested, pinned at end
        never rules     0 violated"
    `)
    expect(score.topicsCovered).toBe(5)
    expect(score.cardMatch).toBeGreaterThanOrEqual(0.8)
    expect(score.wrongOwners).toEqual([])
    expect(score.neverViolations).toEqual([])
    expect(score.pass).toBe(true)

    // The mock's ops all pass the rules, and every run was applied.
    expect(structurer.dropped).toEqual([])
    expect(structurer.runs.every(run => run.error === undefined)).toBe(true)
  })

  it('logs nothing from the engine but additions', async () => {
    const { store } = await play(mock())
    const engineOps = store.log.filter(entry => entry.source === 'engine')
    expect(engineOps.length).toBeGreaterThan(40)
    for (const entry of engineOps) {
      expect(ADDITIVE_OPS).toContain(entry.type)
    }
    expect(
      store.log.filter(entry => /^(delete|rename|merge)_/.test(entry.type))
    ).toEqual([])
  })

  it('builds the same map however the transcript is batched', async () => {
    const steady = await play(mock())

    // A slow model: runs queue up behind it and take several triggers' worth
    // of segments at once.
    const inner = mock()
    const slow: StructurerProvider = {
      ...inner,
      async structure(input) {
        await new Promise(done => setTimeout(done, 5))
        return inner.structure(input)
      },
    }
    const queued = await play(slow)

    expect(queued.structurer.runs.length).toBeLessThan(
      steady.structurer.runs.length
    )
    expect(outline(queued.store)).toEqual(outline(steady.store))
  })
})

describe('golden scoring', () => {
  it('fails an empty map', async () => {
    const { store } = await play({
      name: 'silent',
      local: true,
      structure: async () => ({ ops: [] }),
    })
    acceptPinSuggestions(store)
    const score = scoreGolden(store, expected)
    expect(score).toMatchObject({
      topicsCovered: 0,
      cardsMatched: 0,
      pass: false,
    })
    expect(score.pins).toEqual([
      { key: 'aircon', suggested: false, pinnedAtEnd: false },
      { key: 'popup', suggested: false, pinnedAtEnd: false },
    ])
    expect(score.unmatched).toHaveLength(17)
  })

  /** The mock, with one op rewritten on its way to the engine. */
  function tampered(
    change: (
      op: Record<string, unknown>,
      input: StructurerInput
    ) => Record<string, unknown>[]
  ): StructurerProvider {
    const inner = mock()
    return {
      ...inner,
      async structure(input) {
        const reply = (await inner.structure(input)) as {
          ops: Record<string, unknown>[]
        }
        return { ops: reply.ops.flatMap(op => change(op, input)) }
      },
    }
  }

  async function scoreOf(provider: StructurerProvider) {
    const { store } = await play(provider)
    acceptPinSuggestions(store)
    return scoreGolden(store, expected)
  }

  it('counts an action given to the wrong person', async () => {
    const score = await scoreOf(
      tampered(op =>
        op.text === 'Write the job description'
          ? [{ ...op, owner: 'Zach' }]
          : [op]
      )
    )
    expect(score.wrongOwners).toEqual([
      {
        owner: 'Zach',
        text: 'Write the job description',
        segments: ['s034', 's035'],
      },
    ])
    expect(score.cardsMatched).toBe(16)
    expect(score.pass).toBe(false)
  })

  it('accepts either owner where one sentence carries two actions', async () => {
    // s010 holds a Matt action and a Kabs action; a third card there for
    // either of them is not a wrong owner.
    const score = await scoreOf(
      tampered(op =>
        op.text === 'Platform setup fee 7,500, one-time'
          ? [
              op,
              {
                ...op,
                kind: 'action',
                owner: 'Kabs',
                segment_ids: ['s009', 's010'],
              },
            ]
          : [op]
      )
    )
    expect(score.wrongOwners).toEqual([])
  })

  /** The mock, plus Matt's own action on s027: "…and I'll send it". */
  const withMattSending = () =>
    tampered(op =>
      op.text === 'Draft the two options for UDO'
        ? [
            op,
            {
              ...op,
              owner: 'Matt',
              text: 'Send the drafted options to UDO',
              segment_ids: ['s027'],
            },
          ]
        : [op]
    )

  it('accepts a card the key lists as also accepted, without requiring it', async () => {
    const score = await scoreOf(withMattSending())
    expect(score.wrongOwners).toEqual([])
    // Not one of the expected cards: the count is the same with or without it.
    expect([score.cardsMatched, score.cardsExpected]).toEqual([17, 17])
    expect(score.pass).toBe(true)
  })

  it('counts that card as a wrong owner when the key does not list it', async () => {
    const { store } = await play(withMattSending())
    acceptPinSuggestions(store)
    const strict = scoreGolden(store, { ...expected, also_accepted: [] })
    expect(strict.wrongOwners).toEqual([
      {
        owner: 'Matt',
        text: 'Send the drafted options to UDO',
        segments: ['s027'],
      },
    ])
    expect(strict.pass).toBe(false)
  })

  it('does not count a blank owner as a wrong one, only as unmatched', async () => {
    const score = await scoreOf(
      tampered(op =>
        op.text === 'Write the job description'
          ? [{ ...op, owner: 'Ross' }]
          : [op]
      )
    )
    expect(score.wrongOwners).toEqual([])
    expect(score.unmatched).toEqual(['action: write the job description'])
  })

  it('fails a card made from the agenda statement or the recap alone', async () => {
    const score = await scoreOf(
      tampered(op =>
        op.text === 'Message the landlord about the aircon'
          ? [op, { ...op, kind: 'note', text: 'Recap', segment_ids: ['s044'] }]
          : [op]
      )
    )
    expect(score.neverViolations).toEqual(['a card was made from s044 alone'])
    expect(score.pass).toBe(false)
  })

  it('needs each off-agenda subject under a topic of its own', async () => {
    // Everything about the pop-up filed under the aircon topic instead.
    const score = await scoreOf(
      tampered((op, input) => {
        if (op.tmp_key === 'popup' || op.tmp_key_or_topic_id === 'popup') {
          return []
        }
        if (op.tmp_topic !== 'popup') return [op]
        const aircon = input.outline.find(row => row.title === 'Office aircon')
        return [{ ...op, tmp_topic: undefined, topic_id: aircon?.id }]
      })
    )
    expect(score.pins).toEqual([
      { key: 'aircon', suggested: true, pinnedAtEnd: true },
      { key: 'popup', suggested: false, pinnedAtEnd: false },
    ])
    expect(score.pass).toBe(false)
  })

  it('needs 80% of the segments under a header cited', async () => {
    // Drop the notes on s029-s032: only the decision and the actions remain.
    const talkOnly = ['s029', 's030', 's031', 's032']
    const score = await scoreOf(
      tampered(op =>
        op.kind === 'note' && talkOnly.includes(String(op.segment_ids))
          ? []
          : [op]
      )
    )
    expect(score.topics.find(topic => topic.key === 'designer')).toEqual({
      key: 'designer',
      covered: 3,
      of: 6,
      ok: false,
    })
    expect(score.cardMatch).toBe(1)
    expect(score.pass).toBe(false)
  })
})
