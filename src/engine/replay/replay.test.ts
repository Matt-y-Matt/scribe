// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SegmentFinal } from '../../ipc'
import type { FixtureSegment } from './fixture'
import { replay, type ReplayClock, type SegmentSink } from './replay'

/** A clock that only moves when the replay sleeps, so tests take no time. */
function fakeClock(): ReplayClock & { sleeps: number[] } {
  let now = 1_000_000
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => now,
    sleep: ms => {
      sleeps.push(ms)
      now += ms
      return Promise.resolve()
    },
  }
}

function recordingSink() {
  const events: SegmentFinal[] = []
  const sink: SegmentSink = { segmentFinal: event => void events.push(event) }
  return { events, sink }
}

const SEGMENTS: FixtureSegment[] = [
  { id: 'a', t0: 0, t1: 2, speaker: 'Matt', text: 'One.' },
  { id: 'b', t0: 2.5, t1: 4, speaker: 'Zach', text: 'Two.' },
  { id: 'c', t0: 10, t1: 12, speaker: 'Ant', text: 'Three.' },
]

describe('replay', () => {
  it('emits every segment once, in order, as segment:final payloads', async () => {
    const { events, sink } = recordingSink()
    await replay(SEGMENTS, sink, { clock: fakeClock(), meetingId: 'm_test' })
    expect(events.map(e => e.id)).toEqual(['a', 'b', 'c'])
    expect(events[1]).toEqual({
      id: 'b',
      meeting_id: 'm_test',
      t0_ms: 2500,
      t1_ms: 4000,
      speaker_label: 'Zach',
      source: 'laptop',
      text: 'Two.',
      confidence: 1,
    })
  })

  it('emits each segment when it ends, so silences keep their length', async () => {
    const clock = fakeClock()
    const { sink } = recordingSink()
    await replay(SEGMENTS, sink, { clock })
    // Ends at 2 s, 4 s and 12 s of meeting time: waits of 2 s, 2 s and 8 s.
    expect(clock.sleeps).toEqual([2000, 2000, 8000])
  })

  it('divides every wait by the speed', async () => {
    const clock = fakeClock()
    const { sink } = recordingSink()
    await replay(SEGMENTS, sink, { clock, speed: 10 })
    expect(clock.sleeps).toEqual([200, 200, 800])
  })

  it('schedules against the start, so a slow sink does not add drift', async () => {
    const clock = fakeClock()
    const start = clock.now()
    const times: number[] = []
    let extra = 0
    const slowClock: ReplayClock = {
      now: () => clock.now() + extra,
      sleep: ms => clock.sleep(ms),
    }
    const sink: SegmentSink = {
      segmentFinal: () => {
        times.push(slowClock.now() - start)
        extra += 50 // the sink takes 50 ms of wall time per segment
      },
    }
    await replay(SEGMENTS, sink, { clock: slowClock })
    expect(times).toEqual([2000, 4000, 12000])
  })

  it('reports what it played', async () => {
    const { sink } = recordingSink()
    const summary = await replay(SEGMENTS, sink, {
      clock: fakeClock(),
      speed: 4,
    })
    expect(summary).toEqual({
      segments: 3,
      meetingMs: 12000,
      wallMs: 3000,
      speed: 4,
    })
  })

  it('tells the sink when the replay ends', async () => {
    const ended: number[] = []
    await replay(
      SEGMENTS,
      { segmentFinal: () => undefined, end: s => void ended.push(s.segments) },
      { clock: fakeClock() }
    )
    expect(ended).toEqual([3])
  })

  it('stops between segments when aborted', async () => {
    const controller = new AbortController()
    const seen: string[] = []
    const sink: SegmentSink = {
      segmentFinal: event => {
        seen.push(event.id)
        if (event.id === 'a') controller.abort()
      },
    }
    await expect(
      replay(SEGMENTS, sink, { clock: fakeClock(), signal: controller.signal })
    ).rejects.toThrow(/abort/i)
    expect(seen).toEqual(['a'])
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a speed of %s',
    async speed => {
      const { sink } = recordingSink()
      await expect(
        replay(SEGMENTS, sink, { clock: fakeClock(), speed })
      ).rejects.toThrow(/speed/i)
    }
  )

  it('plays nothing for an empty fixture', async () => {
    const { events, sink } = recordingSink()
    const summary = await replay([], sink, { clock: fakeClock() })
    expect(events).toEqual([])
    expect(summary.segments).toBe(0)
  })
})
