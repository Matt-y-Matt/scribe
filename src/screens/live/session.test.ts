// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SegmentFinal } from '@/ipc'
import { withPeaks, withSegment } from './session'

const segment = (id: string, t0: number): SegmentFinal => ({
  id,
  meeting_id: 'm_1',
  t0_ms: t0,
  t1_ms: t0 + 1_000,
  speaker_label: 'Room',
  source: 'laptop',
  text: id,
  confidence: 1,
})

describe('withSegment', () => {
  it('appends a segment that comes in meeting order', () => {
    const next = withSegment([segment('a', 0)], segment('b', 2_000))
    expect(next.map(row => row.id)).toEqual(['a', 'b'])
  })

  it('puts a late segment where it belongs', () => {
    // The system source finished after the room, but spoke first.
    const heard = [segment('a', 0), segment('c', 5_000)]
    const next = withSegment(heard, segment('b', 2_000))
    expect(next.map(row => row.id)).toEqual(['a', 'b', 'c'])
  })

  it('ignores a segment it already has', () => {
    const heard = [segment('a', 0)]
    expect(withSegment(heard, segment('a', 0))).toBe(heard)
  })
})

describe('withPeaks', () => {
  it('appends the next batch', () => {
    expect(withPeaks([1, 2], 2, [3, 4])).toEqual([1, 2, 3, 4])
  })

  it('lays a batch over what it repeats', () => {
    // Loaded from disk, then an event for peaks already in the file.
    expect(withPeaks([1, 2, 3, 4], 2, [9, 9, 5])).toEqual([1, 2, 9, 9, 5])
  })

  it('leaves silence for peaks it never received', () => {
    expect(withPeaks([1], 3, [7])).toEqual([1, 0, 0, 7])
  })
})
