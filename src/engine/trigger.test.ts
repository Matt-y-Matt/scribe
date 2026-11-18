// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  afterRun,
  countWords,
  initialTrigger,
  onClock,
  onSegment,
  type TimedSegment,
  type TriggerState,
} from './trigger'

const words = (count: number) => Array(count).fill('word').join(' ')
const segment = (t0: number, t1: number, count: number): TimedSegment => ({
  t0_ms: t0,
  t1_ms: t1,
  text: words(count),
})

/** Feeds segments in order and returns what fired, as `reason@ms`. */
function run(segments: TimedSegment[], start: TriggerState = initialTrigger()) {
  const fired: string[] = []
  let state = start
  for (const next of segments) {
    const decision = onSegment(state, next)
    if (decision.fire) fired.push(`${decision.fire}@${decision.atMs}`)
    state = decision.state
  }
  return { fired, state }
}

describe('countWords', () => {
  it('counts words separated by any whitespace', () => {
    expect(countWords('  Okay   let’s\nstart. ')).toBe(3)
    expect(countWords('   ')).toBe(0)
  })
})

describe('trigger', () => {
  it('fires on a silence of 2 s once 25 words are waiting', () => {
    const { fired, state } = run([
      segment(0, 5_000, 25),
      segment(7_000, 9_000, 4),
    ])
    expect(fired).toEqual(['silence@7000'])
    // The segment after the silence starts the next batch.
    expect(state).toEqual({ lastRunMs: 7_000, newWords: 4, lastEndMs: 9_000 })
  })

  it('does not fire on a shorter silence', () => {
    expect(
      run([segment(0, 5_000, 40), segment(6_999, 9_000, 4)]).fired
    ).toEqual([])
  })

  it('does not fire on silence with fewer than 25 new words', () => {
    const { fired, state } = run([
      segment(0, 5_000, 24),
      segment(20_000, 21_000, 1),
    ])
    expect(fired).toEqual([])
    expect(state.newWords).toBe(25)
  })

  it('fires 45 s after the last run when nobody pauses', () => {
    const { fired, state } = run([
      segment(0, 20_000, 30),
      segment(20_500, 44_999, 30),
      segment(45_000, 45_000, 1),
    ])
    expect(fired).toEqual(['elapsed@45000'])
    expect(state).toEqual({ lastRunMs: 45_000, newWords: 0, lastEndMs: 45_000 })
  })

  it('does not fire after 45 s with fewer than 25 new words', () => {
    const { fired } = run([segment(0, 30_000, 10), segment(30_500, 90_000, 14)])
    expect(fired).toEqual([])
  })

  it('measures the 45 s from the last run, not from the start', () => {
    const { fired } = run([
      segment(0, 50_000, 30),
      segment(50_100, 94_000, 30),
      segment(94_100, 95_000, 5),
    ])
    expect(fired).toEqual(['elapsed@50000', 'elapsed@95000'])
  })

  it('fires once for one pause, however long', () => {
    const { fired } = run([
      segment(0, 5_000, 30),
      segment(125_000, 126_000, 3),
      segment(126_200, 127_000, 3),
    ])
    expect(fired).toEqual(['silence@7000'])
  })

  it('ignores the gap before the first segment', () => {
    expect(run([segment(30_000, 31_000, 30)]).fired).toEqual([])
  })

  it('counts afresh after a run that took everything', () => {
    const { state } = run([segment(0, 5_000, 20)])
    expect(afterRun(state, 5_000)).toEqual({
      lastRunMs: 5_000,
      newWords: 0,
      lastEndMs: 5_000,
    })
    // A run cannot move the clock back.
    expect(afterRun({ ...state, lastRunMs: 9_000 }, 5_000).lastRunMs).toBe(
      9_000
    )
  })
})

describe('trigger on the clock', () => {
  const heard = (count: number) => run([segment(0, 5_000, count)]).state

  it('fires once the room has been quiet for 2 s, without a next segment', () => {
    const state = heard(25)
    expect(onClock(state, 6_900).fire).toBeNull()
    const decision = onClock(state, 7_000)
    expect(decision).toMatchObject({ fire: 'silence', atMs: 7_000 })
    // The words are spent: the clock does not fire again for the same pause.
    expect(onClock(decision.state, 60_000).fire).toBeNull()
  })

  it('does not fire with fewer than 25 new words, however long the quiet', () => {
    expect(onClock(heard(24), 120_000).fire).toBeNull()
  })

  it('fires 45 s after the last run when the clock gets there first', () => {
    // Speech with no 2 s pause: the last segment ended half a second ago.
    const state: TriggerState = {
      lastRunMs: 0,
      newWords: 40,
      lastEndMs: 44_500,
    }
    expect(onClock(state, 44_900).fire).toBeNull()
    const decision = onClock(state, 45_000)
    expect(decision).toMatchObject({ fire: 'elapsed', atMs: 45_000 })
    expect(decision.state.newWords).toBe(0)
  })

  it('does nothing before the first segment', () => {
    expect(onClock(initialTrigger(), 300_000).fire).toBeNull()
  })
})
