import { DndContext } from '@dnd-kit/core'
import { useState, type ReactNode } from 'react'
import type { MapStore } from '@/engine/store'
import {
  lastTouchedTopicId,
  LiveContext,
  useMapState,
  type LiveContextValue,
} from './live-context'
import {
  createSessionStore,
  emptySession,
  idleActions,
  type SessionActions,
  type SessionStore,
} from './session'

/** A fixed day, so a test's due dates do not move with the clock. */
const HARNESS_DAY = new Date(2026, 10, 17, 11).getTime()

/**
 * The live screen's context without the canvas, for component tests: the
 * parts under test read the map and act on it exactly as they do on screen.
 */
export function LiveHarness({
  store,
  collapsed = false,
  onNotify,
  session,
  actions,
  onFocusHeader,
  onFocusTopic,
  saidOnMs,
  nowMs,
  children,
}: {
  store: MapStore
  collapsed?: boolean
  onNotify?: (message: string) => void
  session?: SessionStore
  actions?: Partial<SessionActions>
  onFocusHeader?: (headerId: string) => void
  onFocusTopic?: (topicId: string) => void
  /** The day of the meeting and the moment "late" is judged against. */
  saidOnMs?: number
  nowMs?: number
  children: ReactNode
}) {
  const state = useMapState(store)
  const [chosen, setActiveTopicId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [ownSession] = useState(() =>
    createSessionStore(emptySession(state.meeting.id, state.meeting.title))
  )
  const live: LiveContextValue = {
    store,
    state,
    activeTopicId: chosen ?? lastTouchedTopicId(state),
    setActiveTopicId,
    collapsed,
    editingId,
    setEditingId,
    tidy: () => undefined,
    notify: message => onNotify?.(message),
    session: session ?? ownSession,
    actions: { ...idleActions, ...actions },
    focusHeader: headerId => onFocusHeader?.(headerId),
    focusTopic: topicId => onFocusTopic?.(topicId),
    saidOnMs: saidOnMs ?? HARNESS_DAY,
    nowMs: nowMs ?? saidOnMs ?? HARNESS_DAY,
    openPalette: () => undefined,
  }
  return (
    <LiveContext value={live}>
      <DndContext>{children}</DndContext>
    </LiveContext>
  )
}
