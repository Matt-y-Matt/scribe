import { useState } from 'react'
import { FIXTURE_PINS, fixtureStore, type FixtureOptions } from './fixture'
import { LiveScreen } from './LiveScreen'

// The live screen's `?screen=` states (docs/TEST_PLAN.md §8), each the golden
// meeting replayed to the point that state shows.

function fixtureScreen(options: FixtureOptions, zoom?: number) {
  return function LiveFixture() {
    const [store] = useState(() => fixtureStore(options))
    return <LiveScreen store={store} zoom={zoom} />
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
