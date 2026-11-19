// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SegmentFinal } from '../ipc'
import { named, speakerNames } from './speakers'

const segment = (source: string, label: string): SegmentFinal => ({
  id: 's1',
  meeting_id: 'm',
  t0_ms: 0,
  t1_ms: 1_000,
  speaker_label: label,
  source,
  text: 'I will send it tonight.',
  confidence: 1,
})

describe('speakerNames', () => {
  it('names both sides of a call between two people', () => {
    expect(speakerNames(['Matt', 'Zach'], true)).toEqual({
      laptop: 'Matt',
      system: 'Zach',
    })
  })

  it('names only this PC when the call has more people on the other side', () => {
    expect(speakerNames(['Matt', 'Zach', 'Ant'], true)).toEqual({
      laptop: 'Matt',
    })
    expect(speakerNames(['Matt'], true)).toEqual({ laptop: 'Matt' })
  })

  it('names the room only when one person is in it', () => {
    expect(speakerNames(['Matt'], false)).toEqual({ laptop: 'Matt' })
    expect(speakerNames(['Matt', 'Zach'], false)).toEqual({})
    expect(speakerNames([], true)).toEqual({})
  })
})

describe('named', () => {
  const names = speakerNames(['Matt', 'Zach'], true)

  it('puts the name in place of the label the core gave', () => {
    expect(named(segment('laptop', 'Room'), names).speaker_label).toBe('Matt')
    expect(named(segment('system', 'System audio'), names).speaker_label).toBe(
      'Zach'
    )
  })

  it('leaves a line alone when nothing says who spoke', () => {
    const room = segment('laptop', 'Room')
    expect(named(room, {})).toBe(room)
    const phone = segment('phone-2', 'Phone 2')
    expect(named(phone, names)).toBe(phone)
  })
})
