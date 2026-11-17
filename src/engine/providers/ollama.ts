import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAiSdkProvider } from './ai-sdk'
import type { StructurerProvider } from './types'

export const OLLAMA_URL = 'http://127.0.0.1:11434'
/** The local structurer BUILD_PLAN §M1 names. */
export const OLLAMA_MODEL = 'qwen3.5:4b'

export interface OllamaConfig {
  kind: 'ollama'
  /** The system prompt (src/engine/prompts/structurer.md). */
  prompt: string
  baseUrl?: string
  model?: string
}

/** True when `url` points at this machine. */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || /^127\./.test(host)
  } catch {
    return false
  }
}

/** Ollama, through its OpenAI-compatible endpoint. */
export function createOllamaProvider(config: OllamaConfig): StructurerProvider {
  const baseUrl = (config.baseUrl ?? OLLAMA_URL).replace(/\/+$/, '')
  const model = config.model ?? OLLAMA_MODEL
  const ollama = createOpenAICompatible({
    name: 'ollama',
    baseURL: `${baseUrl}/v1`,
    // Sends the schema as `response_format`, which Ollama enforces.
    supportsStructuredOutputs: true,
  })
  return createAiSdkProvider({
    name: `ollama:${model}`,
    // An Ollama on another machine is a cloud provider like any other.
    local: isLoopback(baseUrl),
    model: ollama(model),
    prompt: config.prompt,
    temperature: 0,
  })
}

/** The models an Ollama server has pulled, or null when none answers. */
export async function ollamaModels(
  baseUrl: string = OLLAMA_URL,
  timeoutMs = 2_000
): Promise<string[] | null> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { models?: { name?: string }[] }
    return (body.models ?? []).flatMap(model => model.name ?? [])
  } catch {
    return null
  }
}
