import { useDraggable, useDroppable } from '@dnd-kit/core'
import type { Card } from '@/engine/model'
import { cn } from '@/lib/utils'
import { clock, initials } from './format'
import { KindIcon } from './KindIcon'
import { KIND_BAR } from './kinds'

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
 * the topic instead.
 */
export function CardRow({ card }: { card: Card }) {
  const drag = useDraggable({ id: card.id })
  const target: DropTarget = {
    type: 'card',
    cardId: card.id,
    topicId: card.topic_id,
  }
  const drop = useDroppable({ id: `card:${card.id}`, data: target })
  const setRef = (element: HTMLLIElement | null) => {
    drag.setNodeRef(element)
    drop.setNodeRef(element)
  }
  // dnd-kit would make the row a button; it is a list item that can be dragged.
  const { role: _role, ...attributes } = drag.attributes
  const insertHere = drop.isOver && drop.active?.id !== card.id

  return (
    <li
      ref={setRef}
      data-card-id={card.id}
      data-kind={card.kind}
      className={cn(
        'nodrag nopan fade-in relative flex cursor-grab items-start gap-2 border-b border-l-[3px] py-1 pr-2 pl-[5px] last:border-b-0',
        KIND_BAR[card.kind],
        drag.isDragging && 'opacity-40'
      )}
      {...attributes}
      {...drag.listeners}
    >
      {insertHere && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-accent"
        />
      )}
      <CardFace card={card} />
    </li>
  )
}
