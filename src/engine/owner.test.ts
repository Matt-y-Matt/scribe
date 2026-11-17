// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { jaroWinkler, matchOwner } from './owner'

const ROOM = ['Matt', 'Zach', 'Ant', 'Kabs']

describe('jaroWinkler', () => {
  it('matches the reference values', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.9611, 4)
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.8133, 4)
    expect(jaroWinkler('kabir', 'kabs')).toBeCloseTo(0.8483, 4)
    expect(jaroWinkler('same', 'same')).toBe(1)
    expect(jaroWinkler('abc', 'xyz')).toBe(0)
    expect(jaroWinkler('', 'abc')).toBe(0)
  })
})

describe('matchOwner', () => {
  it('finds the participant a name refers to', () => {
    expect(matchOwner('Kabs', ROOM)).toBe('Kabs')
    expect(matchOwner('Kabir', ROOM)).toBe('Kabs')
    expect(matchOwner('  matt. ', ROOM)).toBe('Matt')
    expect(matchOwner('ZACH', ROOM)).toBe('Zach')
    expect(matchOwner('Anto', ROOM)).toBe('Ant')
  })

  it('leaves the owner blank when nobody is close enough', () => {
    expect(matchOwner('Ross', ROOM)).toBeNull()
    expect(matchOwner('the landlord', ROOM)).toBeNull()
    expect(matchOwner('', ROOM)).toBeNull()
    expect(matchOwner(null, ROOM)).toBeNull()
    expect(matchOwner(undefined, ROOM)).toBeNull()
    expect(matchOwner('Matt', [])).toBeNull()
  })
})
