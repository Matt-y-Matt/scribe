import { Menu } from '@base-ui/react/menu'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ellipsis } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { Sheet } from '@/components/Sheet'
import { Button } from '@/components/ui/button'
import type { MeetingInfo } from '@/ipc'
import { reasonOf, useBackend } from '@/lib/backend'
import { clock } from '../live/format'

// Rename a meeting, or delete it for good, from Home. Deleting takes the
// recording, the transcript, the notes and the summary off this PC and
// cannot be undone, so it says exactly what goes and asks first. Nothing
// here can touch a meeting that is being recorded: the core refuses.

const popup =
  'min-w-36 rounded-md border bg-surface p-1 text-body text-text outline-none'
const item =
  'flex cursor-default items-center rounded-md px-2 py-1 outline-none select-none data-[highlighted]:bg-surface-2'

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

/** The title as a box: Enter or leaving it saves, Escape leaves it alone. */
export function TitleBox({
  meeting,
  onDone,
}: {
  meeting: MeetingInfo
  onDone: () => void
}) {
  const backend = useBackend()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState(meeting.title)
  const rename = useMutation({
    mutationFn: (next: string) => backend.renameMeeting(meeting.id, next),
    retry: false,
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      onDone()
    },
  })

  const save = () => {
    const next = title.trim()
    if (next === '' || next === meeting.title) onDone()
    else rename.mutate(next)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') save()
    if (event.key === 'Escape') onDone()
  }

  return (
    <>
      <input
        autoFocus
        aria-label="Meeting title"
        value={title}
        disabled={rename.isPending}
        onChange={event => setTitle(event.target.value)}
        onBlur={save}
        onKeyDown={onKeyDown}
        className="h-7 w-full rounded-md border border-accent bg-surface px-2 text-title font-semibold outline-none"
      />
      {rename.isError && (
        <p role="alert" className="text-body">
          The title could not be changed. Try again.
        </p>
      )}
    </>
  )
}

function ConfirmDelete({
  meeting,
  onClose,
}: {
  meeting: MeetingInfo
  onClose: () => void
}) {
  const backend = useBackend()
  const queryClient = useQueryClient()
  // Home already has these; here they say what else goes with the meeting.
  const owed = useQuery({
    queryKey: ['open-actions'],
    queryFn: () => backend.openActions(),
    staleTime: 0,
  })
  const remove = useMutation({
    mutationFn: () => backend.deleteMeeting(meeting.id),
    retry: false,
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      onClose()
    },
  })
  const actions = (owed.data ?? []).filter(
    row => row.card.meeting_id === meeting.id
  ).length
  const recorded = meeting.started_at_ms !== null

  return (
    <Sheet title="Delete this meeting?" onClose={onClose} width={480}>
      <div className="flex flex-col gap-3 p-4 text-body">
        <p>
          <strong className="font-semibold">“{meeting.title}”</strong>,{' '}
          {day.format(meeting.created_at_ms)}
          {recorded && `, ${clock(meeting.duration_ms)} recorded`}.
        </p>
        <p>
          {recorded
            ? 'Its recording, transcript, notes and summary are removed from this PC.'
            : 'It was never recorded; its title and agenda are removed.'}{' '}
          {actions > 0 &&
            `${actions === 1 ? 'The 1 open action' : `The ${actions} open actions`} from it ${actions === 1 ? 'goes' : 'go'} too. `}
          This cannot be undone.
        </p>
        {remove.isError && (
          <p role="alert">
            {reasonOf(remove.error) === 'busy'
              ? 'This meeting is being recorded. Stop it first.'
              : 'It could not be deleted. Try again.'}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" autoFocus onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="outline"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? 'Deleting…' : 'Delete meeting'}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

export function MeetingMenu({
  meeting,
  onRename,
}: {
  meeting: MeetingInfo
  onRename: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          aria-label={`More for ${meeting.title}`}
          className="flex size-7 shrink-0 items-center justify-center rounded-md border text-text-muted transition-opacity duration-150 ease-out hover:bg-surface-2"
        >
          <Ellipsis size={14} aria-hidden />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={4} className="z-50">
            <Menu.Popup className={popup}>
              <Menu.Item className={item} onClick={onRename}>
                Rename
              </Menu.Item>
              <Menu.Item className={item} onClick={() => setConfirming(true)}>
                Delete…
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {confirming && (
        <ConfirmDelete meeting={meeting} onClose={() => setConfirming(false)} />
      )}
    </>
  )
}
