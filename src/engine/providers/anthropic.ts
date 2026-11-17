import { createAnthropic } from '@ai-sdk/anthropic'
import { createAiSdkProvider } from './ai-sdk'
import type { StructurerProvider } from './types'

/** Haiku: the cloud structurer BUILD_PLAN §M1 names. */
export const ANTHROPIC_MODEL = 'claude-haiku-5-5'

export interface AnthropicConfig {
  kind: 'anthropic'
  apiKey: string
  /** The system prompt (src/engine/prompts/structurer.md). */
  prompt: string
  model?: string
  effort?: 'low' | 'medium' | 'high'
}

/**
 * Anthropic's API. Not on this PC, so it is cloud mode (CLAUDE.md rule 4):
 * whoever builds this provider has had the user's confirmation first.
 */
export function createAnthropicProvider(
  config: AnthropicConfig
): StructurerProvider {
  const model = config.model ?? ANTHROPIC_MODEL
  return createAiSdkProvider({
    name: `anthropic:${model}`,
    local: false,
    model: createAnthropic({ apiKey: config.apiKey })(model),
    prompt: config.prompt,
    maxOutputTokens: 16_000,
    // No temperature: current Claude models reject sampling parameters.
    providerOptions: config.effort
      ? { anthropic: { effort: config.effort } }
      : undefined,
  })
}
