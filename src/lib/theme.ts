import { getSetting, setSetting } from './settings'
import { logger } from './logger'

// Light/dark switch (UI_SPEC §1). 'system' leaves <html> without data-theme so
// prefers-color-scheme decides; 'light' and 'dark' force it.
export type ThemePreference = 'system' | 'light' | 'dark'

const THEME_KEY = 'theme'
const PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

export function isThemePreference(value: unknown): value is ThemePreference {
  return PREFERENCES.includes(value as ThemePreference)
}

export function applyTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement
): void {
  if (preference === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', preference)
  }
}

/** `?theme=light|dark` forces a theme for this page load (screenshots). */
export function themeFromSearch(search: string): ThemePreference | null {
  const value = new URLSearchParams(search).get('theme')
  return isThemePreference(value) ? value : null
}

export async function initTheme(
  search: string = window.location.search
): Promise<void> {
  const forced = themeFromSearch(search)
  if (forced) {
    applyTheme(forced)
    return
  }
  try {
    const saved = await getSetting<unknown>(THEME_KEY)
    applyTheme(isThemePreference(saved) ? saved : 'system')
  } catch (error) {
    logger.warn('Could not read the saved theme; following the system', {
      error: String(error),
    })
  }
}

export async function setThemePreference(
  preference: ThemePreference
): Promise<void> {
  applyTheme(preference)
  await setSetting(THEME_KEY, preference)
}
