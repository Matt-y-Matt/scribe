import { createProvider, type ProviderConfig } from './providers'
import {
  serveStructurer,
  type MessagePortLike,
  type WorkerRequest,
  type WorkerResponse,
} from './worker-protocol'

// The structurer's Web Worker. Start it with
//   new Worker(new URL('./structurer.worker.ts', import.meta.url), { type: 'module' })
// and talk to it through `WorkerProvider` (worker-protocol.ts).
serveStructurer(
  globalThis as unknown as MessagePortLike<
    WorkerResponse,
    WorkerRequest<ProviderConfig>
  >,
  createProvider
)
