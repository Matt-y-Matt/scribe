import { Plus, Search, Settings } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import { addHeader } from '@/engine/actions'
import { headersOf } from '@/engine/model'
import { cn } from '@/lib/utils'
import { clock } from './format'
import { useLive } from './live-context'

// The status strip, UI_SPEC §2.1: 48 px across the top of the live screen.
// The recording indicator is always here (rule 3) and is the pause control:
// hold it for 300 ms to pause, click it once to resume.

/** How long the indicator must be held to pause a live recording. */
export const HOLD_MS = 300

/** Level at which the meter is full: about −20 dBFS, ordinary speech. */
const FULL_RMS = 0.1

function Indicator() {
  const { session, actions } = useLive()
  const rec = useStore(session, state => state.rec)
  const elapsedMs = useStore(session, state => state.elapsedMs)
  const review = useStore(session, state => state.review)
  const [holding, setHolding] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The press that paused ends in a click; that click must not resume.
  const paused = useRef(false)

  const release = () => {
    clearTimeout(timer.current)
    setHolding(false)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  const time = (
    <span className="font-mono text-body tabular-nums">{clock(elapsedMs)}</span>
  )
  if (review || rec === 'stopped') {
    return (
      <div className="flex items-center gap-2" data-testid="indicator">
        <span className="size-2 rounded-full bg-text-muted" aria-hidden />
        <span className="text-meta font-semibold text-text-muted">REVIEW</span>
        {time}
      </div>
    )
  }
  if (rec === 'idle') {
    return (
      <div className="flex items-center gap-2" data-testid="indicator">
        <span className="size-2 rounded-full bg-text-muted" aria-hidden />
        <span className="text-meta font-semibold text-text-muted">
          NOT RECORDING
        </span>
      </div>
    )
  }

  const live = rec === 'recording'
  return (
    <button
      type="button"
      data-testid="indicator"
      aria-label={
        live
          ? 'Recording. Hold to pause.'
          : 'Paused. Click to resume recording.'
      }
      title={live ? 'Hold to pause' : 'Click to resume'}
      className={cn(
        'flex h-8 items-center gap-2 rounded-md border px-2 transition-opacity duration-150 ease-out',
        holding ? 'border-accent' : 'border-transparent hover:bg-surface-2'
      )}
      onPointerDown={() => {
        paused.current = false
        if (!live) return
        setHolding(true)
        timer.current = setTimeout(() => {
          setHolding(false)
          paused.current = true
          actions.pause()
        }, HOLD_MS)
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onClick={event => {
        if (paused.current) {
          paused.current = false
          return
        }
        if (!live) actions.resume()
        // A click with no pointer behind it is the keyboard: Enter or Space
        // is as deliberate as a hold.
        else if (event.detail === 0) actions.pause()
      }}
    >
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full',
          live ? 'bg-record' : 'bg-text-muted'
        )}
      />
      <span
        className={cn(
          'text-meta font-semibold',
          live ? 'text-text' : 'text-text-muted'
        )}
      >
        {live ? 'REC' : 'PAUSED'}
      </span>
      {time}
    </button>
  )
}

function Meter({ label, rms }: { label: string; rms: number }) {
  const level = Math.min(1, Math.sqrt(rms / FULL_RMS))
  return (
    <div
      role="meter"
      aria-label={`${label} level`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
      title={label}
      className="flex h-4 w-12 items-end overflow-hidden rounded-md bg-surface-2"
    >
      <div
        className="h-full bg-text-muted"
        style={{ width: `${level * 100}%` }}
      />
    </div>
  )
}

function Levels() {
  const { session } = useLive()
  const levels = useStore(session, state => state.levels)
  const loopback = useStore(session, state => state.loopback)
  const live = useStore(session, state => state.rec === 'recording')
  return (
    <div className="flex items-center gap-2 text-meta text-text-muted">
      <span>Room</span>
      <Meter label="Room" rms={live ? levels.laptop : 0} />
      {loopback && (
        <>
          <span>System</span>
          <Meter label="System audio" rms={live ? levels.system : 0} />
        </>
      )}
    </div>
  )
}

/** "+" after the agenda: a header added while the meeting runs (§2.1). */
function AddHeader() {
  const { store, focusHeader } = useLive()
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')

  // The box leaves once: Enter, Escape, or the blur that follows either.
  const settled = useRef(false)

  const close = () => {
    settled.current = true
    setAdding(false)
    setTitle('')
  }
  // Enter or clicking away adds it; an empty box adds nothing.
  const add = () => {
    if (settled.current) return
    const header = addHeader(store, title)
    if (header) focusHeader(header.id)
    close()
  }

  if (!adding) {
    return (
      <button
        type="button"
        aria-label="Add an agenda header"
        title="Add an agenda header"
        className="flex size-6 shrink-0 items-center justify-center rounded-md border text-text-muted transition-opacity duration-150 ease-out hover:bg-surface-2"
        onClick={() => {
          settled.current = false
          setAdding(true)
        }}
      >
        <Plus size={12} aria-hidden />
      </button>
    )
  }
  return (
    <form
      className="shrink-0"
      onSubmit={event => {
        event.preventDefault()
        add()
      }}
    >
      <input
        autoFocus
        aria-label="New agenda header"
        placeholder="New header"
        value={title}
        onChange={event => setTitle(event.target.value)}
        onBlur={add}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            close()
          }
        }}
        className="h-6 w-44 rounded-md border border-accent bg-surface px-2 text-secondary outline-none placeholder:text-text-muted"
      />
    </form>
  )
}

/**
 * A finished meeting's transcript, heard again by the clean-up model. It
 * runs by itself after Stop; a meeting recorded before the model was on
 * this PC gets the button.
 */
function Cleanup() {
  const { session, actions } = useLive()
  const cleaning = useStore(session, store => store.cleaning)
  const ready = useStore(
    session,
    store => store.cleanupModel && !store.cleaned && store.segments.length > 0
  )
  if (cleaning) {
    return (
      <span role="status" className="text-secondary text-text-muted">
        Cleaning the transcript: line {cleaning.done} of {cleaning.of}
      </span>
    )
  }
  if (!ready) return null
  return (
    <Button
      variant="outline"
      size="sm"
      title="Hear the recording again with the second speech model, which hears whole sentences better. Takes several minutes."
      onClick={actions.cleanTranscript}
    >
      Clean transcript
    </Button>
  )
}

/**
 * A finished meeting's notes, written again from its transcript. It replaces
 * what the model wrote, so it asks first, in place.
 */
function Rebuild() {
  const { session, actions } = useLive()
  const rebuilding = useStore(session, store => store.rebuilding)
  const lines = useStore(session, store => store.segments.length)
  const cleaning = useStore(session, store => store.cleaning !== null)
  const [asking, setAsking] = useState(false)

  if (rebuilding) {
    return (
      <span role="status" className="text-secondary text-text-muted">
        Writing the notes again: line {rebuilding.done} of {rebuilding.of}
      </span>
    )
  }
  if (asking) {
    return (
      <span className="flex items-center gap-2 text-secondary">
        Replace the notes the model wrote? Cards you added stay.
        <Button
          size="sm"
          onClick={() => {
            setAsking(false)
            actions.rebuild()
          }}
        >
          Rebuild
        </Button>
        <Button variant="outline" size="sm" onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </span>
    )
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={lines === 0 || cleaning}
      title={
        cleaning
          ? 'Once the transcript is cleaned up'
          : "Have the model on this PC write this meeting's notes again from the transcript"
      }
      onClick={() => setAsking(true)}
    >
      Rebuild notes
    </Button>
  )
}

export function StatusStrip() {
  const { session, actions, state, focusHeader, openPalette } = useLive()
  const rec = useStore(session, store => store.rec)
  const review = useStore(session, store => store.review)
  const agenda = headersOf(state).filter(header => !header.off_agenda)
  const running = !review && (rec === 'recording' || rec === 'paused')

  return (
    <header
      aria-label="Status"
      className="flex h-12 shrink-0 items-center gap-3 border-b bg-surface px-3"
    >
      <Indicator />
      {running && (
        <Button variant="outline" size="sm" onClick={actions.stop}>
          Stop
        </Button>
      )}
      {(review || rec === 'stopped' || rec === 'idle') && (
        <Button variant="outline" size="sm" onClick={actions.leave}>
          Home
        </Button>
      )}
      {(review || rec === 'stopped') && (
        <Button size="sm" onClick={actions.wrapUp}>
          Summary
        </Button>
      )}
      {review && <Cleanup />}
      {review && <Rebuild />}

      <nav
        aria-label="Agenda"
        className="flex min-w-0 flex-1 items-center gap-1 border-l pl-3"
      >
        {/* The chips may run out of room; the "+" after them never does. */}
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {agenda.length === 0 ? (
            <span className="text-secondary text-text-muted">No agenda</span>
          ) : (
            agenda.map(header => (
              <button
                key={header.id}
                type="button"
                title={`Show ${header.title} on the map`}
                className="h-6 max-w-48 shrink-0 truncate rounded-md border px-2 text-secondary transition-opacity duration-150 ease-out hover:bg-surface-2"
                onClick={() => focusHeader(header.id)}
              >
                {header.title}
              </button>
            ))
          )}
        </div>
        <AddHeader />
      </nav>

      {!review && <Levels />}
      <div
        role="group"
        aria-label="Scribe replies"
        title="Spoken replies arrive with the scribe"
        className="flex h-6 items-center rounded-md border text-secondary"
      >
        <span className="rounded-md bg-surface-2 px-2 font-semibold">
          silent
        </span>
        <span className="px-2 text-text-muted">speaking</span>
      </div>
      <span
        title="Audio and transcript stay on this PC"
        className="flex h-6 items-center rounded-md border px-2 text-secondary"
      >
        local
      </span>
      <button
        type="button"
        aria-label="Search this meeting"
        title="Search this meeting (Ctrl+K)"
        className="flex size-7 items-center justify-center rounded-md text-text-muted transition-opacity duration-150 ease-out hover:bg-surface-2"
        onClick={openPalette}
      >
        <Search size={16} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Settings"
        className="flex size-7 items-center justify-center rounded-md text-text-muted transition-opacity duration-150 ease-out hover:bg-surface-2"
        onClick={() => actions.openSettings('audio')}
      >
        <Settings size={16} aria-hidden />
      </button>
    </header>
  )
}
