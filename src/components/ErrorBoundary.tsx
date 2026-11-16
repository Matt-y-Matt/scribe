import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { logger } from '@/lib/logger'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Last-resort error state: says what happened and offers a reload. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Component stacks carry no transcript text, audio paths or keys.
    logger.error('Screen crashed', {
      name: error.name,
      componentStack: info.componentStack ?? undefined,
    })
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <main
        role="alert"
        className="flex h-full flex-col items-start gap-3 bg-bg p-6"
      >
        <h1 className="text-header font-semibold">Something went wrong</h1>
        <p className="text-body text-text-muted">
          This screen stopped working. Reloading keeps your meetings and
          settings.
        </p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </main>
    )
  }
}
