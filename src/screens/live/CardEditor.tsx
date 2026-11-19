import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Button } from '@/components/ui/button'
import { addCard, deleteCard, editCard } from '@/engine/actions'
import { CARD_KINDS, type Card, type CardKind } from '@/engine/model'
import { cn } from '@/lib/utils'
import { wallClockMs } from './format'
import { KindIcon } from './KindIcon'
import { KIND_LABEL } from './kinds'
import { useLive } from './live-context'
import { knownOwners, ownerMention } from './owners'
import { claimTyping } from './type-ahead'

// A card being written or changed by hand (PRD F4.6): its text, its kind,
// and for an action who owes it and by when. It sits in the card's own row,
// so nothing covers the map (rule 4.3). Saving is one operation: Ctrl+Z
// takes all of it back.

const field =
  'w-full rounded-md border bg-surface px-1.5 text-body outline-none placeholder:text-text-muted focus:border-accent'

export function CardEditor({
  card,
  topicId,
  kind: startKind = 'note',
  onDone,
}: {
  /** The card being changed. Without one, a new card for `topicId`. */
  card?: Card
  topicId: string
  /** The kind a new card starts as: N, A or D was pressed. */
  kind?: CardKind
  onDone: () => void
}) {
  const { store, state, notify, session } = useLive()
  const [text, setText] = useState(card?.text ?? '')
  const [kind, setKind] = useState<CardKind>(card?.kind ?? startKind)
  const [owner, setOwner] = useState(card?.owner ?? '')
  const [due, setDue] = useState(card?.due_text ?? '')
  const [done, setDone] = useState(
    card !== undefined && card.done_at_ms !== null
  )
  const owners = useId()
  const textBox = useRef<HTMLTextAreaElement>(null)

  // Open ready to type on, at the end of what is there. Before the browser
  // paints, so no key falls between the box appearing and it having focus;
  // what was typed while it was on its way (type-ahead.ts) goes in first.
  useLayoutEffect(() => {
    const box = textBox.current
    if (!box) return
    // Without moving the map under the host (rule 4.2).
    box.focus({ preventScroll: true })
    box.setSelectionRange(box.value.length, box.value.length)
    claimTyping(typed => setText(written => written + typed))
  }, [])

  // Who and when belong to actions; a card that already has them keeps them
  // in view, whatever its kind.
  const owed = kind === 'action' || !!card?.owner || !!card?.due_text
  const names = knownOwners(state)
  // "@kabs" while typing gives the card to Kabs, and makes a note an action.
  const mention = ownerMention(text, names)
  const ready = (mention?.text ?? text).trim() !== ''

  const save = () => {
    if (!ready) return
    const fields = {
      kind: mention && kind === 'note' ? ('action' as const) : kind,
      text: (mention?.text ?? text).trim(),
      owner: mention?.owner ?? (owner.trim() || null),
      due_text: due.trim() || null,
    }
    if (card) {
      editCard(store, card.id, {
        ...fields,
        // Keep the day it was done; only a change of mind changes it.
        done_at_ms:
          fields.kind === 'action' && done
            ? (card.done_at_ms ?? wallClockMs())
            : null,
      })
    }
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

      {mention && (
        <p role="status" className="text-meta text-text-muted">
          {mention.owner} will own this
          {kind === 'note' ? ', as an action' : ''}.
        </p>
      )}

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
            {names.map(name => (
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

      {card && kind === 'action' && (
        <label className="flex items-center gap-1.5 text-secondary">
          <input
            type="checkbox"
            checked={done}
            onChange={event => setDone(event.target.checked)}
            className="size-3.5 accent-accent"
          />
          Done
        </label>
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
