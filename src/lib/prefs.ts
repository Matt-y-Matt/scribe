import { create } from 'zustand'
import { getSetting, setSetting } from './settings'

// What the host chose in Settings and expects to find again: which
// microphone, whether system audio is recorded, which speech model.

export interface Prefs {
  /** A device name, or null for the PC's default microphone. */
  microphone: string | null
  /** Also record and transcribe what the PC plays (PRD F2.2). */
  loopback: boolean
  modelId: string
}

/** The local default (DECISIONS 2026-11-17). */
export const DEFAULT_MODEL_ID = 'parakeet-tdt-0.6b-v3-int8'

export const DEFAULT_PREFS: Prefs = {
  microphone: null,
  loopback: false,
  modelId: DEFAULT_MODEL_ID,
}

const KEY = 'prefs'

interface PrefsStore extends Prefs {
  /** Reads the saved choices; safe to call more than once. */
  load(): Promise<void>
  /** Changes one or more choices and saves them. */
  change(patch: Partial<Prefs>): void
}

export const usePrefs = create<PrefsStore>((set, get) => ({
  ...DEFAULT_PREFS,
  load: async () => {
    const saved = await getSetting<Partial<Prefs>>(KEY)
    if (saved) set({ ...DEFAULT_PREFS, ...saved })
  },
  change: patch => {
    set(patch)
    const { microphone, loopback, modelId } = get()
    void setSetting(KEY, { microphone, loopback, modelId })
  },
}))

/** The saved choices as they are now, for code outside React. */
export function currentPrefs(): Prefs {
  const { microphone, loopback, modelId } = usePrefs.getState()
  return { microphone, loopback, modelId }
}
