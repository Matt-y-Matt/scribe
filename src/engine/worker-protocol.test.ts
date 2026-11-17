// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { StructurerInput, StructurerProvider } from './providers/types'
import {
  serveStructurer,
  WorkerProvider,
  type MessagePortLike,
  type WorkerRequest,
  type WorkerResponse,
} from './worker-protocol'

interface Config {
  greeting: string
}

/** Two ports wired to each other, delivering like a Worker: later, by copy. */
function channel() {
  type Listener<T> = (event: { data: T }) => void
  const toWorker: Listener<WorkerRequest<Config>>[] = []
  const toPage: Listener<WorkerResponse>[] = []
  const deliver = <T>(listeners: Listener<T>[], message: T) =>
    queueMicrotask(() => {
      const data = structuredClone(message)
      listeners.forEach(listener => listener({ data }))
    })

  const page: MessagePortLike<WorkerRequest<Config>, WorkerResponse> = {
    postMessage: message => deliver(toWorker, message),
    addEventListener: (_type, listener) => toPage.push(listener),
  }
  const worker: MessagePortLike<WorkerResponse, WorkerRequest<Config>> = {
    postMessage: message => deliver(toPage, message),
    addEventListener: (_type, listener) => toWorker.push(listener),
  }
  return { page, worker }
}

const INPUT: StructurerInput = {
  agenda: [],
  outline: [],
  recent_structured: '',
  new_segments: [{ id: 's001', t0: 0, speaker: 'Matt', text: 'Hello' }],
  participants: ['Matt'],
  now_ms: 1000,
}

function setUp(structure: StructurerProvider['structure']) {
  const { page, worker } = channel()
  const create = vi.fn((config: Config): StructurerProvider => ({
    name: config.greeting,
    local: true,
    structure,
  }))
  serveStructurer(worker, create)
  const provider = new WorkerProvider(
    page,
    { greeting: 'hi' },
    { name: 'worker:test', local: true }
  )
  return { provider, create }
}

describe('structurer worker protocol', () => {
  it('configures the worker, runs there and brings the reply back', async () => {
    const structure = vi.fn(async (input: StructurerInput) => ({
      ops: [{ op: 'echo', heard: input.new_segments.length }],
    }))
    const { provider, create } = setUp(structure)

    await expect(provider.structure(INPUT)).resolves.toEqual({
      ops: [{ op: 'echo', heard: 1 }],
    })
    expect(create).toHaveBeenCalledWith({ greeting: 'hi' })
    expect(structure.mock.calls[0]?.[0]).toEqual(INPUT)
    expect(provider).toMatchObject({ name: 'worker:test', local: true })
  })

  it('matches each reply to its own request', async () => {
    const { provider } = setUp(async input => {
      // The first request answers last.
      await new Promise(done => setTimeout(done, input.now_ms === 1 ? 20 : 0))
      return input.now_ms
    })
    const first = provider.structure({ ...INPUT, now_ms: 1 })
    const second = provider.structure({ ...INPUT, now_ms: 2 })
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
  })

  it('carries a provider error back as a rejection', async () => {
    const { provider } = setUp(async () => {
      throw new Error('model not found')
    })
    await expect(provider.structure(INPUT)).rejects.toThrow('model not found')
  })

  it('cancels a run in the worker when the caller aborts', async () => {
    let aborted = false
    const { provider } = setUp(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        })
    )
    const controller = new AbortController()
    const run = provider.structure(INPUT, controller.signal)
    await new Promise(done => setTimeout(done, 0))
    controller.abort()

    await expect(run).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(aborted).toBe(true))
  })

  it('refuses to run before it is configured', async () => {
    const { page, worker } = channel()
    serveStructurer(worker, () => {
      throw new Error('unreachable')
    })
    const replies: WorkerResponse[] = []
    page.addEventListener('message', event => replies.push(event.data))
    page.postMessage({ type: 'run', id: 7, input: INPUT })
    await vi.waitFor(() =>
      expect(replies).toEqual([
        { type: 'error', id: 7, message: 'not configured' },
      ])
    )
  })
})
