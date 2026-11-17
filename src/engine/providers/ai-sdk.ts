import { generateText, Output, type LanguageModel } from 'ai'
import { z } from 'zod'
import type { StructurerInput, StructurerProvider } from './types'

// A real model behind the provider interface, through the Vercel AI SDK. The
// system prompt is src/engine/prompts/structurer.md; the user message is the
// input as JSON; the reply is constrained to `modelOutputSchema` where the
// model supports it (Ollama `format`, Anthropic structured outputs).

const ids = z.array(z.string())

/**
 * The op list as a model is asked to write it: plain JSON Schema, no
 * transforms. It is looser than the rules in apply.ts, which have the last
 * word on every op.
 */
export const modelOutputSchema = z.object({
  ops: z.array(
    z.discriminatedUnion('op', [
      z.object({
        op: z.literal('add_topic'),
        tmp_key: z.string(),
        title: z.string(),
        parent_id: z.string().optional(),
        off_agenda: z.boolean(),
        segment_ids: ids,
      }),
      z.object({
        op: z.literal('add_card'),
        topic_id: z.string().optional(),
        tmp_topic: z.string().optional(),
        kind: z.enum(['note', 'decision', 'action']),
        text: z.string(),
        owner: z.string().optional(),
        due_text: z.string().optional(),
        segment_ids: ids,
      }),
      z.object({
        op: z.literal('suggest_pin'),
        tmp_key_or_topic_id: z.string(),
        title: z.string(),
        reason: z.string(),
      }),
      z.object({
        op: z.literal('suggest_move'),
        card_id: z.string(),
        to_topic_id: z.string(),
        reason: z.string(),
      }),
      z.object({
        op: z.literal('suggest_merge'),
        topic_id: z.string(),
        into_topic_id: z.string(),
        reason: z.string(),
      }),
    ])
  ),
})

type GenerateOptions = Parameters<typeof generateText>[0]

export interface AiSdkProviderOptions {
  name: string
  local: boolean
  model: LanguageModel
  /** The system prompt. */
  prompt: string
  maxOutputTokens?: number
  /** Leave unset for models that reject sampling parameters. */
  temperature?: number
  providerOptions?: GenerateOptions['providerOptions']
}

/**
 * JSON from a reply that is not quite JSON: fenced, or with a sentence in
 * front. Returns undefined when there is no object to be found.
 */
export function looseJson(text: string): unknown {
  const candidates = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*|```[\s\S]*$/g, ''),
  ]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next shape
    }
  }
  return undefined
}

export function createAiSdkProvider(
  options: AiSdkProviderOptions
): StructurerProvider {
  return {
    name: options.name,
    local: options.local,
    async structure(input: StructurerInput, signal?: AbortSignal) {
      try {
        const result = await generateText({
          model: options.model,
          instructions: options.prompt,
          prompt: JSON.stringify(input),
          output: Output.object({ schema: modelOutputSchema }),
          maxOutputTokens: options.maxOutputTokens,
          temperature: options.temperature,
          providerOptions: options.providerOptions,
          abortSignal: signal,
        })
        return result.output
      } catch (error) {
        // A reply that fails the schema still carries its text. One bad op
        // should not cost the batch: hand over what parses and let the apply
        // rules drop what does not belong.
        const text = (error as { text?: unknown } | null)?.text
        const parsed = typeof text === 'string' ? looseJson(text) : undefined
        if (parsed === undefined) throw error
        return parsed
      }
    },
  }
}
