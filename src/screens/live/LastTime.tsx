import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useStore } from 'zustand'
import { cn } from '@/lib/utils'
import { OwnerChip } from './CardRow'
import { useLive } from './live-context'

// What is still owed from the earlier meetings of the same name, at the top
// of the rail: the first two minutes of a weekly meeting. The host reads
// them out and ticks what is done; what stays unticked stays open and will
// be here again next time. Not shown when there is nothing owed.

const day = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
})

export function LastTime() {
  const { session, actions } = useLive()
  const owed = useStore(session, state => state.lastTime)
  const done = useStore(session, state => state.lastTimeDone)
  const [open, setOpen] = useState(true)
  if (owed.length === 0) return null

  const left = owed.filter(row => !done.includes(row.card.id)).length
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <section
      aria-labelledby="last-time-title"
      className="flex max-h-[35%] min-h-0 shrink-0 flex-col border-b"
    >
      <h2 id="last-time-title" className="shrink-0">
        <button
          type="button"
          aria-expanded={open}
          className="flex h-9 w-full items-center gap-1 px-3 text-meta font-semibold text-text-muted hover:bg-surface-2"
          onClick={() => setOpen(!open)}
        >
          <Chevron size={12} aria-hidden />
          <span className="flex-1 text-left">FROM LAST TIME</span>
          <span className="font-mono font-normal">
            {left === 0 ? 'all done' : `${left} open`}
          </span>
        </button>
      </h2>
      {open && (
        <ul className="flex min-h-0 flex-col overflow-y-auto px-2 pb-2">
          {owed.map(({ card, meeting_created_at_ms }) => {
            const ticked = done.includes(card.id)
            const meta = [
              card.owner,
              card.due_text && `due ${card.due_text}`,
              `from ${day.format(meeting_created_at_ms)}`,
            ].filter(Boolean)
            return (
              <li key={card.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    aria-label={`Done: ${card.text}`}
                    checked={ticked}
                    onChange={event =>
                      actions.setDone(card.id, event.target.checked)
                    }
                    className="mt-[3px] size-3.5 shrink-0 accent-accent"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block text-body',
                        ticked && 'text-text-muted line-through'
                      )}
                    >
                      {card.text}
                    </span>
                    <span className="block text-meta text-text-muted">
                      {meta.join(' · ')}
                    </span>
                  </span>
                  {card.owner && <OwnerChip name={card.owner} />}
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
