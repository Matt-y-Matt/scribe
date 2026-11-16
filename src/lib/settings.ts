import { isTauri } from '@tauri-apps/api/core'

// User settings live in tauri-plugin-store (CLAUDE.md §Stack). Under plain
// `vite dev` (screenshots, Playwright) there is no Tauri runtime, so settings
// fall back to memory and last for the page only.
const SETTINGS_FILE = 'settings.json'
const memory = new Map<string, unknown>()

async function store() {
  const { load } = await import('@tauri-apps/plugin-store')
  return load(SETTINGS_FILE, { defaults: {}, autoSave: true })
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  if (!isTauri()) return memory.get(key) as T | undefined
  return (await store()).get<T>(key)
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  if (!isTauri()) {
    memory.set(key, value)
    return
  }
  await (await store()).set(key, value)
}
