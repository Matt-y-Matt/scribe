import { useDraggable, useDroppable } from '@dnd-kit/core'
import { Pencil } from 'lucide-react'
import { useStore } from 'zustand'
import type { Card } from '@/engine/model'
import { cn } from '@/lib/utils'
import { CardEditor } from './CardEditor'
import { clock, initials } from './format'
import { KindIcon } from './KindIcon'
import { KIND_BAR } from './kinds'
import { useLive } from './live-context'

/** What a card or a topic tells the drag handler when something lands on it. */
export type DropTarget =
  | { type: 'card'; cardId: string; topicId: string }
  | { type: 'topic'; topicId: string }

/** Owner chip: initials in the action colour's outline (UI_SPEC §2.2). */
export function OwnerChip({ name }: { name: string }) {
  return (
    <span
      title={name}
      className="shrink-0 rounded-md border border-action px-1 font-mono text-meta text-action"
    >
      {initials(name)}
    </span>
  )
}

/** The card as it looks, with no behaviour: also what follows the pointer. */
export function CardFace({ card }: { card: Card }) {
  const meta = [
    clock(card.created_t_ms),
    card.owner,
    card.due_text && `due ${card.due_text}`,
  ].filter(Boolean)
  return (
    <>
      <KindIcon kind={card.kind} className="mt-[3px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-body">{card.text}</p>
          {card.kind === 'action' && card.owner && (
            <OwnerChip name={card.owner} />
          )}
        </div>
        {/* The meta line runs under the chip, so it stays on one line. */}
        <p className="font-mono text-meta text-text-muted">
          {meta.join(' · ')}
        </p>
      </div>
    </>
  )
}

/**
 * One card: a row inside its topic. Drag it by pointer to another topic, or
 * onto a card to go in front of it. `nodrag` keeps React Flow from dragging
 * the topic instead. A click plays what the card was made from, and the card
 * is outlined while that plays (UI_SPEC §2.5). The pencil, or Enter on the
 * card, opens it for editing in place (PRD F4.6).
 */
/** A card with nothing cited still plays a little from where it points. */
const UNCITED_MS = 8_000

export function CardRow({ card }: { card: Card }) {
  const { session, actions, editingId, setEditingId } = useLive()
  const editing = editingId === card.id
  // The span the card was made from: its first cited segment to its last.
  const endMs = useStore(session, state => {
    let end = 0
    for (const segment of state.segments) {
      if (card.segment_ids.includes(segment.id))
        end = Math.max(end, segment.t1_ms)
    }
    return end > card.created_t_ms ? end : card.created_t_ms + UNCITED_MS
  })
  const playing = useStore(
    session,
    state =>
      state.playback.playing &&
      state.playback.tMs >= card.created_t_ms &&
      state.playback.tMs < endMs
  )
  const drag = useDraggable({ id: card.id, disabled: editing })
  const target: DropTarget = {
    type: 'card',
    cardId: card.id,
    topicId: card.topic_id,
  }
  const {
    setNodeRef: setDropRef,
    isOver,
    active,
  } = useDroppable({ id: `card:${card.id}`, data: target })
  const setRef = (element: HTMLLIElement | null) => {
    drag.setNodeRef(element)
    setDropRef(element)
  }
  // dnd-kit would make the row a button; it is a list item that can be dragged.
  const { role: _role, ...attributes } = drag.attributes
  const insertHere = isOver && active?.id !== card.id

  if (editing) {
    return (
      <li
        ref={setDropRef}
        data-card-id={card.id}
        data-kind={card.kind}
        className={cn(
          'nodrag nopan relative flex items-start gap-2 border-b border-l-[3px] pr-2 pl-[5px] last:border-b-0',
          KIND_BAR[card.kind]
        )}
      >
        <CardEditor
          card={card}
          topicId={card.topic_id}
          onDone={() => setEditingId(null)}
        />
      </li>
    )
  }

  return (
    <li
      ref={setRef}
      data-card-id={card.id}
      data-kind={card.kind}
      className={cn(
        'group nodrag nopan fade-in relative flex cursor-grab items-start gap-2 border-b border-l-[3px] py-1 pr-2 pl-[5px] last:border-b-0',
        KIND_BAR[card.kind],
        drag.isDragging && 'opacity-40',
        playing && 'outline outline-1 -outline-offset-1 outline-accent'
      )}
      {...attributes}
      {...drag.listeners}
      onClick={() => actions.playSpan(card.created_t_ms, endMs)}
      onKeyDown={event => {
        if (event.key !== 'Enter' || event.target !== event.currentTarget) {
          return
        }
        event.stopPropagation()
        setEditingId(card.id)
      }}
    >
      {insertHere && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-accent"
        />
      )}
      <CardFace card={card} />
      {/* Out of the way until the card is pointed at or focused. */}
      <button
        type="button"
        aria-label="Edit card"
        className="absolute right-1 bottom-0.5 flex size-5 items-center justify-center rounded-md bg-surface text-text-muted opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-surface-2 focus-visible:opacity-100"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation()
          setEditingId(card.id)
        }}
      >
        <Pencil size={11} aria-hidden />
      </button>
    </li>
  )
}
