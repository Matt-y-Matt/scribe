import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { addCard, deleteCard, editCard } from '@/engine/actions'
import { CARD_KINDS, type Card, type CardKind } from '@/engine/model'
import { cn } from '@/lib/utils'
import { KindIcon } from './KindIcon'
import { KIND_LABEL } from './kinds'
import { useLive } from './live-context'

// A card being written or changed by hand (PRD F4.6): its text, its kind,
// and for an action who owes it and by when. It sits in the card's own row,
// so nothing covers the map (rule 4.3). Saving is one operation: Ctrl+Z
// takes all of it back.

const field =
  'w-full rounded-md border bg-surface px-1.5 text-body outline-none placeholder:text-text-muted focus:border-accent'

/** The names an owner is most likely to be: the room, then who already owes. */
function knownOwners(
  participants: readonly string[],
  cards: Iterable<Card>
): string[] {
  const names = new Set(participants)
  for (const card of cards) if (card.owner) names.add(card.owner)
  return [...names]
}

export function CardEditor({
  card,
  topicId,
  onDone,
}: {
  /** The card being changed. Without one, a new card for `topicId`. */
  card?: Card
  topicId: string
  onDone: () => void
}) {
  const { store, state, notify, session } = useLive()
  const [text, setText] = useState(card?.text ?? '')
  const [kind, setKind] = useState<CardKind>(card?.kind ?? 'note')
  const [owner, setOwner] = useState(card?.owner ?? '')
  const [due, setDue] = useState(card?.due_text ?? '')
  const owners = useId()
  const textBox = useRef<HTMLTextAreaElement>(null)

  // Open ready to type on, at the end of what is there.
  useEffect(() => {
    const box = textBox.current
    if (!box) return
    box.focus()
    box.setSelectionRange(box.value.length, box.value.length)
  }, [])

  // Who and when belong to actions; a card that already has them keeps them
  // in view, whatever its kind.
  const owed = kind === 'action' || !!card?.owner || !!card?.due_text
  const ready = text.trim() !== ''

  const save = () => {
    if (!ready) return
    const fields = {
      kind,
      text: text.trim(),
      owner: owner.trim() || null,
      due_text: due.trim() || null,
    }
    if (card) editCard(store, card.id, fields)
    // A card the host writes once the meeting is over is one they vouch
    // for: it is in the summary unless they untick it.
    else {
      addCard(store, topicId, {
        ...fields,
        confirmed: session.getState().review,
      })
    }
    onDone()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // The map's own keys (F, T, P, Space) stay out of the form.
    event.stopPropagation()
    if (event.key === 'Escape') onDone()
    if (event.key === 'Enter' && !event.shiftKey) {
      // Enter on a button presses that button.
      if (event.target instanceof HTMLButtonElement) return
      event.preventDefault()
      save()
    }
  }

  return (
    <form
      aria-label={card ? 'Edit card' : 'New card'}
      className="nodrag nopan nowheel flex min-w-0 flex-1 cursor-default flex-col gap-1.5 py-1"
      onSubmit={event => {
        event.preventDefault()
        save()
      }}
      onKeyDown={onKeyDown}
      onClick={event => event.stopPropagation()}
    >
      <textarea
        ref={textBox}
        aria-label="Card text"
        placeholder="What was said, decided or owed"
        rows={3}
        value={text}
        onChange={event => setText(event.target.value)}
        className={cn(field, 'resize-none py-1')}
      />

      <div role="radiogroup" aria-label="Kind" className="flex gap-1">
        {CARD_KINDS.map(option => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={kind === option}
            aria-label={KIND_LABEL[option]}
            title={KIND_LABEL[option]}
            className={cn(
              'flex h-6 items-center gap-1 rounded-md border px-1.5 text-meta transition-opacity duration-150 ease-out',
              kind === option
                ? 'border-accent bg-accent-soft'
                : 'border-transparent hover:bg-surface-2'
            )}
            onClick={() => setKind(option)}
          >
            <KindIcon kind={option} />
            {/* The chosen kind is named; the rest are icons with a title. */}
            {kind === option && <span>{KIND_LABEL[option]}</span>}
          </button>
        ))}
      </div>

      {owed && (
        <div className="flex gap-1.5">
          <input
            aria-label="Owner"
            placeholder="Owner"
            list={owners}
            value={owner}
            onChange={event => setOwner(event.target.value)}
            className={cn(field, 'h-6 min-w-0 flex-1')}
          />
          <datalist id={owners}>
            {knownOwners(
              state.meeting.participants,
              Object.values(state.cards)
            ).map(name => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <input
            aria-label="Due"
            placeholder="Due"
            value={due}
            onChange={event => setDue(event.target.value)}
            className={cn(field, 'h-6 min-w-0 flex-1')}
          />
        </div>
      )}

      <div className="flex items-center gap-1.5">
        {card && (
          <button
            type="button"
            className="text-secondary text-text-muted hover:text-text"
            onClick={() => {
              deleteCard(store, card.id)
              notify('Deleted the card.')
              onDone()
            }}
          >
            Delete
          </button>
        )}
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready}>
          {card ? 'Save' : 'Add'}
        </Button>
      </div>
    </form>
  )
}
