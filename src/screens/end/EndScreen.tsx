import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import { confirmCards } from '@/engine/actions'
import type { MapStore } from '@/engine/store'
import { draftsOf, listedCards, wrapUpOf } from '@/engine/summary'
import { reasonOf, useBackend } from '@/lib/backend'
import { logger } from '@/lib/logger'
import { clock } from '../live/format'
import { useMapState } from '../live/live-context'
import type { SessionActions, SessionStore } from '../live/session'
import { ConfirmLists } from './ConfirmLists'
import { Drafts } from './Drafts'
import { SummaryPanel } from './SummaryPanel'

// The end screen, UI_SPEC §3.3: where a meeting goes on Stop. The host reads
// what was decided and who owes what, fixes what is wrong, and gets a
// summary and a draft per person from what is left ticked. Nothing leaves
// this PC from here (PRD principle 2): Finish only goes back to Home.

const dayOf = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

/** In a box where Ctrl+Z means the box's own undo. A tick box is not one. */
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLInputElement && target.type !== 'checkbox')

export function EndScreen({
  store,
  session,
  actions,
}: {
  store: MapStore
  session: SessionStore
  actions: SessionActions
}) {
  const backend = useBackend()
  const state = useMapState(store)
  const meetingId = state.meeting.id
  const elapsedMs = useStore(session, live => live.elapsedMs)

  const meeting = useQuery({
    queryKey: ['meeting', meetingId],
    queryFn: () => backend.getMeeting(meetingId),
  })
  const saved = useQuery({
    queryKey: ['summary', meetingId],
    queryFn: () => backend.getSummary(meetingId),
    staleTime: 0,
    gcTime: 0,
  })

  // The first time a meeting is wrapped up, everything is in: the host
  // takes out what is wrong instead of ticking what is right.
  const opened = useRef(false)
  useEffect(() => {
    if (!saved.data || opened.current) return
    opened.current = true
    const listed = listedCards(store.getState())
    if (saved.data.markdown === null && !listed.some(card => card.confirmed)) {
      confirmCards(
        store,
        listed.map(card => card.id),
        true,
        'engine'
      )
    }
  }, [saved.data, store])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target) || !(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) store.redo()
        else store.undo()
      } else if (key === 'y') {
        event.preventDefault()
        store.redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [store])

  const wrap = wrapUpOf(state)
  const started = meeting.data?.started_at_ms ?? meeting.data?.created_at_ms
  const meta = {
    title: state.meeting.title,
    date: started ? dayOf.format(started) : undefined,
    participants: state.meeting.participants,
  }

  return (
    <main className="flex h-full flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-surface px-3">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-text-muted" aria-hidden />
          <span className="text-meta font-semibold text-text-muted">
            STOPPED
          </span>
          <span className="font-mono text-body tabular-nums">
            {clock(elapsedMs)}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={actions.showMap}>
          Map and recording
        </Button>
        <h1 className="min-w-0 flex-1 truncate border-l pl-3 text-header font-semibold">
          {state.meeting.title}
        </h1>
        <span className="text-secondary text-text-muted">
          Nothing is sent from this screen.
        </span>
        <Button onClick={actions.leave}>Finish</Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <p className="text-body text-text-muted">
            Untick what should not be in the summary. Click any text to fix it.
            Every action wants an owner and a date before it leaves the room.
          </p>
          <ConfirmLists
            store={store}
            state={state}
            wrap={wrap}
            onPlay={actions.playSpan}
          />
          <Drafts drafts={draftsOf(state, state.meeting.title)} />
        </div>
        <aside className="flex w-[400px] shrink-0 flex-col border-l bg-surface">
          {saved.isError ? (
            <p role="alert" className="p-4 text-body">
              The summary of this meeting could not be read.
            </p>
          ) : (
            saved.data && (
              <SummaryPanel
                state={state}
                meta={meta}
                initial={saved.data}
                ask={body => backend.ollamaChat(body)}
                onSave={summary => {
                  backend
                    .saveSummary(meetingId, summary)
                    .catch((error: unknown) =>
                      logger.error('the summary could not be saved', {
                        reason: reasonOf(error),
                      })
                    )
                }}
              />
            )
          )}
        </aside>
      </div>
    </main>
  )
}
