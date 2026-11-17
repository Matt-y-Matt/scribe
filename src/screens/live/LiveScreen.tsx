import { useEffect, useReducer, useState } from 'react'
import type { MapStore } from '@/engine/store'
import { canvasReducer, INITIAL_CANVAS } from './canvas-state'
import {
  lastTouchedTopicId,
  LiveContext,
  useMapState,
  type LiveContextValue,
} from './live-context'
import { COLLAPSE_ZOOM, MapCanvas } from './MapCanvas'
import { PinsRail } from './PinsRail'

// The live meeting screen, UI_SPEC §2. M1 builds the map and the Pins rail;
// the status strip, the scribe panel and the timeline arrive with the
// milestones that feed them (M2, M3).

const TOAST_MS = 4_000

export interface LiveScreenProps {
  store: MapStore
  /** The zoom the map opens at. */
  zoom?: number
}

export function LiveScreen({ store, zoom = 0.8 }: LiveScreenProps) {
  const state = useMapState(store)
  const [canvas, dispatch] = useReducer(canvasReducer, INITIAL_CANVAS)
  const [chosenTopicId, setActiveTopicId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(zoom < COLLAPSE_ZOOM)
  const [toast, setToast] = useState<{ id: number; message: string } | null>(
    null
  )

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  // The topic the host picked, while it exists; else where the talk is.
  const activeTopicId =
    chosenTopicId && state.topics[chosenTopicId]
      ? chosenTopicId
      : lastTouchedTopicId(state)

  const live: LiveContextValue = {
    store,
    state,
    activeTopicId,
    setActiveTopicId,
    collapsed,
    tidy: () => dispatch({ type: 'tidy' }),
    notify: message => setToast({ id: Date.now(), message }),
  }

  return (
    <LiveContext value={live}>
      <main className="flex h-full bg-bg">
        <section aria-label="Map" className="relative min-w-0 flex-1">
          <MapCanvas
            canvas={canvas}
            dispatch={dispatch}
            initialViewport={{ x: 16, y: 20, zoom }}
            onZoom={next => setCollapsed(next < COLLAPSE_ZOOM)}
          />
          {toast && (
            <div
              key={toast.id}
              role="status"
              className="fade-in absolute bottom-12 left-4 flex items-center gap-3 rounded-md border bg-surface px-3 py-2 text-body"
            >
              {toast.message}
              <button
                type="button"
                className="font-semibold text-accent"
                onClick={() => {
                  store.undo()
                  setToast(null)
                }}
              >
                Undo
              </button>
            </div>
          )}
        </section>
        <aside
          aria-label="Pins"
          className="flex w-[320px] shrink-0 flex-col border-l bg-surface"
        >
          <PinsRail />
        </aside>
      </main>
    </LiveContext>
  )
}
