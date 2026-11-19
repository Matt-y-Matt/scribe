import { createContext, use, useSyncExternalStore } from 'react'
import type { MapState } from '@/engine/model'
import type { MapStore } from '@/engine/store'
import type { SessionActions, SessionStore } from './session'

/** What every part of the live screen shares. */
export interface LiveContextValue {
  store: MapStore
  state: MapState
  /** The topic on the table: clicked, revisited, or the last one added to. */
  activeTopicId: string | null
  setActiveTopicId: (topicId: string | null) => void
  /** Below zoom 0.7 cards collapse to kind icons with counts. */
  collapsed: boolean
  /** Forgets every hand-placed position and lays the map out afresh. */
  tidy: () => void
  /**
   * What is being edited in place: a card's id, or `new:<kind>:<topic id>`
   * for a card of that kind being added to that topic. One at a time.
   */
  editingId: string | null
  setEditingId: (id: string | null) => void
  /** A line in the bottom-left corner for four seconds, with an Undo. */
  notify: (message: string) => void
  /** Recording state, transcript, levels, waveform, playback. */
  session: SessionStore
  actions: SessionActions
  /** Brings a header's column into view on the map, at the host's request. */
  focusHeader: (headerId: string) => void
  /** Brings a topic into view on the map, at the host's request. */
  focusTopic: (topicId: string) => void
  /** Opens the search over the map (Ctrl+K). */
  openPalette: () => void
  /** The day of the meeting: what "Friday" on a card is counted from. */
  saidOnMs: number
  /** The moment "late" is judged against. */
  nowMs: number
}

export const LiveContext = createContext<LiveContextValue | null>(null)

export function useLive(): LiveContextValue {
  const value = use(LiveContext)
  if (!value) throw new Error('useLive outside the live screen')
  return value
}

/** The map as a React value that changes whenever the store does. */
export function useMapState(store: MapStore): MapState {
  return useSyncExternalStore(store.subscribe, store.getState)
}

/** The topic that most recently gained a card: the default active topic. */
export function lastTouchedTopicId(state: MapState): string | null {
  let latest: { topic_id: string; created_t_ms: number } | null = null
  for (const card of Object.values(state.cards)) {
    if (card.status === 'dismissed') continue
    if (state.topics[card.topic_id]?.status === 'pinned') continue
    if (!latest || card.created_t_ms >= latest.created_t_ms) latest = card
  }
  return latest?.topic_id ?? null
}
