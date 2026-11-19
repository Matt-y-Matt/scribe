import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { MapState } from '@/engine/model'
import {
  PRESET_LABEL,
  renderSummary,
  SUMMARY_PRESETS,
  writeSummary,
  type SummaryMeta,
  type SummaryPreset,
} from '@/engine/summary'
import type { Summary } from '@/ipc'
import { cn } from '@/lib/utils'
import { CopyButton } from './CopyButton'

// The summary, UI_SPEC §3.3. The three presets are written from the ticked
// rows the moment they change, with no model. Typing a layout of one's own
// and pressing Write asks the model on this PC to lay the same notes out
// that way. Either can then be edited by hand; what is on screen is what is
// saved.

const SAVE_AFTER_MS = 500

const isPreset = (value: string | null): value is SummaryPreset =>
  SUMMARY_PRESETS.includes(value as SummaryPreset)

export function SummaryPanel({
  state,
  meta,
  initial,
  onSave,
  ask,
}: {
  state: MapState
  meta: SummaryMeta
  /** What was saved for this meeting; both null the first time. */
  initial: Summary
  onSave: (summary: Summary) => void
  /** One request to the model on this PC (the core's relay to Ollama). */
  ask: (body: string) => Promise<string>
}) {
  const [preset, setPreset] = useState<SummaryPreset>(
    isPreset(initial.layout) ? initial.layout : 'decisions-actions'
  )
  const [layout, setLayout] = useState(
    isPreset(initial.layout) ? '' : (initial.layout ?? '')
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

  const shown = own?.text ?? preview
  const stale = own !== null && own.from !== preview
  const custom = layout.trim()

  // Save what is on screen, a moment after it stops changing, and at once
  // when the screen is left.
  const saved = useRef(initial.markdown)
  const latest = useRef({ shown, layout: custom || preset, onSave })
  useEffect(() => {
    latest.current = { shown, layout: custom || preset, onSave }
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
  }, [shown, custom, preset])
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
    } catch {
      setFailed(true)
    } finally {
      setWriting(false)
    }
  }

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
      </div>

      <div role="radiogroup" aria-label="Layout" className="flex gap-1">
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

      {writing && (
        <p role="status" className="text-secondary text-text-muted">
          The model on this PC is writing. This can take a minute; the text
          below stays until it is done.
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
            }}
          >
            Write it again
          </Button>
        </p>
      )}

      {byModel && own !== null && !writing && (
        <p role="status" className="text-secondary text-text-muted">
          Written by the model on this PC. Read it against the lists: a small
          model can get a number or a condition wrong.
        </p>
      )}

      <textarea
        aria-label="Summary text"
        spellCheck={false}
        value={shown}
        onChange={event =>
          setOwn({ text: event.target.value, from: own?.from ?? preview })
        }
        className="min-h-40 flex-1 resize-none rounded-md border bg-surface p-3 font-mono text-secondary outline-none focus:border-accent"
      />
      <p className="text-meta text-text-muted">
        Markdown. Edit it freely; it is saved on this PC as you type.
      </p>
    </section>
  )
}
