// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SegmentFinal } from '../ipc'
import { cardsIn, topicsUnder } from './model'
import type { StructurerInput, StructurerProvider } from './providers/types'
import { buildInput, Structurer } from './structurer'
import { headerNamed, testStore } from './testing'

const words = (count: number) => Array(count).fill('word').join(' ')

/** Segment `n` runs from (n-1)·10 s to n·10 s − 0.5 s and carries 10 words. */
function segment(
  n: number,
  overrides: Partial<SegmentFinal> = {}
): SegmentFinal {
  return {
    id: `s${String(n).padStart(3, '0')}`,
    meeting_id: 'm_test',
    t0_ms: (n - 1) * 10_000,
    t1_ms: n * 10_000 - 500,
    speaker_label: 'Matt',
    source: 'laptop',
    text: words(10),
    confidence: 1,
    ...overrides,
  }
}

interface Call {
  input: StructurerInput
  resolve: (reply: unknown) => void
  reject: (error: Error) => void
}

/** A provider the test answers by hand, so runs can be held open. */
function manualProvider() {
  const calls: Call[] = []
  const provider: StructurerProvider = {
    name: 'manual',
    local: true,
    structure: input =>
      new Promise((resolve, reject) => calls.push({ input, resolve, reject })),
  }
  return { provider, calls }
}

const ids = (call: Call | undefined) =>
  call?.input.new_segments.map(row => row.id)

function setUp() {
  const store = testStore()
  const manual = manualProvider()
  const onRun = vi.fn()
  const structurer = new Structurer({ store, provider: manual.provider, onRun })
  const feed = (from: number, to: number) => {
    for (let n = from; n <= to; n++) structurer.segmentFinal(segment(n))
  }
  return { store, structurer, feed, onRun, ...manual }
}

describe('Structurer', () => {
  it('runs when the trigger fires, with the segments heard since', async () => {
    const { structurer, feed, calls } = setUp()
    feed(1, 4)
    expect(calls).toHaveLength(0)

    // Segment 5 ends at 49.5 s: 45 s have passed and 50 words are new.
    feed(5, 5)
    expect(calls).toHaveLength(1)
    expect(ids(calls[0])).toEqual(['s001', 's002', 's003', 's004', 's005'])
    expect(calls[0]?.input.now_ms).toBe(49_500)

    calls[0]?.resolve({ ops: [] })
    await structurer.idle()
    expect(structurer.runs).toMatchObject([
      { index: 0, reason: 'elapsed', dueAtMs: 49_500, applied: 0 },
    ])
  })

  it('leaves the segment after a silence for the next run', () => {
    const { structurer, calls } = setUp()
    structurer.segmentFinal(segment(1, { text: words(30) }))
    structurer.segmentFinal(segment(2, { t0_ms: 12_000, t1_ms: 15_000 }))
    expect(ids(calls[0])).toEqual(['s001'])
    expect(structurer.runs[0]).toMatchObject({
      reason: 'silence',
      dueAtMs: 11_500,
    })
  })

  it('keeps one run in flight and gives the next everything new', async () => {
    const { structurer, feed, calls, onRun } = setUp()
    feed(1, 5)
    expect(calls).toHaveLength(1)

    // Two more triggers fire while the first run is still out.
    feed(6, 10)
    feed(11, 15)
    feed(16, 17)
    expect(calls).toHaveLength(1)
    expect(structurer.busy).toBe(true)

    calls[0]?.resolve([])
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    // Nothing skipped: the queued run carries both triggers' segments, and
    // the two that had not triggered anything yet.
    expect(ids(calls[1])).toEqual(
      Array.from({ length: 12 }, (_, i) => `s${String(i + 6).padStart(3, '0')}`)
    )
    expect(onRun).toHaveBeenCalledTimes(1)

    calls[1]?.resolve([])
    await structurer.idle()
    expect(structurer.busy).toBe(false)
    expect(structurer.runs.map(run => run.segmentIds.length)).toEqual([5, 12])

    // Runs never overlapped, and every segment went out exactly once.
    const sent = calls.flatMap(call => ids(call) ?? [])
    expect(sent).toHaveLength(17)
    expect(new Set(sent).size).toBe(17)
  })

  it('structures what is left when the meeting ends', async () => {
    const { structurer, feed, calls } = setUp()
    feed(1, 2)
    structurer.end()
    expect(ids(calls[0])).toEqual(['s001', 's002'])
    expect(structurer.runs[0]?.reason).toBe('end')

    calls[0]?.resolve([])
    await structurer.idle()
    structurer.end()
    expect(calls).toHaveLength(1)
  })

  it('ignores a segment it has already heard', () => {
    const { structurer, calls } = setUp()
    structurer.segmentFinal(segment(1))
    structurer.segmentFinal(segment(1))
    structurer.end()
    expect(ids(calls[0])).toEqual(['s001'])
  })

  it('applies the reply through the rules and records what was dropped', async () => {
    const { store, structurer, feed, calls } = setUp()
    const cla = headerNamed(store, 'CLA quote')
    feed(1, 5)
    calls[0]?.resolve({
      ops: [
        {
          op: 'add_topic',
          tmp_key: 'p',
          title: 'Pricing',
          parent_id: cla.id,
          off_agenda: false,
          segment_ids: ['s002'],
        },
        {
          op: 'add_card',
          tmp_topic: 'p',
          kind: 'note',
          text: 'Under forty a set',
          segment_ids: ['s004'],
        },
        // Cites a segment the meeting has not reached.
        {
          op: 'add_card',
          tmp_topic: 'p',
          kind: 'note',
          text: 'From the future',
          segment_ids: ['s030'],
        },
        { op: 'delete_topic', topic_id: cla.id },
      ],
    })
    await structurer.idle()

    const [pricing] = topicsUnder(store.getState(), cla.id)
    expect(cardsIn(store.getState(), pricing?.id ?? '')).toMatchObject([
      { text: 'Under forty a set', created_t_ms: 30_000 },
    ])
    expect(structurer.runs[0]).toMatchObject({ applied: 2 })
    expect(structurer.dropped.map(drop => [drop.op, drop.reason])).toEqual([
      ['add_card', 'no_segments'],
      ['delete_topic', 'not_in_schema'],
    ])
  })

  it('keeps the segments of a failed run for the next one', async () => {
    const { provider, calls } = manualProvider()
    const log = vi.fn()
    const structurer = new Structurer({ store: testStore(), provider, log })
    const feed = (from: number, to: number) => {
      for (let n = from; n <= to; n++) structurer.segmentFinal(segment(n))
    }

    feed(1, 5)
    // The run is tried twice with the same input before it gives up.
    calls[0]?.reject(new Error('timed out'))
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(ids(calls[1])).toEqual(ids(calls[0]))
    // More of the meeting arrives, and another trigger, while it is out.
    feed(6, 10)
    calls[1]?.reject(new Error('connection refused'))

    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(structurer.runs[0]).toMatchObject({
      error: 'connection refused',
      applied: 0,
    })
    expect(log).toHaveBeenCalledWith('structurer run failed', {
      run: 0,
      provider: 'manual',
      error: 'connection refused',
    })

    // The next run leads with the segments that failed, in meeting order.
    expect(ids(calls[2])).toEqual(
      Array.from({ length: 10 }, (_, i) => `s${String(i + 1).padStart(3, '0')}`)
    )
    calls[2]?.resolve([])
    await structurer.idle()
    expect(structurer.runs[1]?.error).toBeUndefined()
    expect(structurer.runs).toHaveLength(2)
  })

  it('recovers when the first attempt fails and the second works', async () => {
    const { store, structurer, feed, calls } = setUp()
    feed(1, 5)
    calls[0]?.reject(new Error('busy'))
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    calls[1]?.resolve([])
    await structurer.idle()
    expect(structurer.runs).toMatchObject([{ applied: 0 }])
    expect(structurer.runs[0]?.error).toBeUndefined()
    expect(store.now).toBe(49_500)
  })

  it('moves the meeting clock as segments arrive', () => {
    const { store, feed } = setUp()
    feed(1, 3)
    expect(store.now).toBe(29_500)
  })
})

describe('buildInput', () => {
  it('describes the map and the transcript the way the prompt expects', async () => {
    const { store, structurer, feed, calls } = setUp()
    const cla = headerNamed(store, 'CLA quote')
    feed(1, 5)
    calls[0]?.resolve([
      {
        op: 'add_topic',
        tmp_key: 'p',
        title: 'Pricing',
        parent_id: cla.id,
        segment_ids: ['s001'],
      },
      ...[1, 2, 3].map(n => ({
        op: 'add_card',
        tmp_topic: 'p',
        kind: 'note',
        text: `Note ${n}`,
        segment_ids: [`s00${n}`],
      })),
      { op: 'add_topic', tmp_key: 'x', title: 'Aircon', off_agenda: true },
    ])
    await structurer.idle()
    feed(6, 10)

    const input = calls[1]?.input
    expect(input?.agenda.map(row => row.title)).toEqual([
      'CLA quote',
      'Supplier delays',
      'Designer hire',
    ])
    // The provider is shown aliases, not the map's ids (aliases.ts).
    expect(input?.agenda[0]?.id).toBe('H1')
    expect(input?.outline).toMatchObject([
      {
        title: 'Pricing',
        id: 'T1',
        parent_id: 'H1',
        header: 'CLA quote',
        off_agenda: false,
        // The last two cards only.
        last_cards: [
          { kind: 'note', text: 'Note 2' },
          { kind: 'note', text: 'Note 3' },
        ],
      },
      { title: 'Aircon', off_agenda: true, last_cards: [] },
    ])
    expect(input?.recent_structured.split('\n')).toEqual(
      [1, 2, 3, 4, 5].map(n => `[s00${n}] Matt: ${words(10)}`)
    )
    expect(input?.new_segments[0]).toEqual({
      id: 's006',
      t0: 50_000,
      speaker: 'Matt',
      text: words(10),
    })
    expect(input?.participants).toEqual(['Matt', 'Zach', 'Ant', 'Kabs'])
    expect(input?.now_ms).toBe(99_500)
  })

  it('shows only the last 90 s of what is already structured', () => {
    const store = testStore()
    const old = Array.from({ length: 20 }, (_, i) => segment(i + 1))
    const batch = [segment(21)]
    const recent = old.filter(row => row.t1_ms >= 200_000 - 90_000)
    const input = buildInput(store.getState(), recent, batch, 209_500)
    expect(input.recent_structured.split('\n')[0]).toMatch(/^\[s012\]/)
    expect(input.outline).toEqual([])
  })
})
