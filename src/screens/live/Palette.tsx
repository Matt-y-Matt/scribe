import { AudioLines, LayoutList, Search } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useStore } from 'zustand'
import { cn } from '@/lib/utils'
import { clock } from './format'
import { KindIcon } from './KindIcon'
import { useLive } from './live-context'
import { searchMeeting, type PaletteHit } from './palette-search'

// Ctrl+K (UI_SPEC §4.6): find a topic, a card or something that was said,
// and go there. A topic or a card brings its topic into view on the map; a
// line of the transcript plays. It sits over the map without dimming it and
// goes away on Escape or a click elsewhere: not a dialog that stops the
// meeting (rule 4.3).

const GROUP: Record<PaletteHit['type'], string> = {
  topic: 'Topics',
  card: 'Cards',
  line: 'Said',
}

export function Palette({ onClose }: { onClose: () => void }) {
  const { state, session, actions, focusTopic, setActiveTopicId } = useLive()
  const segments = useStore(session, live => live.segments)
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const list = useRef<HTMLUListElement>(null)

  const hits = searchMeeting(state, segments, query.trim(), clock)
  const chosen = Math.min(at, hits.length - 1)

  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [chosen])

  const go = (hit: PaletteHit) => {
    if (hit.type === 'line') {
      actions.playSpan(hit.t0Ms, hit.t1Ms)
    } else {
      const topicId = hit.type === 'topic' ? hit.id : hit.topicId
      setActiveTopicId(topicId)
      focusTopic(topicId)
    }
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // Nothing typed here is a key of the map.
    event.stopPropagation()
    if (event.key === 'Escape') onClose()
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setAt(Math.min(chosen + 1, hits.length - 1))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setAt(Math.max(chosen - 1, 0))
    }
    if (event.key === 'Enter') {
      const hit = hits[chosen]
      if (hit) go(hit)
    }
  }

  return (
    <>
      {/* A click anywhere else closes it. Nothing is dimmed. */}
      <button
        type="button"
        aria-label="Close search"
        tabIndex={-1}
        className="absolute inset-0 z-30 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Search this meeting"
        className="fade-in absolute top-3 left-1/2 z-30 flex max-h-[70%] w-[520px] max-w-[calc(100%-32px)] -translate-x-1/2 flex-col rounded-md border bg-surface"
        onKeyDown={onKeyDown}
      >
        <label className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
          <Search size={14} aria-hidden className="text-text-muted" />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="palette-hits"
            aria-label="Search this meeting"
            placeholder="Find a topic, a card or something that was said"
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setAt(0)
            }}
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
          />
          <kbd className="font-mono text-meta text-text-muted">Esc</kbd>
        </label>
        {hits.length === 0 ? (
          <p role="status" className="px-3 py-3 text-body text-text-muted">
            {query.trim() === ''
              ? 'No topics yet.'
              : `Nothing in this meeting matches “${query.trim()}”.`}
          </p>
        ) : (
          <ul
            ref={list}
            id="palette-hits"
            role="listbox"
            aria-label="Results"
            className="min-h-0 overflow-y-auto p-1"
          >
            {hits.map((hit, index) => (
              <li key={`${hit.type}:${hit.id}`} role="presentation">
                {hit.type !== hits[index - 1]?.type && (
                  <p className="px-2 pt-2 pb-1 text-meta font-semibold text-text-muted">
                    {GROUP[hit.type].toUpperCase()}
                  </p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === chosen}
                  tabIndex={-1}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-1 text-left',
                    index === chosen ? 'bg-accent-soft' : 'hover:bg-surface-2'
                  )}
                  onPointerMove={() => setAt(index)}
                  onClick={() => go(hit)}
                >
                  {hit.type === 'card' ? (
                    <KindIcon kind={hit.kind} className="mt-[3px]" />
                  ) : hit.type === 'topic' ? (
                    <LayoutList
                      size={12}
                      aria-hidden
                      className="mt-[3px] shrink-0 text-text-muted"
                    />
                  ) : (
                    <AudioLines
                      size={12}
                      aria-hidden
                      className="mt-[3px] shrink-0 text-text-muted"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-body">{hit.text}</span>
                    {hit.meta && (
                      <span className="block truncate text-meta text-text-muted">
                        {hit.meta}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-meta text-text-muted">
                    {hit.type === 'line' ? 'play' : 'show'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
