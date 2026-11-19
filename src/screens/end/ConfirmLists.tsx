import { Pin } from 'lucide-react'
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { editCard, scheduleTopic } from '@/engine/actions'
import { cardsIn, type Card, type MapState } from '@/engine/model'
import type { MapStore } from '@/engine/store'
import type { WrapUp } from '@/engine/summary'
import { cn } from '@/lib/utils'
import { clock } from '../live/format'
import { KindIcon } from '../live/KindIcon'

// The end screen's lists, UI_SPEC §3.3: what was decided, who owes what, what
// was parked, what was quoted. A tick puts a row in the summary; text, owner
// and due date are edited where they stand. Every edit is one operation on
// the map, so the map, the summary and the drafts never disagree.

const field =
  'h-6 min-w-0 rounded-md border bg-surface px-1.5 text-secondary outline-none placeholder:text-text-muted focus:border-accent'

/** How long a time link plays for: enough to hear what was said. */
const LISTEN_MS = 12_000

/** A line of text that becomes a box when clicked. Enter saves, Esc leaves. */
function EditableText({
  value,
  label,
  muted,
  onSave,
}: {
  value: string
  label: string
  muted: boolean
  onSave: (next: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null) {
    return (
      <button
        type="button"
        title="Click to edit"
        className={cn(
          'w-full cursor-text rounded-md text-left text-body hover:bg-surface-2',
          muted && 'text-text-muted'
        )}
        onClick={() => setDraft(value)}
      >
        {value}
      </button>
    )
  }
  const save = () => {
    if (draft.trim() !== '') onSave(draft.trim())
    setDraft(null)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      save()
    }
    if (event.key === 'Escape') setDraft(null)
  }
  return (
    <textarea
      autoFocus
      aria-label={label}
      rows={2}
      value={draft}
      onChange={event => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={onKeyDown}
      className="w-full resize-none rounded-md border border-accent bg-surface px-1.5 py-0.5 text-body outline-none"
    />
  )
}

/** A short field saved when it is left or on Enter. */
function QuickField({
  label,
  value,
  placeholder,
  list,
  missing,
  onSave,
}: {
  label: string
  value: string
  placeholder: string
  list?: string
  /** Empty and wanted: drawn so it is hard to overlook. */
  missing?: boolean
  onSave: (next: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft !== null && draft.trim() !== value) onSave(draft.trim())
    setDraft(null)
  }
  return (
    <input
      aria-label={label}
      placeholder={placeholder}
      list={list}
      value={draft ?? value}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') setDraft(null)
      }}
      className={cn(field, 'flex-1', missing && 'border-action')}
    />
  )
}

function ConfirmRow({
  card,
  topic,
  store,
  owners,
  onPlay,
}: {
  card: Card
  topic: string
  store: MapStore
  /** The id of the datalist of names an owner field offers. */
  owners: string
  onPlay: (t0Ms: number, t1Ms: number) => void
}) {
  const action = card.kind === 'action'
  return (
    <li
      data-card-id={card.id}
      className="flex items-start gap-2 border-b px-2 py-1.5 last:border-b-0"
    >
      <input
        type="checkbox"
        aria-label={`In the summary: ${card.text}`}
        checked={card.confirmed}
        onChange={event =>
          editCard(store, card.id, { confirmed: event.target.checked })
        }
        className="mt-[3px] size-3.5 shrink-0 accent-accent"
      />
      <KindIcon kind={card.kind} className="mt-[3px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <EditableText
          value={card.text}
          label="Card text"
          muted={!card.confirmed}
          onSave={text => editCard(store, card.id, { text })}
        />
        {action ? (
          // Who and by when sit on one line with the time, so eleven actions
          // still fit on a screen.
          <div className="flex items-center gap-1.5">
            <QuickField
              label={`Owner of: ${card.text}`}
              placeholder="Who?"
              list={owners}
              value={card.owner ?? ''}
              missing={card.confirmed && !card.owner}
              onSave={owner =>
                editCard(store, card.id, { owner: owner || null })
              }
            />
            <QuickField
              label={`Due date of: ${card.text}`}
              placeholder="By when?"
              value={card.due_text ?? ''}
              onSave={due =>
                editCard(store, card.id, { due_text: due || null })
              }
            />
            <button
              type="button"
              title={topic ? `Hear it · ${topic}` : 'Hear it'}
              className="shrink-0 font-mono text-meta text-text-muted hover:text-text"
              onClick={() =>
                onPlay(card.created_t_ms, card.created_t_ms + LISTEN_MS)
              }
            >
              {clock(card.created_t_ms)}
            </button>
          </div>
        ) : (
          <p className="flex gap-1 text-meta text-text-muted">
            <button
              type="button"
              title={topic ? `Hear it · ${topic}` : 'Hear it'}
              className="shrink-0 font-mono text-meta text-text-muted hover:text-text"
              onClick={() =>
                onPlay(card.created_t_ms, card.created_t_ms + LISTEN_MS)
              }
            >
              {clock(card.created_t_ms)}
            </button>
            {topic && <span className="truncate">· {topic}</span>}
          </p>
        )}
      </div>
    </li>
  )
}

function Column({
  title,
  count,
  note,
  empty,
  children,
}: {
  title: string
  count: number
  note?: string
  empty: string
  children: ReactNode
}) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-1">
      <h2 className="flex items-baseline gap-2 text-meta font-semibold text-text-muted">
        <span>
          {title.toUpperCase()} <span className="font-mono">({count})</span>
        </span>
        {note && <span className="font-normal text-action">{note}</span>}
      </h2>
      {count === 0 ? (
        <p className="rounded-md border border-dashed px-2 py-3 text-body text-text-muted">
          {empty}
        </p>
      ) : (
        <ul className="rounded-md border bg-surface">{children}</ul>
      )}
    </section>
  )
}

export function ConfirmLists({
  store,
  state,
  wrap,
  onPlay,
}: {
  store: MapStore
  state: MapState
  wrap: WrapUp
  onPlay: (t0Ms: number, t1Ms: number) => void
}) {
  const owners = useId()
  const names = new Set(state.meeting.participants)
  for (const card of wrap.actions) if (card.owner) names.add(card.owner)
  const topicOf = (card: Card) => state.topics[card.topic_id]?.title ?? ''
  const unowned = wrap.actions.filter(
    card => card.confirmed && !card.owner
  ).length

  const rows = (cards: readonly Card[]) =>
    cards.map(card => (
      <ConfirmRow
        key={card.id}
        card={card}
        topic={topicOf(card)}
        store={store}
        owners={owners}
        onPlay={onPlay}
      />
    ))

  return (
    <>
      <datalist id={owners}>
        {[...names].map(name => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="grid grid-cols-3 items-start gap-4">
        <Column
          title="Decisions"
          count={wrap.decisions.length}
          empty="Nothing was marked as decided. A note on the map can be changed into a decision."
        >
          {rows(wrap.decisions)}
        </Column>
        <Column
          title="Actions"
          count={wrap.actions.length}
          note={
            unowned === 0
              ? undefined
              : unowned === 1
                ? '1 has no owner'
                : `${unowned} have no owner`
          }
          empty="Nobody was given anything to do."
        >
          {rows(wrap.actions)}
        </Column>
        <Column
          title="Pinned"
          count={wrap.pinned.length}
          empty="Nothing was parked for later."
        >
          {wrap.pinned.map(topic => (
            <li
              key={topic.id}
              className="flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0"
            >
              <Pin size={12} aria-hidden className="shrink-0 text-text-muted" />
              <div className="min-w-0 flex-1">
                <p className="text-body">{topic.title}</p>
                <p className="font-mono text-meta text-text-muted">
                  pinned at {clock(topic.pinned_t_ms ?? 0)} ·{' '}
                  {cardsIn(state, topic.id).length} cards
                </p>
              </div>
              {topic.scheduled_t_ms === null ? (
                <button
                  type="button"
                  className="h-6 shrink-0 rounded-md border px-2 text-secondary font-semibold hover:bg-surface-2"
                  onClick={() => scheduleTopic(store, topic.id)}
                >
                  Schedule
                </button>
              ) : (
                <span className="shrink-0 text-meta text-text-muted">
                  to schedule
                </span>
              )}
            </li>
          ))}
        </Column>
      </div>
      {wrap.quotes.length > 0 && (
        <Column title="Quotes" count={wrap.quotes.length} empty="">
          {rows(wrap.quotes)}
        </Column>
      )}
    </>
  )
}
