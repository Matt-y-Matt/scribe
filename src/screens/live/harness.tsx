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
  children,
}: {
  store: MapStore
  collapsed?: boolean
  onNotify?: (message: string) => void
  session?: SessionStore
  actions?: Partial<SessionActions>
  onFocusHeader?: (headerId: string) => void
  children: ReactNode
}) {
  const state = useMapState(store)
  const [chosen, setActiveTopicId] = useState<string | null>(null)
  const [ownSession] = useState(() =>
    createSessionStore(emptySession(state.meeting.id, state.meeting.title))
  )
  const live: LiveContextValue = {
    store,
    state,
    activeTopicId: chosen ?? lastTouchedTopicId(state),
    setActiveTopicId,
    collapsed,
    tidy: () => undefined,
    notify: message => onNotify?.(message),
    session: session ?? ownSession,
    actions: { ...idleActions, ...actions },
    focusHeader: headerId => onFocusHeader?.(headerId),
  }
  return (
    <LiveContext value={live}>
      <DndContext>{children}</DndContext>
    </LiveContext>
  )
}
