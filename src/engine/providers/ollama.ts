import { z } from 'zod'
import { looseJson, modelOutputSchema } from './ai-sdk'
import { cardsMessage, cardsSchema, cardsToOps } from './cards'
import type { StructurerInput, StructurerProvider } from './types'

// Ollama, the local default. This talks to Ollama's own `/api/chat` rather
// than its OpenAI-compatible endpoint, because only the native API can set
// the context size: Ollama loads a model with 4,096 tokens unless told
// otherwise, and the structurer's prompt and transcript do not fit in that.
// The native API also takes a JSON schema as `format` (grammar-constrained
// output) and can switch a thinking model's reasoning off, which a live
// meeting needs: with reasoning on, qwen3.5:4b took 11 to 178 s a run.

export const OLLAMA_URL = 'http://127.0.0.1:11434'
/** The local structurer BUILD_PLAN §M1 names. */
export const OLLAMA_MODEL = 'qwen3.5:4b'
/** Room for the prompt, a long batch, the outline and the reply. */
export const OLLAMA_CONTEXT_TOKENS = 16_384
const TIMEOUT_MS = 180_000

export interface OllamaConfig {
  kind: 'ollama'
  /** The system prompt (src/engine/prompts/structurer.md). */
  prompt: string
  baseUrl?: string
  model?: string
  contextTokens?: number
  /** Let a thinking model reason first. Slower; off by default. */
  think?: boolean
  /**
   * What the model is asked to write. `cards` (the default) is the cut-down
   * protocol a small local model can follow (cards.ts, and the prompt
   * structurer-cards.md); `ops` is the full op list (structurer.md).
   */
  protocol?: 'cards' | 'ops'
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

const trimSlash = (url: string) => url.replace(/\/+$/, '')

export function createOllamaProvider(config: OllamaConfig): StructurerProvider {
  const baseUrl = trimSlash(config.baseUrl ?? OLLAMA_URL)
  const model = config.model ?? OLLAMA_MODEL
  const cards = (config.protocol ?? 'cards') === 'cards'
  const opsFormat = z.toJSONSchema(modelOutputSchema)

  return {
    name: `ollama:${model}`,
    // An Ollama on another machine is a cloud provider like any other.
    local: isLoopback(baseUrl),
    async structure(input: StructurerInput, signal?: AbortSignal) {
      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        body: JSON.stringify({
          model,
          stream: false,
          think: config.think ?? false,
          format: cards ? cardsSchema(input) : opsFormat,
          options: {
            num_ctx: config.contextTokens ?? OLLAMA_CONTEXT_TOKENS,
            temperature: 0,
          },
          messages: [
            { role: 'system', content: config.prompt },
            {
              role: 'user',
              content: cards ? cardsMessage(input) : JSON.stringify(input),
            },
          ],
        }),
      })
      if (!response.ok) {
        // Ollama's own error line (model missing, out of memory); never ours.
        const detail = (await response.text()).slice(0, 200)
        throw new Error(`Ollama answered ${response.status}: ${detail}`)
      }

      const body = (await response.json()) as {
        message?: { content?: string }
        done_reason?: string
      }
      const reply = looseJson(body.message?.content ?? '')
      if (reply === undefined) {
        throw new Error(
          `Ollama returned no JSON (done_reason: ${body.done_reason ?? 'none'})`
        )
      }
      return cards ? cardsToOps(reply, input) : reply
    },
  }
}

/** The models an Ollama server has pulled, or null when none answers. */
export async function ollamaModels(
  baseUrl: string = OLLAMA_URL,
  timeoutMs = 2_000
): Promise<string[] | null> {
  try {
    const response = await fetch(`${trimSlash(baseUrl)}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { models?: { name?: string }[] }
    return (body.models ?? []).flatMap(model => model.name ?? [])
  } catch {
    return null
  }
}
