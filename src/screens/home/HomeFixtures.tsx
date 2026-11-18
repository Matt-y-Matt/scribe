import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { useApp, type Sheet } from '@/lib/app-state'
import { BackendContext } from '@/lib/backend'
import {
  fixtureBackend,
  FIXTURE_MODELS,
  type FixtureData,
} from '@/lib/fixture-backend'
import { Settings } from '../settings/Settings'
import { Home } from './Home'
import {
  FIXTURE_MEETINGS,
  fixtureMaps,
  fixtureTranscripts,
  PREMEETING_DRAFT,
} from './home-fixture-data'
import { PreMeeting } from './PreMeeting'

// Home, the Pre-meeting sheet and Settings as `?screen=` states
// (docs/TEST_PLAN.md §8), on a core that is not there.

function fixtureHome(
  data: Partial<FixtureData>,
  sheet: Sheet = null,
  search = ''
) {
  return function HomeFixture() {
    const [backend] = useState(() =>
      fixtureBackend({
        maps: fixtureMaps(),
        segments: fixtureTranscripts(),
        ...data,
      })
    )
    const [client] = useState(
      () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
    )
    // The sheet a state shows is open from the first frame.
    useState(() => useApp.setState({ route: { name: 'home' }, sheet: null }))
    const [tab, setTab] = useState(
      sheet?.name === 'settings' ? sheet.tab : 'audio'
    )
    const close = () => undefined

    return (
      <QueryClientProvider client={client}>
        <BackendContext value={backend}>
          <div className="relative h-full">
            <Home initialSearch={search} />
            {sheet?.name === 'premeeting' && (
              <PreMeeting
                initial={PREMEETING_DRAFT}
                onStart={async () => undefined}
                onClose={close}
              />
            )}
            {sheet?.name === 'settings' && (
              <Settings tab={tab} onTab={setTab} onClose={close} />
            )}
          </div>
        </BackendContext>
      </QueryClientProvider>
    )
  }
}

/** First launch: nothing recorded yet. */
export const HomeEmpty = fixtureHome({})

/** A few meetings, and one that was being recorded when the app died. */
export const HomeList = fixtureHome({ meetings: FIXTURE_MEETINGS })

/** A search that matches a title and lines of two transcripts. */
export const HomeSearch = fixtureHome(
  { meetings: FIXTURE_MEETINGS },
  null,
  'landlord'
)

/** New meeting pressed: the Pre-meeting sheet, filled in. */
export const PreMeetingSheet = fixtureHome(
  { meetings: FIXTURE_MEETINGS.slice(1) },
  { name: 'premeeting' }
)

export const SettingsAudio = fixtureHome(
  { meetings: FIXTURE_MEETINGS.slice(1) },
  { name: 'settings', tab: 'audio' }
)

/** Parakeet installed, Whisper a third of the way down. */
export const SettingsSpeech = fixtureHome(
  {
    meetings: FIXTURE_MEETINGS.slice(1),
    models: FIXTURE_MODELS.map(model =>
      model.installed ? model : { ...model, downloading: true }
    ),
    download: {
      model_id: 'whisper-large-v3-turbo-int8',
      bytes: 352_000_000,
      total: 1_036_613_791,
      done: false,
      error: null,
    },
  },
  { name: 'settings', tab: 'speech' }
)
