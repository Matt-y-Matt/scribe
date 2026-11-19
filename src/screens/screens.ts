// Every screen state the app can render from fixtures, addressable as
// `?screen=<id>` under `vite dev`. `pnpm screenshot` walks this list; the full
// inventory it grows into is docs/TEST_PLAN.md §8. Plain data, no React, so
// Node scripts can import it.
export const SCREEN_IDS = [
  'home-empty',
  'home-list',
  'home-search',
  'home-actions',
  'premeeting',
  'live',
  'live-ghost',
  'live-unplanned',
  'live-zoomed-out',
  'live-last-time',
  'paused',
  'nomic-error',
  'model-missing',
  'notes-off',
  'review',
  'end',
  'settings-audio',
  'settings-speech',
] as const

export type ScreenId = (typeof SCREEN_IDS)[number]

export function isScreenId(value: unknown): value is ScreenId {
  return SCREEN_IDS.includes(value as ScreenId)
}

/** The `?screen=` value, or null when the URL does not ask for one. */
export function screenFromSearch(search: string): string | null {
  return new URLSearchParams(search).get('screen')
}
