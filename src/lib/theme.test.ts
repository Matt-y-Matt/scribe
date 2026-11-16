import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./settings', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

import { getSetting, setSetting } from './settings'
import {
  applyTheme,
  initTheme,
  setThemePreference,
  themeFromSearch,
} from './theme'

const root = document.documentElement

beforeEach(() => {
  root.removeAttribute('data-theme')
  vi.mocked(getSetting).mockReset()
  vi.mocked(setSetting).mockReset()
})

describe('applyTheme', () => {
  it('forces light or dark with data-theme', () => {
    applyTheme('dark')
    expect(root.getAttribute('data-theme')).toBe('dark')
    applyTheme('light')
    expect(root.getAttribute('data-theme')).toBe('light')
  })

  it('removes data-theme for system, so the OS preference decides', () => {
    applyTheme('dark')
    applyTheme('system')
    expect(root.hasAttribute('data-theme')).toBe(false)
  })
})

describe('themeFromSearch', () => {
  it('reads ?theme=', () => {
    expect(themeFromSearch('?screen=home-empty&theme=dark')).toBe('dark')
  })

  it('ignores a missing or unknown value', () => {
    expect(themeFromSearch('')).toBeNull()
    expect(themeFromSearch('?theme=sepia')).toBeNull()
  })
})

describe('initTheme', () => {
  it('lets ?theme= win without reading settings', async () => {
    await initTheme('?theme=dark')
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(getSetting).not.toHaveBeenCalled()
  })

  it('applies the saved preference', async () => {
    vi.mocked(getSetting).mockResolvedValue('light')
    await initTheme('')
    expect(root.getAttribute('data-theme')).toBe('light')
  })

  it('follows the system when nothing valid is saved', async () => {
    vi.mocked(getSetting).mockResolvedValue('sepia')
    await initTheme('')
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('follows the system when settings cannot be read', async () => {
    vi.mocked(getSetting).mockRejectedValue(new Error('store unavailable'))
    await initTheme('')
    expect(root.hasAttribute('data-theme')).toBe(false)
  })
})

describe('setThemePreference', () => {
  it('applies and saves', async () => {
    await setThemePreference('dark')
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(setSetting).toHaveBeenCalledWith('theme', 'dark')
  })
})
