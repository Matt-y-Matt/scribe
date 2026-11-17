import { createMockProvider, type MockOps } from './mock'
import type { StructurerProvider } from './types'

// Which model does the structuring. The config is plain data so it can cross
// into the structurer's Web Worker; `createProvider` runs on the other side.

export interface MockConfig {
  kind: 'mock'
  canned: MockOps
}

export type ProviderConfig = MockConfig

export function createProvider(config: ProviderConfig): StructurerProvider {
  switch (config.kind) {
    case 'mock':
      return createMockProvider(config.canned)
  }
}
