import { useEffect, useState } from 'react'
import { MapStore } from '@/engine/store'
import { FIXTURE_PINS, fixtureStore, type FixtureOptions } from './fixture'
import { fixtureSession, type FixtureMode } from './fixture-session'
import { LiveScreen } from './LiveScreen'
import { installTestHook } from './test-hook'

// The live screen's `?screen=` states (docs/TEST_PLAN.md §8), each the golden
// meeting replayed to the point that state shows.

function fixtureScreen(
  options: FixtureOptions,
  zoom?: number,
  mode: FixtureMode = 'recording'
) {
  return function LiveFixture() {
    const [store] = useState(() =>
      mode === 'no-mic' || mode === 'model-missing'
        ? // Nothing was transcribed, so nothing is on the map but the agenda.
          new MapStore({
            meeting: fixtureStore().getState().meeting,
            agenda: ['CLA quote', 'Supplier delays', 'Designer hire'],
          })
        : fixtureStore(options)
    )
    const [{ session, actions }] = useState(() =>
      fixtureSession({ until: options.until, mode })
    )
    useEffect(() => installTestHook(store, session), [store, session])
    return (
      <LiveScreen
        store={store}
        session={session}
        actions={actions}
        zoom={zoom}
      />
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

/** Paused mid-meeting: the indicator is grey and nothing is captured. */
export const Paused = fixtureScreen({ until: 's022' }, undefined, 'paused')

/** Start was pressed on a PC with no microphone. */
export const NoMicError = fixtureScreen({}, undefined, 'no-mic')

/** Recording with no speech model: audio is kept, the transcript is off. */
export const ModelMissing = fixtureScreen(
  { until: 's010' },
  undefined,
  'model-missing'
)
