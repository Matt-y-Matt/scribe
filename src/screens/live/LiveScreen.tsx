import { TriangleAlert } from 'lucide-react'
import { useEffect, useReducer, useState, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import type { MapStore } from '@/engine/store'
import { canvasReducer, INITIAL_CANVAS } from './canvas-state'
import {
  lastTouchedTopicId,
  LiveContext,
  useLive,
  useMapState,
  type LiveContextValue,
} from './live-context'
import { COLLAPSE_ZOOM, MapCanvas } from './MapCanvas'
import { PinsRail } from './PinsRail'
import type { SessionActions, SessionStore } from './session'
import { StatusStrip } from './StatusStrip'
import { Timeline } from './Timeline'
import { TranscriptPanel } from './TranscriptPanel'

// The live meeting screen, UI_SPEC §2: the status strip, the map, the Pins
// rail with the transcript under it, and the timeline. The scribe panel
// joins the transcript as a second tab in M3.

const TOAST_MS = 4_000

export interface LiveScreenProps {
  store: MapStore
  session: SessionStore
  actions: SessionActions
  /** The zoom the map opens at. */
  zoom?: number
  /** Drawn over everything below the status strip: the settings sheet. */
  overlay?: ReactNode
}

function Banner({ alert, children }: { alert?: boolean; children: ReactNode }) {
  return (
    <div
      role={alert ? 'alert' : 'status'}
      className="flex min-h-9 shrink-0 items-center gap-2 border-b bg-surface-2 px-3 py-1 text-body"
    >
      <TriangleAlert
        size={14}
        aria-hidden
        className="shrink-0 text-text-muted"
      />
      {children}
    </div>
  )
}

/** What is wrong, said once, under the status strip. Never a dialog. */
function Banners() {
  const { session, actions } = useLive()
  const noMic = useStore(session, state => state.noMic)
  const notStarted = useStore(session, state => state.notStarted)
  const micLost = useStore(session, state => state.micLost)
  const modelMissing = useStore(session, state => state.modelMissing)
  const review = useStore(session, state => state.review)
  if (review) return null

  return (
    <>
      {notStarted && !noMic && (
        <Banner>
          <span className="min-w-0 flex-1">
            <strong className="font-semibold">Not recorded yet.</strong> This
            meeting was set up and never started.
          </span>
          <Button size="sm" onClick={actions.retry}>
            Start recording
          </Button>
        </Banner>
      )}
      {noMic && (
        <Banner alert>
          <span className="min-w-0 flex-1">
            <strong className="font-semibold">No microphone found.</strong>{' '}
            Nothing is being recorded. Plug one in, then try again.
          </span>
          <Button variant="outline" size="sm" onClick={actions.retry}>
            Try again
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => actions.openSettings('audio')}
          >
            Audio settings
          </Button>
        </Banner>
      )}
      {micLost && !noMic && (
        <Banner alert>
          <span className="min-w-0 flex-1">
            <strong className="font-semibold">The microphone stopped.</strong>{' '}
            Scribe carries on as soon as it is back.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => actions.openSettings('audio')}
          >
            Audio settings
          </Button>
        </Banner>
      )}
      {modelMissing && (
        <Banner>
          <span className="min-w-0 flex-1">
            <strong className="font-semibold">
              No speech model is installed.
            </strong>{' '}
            The meeting is recorded; the transcript is off.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => actions.openSettings('speech')}
          >
            Download model
          </Button>
        </Banner>
      )}
    </>
  )
}

export function LiveScreen({
  store,
  session,
  actions,
  zoom = 0.8,
  overlay,
}: LiveScreenProps) {
  const state = useMapState(store)
  const [canvas, dispatch] = useReducer(canvasReducer, INITIAL_CANVAS)
  const [chosenTopicId, setActiveTopicId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(zoom < COLLAPSE_ZOOM)
  const [focus, setFocus] = useState<{ headerId: string; ask: number } | null>(
    null
  )
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
    session,
    actions,
    focusHeader: headerId =>
      setFocus(asked => ({ headerId, ask: (asked?.ask ?? 0) + 1 })),
  }

  return (
    <LiveContext value={live}>
      <main className="flex h-full flex-col bg-bg">
        <StatusStrip />
        <Banners />
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <section aria-label="Map" className="relative min-w-0 flex-1">
              <MapCanvas
                canvas={canvas}
                dispatch={dispatch}
                initialViewport={{ x: 16, y: 20, zoom }}
                onZoom={next => setCollapsed(next < COLLAPSE_ZOOM)}
                focus={focus}
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
              aria-label="Pins and transcript"
              className="flex w-[320px] shrink-0 flex-col border-l bg-surface"
            >
              <PinsRail />
              <TranscriptPanel />
            </aside>
          </div>
          <Timeline />
          {overlay}
        </div>
      </main>
    </LiveContext>
  )
}
