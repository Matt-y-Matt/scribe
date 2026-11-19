import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, Settings as SettingsIcon, TriangleAlert } from 'lucide-react'
import { useDeferredValue, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { MeetingInfo, NewMeeting, SegmentFinal } from '@/ipc'
import { useApp } from '@/lib/app-state'
import { useBackend } from '@/lib/backend'
import { usePrefs } from '@/lib/prefs'
import { cn } from '@/lib/utils'
import { clock } from '../live/format'
import { Settings } from '../settings/Settings'
import { MeetingPreview } from './MeetingPreview'
import { useDoneTicks } from './open-actions'
import { OpenActions } from './OpenActions'
import { matchesMeeting } from './outline'
import { PreMeeting } from './PreMeeting'

// Home, docs/UI_SPEC.md §3.1. Left: New meeting, the search box and the
// meetings list. Right: the selected meeting at a glance, what was decided
// and who owes what, with Open to go into it.

const day = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const now = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** A search starts at two letters; one matches nearly everything. */
const MIN_QUERY = 2
/** Lines of transcript shown under a meeting that matched. */
const MAX_LINES = 3

function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-md border bg-surface-2 p-3 text-body"
    >
      {children}
    </div>
  )
}

function MeetingRow({
  meeting,
  selected,
  lines,
  onSelect,
}: {
  meeting: MeetingInfo
  selected: boolean
  /** Transcript lines that matched the search. */
  lines: readonly SegmentFinal[]
  onSelect: () => void
}) {
  const go = useApp(app => app.go)
  const unfinished =
    meeting.started_at_ms !== null && meeting.ended_at_ms === null
  return (
    <li
      className={cn(
        'rounded-md border',
        selected ? 'border-accent bg-accent-soft' : 'border-transparent'
      )}
    >
      <button
        type="button"
        aria-current={selected || undefined}
        title="Double-click to open"
        className={cn(
          'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-opacity duration-150 ease-out',
          !selected && 'hover:bg-surface-2'
        )}
        onClick={onSelect}
        onDoubleClick={() => go({ name: 'meeting', meetingId: meeting.id })}
      >
        <span className="truncate text-body font-semibold">
          {meeting.title}
        </span>
        <span className="font-mono text-meta text-text-muted">
          {day.format(meeting.created_at_ms)} ·{' '}
          {unfinished ? 'not finished' : clock(meeting.duration_ms)}
        </span>
        {meeting.agenda.length > 0 && (
          <span className="truncate text-secondary text-text-muted">
            {meeting.agenda.join(' · ')}
          </span>
        )}
      </button>
      {lines.length > 0 && (
        <ul aria-label={`Matches in ${meeting.title}`} className="pb-1">
          {lines.slice(0, MAX_LINES).map(line => (
            <li key={line.id}>
              <button
                type="button"
                title="Open the meeting and play from here"
                className="flex w-full gap-2 rounded-md px-2 py-0.5 text-left text-secondary hover:bg-surface-2"
                onClick={() =>
                  go({
                    name: 'meeting',
                    meetingId: meeting.id,
                    atMs: line.t0_ms,
                  })
                }
              >
                <span className="shrink-0 font-mono text-meta text-text-muted">
                  {clock(line.t0_ms)}
                </span>
                <span className="line-clamp-2 min-w-0">{line.text}</span>
              </button>
            </li>
          ))}
          {lines.length > MAX_LINES && (
            <li className="px-2 text-meta text-text-muted">
              and {lines.length - MAX_LINES} more in the transcript
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

export function Home({
  initialSearch = '',
  initialPane = 'meeting',
}: {
  /** What the right side opens on: the `?screen=home-actions` fixture. */
  initialPane?: 'meeting' | 'actions'
  /** What the search box opens with: the `?screen=home-search` fixture. */
  initialSearch?: string
}) {
  const backend = useBackend()
  const queryClient = useQueryClient()
  const { sheet, open, close, go } = useApp()
  const modelId = usePrefs(prefs => prefs.modelId)
  const [later, setLater] = useState<string[]>([])
  const [chosen, setChosen] = useState<string | null>(null)
  const [typed, setTyped] = useState(initialSearch)
  const [pane, setPane] = useState(initialPane)
  const [startFailed, setStartFailed] = useState(false)
  const ticks = useDoneTicks()
  const query = useDeferredValue(typed.trim())
  const searching = query.length >= MIN_QUERY

  const meetings = useQuery({
    queryKey: ['meetings'],
    queryFn: () => backend.listMeetings(),
    staleTime: 0,
  })
  const owed = useQuery({
    queryKey: ['open-actions'],
    queryFn: () => backend.openActions(),
    staleTime: 0,
    gcTime: 0,
  })
  const unfinished = useQuery({
    queryKey: ['unfinished'],
    queryFn: () => backend.unfinishedMeetings(),
    staleTime: 0,
  })
  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => backend.listModels(),
    staleTime: 0,
  })
  const said = useQuery({
    queryKey: ['search', query],
    queryFn: () => backend.searchSegments(null, query),
    enabled: searching,
    staleTime: 0,
  })
  const recover = useMutation({
    mutationFn: (meetingId: string) =>
      backend.recoverMeeting(meetingId, modelId),
    retry: false,
    onSuccess: async recovered => {
      await queryClient.invalidateQueries()
      go({ name: 'meeting', meetingId: recovered.meeting_id })
    },
  })

  const start = async (meeting: NewMeeting) => {
    const created = await backend.createMeeting(meeting)
    go({ name: 'meeting', meetingId: created.id, start: true })
  }

  // One click, no sheet: a meeting that was not planned.
  const startNow = () => {
    setStartFailed(false)
    start({
      title: `Meeting, ${now.format(Date.now())}`,
      agenda: [],
      mode: 'group',
      participants: [],
    }).catch(() => setStartFailed(true))
  }
  const stillOwed = (owed.data ?? []).filter(
    row => !ticks.done.includes(row.card.id)
  ).length

  const toRecover = (unfinished.data ?? []).filter(
    meeting => !later.includes(meeting.id)
  )
  const noModel = models.data?.every(model => !model.installed) ?? false

  // What was said, by meeting, in meeting order.
  const linesBy = new Map<string, SegmentFinal[]>()
  if (searching) {
    for (const line of said.data ?? []) {
      linesBy.set(line.meeting_id, [
        ...(linesBy.get(line.meeting_id) ?? []),
        line,
      ])
    }
    for (const lines of linesBy.values()) {
      lines.sort((a, b) => a.t0_ms - b.t0_ms)
    }
  }
  const all = meetings.data ?? []
  const shown = searching
    ? all.filter(
        meeting => matchesMeeting(meeting, query) || linesBy.has(meeting.id)
      )
    : all
  // The meeting on the right: the one picked, else the first in the list.
  const selected = shown.find(meeting => meeting.id === chosen) ?? shown[0]

  return (
    <main className="relative flex h-full bg-bg">
      <section
        aria-labelledby="home-title"
        className="flex w-[360px] shrink-0 flex-col gap-3 border-r bg-surface p-4"
      >
        <div className="flex items-center gap-2">
          <h1 id="home-title" className="flex-1 text-title font-semibold">
            Meetings
          </h1>
          <button
            type="button"
            aria-label="Settings"
            className="flex size-7 items-center justify-center rounded-md text-text-muted transition-opacity duration-150 ease-out hover:bg-surface-2"
            onClick={() => open({ name: 'settings', tab: 'audio' })}
          >
            <SettingsIcon size={16} aria-hidden />
          </button>
          <Button
            variant="outline"
            title="Start recording now, with no agenda"
            onClick={startNow}
          >
            Start now
          </Button>
          <Button onClick={() => open({ name: 'premeeting' })}>
            New meeting
          </Button>
        </div>
        {startFailed && (
          <p role="alert" className="text-body">
            The meeting could not be started. Try again.
          </p>
        )}

        {all.length > 0 && (
          <label className="flex h-7 items-center gap-2 rounded-md border bg-surface px-2 focus-within:border-accent">
            <Search size={14} aria-hidden className="text-text-muted" />
            <input
              type="search"
              aria-label="Search meetings"
              placeholder="Search titles, people and what was said"
              value={typed}
              onChange={event => setTyped(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') setTyped('')
              }}
              className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
            />
          </label>
        )}

        {toRecover.map(meeting => (
          <Notice key={meeting.id}>
            <p>
              <strong className="font-semibold">
                Recover meeting “{meeting.title}”?
              </strong>{' '}
              It was being recorded when Scribe closed. Its audio and transcript
              are on this PC.
            </p>
            {recover.isError && recover.variables === meeting.id && (
              <p role="alert">It could not be recovered. Try again.</p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={recover.isPending}
                onClick={() => recover.mutate(meeting.id)}
              >
                {recover.isPending && recover.variables === meeting.id
                  ? 'Recovering…'
                  : 'Recover'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLater([...later, meeting.id])}
              >
                Not now
              </Button>
            </div>
          </Notice>
        ))}

        {noModel && (
          <Notice>
            <p className="flex gap-2">
              <TriangleAlert
                size={14}
                aria-hidden
                className="mt-0.5 shrink-0 text-text-muted"
              />
              <span>
                <strong className="font-semibold">
                  No speech model is installed.
                </strong>{' '}
                Meetings are recorded without a transcript until one is.
              </span>
            </p>
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => open({ name: 'settings', tab: 'speech' })}
              >
                Download model
              </Button>
            </div>
          </Notice>
        )}

        {meetings.isError ? (
          <p role="alert" className="text-body">
            The meetings could not be read from this PC.
          </p>
        ) : all.length === 0 ? (
          <p className="text-body text-text-muted">
            {meetings.isPending
              ? ''
              : 'No meetings yet. Start one and Scribe keeps the notes.'}
          </p>
        ) : shown.length === 0 ? (
          <p role="status" className="text-body text-text-muted">
            {said.isFetching
              ? 'Searching…'
              : `No meeting has “${query}” in its title, people or transcript.`}
          </p>
        ) : (
          <ul
            aria-label="Meetings"
            className="-mx-2 flex min-h-0 flex-col gap-0.5 overflow-y-auto px-px"
          >
            {shown.map(meeting => (
              <MeetingRow
                key={meeting.id}
                meeting={meeting}
                selected={pane === 'meeting' && meeting.id === selected?.id}
                lines={linesBy.get(meeting.id) ?? []}
                onSelect={() => {
                  setChosen(meeting.id)
                  setPane('meeting')
                }}
              />
            ))}
          </ul>
        )}
      </section>
      <section
        aria-label="Summary preview"
        className="min-w-0 flex-1 overflow-y-auto"
      >
        {all.length > 0 && (
          <div
            role="tablist"
            aria-label="What to show"
            className="flex h-10 items-center gap-1 border-b bg-surface px-4"
          >
            {(
              [
                ['meeting', 'Meeting'],
                ['actions', `Open actions (${stillOwed})`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={pane === id}
                className={cn(
                  'h-6 rounded-md border px-2 text-secondary transition-opacity duration-150 ease-out',
                  pane === id
                    ? 'border-accent bg-accent-soft font-semibold'
                    : 'border-transparent hover:bg-surface-2'
                )}
                onClick={() => setPane(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {pane === 'actions' && all.length > 0 ? (
          owed.isError ? (
            <p role="alert" className="p-6 text-body">
              The open actions could not be read.
            </p>
          ) : (
            owed.data && (
              <OpenActions
                open={owed.data}
                done={ticks.done}
                onDone={ticks.onDone}
              />
            )
          )
        ) : (
          selected && <MeetingPreview key={selected.id} meeting={selected} />
        )}
      </section>

      {sheet?.name === 'premeeting' && (
        <PreMeeting
          key={sheet.like?.title ?? ''}
          onStart={start}
          onClose={close}
          initial={sheet.like}
          parked={sheet.like?.parked}
        />
      )}
      {sheet?.name === 'settings' && (
        <Settings
          tab={sheet.tab}
          onTab={tab => open({ name: 'settings', tab })}
          onClose={close}
        />
      )}
    </main>
  )
}
