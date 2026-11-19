import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { editCard } from '@/engine/actions'
import type { MapState } from '@/engine/model'
import type { MapStore } from '@/engine/store'
import { ownersOf, wrapUpOf } from '@/engine/summary'
import { OwnerChip } from '../live/CardRow'
import { knownOwners } from '../live/owners'

// Read-back: the ticked actions, one person at a time, for the host to read
// to the room before anyone leaves. The moment to fix a wrong owner is while
// that person is still in the chair (PRD §2), so every action carries the
// other names: one click hands it over. The right arrow or Enter goes on,
// the left arrow back, Escape closes.

export function ReadBack({
  store,
  state,
  onClose,
}: {
  store: MapStore
  state: MapState
  onClose: () => void
}) {
  const actions = wrapUpOf(state).actions.filter(card => card.confirmed)
  const people = ownersOf(actions)
  // The person being read, by name: handing an action over can change the
  // order of the people, and the page must not jump to someone else. `at`
  // is where to land if that person's page goes with its last action.
  const [reading, setReading] = useState<{ who: string | null; at: number }>(
    () => ({ who: people[0] ?? null, at: 0 })
  )
  const found = people.indexOf(reading.who)
  const page =
    found >= 0 ? found : Math.min(reading.at, Math.max(0, people.length - 1))
  const owner = people[page] ?? null
  const setAt = (next: number) =>
    setReading({ who: people[next] ?? null, at: next })
  const mine = actions.filter(card => card.owner === owner)
  const names = knownOwners(state)
  const last = page >= people.length - 1

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLButtonElement && event.key === 'Enter') {
        return
      }
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight' || event.key === 'Enter') {
        if (last) onClose()
        else setAt(page + 1)
      } else if (event.key === 'ArrowLeft') setAt(Math.max(0, page - 1))
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Read back"
      className="fade-in absolute inset-0 z-40 flex flex-col bg-bg"
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-surface px-3">
        <h2 className="flex-1 text-header font-semibold">
          Read back
          {people.length > 0 && (
            <span className="ml-2 font-mono text-meta font-normal text-text-muted">
              {page + 1} of {people.length}
            </span>
          )}
        </h2>
        <span className="text-secondary text-text-muted">
          Read each one aloud. Anyone can object while they are still here.
        </span>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </header>

      {people.length === 0 ? (
        <p className="p-6 text-body text-text-muted">
          No ticked actions to read back.
        </p>
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col gap-4 overflow-y-auto p-6">
          <h3 className="flex items-center gap-2 text-title font-semibold">
            {owner ? (
              <>
                <OwnerChip name={owner} />
                {owner}
              </>
            ) : (
              <span className="text-action">Nobody owns these yet</span>
            )}
            <span className="font-mono text-meta font-normal text-text-muted">
              {mine.length} {mine.length === 1 ? 'action' : 'actions'}
            </span>
          </h3>
          <ul className="flex flex-col gap-3">
            {mine.map(card => (
              <li
                key={card.id}
                className="flex flex-col gap-2 rounded-md border bg-surface p-3"
              >
                <p className="text-header">
                  {card.text}
                  {card.due_text && (
                    <span className="text-text-muted">
                      {' '}
                      — by {card.due_text}
                    </span>
                  )}
                </p>
                <div
                  role="group"
                  aria-label={`Who owns: ${card.text}`}
                  className="flex flex-wrap items-center gap-1"
                >
                  <span className="text-meta text-text-muted">
                    {owner ? 'Not theirs? Give it to' : 'Give it to'}
                  </span>
                  {names
                    .filter(name => name !== owner)
                    .map(name => (
                      <button
                        key={name}
                        type="button"
                        className="h-6 rounded-md border px-2 text-secondary hover:bg-surface-2"
                        onClick={() =>
                          editCard(store, card.id, { owner: name })
                        }
                      >
                        {name}
                      </button>
                    ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer className="flex h-12 shrink-0 items-center justify-end gap-2 border-t bg-surface px-3">
        <Button
          variant="outline"
          disabled={page === 0}
          onClick={() => setAt(page - 1)}
        >
          Back
        </Button>
        {last ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <Button onClick={() => setAt(page + 1)}>
            Next: {people[page + 1] ?? 'no owner'}
          </Button>
        )}
      </footer>
    </div>
  )
}
