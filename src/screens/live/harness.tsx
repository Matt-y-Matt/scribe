import { DndContext } from '@dnd-kit/core'
import { useState, type ReactNode } from 'react'
import type { MapStore } from '@/engine/store'
import {
  lastTouchedTopicId,
  LiveContext,
  useMapState,
  type LiveContextValue,
} from './live-context'

/**
 * The live screen's context without the canvas, for component tests: the
 * parts under test read the map and act on it exactly as they do on screen.
 */
export function LiveHarness({
  store,
  collapsed = false,
  onNotify,
  children,
}: {
  store: MapStore
  collapsed?: boolean
  onNotify?: (message: string) => void
  children: ReactNode
}) {
  const state = useMapState(store)
  const [chosen, setActiveTopicId] = useState<string | null>(null)
  const live: LiveContextValue = {
    store,
    state,
    activeTopicId: chosen ?? lastTouchedTopicId(state),
    setActiveTopicId,
    collapsed,
    tidy: () => undefined,
    notify: message => onNotify?.(message),
  }
  return (
    <LiveContext value={live}>
      <DndContext>{children}</DndContext>
    </LiveContext>
  )
}
