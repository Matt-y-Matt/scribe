import type { OpenAction } from '@/ipc'
import { useApp } from '@/lib/app-state'
import { lateText } from '@/lib/due'
import { cn } from '@/lib/utils'
import { OwnerChip } from '../live/CardRow'
import { clock } from '../live/format'
import { byOwner } from './open-actions'

// Everything still owed, across meetings, by person: the reason the notes
// are kept at all (PRD §3: every action leaves the room with an owner and a
// date, and gets done). A tick marks one done; it stays on screen, struck
// through, until Home is opened again, so a slip of the hand can be undone.
// "Friday" is shown with the date it meant, and what is past its date says
// how late it is.

const day = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
})

export function OpenActions({
  open,
  done,
  onDone,
  nowMs,
}: {
  open: readonly OpenAction[]
  /** The moment "late" is judged against. */
  nowMs: number
  /** Ids ticked since Home was opened. */
  done: readonly string[]
  onDone: (cardId: string, done: boolean) => void
}) {
  const go = useApp(app => app.go)

  if (open.length === 0) {
    return (
      <p className="p-6 text-body text-text-muted">
        Nothing is owed. Actions from your meetings appear here until they are
        ticked done.
      </p>
    )
  }

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-4 p-6">
      <p className="text-body text-text-muted">
        Every action not yet done, soonest due first. Tick one when it is done.
      </p>
      {byOwner(open, nowMs).map(({ owner, rows }) => {
        const open = rows.filter(row => !done.includes(row.card.id))
        const left = open.length
        const late = open.filter(row => (row.due?.lateDays ?? 0) > 0).length
        return (
          <section
            key={owner ?? ''}
            aria-label={owner ?? 'No owner'}
            className="flex flex-col gap-1"
          >
            <h3 className="flex items-center gap-2 text-body font-semibold">
              {owner ? <OwnerChip name={owner} /> : null}
              <span className={cn(!owner && 'text-action')}>
                {owner ?? 'No owner'}
              </span>
              <span className="font-mono text-meta font-normal text-text-muted">
                {left === 0 ? 'all done' : `${left} open`}
              </span>
              {late > 0 && (
                <span className="font-mono text-meta font-semibold text-action">
                  {late} late
                </span>
              )}
            </h3>
            <ul className="rounded-md border bg-surface">
              {rows.map(row => {
                const { card, meeting_title, meeting_created_at_ms, due } = row
                const ticked = done.includes(card.id)
                const lateDays = ticked ? 0 : (due?.lateDays ?? 0)
                return (
                  <li
                    key={card.id}
                    className="flex items-start gap-2 border-b px-2 py-1.5 last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      aria-label={`Done: ${card.text}`}
                      checked={ticked}
                      onChange={event => onDone(card.id, event.target.checked)}
                      className="mt-[3px] size-3.5 shrink-0 accent-accent"
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          'text-body',
                          ticked && 'text-text-muted line-through'
                        )}
                      >
                        {card.text}
                      </p>
                      <p className="text-meta text-text-muted">
                        {due && `${due.label} · `}
                        {lateDays > 0 && (
                          <>
                            <span className="font-semibold whitespace-nowrap text-action">
                              {lateText(lateDays)}
                            </span>
                            {' · '}
                          </>
                        )}
                        {meeting_title}, {day.format(meeting_created_at_ms)} ·{' '}
                        <button
                          type="button"
                          title="Open the meeting and play from here"
                          className="font-mono hover:text-text"
                          onClick={() =>
                            go({
                              name: 'meeting',
                              meetingId: card.meeting_id,
                              atMs: card.created_t_ms,
                            })
                          }
                        >
                          {clock(card.created_t_ms)}
                        </button>
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
