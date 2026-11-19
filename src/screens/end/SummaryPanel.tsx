import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { headersOf, type MapState } from '@/engine/model'
import {
  PRESET_LABEL,
  renderSummary,
  SUMMARY_PRESETS,
  wrapUpOf,
  writeSummary,
  type SummaryMeta,
  type SummaryPreset,
} from '@/engine/summary'
import { OLLAMA_MODEL } from '@/engine/providers/ollama'
import type { Turn } from '@/engine/turns'
import {
  renderWritten,
  SUMMARY_MODEL,
  writeMeetingSummary,
} from '@/engine/written-summary'
import type { Summary } from '@/ipc'
import { cn } from '@/lib/utils'
import { CopyButton } from './CopyButton'
import { SaveButton } from './SaveButton'

// The summary, UI_SPEC §3.3. The three presets are written from the ticked
// rows the moment they change, with no model: they list what was decided
// and who owes what, and nothing else. "Written" has the model on this PC
// read the whole transcript and say what the meeting was about; it is what
// a meeting gets the first time it is wrapped up, and the preset stands
// until it is done. Typing a layout of one's own and pressing Write asks the
// model to lay the notes out that way. Any of them can then be edited by
// hand; what is on screen is what is saved.

const SAVE_AFTER_MS = 500
/** The saved layout of a summary the model wrote from the transcript. */
export const WRITTEN = 'written'
type Mode = 'preset' | 'written' | 'custom'

/** "Custore weekly, 19 Nov 2026.md": what the Save dialog offers. */
const fileNameOf = (meta: SummaryMeta) =>
  `${[meta.title, meta.date].filter(Boolean).join(', ')}.md`

const isPreset = (value: string | null): value is SummaryPreset =>
  SUMMARY_PRESETS.includes(value as SummaryPreset)

export function SummaryPanel({
  state,
  meta,
  initial,
  onSave,
  ask,
  saveAs,
  transcript = [],
  cleaning = null,
}: {
  state: MapState
  meta: SummaryMeta
  /** What was saved for this meeting; both null the first time. */
  initial: Summary
  onSave: (summary: Summary) => void
  /** One request to the model on this PC (the core's relay to Ollama). */
  ask: (body: string) => Promise<string>
  /** Writes a file where the person says; null when they close the dialog. */
  saveAs: (fileName: string, text: string) => Promise<string | null>
  /** What was said, as turns; the written summary is read from it. */
  transcript?: readonly Turn[]
  /**
   * The transcript is being cleaned up: lines heard again so far. The
   * written summary waits for the cleaner text.
   */
  cleaning?: { done: number; of: number } | null
}) {
  const [preset, setPreset] = useState<SummaryPreset>(
    isPreset(initial.layout) ? initial.layout : 'decisions-actions'
  )
  const [layout, setLayout] = useState(
    isPreset(initial.layout) || initial.layout === WRITTEN
      ? ''
      : (initial.layout ?? '')
  )
  const [mode, setMode] = useState<Mode>(
    initial.layout === WRITTEN
      ? 'written'
      : isPreset(initial.layout) || initial.layout === null
        ? 'preset'
        : 'custom'
  )
  const preview = renderSummary(state, preset, meta)
  // Text that is not the preset's: typed by the host, or written by the
  // model. `from` is the preset text it replaced, so a change to the lists
  // since then can be pointed out instead of written over.
  const [own, setOwn] = useState<{ text: string; from: string } | null>(() =>
    initial.markdown !== null && initial.markdown !== preview
      ? { text: initial.markdown, from: preview }
      : null
  )
  // A small local model can get a detail wrong; say so while its text stands.
  const [byModel, setByModel] = useState(false)
  const [writing, setWriting] = useState(false)
  const [failed, setFailed] = useState(false)
  /** Reading the transcript: which request, out of how many. */
  const [reading, setReading] = useState<{ step: number; of: number } | null>(
    null
  )
  /** The first wrap-up's own attempt got no answer: the preset stands. */
  const [unread, setUnread] = useState(false)
  /** Where the file went, or that it could not be written. */
  const [file, setFile] = useState<{ path: string } | { failed: true } | null>(
    null
  )

  const shown = own?.text ?? preview
  const stale = own !== null && own.from !== preview
  const custom = layout.trim()

  // Save what is on screen, a moment after it stops changing, and at once
  // when the screen is left.
  const saved = useRef(initial.markdown)
  const savedLayout = mode === 'written' ? WRITTEN : custom || preset
  const latest = useRef({ shown, layout: savedLayout, onSave, preview, state })
  useEffect(() => {
    latest.current = { shown, layout: savedLayout, onSave, preview, state }
  })
  useEffect(() => {
    const save = () => {
      const now = latest.current
      if (saved.current === now.shown) return
      saved.current = now.shown
      now.onSave({ markdown: now.shown, layout: now.layout })
    }
    const timer = setTimeout(save, SAVE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [shown, savedLayout])
  useEffect(
    () => () => {
      const now = latest.current
      if (saved.current !== now.shown) {
        now.onSave({ markdown: now.shown, layout: now.layout })
      }
    },
    []
  )

  const write = async () => {
    setWriting(true)
    setFailed(false)
    try {
      const text = await writeSummary(
        ask,
        custom,
        renderSummary(state, 'minutes', meta)
      )
      setOwn({ text, from: preview })
      setByModel(true)
      setMode('custom')
    } catch {
      setFailed(true)
    } finally {
      setWriting(false)
    }
  }

  // What the host typed while the model was reading is theirs to keep.
  const typed = useRef(false)
  /** Has the model read the transcript and write the summary from it. */
  const readMeeting = async (unasked: boolean) => {
    setWriting(true)
    setFailed(false)
    setUnread(false)
    typed.current = false
    // The larger model first; if it is not there, the one the notes use.
    const read = (model: string) =>
      writeMeetingSummary(ask, transcript, {
        model,
        title: meta.title,
        participants: meta.participants,
        agenda: headersOf(state)
          .filter(header => !header.off_agenda)
          .map(header => header.title),
        // What the host has left ticked by the time the reading is done
        // leads the lists, worded as it stands.
        noted: () => {
          const wrap = wrapUpOf(latest.current.state)
          return {
            decisions: wrap.decisions
              .filter(card => card.confirmed)
              .map(card => card.text),
            actions: wrap.actions
              .filter(card => card.confirmed)
              .map(card => ({
                owner: card.owner,
                text: card.text,
                due: card.due_text,
              })),
          }
        },
        onProgress: (step, of) => setReading({ step, of }),
      })
    try {
      const summary = await read(SUMMARY_MODEL).catch(() => {
        if (typed.current) throw new Error('the host is writing it')
        return read(OLLAMA_MODEL)
      })
      if (typed.current) return
      setOwn({
        text: renderWritten(summary, meta),
        from: latest.current.preview,
      })
      setByModel(true)
      setMode('written')
    } catch {
      // Unasked, a model that is not there is no error: the preset stands.
      if (unasked) setUnread(true)
      else setFailed(true)
    } finally {
      setWriting(false)
      setReading(null)
    }
  }

  // The first time a meeting is wrapped up, read it without being asked.
  const began = useRef(false)
  const waiting = cleaning !== null
  const readFirst = useRef(readMeeting)
  useEffect(() => {
    readFirst.current = readMeeting
  })
  useEffect(() => {
    if (
      began.current ||
      initial.markdown !== null ||
      transcript.length === 0 ||
      waiting
    ) {
      return
    }
    began.current = true
    void readFirst.current(true)
  }, [initial.markdown, transcript.length, waiting])

  return (
    <section
      aria-label="Summary"
      className="flex min-h-0 flex-1 flex-col gap-2 p-4"
    >
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-meta font-semibold text-text-muted">
          SUMMARY
        </h2>
        <CopyButton text={shown} />
        <SaveButton
          save={() => saveAs(fileNameOf(meta), shown)}
          onSaved={setFile}
        />
      </div>

      <div
        role="radiogroup"
        aria-label="Layout"
        className="flex flex-wrap gap-1"
      >
        <button
          type="button"
          role="radio"
          aria-checked={own !== null && mode === 'written'}
          disabled={writing || transcript.length === 0}
          title={
            transcript.length === 0
              ? 'This meeting has no transcript to read'
              : 'The model on this PC reads the whole transcript'
          }
          className={cn(
            'h-6 rounded-md border px-2 text-secondary transition-opacity duration-150 ease-out disabled:opacity-50',
            own !== null && mode === 'written'
              ? 'border-accent bg-accent-soft font-semibold'
              : 'hover:bg-surface-2'
          )}
          onClick={() => void readMeeting(false)}
        >
          Written
        </button>
        {SUMMARY_PRESETS.map(option => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={own === null && preset === option}
            className={cn(
              'h-6 rounded-md border px-2 text-secondary transition-opacity duration-150 ease-out',
              own === null && preset === option
                ? 'border-accent bg-accent-soft font-semibold'
                : 'hover:bg-surface-2'
            )}
            onClick={() => {
              setPreset(option)
              setOwn(null)
              setByModel(false)
              setFailed(false)
              setUnread(false)
              setMode('preset')
              // A reading still under way must not write over this choice.
              typed.current = true
            }}
          >
            {PRESET_LABEL[option]}
          </button>
        ))}
      </div>

      <form
        className="flex gap-1.5"
        onSubmit={event => {
          event.preventDefault()
          if (custom !== '' && !writing) void write()
        }}
      >
        <input
          aria-label="Your own layout"
          placeholder="Or describe it: “one page, plain words, actions first”"
          value={layout}
          onChange={event => setLayout(event.target.value)}
          className="h-7 min-w-0 flex-1 rounded-md border bg-surface px-2 text-body outline-none placeholder:text-text-muted focus:border-accent"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={custom === '' || writing}
        >
          {writing ? 'Writing…' : 'Write'}
        </Button>
      </form>

      {writing && reading === null && (
        <p role="status" className="text-secondary text-text-muted">
          The model on this PC is writing. This can take a minute; the text
          below stays until it is done.
        </p>
      )}
      {reading !== null && (
        <p role="status" className="text-secondary text-text-muted">
          The model on this PC is reading the meeting, part {reading.step} of{' '}
          {reading.of}. A half-hour meeting takes several minutes; the text
          below stays until it is done, and you can keep working.
        </p>
      )}
      {cleaning && (
        <p role="status" className="text-secondary text-text-muted">
          Cleaning the transcript with the second speech model: line{' '}
          {cleaning.done} of {cleaning.of}. The written summary starts once it
          is done.
        </p>
      )}
      {unread && !writing && (
        <p role="status" className="text-secondary text-text-muted">
          The model on this PC did not answer, so this is the list of what is
          ticked and nothing more. With Ollama running, Written reads the whole
          meeting.
        </p>
      )}
      {failed && (
        <p role="alert" className="text-secondary">
          The model on this PC did not answer, so nothing was changed. Is Ollama
          running?
        </p>
      )}
      {stale && !writing && (
        <p role="status" className="flex items-center gap-2 text-secondary">
          <span className="min-w-0 flex-1">
            The lists changed after this was written.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOwn(null)
              setByModel(false)
              setMode('preset')
            }}
          >
            Write it again
          </Button>
        </p>
      )}

      {byModel && own !== null && !writing && mode !== 'written' && (
        <p role="status" className="text-secondary text-text-muted">
          Written by the model on this PC. Read it against the lists: a small
          model can get a number or a condition wrong.
        </p>
      )}
      {byModel && own !== null && !writing && mode === 'written' && (
        <p role="status" className="text-secondary text-text-muted">
          Written by the model on this PC from the transcript. Check names,
          numbers and dates before you pass it on: a small model gets some
          wrong, and so does speech recognition.
        </p>
      )}

      <textarea
        aria-label="Summary text"
        spellCheck={false}
        value={shown}
        onChange={event => {
          typed.current = true
          setOwn({ text: event.target.value, from: own?.from ?? preview })
        }}
        className="min-h-40 flex-1 resize-none rounded-md border bg-surface p-3 font-mono text-secondary outline-none focus:border-accent"
      />
      {file && 'path' in file && (
        <p role="status" className="text-secondary break-words">
          Saved to {file.path}
        </p>
      )}
      {file && 'failed' in file && (
        <p role="alert" className="text-secondary">
          The file could not be written there. Try another folder.
        </p>
      )}
      <p className="text-meta text-text-muted">
        Markdown. Edit it freely; it is saved on this PC as you type.
      </p>
    </section>
  )
}
