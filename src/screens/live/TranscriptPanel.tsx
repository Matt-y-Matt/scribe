import { ArrowDown, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import type { SegmentFinal } from '@/ipc'
import { cn } from '@/lib/utils'
import { clock } from './format'
import { useLive } from './live-context'

// The transcript panel (PRD F3.5): the meeting as it is said, newest at the
// bottom. It follows the live text until the host scrolls up to read; then
// it stays put and offers "Jump to live". The search box searches this
// meeting. A click on a line plays that span of the recording.

/** Closer to the bottom than this counts as following the live text. */
const FOLLOW_PX = 24

const SOURCE_LABEL: Record<string, string> = {
  laptop: 'Room',
  system: 'System audio',
}

function Line({
  segment,
  playing,
  onPlay,
}: {
  segment: SegmentFinal
  playing: boolean
  onPlay: () => void
}) {
  return (
    <li>
      <button
        type="button"
        data-segment-id={segment.id}
        title="Play this"
        className={cn(
          'flex w-full gap-2 rounded-md border px-2 py-1 text-left transition-opacity duration-150 ease-out hover:bg-surface-2',
          playing ? 'border-accent' : 'border-transparent'
        )}
        onClick={onPlay}
      >
        <span className="shrink-0 pt-px font-mono text-meta text-text-muted">
          {clock(segment.t0_ms)}
        </span>
        <span className="min-w-0">
          <span className="block text-meta text-text-muted">
            {SOURCE_LABEL[segment.source] ?? segment.speaker_label}
          </span>
          <span className="block text-body">{segment.text}</span>
        </span>
      </button>
    </li>
  )
}

export function TranscriptPanel() {
  const { session, actions } = useLive()
  const segments = useStore(session, state => state.segments)
  const rec = useStore(session, state => state.rec)
  const review = useStore(session, state => state.review)
  const modelMissing = useStore(session, state => state.modelMissing)
  const playback = useStore(session, state => state.playback)

  const list = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<SegmentFinal[] | null>(null)
  const [failed, setFailed] = useState(false)
  const searching = query.trim() !== ''

  // Keep the newest line in view while following: when a line arrives, and
  // when the lines change height (a font loads, the panel is resized).
  useEffect(() => {
    const box = list.current
    if (!box || !following || searching) return
    const toEnd = () => (box.scrollTop = box.scrollHeight)
    toEnd()
    const content = box.firstElementChild
    if (!content || typeof ResizeObserver === 'undefined') return
    const resized = new ResizeObserver(toEnd)
    resized.observe(content)
    resized.observe(box)
    return () => resized.disconnect()
  }, [segments, following, searching])

  useEffect(() => {
    const typed = query.trim()
    if (typed === '') return
    let stale = false
    // Wait for a pause in the typing before asking.
    const timer = setTimeout(() => {
      actions.search(typed).then(
        results => {
          if (stale) return
          setFound(results)
          setFailed(false)
        },
        () => {
          if (!stale) setFailed(true)
        }
      )
    }, 150)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query, actions])

  const shown = searching ? (found ?? []) : segments
  const isPlaying = (segment: SegmentFinal) =>
    playback.playing &&
    playback.tMs >= segment.t0_ms &&
    playback.tMs < segment.t1_ms

  const empty = searching
    ? failed
      ? 'The transcript could not be searched.'
      : found === null
        ? 'Searching…'
        : `Nothing in this meeting matches “${query.trim()}”.`
    : modelMissing
      ? 'The transcript is off: no speech model is installed.'
      : review || rec === 'stopped'
        ? 'Nothing was transcribed in this meeting.'
        : rec === 'paused'
          ? 'Paused. Nothing is being recorded.'
          : 'Nothing said yet. What the room says appears here.'

  return (
    <section
      aria-labelledby="transcript-title"
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <div role="tablist" className="flex h-9 shrink-0 items-center px-3">
        <h2
          id="transcript-title"
          role="tab"
          aria-selected
          className="text-meta font-semibold text-text-muted"
        >
          TRANSCRIPT
        </h2>
      </div>
      <label className="mx-2 mb-2 flex h-7 shrink-0 items-center gap-2 rounded-md border bg-surface px-2 focus-within:border-accent">
        <Search size={12} aria-hidden className="shrink-0 text-text-muted" />
        <input
          type="search"
          aria-label="Search this meeting"
          placeholder="Search this meeting"
          value={query}
          onChange={event => {
            setQuery(event.target.value)
            setFound(null)
            setFailed(false)
          }}
          className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
        />
        {searching && (
          <button
            type="button"
            aria-label="Clear search"
            className="text-text-muted"
            onClick={() => setQuery('')}
          >
            <X size={12} aria-hidden />
          </button>
        )}
      </label>

      <div
        ref={list}
        data-testid="transcript"
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-2"
        onScroll={event => {
          const box = event.currentTarget
          const fromBottom = box.scrollHeight - box.scrollTop - box.clientHeight
          setFollowing(fromBottom <= FOLLOW_PX)
        }}
      >
        {shown.length === 0 ? (
          <p className="px-2 text-body text-text-muted">{empty}</p>
        ) : (
          <ul className="flex flex-col">
            {shown.map(segment => (
              <Line
                key={segment.id}
                segment={segment}
                playing={isPlaying(segment)}
                onPlay={() => actions.playSpan(segment.t0_ms, segment.t1_ms)}
              />
            ))}
          </ul>
        )}
      </div>

      {!following && !searching && (
        <div className="fade-in absolute right-3 bottom-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const box = list.current
              if (box) box.scrollTop = box.scrollHeight
              setFollowing(true)
            }}
          >
            {review ? 'Jump to end' : 'Jump to live'}{' '}
            <ArrowDown size={12} aria-hidden />
          </Button>
        </div>
      )}
    </section>
  )
}
