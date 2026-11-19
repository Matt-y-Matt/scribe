import { Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import { addCard, addTopic } from '@/engine/actions'
import { headersOf } from '@/engine/model'
import type { Highlight, SegmentFinal } from '@/ipc'
import { clock } from './format'
import { useLive } from './live-context'

// The timeline, UI_SPEC §2.5: the waveform of the whole meeting, a playhead,
// highlights. wavesurfer.js draws the wave and the regions from peaks the
// Rust core measured; the sound itself is played by the core, which tells us
// where the playhead is. Click to seek, drag to mark a highlight.

/** Peaks per second of meeting (audio/peaks.rs). */
const PEAKS_PER_SECOND = 20
const WAVE_HEIGHT = 52
const STEP_MS = 10_000
/** A live recording's wave is redrawn at most this often. */
const REDRAW_MS = 2_000
/** A drag shorter than this is a click, not a highlight. */
const MIN_HIGHLIGHT_MS = 300
/** What M keeps: long enough to hold the sentence that was just said. */
const KEEP_MS = 20_000
/** The most of what was said that a quote card carries. */
const QUOTE_CHARS = 240
/** How long the timeline says what M kept, or what was removed. */
const KEPT_NOTE_MS = 5_000

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/** A token's colour as the canvas needs it: a plain colour string. */
function token(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
}

const HIGHLIGHT_FILL = 'color-mix(in srgb, var(--quote) 40%, transparent)'
const PENDING_FILL = 'color-mix(in srgb, var(--accent) 25%, transparent)'

/** A highlight's name on its region: one line, however narrow the region. */
function labelOf(text: string): HTMLElement {
  const label = document.createElement('span')
  label.textContent = text
  // wavesurfer draws inside a shadow root, where the app's classes do not
  // reach: this one element is styled by hand, from the same tokens.
  Object.assign(label.style, {
    display: 'block',
    padding: '0 4px',
    whiteSpace: 'nowrap',
    fontSize: '11px',
    lineHeight: '16px',
    color: 'var(--text)',
  })
  return label
}

interface Span {
  t0: number
  t1: number
}

function Wave({
  peaks,
  durationMs,
  playheadMs,
  regions,
  pending,
  onSeek,
  onMark,
  onRegion,
}: {
  peaks: readonly number[]
  durationMs: number
  /** Null hides the playhead and leaves the whole wave unplayed. */
  playheadMs: number | null
  regions: readonly { id: string; t0: number; t1: number; label: string }[]
  pending: Span | null
  onSeek: (tMs: number) => void
  onMark: (span: Span) => void
  onRegion: (id: string, span: Span) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const surfer = useRef<WaveSurfer>(null)
  const plugin = useRef<ReturnType<typeof RegionsPlugin.create>>(null)
  const drawnAt = useRef(0)
  const busy = useRef(false)
  const latest = useRef({ onSeek, onMark, onRegion, durationMs })
  const [ready, setReady] = useState(0)

  useEffect(() => {
    latest.current = { onSeek, onMark, onRegion, durationMs }
  })

  useEffect(() => {
    if (!box.current) return
    const regionsPlugin = RegionsPlugin.create()
    const wave = WaveSurfer.create({
      container: box.current,
      height: WAVE_HEIGHT,
      waveColor: token('--text-muted'),
      progressColor: token('--accent'),
      // The playhead is ours, so it shows on a recording with no audio
      // element behind it.
      cursorWidth: 0,
      barWidth: 2,
      barGap: 1,
      interact: true,
      hideScrollbar: true,
      backend: 'WebAudio',
      plugins: [regionsPlugin],
    })
    surfer.current = wave
    plugin.current = regionsPlugin

    const offClick = wave.on('interaction', seconds => {
      latest.current.onSeek(Math.round(seconds * 1000))
    })
    // A drag across the wave marks a highlight. The plugin draws its own
    // region for it; ours replaces that once the span is known.
    const stopSelecting = regionsPlugin.enableDragSelection({
      color: PENDING_FILL,
    })
    const offCreated = regionsPlugin.on('region-created', region => {
      if (region.id.startsWith('h_') || region.id === 'pending') return
      const span = {
        t0: Math.round(region.start * 1000),
        t1: Math.round(region.end * 1000),
      }
      region.remove()
      if (span.t1 - span.t0 >= MIN_HIGHLIGHT_MS) latest.current.onMark(span)
    })
    const offRegion = regionsPlugin.on('region-clicked', (region, event) => {
      event.stopPropagation()
      latest.current.onRegion(region.id, {
        t0: Math.round(region.start * 1000),
        t1: Math.round(region.end * 1000),
      })
    })
    const offReady = wave.on('ready', () => setReady(count => count + 1))

    // The app follows the OS theme; redraw in the new colours when it flips.
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const recolour = () =>
      wave.setOptions({
        waveColor: token('--text-muted'),
        progressColor: token('--accent'),
      })
    scheme.addEventListener('change', recolour)
    const themed = new MutationObserver(recolour)
    themed.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    return () => {
      scheme.removeEventListener('change', recolour)
      themed.disconnect()
      offClick()
      offCreated()
      offRegion()
      offReady()
      stopSelecting()
      wave.destroy()
      surfer.current = null
      plugin.current = null
    }
  }, [])

  // Draw the wave. A live meeting adds peaks every second; redrawing that
  // often would fight a highlight being dragged, so it is paced.
  useEffect(() => {
    const wave = surfer.current
    if (!wave || peaks.length === 0) return
    const draw = () => {
      if (busy.current) return
      drawnAt.current = Date.now()
      const data = Float32Array.from(peaks, peak => peak / 255)
      void wave.load('', [data], durationMs / 1000).catch(() => undefined)
    }
    const wait = REDRAW_MS - (Date.now() - drawnAt.current)
    if (wait <= 0) {
      draw()
      return
    }
    const timer = setTimeout(draw, wait)
    return () => clearTimeout(timer)
  }, [peaks, durationMs])

  useEffect(() => {
    const regionsPlugin = plugin.current
    if (!regionsPlugin || ready === 0) return
    regionsPlugin.clearRegions()
    for (const region of regions) {
      regionsPlugin.addRegion({
        id: region.id,
        start: region.t0 / 1000,
        end: region.t1 / 1000,
        content: labelOf(region.label),
        color: HIGHLIGHT_FILL,
        drag: false,
        resize: false,
      })
    }
    if (pending) {
      regionsPlugin.addRegion({
        id: 'pending',
        start: pending.t0 / 1000,
        end: pending.t1 / 1000,
        color: PENDING_FILL,
        drag: false,
        resize: false,
      })
    }
  }, [regions, pending, ready])

  useEffect(() => {
    if (ready > 0) surfer.current?.setTime((playheadMs ?? 0) / 1000)
  }, [playheadMs, ready])

  const at = playheadMs === null ? null : (playheadMs / durationMs) * 100
  return (
    <div
      className="relative rounded-md bg-surface-2"
      style={{ height: WAVE_HEIGHT }}
      onPointerDown={() => (busy.current = true)}
      onPointerUp={() => (busy.current = false)}
      onPointerLeave={() => (busy.current = false)}
    >
      <div ref={box} data-testid="waveform" className="h-full text-meta" />
      {at !== null && (
        <span
          aria-hidden
          data-testid="playhead"
          className="pointer-events-none absolute inset-y-0 w-px bg-accent"
          style={{ left: `${Math.min(100, Math.max(0, at))}%` }}
        />
      )}
    </div>
  )
}

/** Where each source spoke: one thin band per source, labels only. */
function Bands({
  segments,
  durationMs,
  loopback,
}: {
  segments: readonly SegmentFinal[]
  durationMs: number
  loopback: boolean
}) {
  const band = (source: string, label: string, colour: string) => (
    <div
      role="img"
      aria-label={`${label}: where it spoke`}
      title={label}
      className="relative h-1 overflow-hidden rounded-full bg-surface-2"
    >
      {segments
        .filter(segment => segment.source === source)
        .map(segment => (
          <span
            key={segment.id}
            className={`absolute inset-y-0 ${colour}`}
            style={{
              left: `${(segment.t0_ms / durationMs) * 100}%`,
              width: `${Math.max(0.1, ((segment.t1_ms - segment.t0_ms) / durationMs) * 100)}%`,
            }}
          />
        ))}
    </div>
  )
  return (
    <div className="flex flex-col gap-0.5">
      {band('laptop', 'Room', 'bg-text-muted')}
      {loopback && band('system', 'System audio', 'bg-research')}
    </div>
  )
}

export function Timeline() {
  const { session, actions, store, activeTopicId } = useLive()
  const peaks = useStore(session, state => state.peaks)
  const elapsedMs = useStore(session, state => state.elapsedMs)
  const rec = useStore(session, state => state.rec)
  const review = useStore(session, state => state.review)
  const playback = useStore(session, state => state.playback)
  const highlights = useStore(session, state => state.highlights)
  const segments = useStore(session, state => state.segments)
  const loopback = useStore(session, state => state.loopback)

  const [pending, setPending] = useState<Span | null>(null)
  const [markedAt, setMarkedAt] = useState<number | null>(null)
  const [name, setName] = useState('')
  /** The span just kept with M, said back for a few seconds. */
  const [kept, setKept] = useState<Span | null>(null)
  /** The highlight that was clicked: the one Remove would take. */
  const [pickedId, setPickedId] = useState<string | null>(null)
  /** The highlight just removed, kept for a few seconds so it can come back. */
  const [removed, setRemoved] = useState<Highlight | null>(null)

  const live = !review && (rec === 'recording' || rec === 'paused')
  const recordedMs = Math.max(
    elapsedMs,
    (peaks.length * 1000) / PEAKS_PER_SECOND
  )
  const durationMs = Math.max(recordedMs, 1_000)
  // While a meeting is live and nothing plays, "now" is the live edge.
  const cursorMs = playback.playing || !live ? playback.tMs : recordedMs
  const hasAudio = recordedMs > 0
  // The highlight in hand: the one that was clicked, else the one the
  // playhead stands in (so [ and ] reach it without a mouse).
  const picked =
    highlights.find(highlight => highlight.id === pickedId) ??
    ((playback.playing || !live) && hasAudio
      ? highlights.find(
          highlight => highlight.t0_ms <= cursorMs && cursorMs < highlight.t1_ms
        )
      : undefined)

  const seek = (tMs: number) => {
    const target = Math.min(Math.max(0, tMs), recordedMs)
    if (playback.playing) actions.seekPlay(target)
    else session.setState({ playback: { playing: false, tMs: target } })
  }
  const toggle = () => {
    if (playback.playing) actions.stopPlayback()
    else if (hasAudio) {
      // At the end there is nothing to play: start ten seconds back.
      const from =
        cursorMs >= recordedMs - 500
          ? Math.max(0, recordedMs - STEP_MS)
          : cursorMs
      actions.seekPlay(from)
    }
  }
  const mark = () => {
    if (markedAt === null) {
      setMarkedAt(cursorMs)
      return
    }
    const span = {
      t0: Math.min(markedAt, cursorMs),
      t1: Math.max(markedAt, cursorMs),
    }
    setMarkedAt(null)
    if (span.t1 - span.t0 >= MIN_HIGHLIGHT_MS) setPending(span)
  }

  /**
   * Keeps a span: a highlight on the waveform and a quote card on the map,
   * under the topic on the table. Ctrl+Z takes the card back.
   */
  const keep = (span: Span, label: string, latest = false) => {
    const said = segments.filter(
      segment => segment.t1_ms > span.t0 && segment.t0_ms < span.t1
    )
    actions.addHighlight(span.t0, span.t1, label)

    const state = store.getState()
    const [header] = headersOf(state)
    const topicId =
      activeTopicId ??
      Object.values(state.topics).find(topic => topic.kind === 'topic')?.id ??
      (header && addTopic(store, header.id, 'Highlights')?.id)
    const all = said.map(segment => segment.text).join(' ')
    // A span that was dragged is quoted from its start. What M keeps is
    // quoted from its end: the host pressed it because of the last thing said.
    const words =
      all.length <= QUOTE_CHARS
        ? all
        : latest
          ? `…${all.slice(-QUOTE_CHARS).replace(/^\S*\s/, '')}`
          : all.slice(0, QUOTE_CHARS)
    if (topicId) {
      addCard(store, topicId, {
        kind: 'quote',
        text: label || words || `Highlight at ${clock(span.t0)}`,
        segment_ids: said.map(segment => segment.id),
        t_ms: span.t0,
      })
    }
  }

  // M: something worth keeping was just said. No drag, no name: the last
  // twenty seconds are kept at once, and the card can be reworded later.
  const keepLast = () => {
    const span = { t0: Math.max(0, cursorMs - KEEP_MS), t1: cursorMs }
    if (!hasAudio || span.t1 - span.t0 < MIN_HIGHLIGHT_MS) return
    keep(span, '', true)
    setKept(span)
  }
  useEffect(() => {
    if (!kept) return
    const timer = setTimeout(() => setKept(null), KEPT_NOTE_MS)
    return () => clearTimeout(timer)
  }, [kept])

  const remove = (highlight: Highlight) => {
    actions.removeHighlight(highlight.id)
    setPickedId(null)
    setKept(null)
    setRemoved(highlight)
  }
  const putBack = () => {
    if (!removed) return
    actions.addHighlight(removed.t0_ms, removed.t1_ms, removed.label)
    setRemoved(null)
  }
  useEffect(() => {
    if (!removed) return
    const timer = setTimeout(() => setRemoved(null), KEPT_NOTE_MS)
    return () => clearTimeout(timer)
  }, [removed])

  const keys = useRef({ toggle, seek, mark, keepLast, cursorMs })
  useEffect(() => {
    keys.current = { toggle, seek, mark, keepLast, cursorMs }
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const now = keys.current
      if (event.key === ' ') {
        // Space on a focused button presses that button.
        if (event.target instanceof HTMLButtonElement) return
        event.preventDefault()
        now.toggle()
      } else if (event.key === '[') now.seek(now.cursorMs - STEP_MS)
      else if (event.key === ']') now.seek(now.cursorMs + STEP_MS)
      else if (event.key.toLowerCase() === 'h') now.mark()
      else if (event.key.toLowerCase() === 'm') now.keepLast()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const save = () => {
    if (!pending) return
    keep(pending, name.trim())
    setPending(null)
    setName('')
  }

  return (
    <section
      aria-label="Timeline"
      className="flex h-[120px] shrink-0 flex-col gap-1.5 border-t bg-surface px-3 py-2"
    >
      <div className="flex h-6 items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          aria-label={playback.playing ? 'Pause playback' : 'Play'}
          title="Play or pause (Space)"
          disabled={!hasAudio}
          onClick={toggle}
        >
          {playback.playing ? (
            <Pause size={12} aria-hidden />
          ) : (
            <Play size={12} aria-hidden />
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="Back 10 s ( [ )"
          disabled={!hasAudio}
          onClick={() => seek(cursorMs - STEP_MS)}
        >
          ◀10
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="Forward 10 s ( ] )"
          disabled={!hasAudio}
          onClick={() => seek(cursorMs + STEP_MS)}
        >
          10▶
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="Keep the last 20 seconds as a quote (M)"
          disabled={!hasAudio}
          onClick={keepLast}
        >
          Mark
        </Button>

        {pending ? (
          <form
            className="ml-2 flex min-w-0 flex-1 items-center gap-2"
            onSubmit={event => {
              event.preventDefault()
              save()
            }}
          >
            <span className="shrink-0 font-mono text-meta text-text-muted">
              {clock(pending.t0)}–{clock(pending.t1)}
            </span>
            <input
              autoFocus
              aria-label="Name this highlight"
              placeholder="Name this highlight, or press Enter to quote what was said"
              value={name}
              onChange={event => setName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  setPending(null)
                  setName('')
                }
              }}
              className="h-6 min-w-0 flex-1 rounded-md border bg-surface px-2 text-body outline-none placeholder:text-text-muted focus:border-accent"
            />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        ) : picked ? (
          <p
            role="status"
            className="ml-2 flex min-w-0 flex-1 items-center gap-2 text-secondary"
          >
            <span className="shrink-0 font-mono text-meta text-text-muted">
              {clock(picked.t0_ms)}–{clock(picked.t1_ms)}
            </span>
            <span className="min-w-0 truncate">
              {picked.label || 'Highlight'}
            </span>
            <Button
              variant="outline"
              size="sm"
              title="Take this highlight off the timeline"
              onClick={() => remove(picked)}
            >
              Remove highlight
            </Button>
          </p>
        ) : removed ? (
          <p
            role="status"
            className="ml-2 flex min-w-0 flex-1 items-center gap-2 text-secondary text-text-muted"
          >
            <span className="min-w-0 truncate">
              Highlight removed. Its quote card stays on the map.
            </span>
            <Button variant="outline" size="sm" onClick={putBack}>
              Put it back
            </Button>
          </p>
        ) : (
          <p className="ml-2 min-w-0 flex-1 truncate text-secondary text-text-muted">
            {kept
              ? `Kept ${clock(kept.t0)}–${clock(kept.t1)} as a quote on the map. Ctrl+Z takes it back.`
              : markedAt !== null
                ? `Highlight started at ${clock(markedAt)}. Press H again to end it.`
                : hasAudio
                  ? 'Click to play from there. M keeps the last 20 seconds; drag to mark a span.'
                  : review
                    ? 'This meeting has no recording.'
                    : 'The waveform appears as the meeting is recorded.'}
          </p>
        )}

        <p className="shrink-0 font-mono text-secondary tabular-nums">
          {clock(cursorMs)}{' '}
          <span className="text-text-muted">
            / {live ? 'live' : clock(recordedMs)}
          </span>
        </p>
      </div>

      <Wave
        peaks={peaks}
        durationMs={durationMs}
        playheadMs={
          hasAudio && (playback.playing || !live) ? playback.tMs : null
        }
        regions={highlights.map(highlight => ({
          id: highlight.id,
          t0: highlight.t0_ms,
          t1: highlight.t1_ms,
          label: highlight.label,
        }))}
        pending={pending}
        onSeek={tMs => {
          setPickedId(null)
          actions.seekPlay(Math.min(tMs, recordedMs))
        }}
        onMark={setPending}
        onRegion={(id, span) => {
          setPickedId(id)
          actions.playSpan(span.t0, span.t1)
        }}
      />
      <Bands segments={segments} durationMs={durationMs} loopback={loopback} />
    </section>
  )
}
