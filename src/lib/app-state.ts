import { create } from 'zustand'

// Where the app is. Two screens (Home, and a meeting: live or in review) and
// two sheets that open over them (UI_SPEC §3.2, §3.5).

export type Route =
  | { name: 'home' }
  /**
   * `start`: the host pressed Start recording to get here. `atMs`: they
   * picked a moment of a past meeting (a search hit, a card on Home), and the
   * recording plays from it.
   */
  | { name: 'meeting'; meetingId: string; start?: boolean; atMs?: number }

export type SettingsTab = 'audio' | 'speech' | 'appearance'

/** A past meeting to start the next one from. */
export interface MeetingLike {
  title: string
  agenda: string[]
  participants: string[]
  /** What that meeting parked: offered as agenda headers. */
  parked: string[]
}

export type Sheet =
  | { name: 'premeeting'; like?: MeetingLike }
  | { name: 'settings'; tab: SettingsTab }
  | null

interface AppState {
  route: Route
  sheet: Sheet
  go(route: Route): void
  open(sheet: Sheet): void
  close(): void
}

export const useApp = create<AppState>(set => ({
  route: { name: 'home' },
  sheet: null,
  go: route => set({ route, sheet: null }),
  open: sheet => set({ sheet }),
  close: () => set({ sheet: null }),
}))
