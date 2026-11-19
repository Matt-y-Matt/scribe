import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { MapStore } from '@/engine/store'
import { BackendContext } from '@/lib/backend'
import { fixtureBackend } from '@/lib/fixture-backend'
import { FIXTURE_PINS, fixtureStore, type FixtureOptions } from './fixture'
import { fixtureSession, type FixtureMode } from './fixture-session'
import { MeetingScreen } from './MeetingScreen'
import { installTestHook } from './test-hook'

// The live screen's `?screen=` states (docs/TEST_PLAN.md §8), each the golden
// meeting replayed to the point that state shows.

function fixtureScreen(
  options: FixtureOptions,
  zoom?: number,
  mode: FixtureMode = 'recording',
  lastTime = false
) {
  return function LiveFixture() {
    const [store] = useState(() =>
      mode === 'no-mic' || mode === 'model-missing' || mode === 'notes-off'
        ? // Nothing was written, so nothing is on the map but the agenda.
          new MapStore({
            meeting: fixtureStore().getState().meeting,
            agenda: ['CLA quote', 'Supplier delays', 'Designer hire'],
          })
        : fixtureStore(options)
    )
    const [{ session, actions }] = useState(() =>
      fixtureSession({ until: options.until, mode, lastTime })
    )
    // The end screen reads and saves the summary: a core that is not there.
    const [backend] = useState(() =>
      fixtureBackend({
        meetings: [
          {
            id: 'm_fixture',
            title: store.getState().meeting.title,
            created_at_ms: Date.UTC(2026, 10, 17, 3, 0),
            started_at_ms: Date.UTC(2026, 10, 17, 3, 0),
            ended_at_ms: Date.UTC(2026, 10, 17, 3, 7),
            duration_ms: session.getState().elapsedMs,
            mode: 'group',
            agenda: [],
            participants: [...store.getState().meeting.participants],
            loopback: false,
            cleaned: false,
          },
        ],
      })
    )
    const [client] = useState(
      () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
    )
    useEffect(() => installTestHook(store, session), [store, session])
    return (
      <QueryClientProvider client={client}>
        <BackendContext value={backend}>
          <MeetingScreen
            store={store}
            session={session}
            actions={actions}
            zoom={zoom}
          />
        </BackendContext>
      </QueryClientProvider>
    )
  }
}

/** The meeting at its end: every topic, both off-agenda topics pinned. */
export const Live = fixtureScreen({ pins: FIXTURE_PINS })

/** The same, with a suggested move and a suggested merge waiting. */
export const LiveGhost = fixtureScreen({ pins: FIXTURE_PINS, ghosts: true })

/** Mid-meeting, just after the aircon came up: "New topic… Pin it?". */
export const LiveUnplanned = fixtureScreen({ until: 's026' })

/** Below zoom 0.7: cards collapse to kind icons with counts. */
export const LiveZoomedOut = fixtureScreen({ pins: FIXTURE_PINS }, 0.55)

/** Two minutes in, with last week's open actions at the top of the rail. */
export const LiveLastTime = fixtureScreen(
  { until: 's012' },
  undefined,
  'recording',
  true
)

/** Paused mid-meeting: the indicator is grey and nothing is captured. */
export const Paused = fixtureScreen({ until: 's022' }, undefined, 'paused')

/** Start was pressed on a PC with no microphone. */
export const NoMicError = fixtureScreen({}, undefined, 'no-mic')

/** Recording and transcribing, with the local model not answering. */
export const NotesOff = fixtureScreen({ until: 's010' }, undefined, 'notes-off')

/** A finished meeting opened again: the map, the transcript, the recording. */
export const Review = fixtureScreen({ pins: FIXTURE_PINS }, undefined, 'review')

/** Stop was pressed: the end screen, everything ticked. */
export const End = fixtureScreen({ pins: FIXTURE_PINS }, undefined, 'wrap')

/** Recording with no speech model: audio is kept, the transcript is off. */
export const ModelMissing = fixtureScreen(
  { until: 's010' },
  undefined,
  'model-missing'
)
