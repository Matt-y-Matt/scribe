import { QueryClientProvider } from '@tanstack/react-query'
import { isTauri } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useApp } from './lib/app-state'
import { BackendContext, tauriBackend } from './lib/backend'
import { fixtureBackend } from './lib/fixture-backend'
import { usePrefs } from './lib/prefs'
import { queryClient } from './lib/query-client'
import { Home } from './screens/home/Home'
import { LiveMeeting } from './screens/live/LiveMeeting'
import { SCREENS } from './screens/registry'
import { isScreenId, screenFromSearch } from './screens/screens'

/** The app itself: Home, or a meeting, on the Rust core. */
function Shell() {
  const route = useApp(app => app.route)
  // In a browser there is no core: the screens run on an empty stand-in.
  const [backend] = useState(() =>
    isTauri() ? tauriBackend : fixtureBackend()
  )
  useEffect(() => void usePrefs.getState().load(), [])

  return (
    <QueryClientProvider client={queryClient}>
      <BackendContext value={backend}>
        {route.name === 'meeting' ? (
          <LiveMeeting
            key={route.meetingId}
            meetingId={route.meetingId}
            start={route.start ?? false}
          />
        ) : (
          <Home />
        )}
      </BackendContext>
    </QueryClientProvider>
  )
}

function App() {
  // `?screen=` renders a named screen state from fixtures (Playwright and
  // `pnpm screenshot`). Without it the app opens on Home.
  const requested = screenFromSearch(window.location.search)

  if (requested !== null && !isScreenId(requested)) {
    return (
      <main role="alert" className="p-6 text-body">
        Unknown screen “{requested}”. See src/screens/screens.ts for the list.
      </main>
    )
  }

  const Screen = requested === null ? Shell : SCREENS[requested]
  return (
    <ErrorBoundary>
      <Screen />
    </ErrorBoundary>
  )
}

export default App
