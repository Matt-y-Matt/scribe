import type { StructurerProvider } from './types'

// Which model does the structuring. The config is plain data so it can cross
// into the structurer's Web Worker; `createProvider` runs on the other side.

export type ProviderConfig = never

export function createProvider(config: ProviderConfig): StructurerProvider {
  throw new Error(`Unknown provider: ${JSON.stringify(config)}`)
}
