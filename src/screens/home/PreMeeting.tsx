import { X } from 'lucide-react'
import { useState } from 'react'
import { Sheet } from '@/components/Sheet'
import { Button } from '@/components/ui/button'
import type { NewMeeting } from '@/ipc'

// The Pre-meeting sheet, UI_SPEC §3.2, in its M2 form: a title, the agenda,
// who is expected, the consent reminder, Start. The QR code and the mode and
// privacy controls arrive with phones (M4) and the cloud switch.

/** PRD F1.1: an agenda of 0 to 8 headers. */
export const MAX_AGENDA = 8

const field =
  'h-7 w-full rounded-md border bg-surface px-2 text-body outline-none placeholder:text-text-muted focus:border-accent'

export function PreMeeting({
  onStart,
  onClose,
  initial,
}: {
  /** Creates the meeting and starts recording. Rejects when it cannot. */
  onStart: (meeting: NewMeeting) => Promise<void>
  onClose: () => void
  /** What the sheet opens with: the `?screen=premeeting` fixture. */
  initial?: Partial<NewMeeting>
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [agenda, setAgenda] = useState<string[]>(initial?.agenda ?? [])
  const [header, setHeader] = useState('')
  const [people, setPeople] = useState((initial?.participants ?? []).join(', '))
  const [starting, setStarting] = useState(false)
  const [failed, setFailed] = useState(false)

  const full = agenda.length >= MAX_AGENDA
  const addHeader = () => {
    const next = header.trim()
    if (next === '' || full) return
    if (!agenda.includes(next)) setAgenda([...agenda, next])
    setHeader('')
  }

  const start = async () => {
    setStarting(true)
    setFailed(false)
    // A header still in the box counts: the host typed it.
    const typed = header.trim()
    const headers =
      typed !== '' && !full && !agenda.includes(typed)
        ? [...agenda, typed]
        : agenda
    try {
      await onStart({
        title: title.trim() || 'Untitled meeting',
        agenda: headers,
        mode: 'group',
        participants: people
          .split(',')
          .map(name => name.trim())
          .filter(Boolean),
      })
    } catch {
      setFailed(true)
      setStarting(false)
    }
  }

  return (
    <Sheet title="New meeting" onClose={onClose}>
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={event => {
          event.preventDefault()
          void start()
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-secondary font-semibold">Title</span>
          <input
            autoFocus
            value={title}
            onChange={event => setTitle(event.target.value)}
            placeholder="Weekly team meeting"
            className={field}
          />
        </label>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="agenda-header"
            className="text-secondary font-semibold"
          >
            Agenda
          </label>
          {agenda.length > 0 && (
            <ul aria-label="Agenda headers" className="flex flex-wrap gap-1">
              {agenda.map(item => (
                <li
                  key={item}
                  className="flex h-6 items-center gap-1 rounded-md border pr-1 pl-2 text-secondary"
                >
                  {item}
                  <button
                    type="button"
                    aria-label={`Remove ${item}`}
                    className="text-text-muted"
                    onClick={() =>
                      setAgenda(agenda.filter(other => other !== item))
                    }
                  >
                    <X size={12} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            id="agenda-header"
            value={header}
            disabled={full}
            onChange={event => setHeader(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addHeader()
              }
            }}
            placeholder={
              full ? 'Eight headers is the most' : 'Type a header, press Enter'
            }
            className={field}
          />
          <p className="text-meta text-text-muted">
            Each header becomes a column on the map. A meeting with no agenda is
            fine.
          </p>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-secondary font-semibold">
            People{' '}
            <span className="font-normal text-text-muted">(optional)</span>
          </span>
          <input
            value={people}
            onChange={event => setPeople(event.target.value)}
            placeholder="Matt, Zach, Ant, Kabs"
            className={field}
          />
          <p className="text-meta text-text-muted">
            Names, separated by commas, so an action can be given to its owner.
          </p>
        </label>

        <p className="rounded-md bg-surface-2 px-3 py-2 text-body">
          Tell the room you’re recording. Audio and transcript stay on this PC.
        </p>

        {failed && (
          <p role="alert" className="text-body">
            The meeting could not be created. Try again.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={starting}>
            Start recording
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
