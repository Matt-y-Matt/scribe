import { ErrorBoundary } from './components/ErrorBoundary'
import { SCREENS } from './screens/registry'
import { isScreenId, screenFromSearch } from './screens/screens'

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

  const Screen = SCREENS[requested ?? 'home-empty']
  return (
    <ErrorBoundary>
      <Screen />
    </ErrorBoundary>
  )
}

export default App
