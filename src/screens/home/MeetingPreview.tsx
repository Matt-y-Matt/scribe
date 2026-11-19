import { useQuery } from '@tanstack/react-query'
import { Pin } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { CardRow, MeetingInfo } from '@/ipc'
import { useApp } from '@/lib/app-state'
import { useBackend } from '@/lib/backend'
import { OwnerChip } from '../live/CardRow'
import { clock } from '../live/format'
import { KindIcon } from '../live/KindIcon'
import { MeetingMenu, TitleBox } from './MeetingMenu'
import { outlineOf } from './outline'

// The selected meeting at a glance (UI_SPEC §3.1): what was decided, who
// owes what, what was parked. Read from the saved map, so it is there the
// moment a meeting ends, with or without a written summary.

const when = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function Group({
  title,
  count,
  empty,
  children,
}: {
  title: string
  count: number
  empty: string
  children: ReactNode
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="text-meta font-semibold text-text-muted">
        {title.toUpperCase()} <span className="font-mono">({count})</span>
      </h3>
      {count === 0 ? (
        <p className="text-body text-text-muted">{empty}</p>
      ) : (
        <ul className="rounded-md border bg-surface">{children}</ul>
      )}
    </section>
  )
}

function Row({
  card,
  topic,
  onOpen,
}: {
  card: CardRow
  topic: string
  onOpen: (atMs: number) => void
}) {
  const meta = [topic, card.owner, card.due_text && `due ${card.due_text}`]
    .filter(Boolean)
    .join(' · ')
  return (
    <li className="flex items-start gap-2 border-b px-2 py-1.5 last:border-b-0">
      <KindIcon kind={card.kind} className="mt-[3px]" />
      <div className="min-w-0 flex-1">
        <p className="text-body">{card.text}</p>
        <p className="text-meta text-text-muted">
          <button
            type="button"
            title="Open the meeting and play from here"
            className="font-mono hover:text-text"
            onClick={() => onOpen(card.created_t_ms)}
          >
            {clock(card.created_t_ms)}
          </button>
          {meta && ` · ${meta}`}
        </p>
      </div>
      {card.kind === 'action' && card.owner && <OwnerChip name={card.owner} />}
    </li>
  )
}

export function MeetingPreview({ meeting }: { meeting: MeetingInfo }) {
  const backend = useBackend()
  const go = useApp(app => app.go)
  const openSheet = useApp(app => app.open)
  const [renaming, setRenaming] = useState(false)
  const map = useQuery({
    queryKey: ['map', meeting.id],
    queryFn: () => backend.mapLoad(meeting.id),
    staleTime: 0,
  })

  const recorded = meeting.started_at_ms !== null
  const unfinished = recorded && meeting.ended_at_ms === null
  const open = (atMs?: number) =>
    go({ name: 'meeting', meetingId: meeting.id, atMs })
  const outline = map.data ? outlineOf(map.data) : null

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-4 p-6">
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {renaming ? (
            <TitleBox meeting={meeting} onDone={() => setRenaming(false)} />
          ) : (
            <h2 className="text-title font-semibold">{meeting.title}</h2>
          )}
          <p className="font-mono text-meta text-text-muted">
            {when.format(meeting.created_at_ms)} ·{' '}
            {!recorded
              ? 'not recorded'
              : unfinished
                ? 'not finished'
                : clock(meeting.duration_ms)}
          </p>
          {meeting.participants.length > 0 && (
            <p className="text-secondary text-text-muted">
              {meeting.participants.join(', ')}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          title="A new meeting with this title, agenda and people"
          onClick={() =>
            openSheet({
              name: 'premeeting',
              like: {
                title: meeting.title,
                agenda: meeting.agenda,
                participants: meeting.participants,
                parked: outline?.pinned.map(topic => topic.title) ?? [],
              },
            })
          }
        >
          New meeting like this
        </Button>
        <Button onClick={() => open()}>Open</Button>
        <MeetingMenu meeting={meeting} onRename={() => setRenaming(true)} />
      </header>

      {meeting.agenda.length > 0 && (
        <ul aria-label="Agenda" className="flex flex-wrap gap-1">
          {meeting.agenda.map(header => (
            <li
              key={header}
              className="flex h-6 items-center rounded-md border px-2 text-secondary"
            >
              {header}
            </li>
          ))}
        </ul>
      )}

      {map.isError ? (
        <p role="alert" className="text-body">
          The notes of this meeting could not be read.
        </p>
      ) : !outline ? null : outline.cards === 0 &&
        outline.pinned.length === 0 ? (
        <p className="text-body text-text-muted">
          {recorded
            ? 'No notes were taken in this meeting. Open it for the recording and the transcript.'
            : 'This meeting was set up and never recorded.'}
        </p>
      ) : (
        <>
          <Group
            title="Decisions"
            count={outline.decisions.length}
            empty="Nothing was marked as decided."
          >
            {outline.decisions.map(card => (
              <Row
                key={card.id}
                card={card}
                topic={outline.topicTitle(card.topic_id)}
                onOpen={open}
              />
            ))}
          </Group>
          <Group
            title="Actions"
            count={outline.actions.length}
            empty="Nobody was given anything to do."
          >
            {outline.actions.map(card => (
              <Row
                key={card.id}
                card={card}
                topic={outline.topicTitle(card.topic_id)}
                onOpen={open}
              />
            ))}
          </Group>
          {outline.pinned.length > 0 && (
            <Group title="Pinned" count={outline.pinned.length} empty="">
              {outline.pinned.map(topic => (
                <li
                  key={topic.id}
                  className="flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0"
                >
                  <Pin
                    size={12}
                    aria-hidden
                    className="shrink-0 text-text-muted"
                  />
                  <span className="min-w-0 flex-1 text-body">
                    {topic.title}
                  </span>
                  <span className="font-mono text-meta text-text-muted">
                    {topic.cards} {topic.cards === 1 ? 'card' : 'cards'}
                  </span>
                </li>
              ))}
            </Group>
          )}
          <p className="text-meta text-text-muted">
            {outline.cards} cards on the map. Open the meeting for all of them,
            the transcript and the recording.
          </p>
        </>
      )}
    </div>
  )
}
