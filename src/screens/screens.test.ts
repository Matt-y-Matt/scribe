import { describe, expect, it } from 'vitest'
import { SCREENS } from './registry'
import { isScreenId, SCREEN_IDS, screenFromSearch } from './screens'

describe('screens', () => {
  it('has a component for every listed screen state', () => {
    expect(Object.keys(SCREENS).sort()).toEqual([...SCREEN_IDS].sort())
  })

  it('reads ?screen=', () => {
    expect(screenFromSearch('?screen=home-empty&theme=dark')).toBe('home-empty')
    expect(screenFromSearch('')).toBeNull()
  })

  it('knows which ids exist', () => {
    expect(isScreenId('home-empty')).toBe(true)
    expect(isScreenId('nope')).toBe(false)
  })
})
