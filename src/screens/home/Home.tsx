import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Settings as SettingsIcon, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { MeetingInfo, NewMeeting } from '@/ipc'
import { useApp } from '@/lib/app-state'
import { useBackend } from '@/lib/backend'
import { usePrefs } from '@/lib/prefs'
import { clock } from '../live/format'
import { Settings } from '../settings/Settings'
import { PreMeeting } from './PreMeeting'

// Home, docs/UI_SPEC.md §3.1. Left: New meeting and the meetings list.
// Right: the selected meeting's summary preview, which has nothing to show
// until the end screen writes summaries (M5). Search arrives with it.

const day = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

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

function MeetingRow({ meeting }: { meeting: MeetingInfo }) {
  const go = useApp(app => app.go)
  const unfinished =
    meeting.started_at_ms !== null && meeting.ended_at_ms === null
  return (
    <li>
      <button
        type="button"
        className="flex w-full flex-col gap-0.5 rounded-md border border-transparent px-2 py-1.5 text-left transition-opacity duration-150 ease-out hover:bg-surface-2"
        onClick={() => go({ name: 'meeting', meetingId: meeting.id })}
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
    </li>
  )
}

export function Home() {
  const backend = useBackend()
  const queryClient = useQueryClient()
  const { sheet, open, close, go } = useApp()
  const modelId = usePrefs(prefs => prefs.modelId)
  const [later, setLater] = useState<string[]>([])

  const meetings = useQuery({
    queryKey: ['meetings'],
    queryFn: () => backend.listMeetings(),
    staleTime: 0,
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

  const toRecover = (unfinished.data ?? []).filter(
    meeting => !later.includes(meeting.id)
  )
  const noModel = models.data?.every(model => !model.installed) ?? false

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
          <Button onClick={() => open({ name: 'premeeting' })}>
            New meeting
          </Button>
        </div>

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
        ) : meetings.data && meetings.data.length > 0 ? (
          <ul
            aria-label="Meetings"
            className="-mx-2 flex min-h-0 flex-col overflow-y-auto"
          >
            {meetings.data.map(meeting => (
              <MeetingRow key={meeting.id} meeting={meeting} />
            ))}
          </ul>
        ) : (
          <p className="text-body text-text-muted">
            No meetings yet. Start one and Scribe keeps the notes.
          </p>
        )}
      </section>
      <section aria-label="Summary preview" className="min-w-0 flex-1" />

      {sheet?.name === 'premeeting' && (
        <PreMeeting onStart={start} onClose={close} />
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
