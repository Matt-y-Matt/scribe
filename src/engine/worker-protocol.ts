import type { StructurerInput, StructurerProvider } from './providers/types'

// The structurer's model call runs in a Web Worker so a slow reply never
// holds up the UI (docs/ARCHITECTURE.md §3.2). The map stays on the UI side:
// the worker is handed an input and hands back ops, nothing else. This file is
// both ends of that conversation, written against a minimal port so tests can
// run it without a real Worker.

export type WorkerRequest<Config> =
  | { type: 'configure'; config: Config }
  | { type: 'run'; id: number; input: StructurerInput }
  | { type: 'cancel'; id: number }

export type WorkerResponse =
  | { type: 'result'; id: number; reply: unknown }
  | { type: 'error'; id: number; message: string }

/** The part of `Worker` and of a worker's global scope that is used here. */
export interface MessagePortLike<Out, In> {
  postMessage(message: Out): void
  addEventListener(
    type: 'message',
    listener: (event: { data: In }) => void
  ): void
}

/** Worker side: answers `run` requests with the configured provider. */
export function serveStructurer<Config>(
  port: MessagePortLike<WorkerResponse, WorkerRequest<Config>>,
  create: (config: Config) => StructurerProvider
): void {
  let provider: StructurerProvider | null = null
  const running = new Map<number, AbortController>()

  port.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'configure':
        provider = create(data.config)
        return
      case 'cancel':
        running.get(data.id)?.abort()
        return
      case 'run': {
        const { id, input } = data
        if (!provider) {
          port.postMessage({ type: 'error', id, message: 'not configured' })
          return
        }
        const controller = new AbortController()
        running.set(id, controller)
        provider
          .structure(input, controller.signal)
          .then(
            reply => port.postMessage({ type: 'result', id, reply }),
            (error: unknown) =>
              port.postMessage({
                type: 'error',
                id,
                message: error instanceof Error ? error.message : String(error),
              })
          )
          .finally(() => running.delete(id))
      }
    }
  })
}

/** UI side: a provider whose work happens in the worker behind `port`. */
export class WorkerProvider<Config> implements StructurerProvider {
  readonly name: string
  readonly local: boolean
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (reply: unknown) => void; reject: (error: Error) => void }
  >()

  constructor(
    private readonly port: MessagePortLike<
      WorkerRequest<Config>,
      WorkerResponse
    >,
    config: Config,
    about: { name: string; local: boolean }
  ) {
    this.name = about.name
    this.local = about.local
    port.addEventListener('message', ({ data }) => {
      const waiting = this.pending.get(data.id)
      if (!waiting) return
      this.pending.delete(data.id)
      if (data.type === 'result') waiting.resolve(data.reply)
      else waiting.reject(new Error(data.message))
    })
    port.postMessage({ type: 'configure', config })
  }

  structure(input: StructurerInput, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return
        this.port.postMessage({ type: 'cancel', id })
        reject(new Error('cancelled'))
      })
      this.port.postMessage({ type: 'run', id, input })
    })
  }
}
