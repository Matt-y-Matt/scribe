import { createAnthropicProvider, type AnthropicConfig } from './anthropic'
import { createMockProvider, type MockOps } from './mock'
import { createOllamaProvider, type OllamaConfig } from './ollama'
import type { StructurerProvider } from './types'

// Which model does the structuring. The config is plain data so it can cross
// into the structurer's Web Worker; `createProvider` runs on the other side.

export interface MockConfig {
  kind: 'mock'
  canned: MockOps
}

export type ProviderConfig = MockConfig | OllamaConfig | AnthropicConfig

export function createProvider(config: ProviderConfig): StructurerProvider {
  switch (config.kind) {
    case 'mock':
      return createMockProvider(config.canned)
    case 'ollama':
      return createOllamaProvider(config)
    case 'anthropic':
      return createAnthropicProvider(config)
  }
}
