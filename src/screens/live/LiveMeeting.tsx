import { useEffect, useState } from 'react'
import { useApp } from '@/lib/app-state'
import { reasonOf, useBackend } from '@/lib/backend'
import { logger } from '@/lib/logger'
import { Settings } from '../settings/Settings'
import { LiveScreen } from './LiveScreen'
import { openMeeting, type RunningMeeting } from './meeting-controller'

// The live screen on the real core (meeting-controller.ts does the work).

export function LiveMeeting({
  meetingId,
  start,
  atMs,
}: {
  meetingId: string
  /** Start recording at once: the host came from Start recording. */
  start: boolean
  /** Play the recording from this moment once the meeting is open. */
  atMs?: number
}) {
  const backend = useBackend()
  const { sheet, open: openSheet, close, go } = useApp()
  const [running, setRunning] = useState<RunningMeeting | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let gone = false
    let opened: RunningMeeting | undefined
    openMeeting(
      backend,
      meetingId,
      () => useApp.getState().go({ name: 'home' }),
      start,
      tab => useApp.getState().open({ name: 'settings', tab })
    ).then(
      next => {
        if (gone) next.dispose()
        else {
          opened = next
          setRunning(next)
          // A finished meeting opened at a moment plays from that moment.
          if (atMs !== undefined && next.session.getState().review) {
            next.actions.seekPlay(atMs)
          }
        }
      },
      (error: unknown) => {
        logger.error('the meeting could not be opened', {
          reason: reasonOf(error),
        })
        if (!gone) setFailed(true)
      }
    )
    return () => {
      gone = true
      opened?.dispose()
    }
  }, [backend, meetingId, start, atMs])

  if (failed) {
    return (
      <main role="alert" className="flex h-full flex-col items-start gap-3 p-6">
        <p className="text-body">This meeting could not be opened.</p>
        <button
          type="button"
          className="text-body font-semibold text-accent"
          onClick={() => go({ name: 'home' })}
        >
          Back to meetings
        </button>
      </main>
    )
  }
  if (!running) {
    return (
      <main className="p-6 text-body text-text-muted" aria-busy>
        Opening the meeting…
      </main>
    )
  }

  return (
    <LiveScreen
      store={running.store}
      session={running.session}
      actions={running.actions}
      overlay={
        sheet?.name === 'settings' && (
          <Settings
            tab={sheet.tab}
            onTab={tab => openSheet({ name: 'settings', tab })}
            onClose={close}
          />
        )
      }
    />
  )
}
