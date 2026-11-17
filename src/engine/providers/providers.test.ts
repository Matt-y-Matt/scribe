// @vitest-environment node
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAiSdkProvider, looseJson, modelOutputSchema } from './ai-sdk'
import { ANTHROPIC_MODEL } from './anthropic'
import { createProvider } from './index'
import { createMockProvider, parseMockOps } from './mock'
import { isLoopback, OLLAMA_MODEL, ollamaModels } from './ollama'
import type { StructurerInput } from './types'

const INPUT: StructurerInput = {
  agenda: [{ id: 't_A', title: 'CLA quote' }],
  outline: [],
  recent_structured: '',
  new_segments: [{ id: 's001', t0: 0, speaker: 'Matt', text: 'Hello' }],
  participants: ['Matt'],
  now_ms: 1000,
}

/** A model that replies with `text`, whatever it is asked. */
function replying(text: string) {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    } as never,
  })
}

const provider = (model: MockLanguageModelV4) =>
  createAiSdkProvider({
    name: 'test:model',
    local: true,
    model,
    prompt: 'You keep the live map of a meeting.',
    temperature: 0,
  })

describe('AI SDK provider', () => {
  it('sends the prompt, the input as JSON and the op schema', async () => {
    const ops = [
      {
        op: 'add_topic',
        tmp_key: 'p',
        title: 'Pricing',
        parent_id: 't_A',
        off_agenda: false,
        segment_ids: ['s001'],
      },
    ]
    const model = replying(JSON.stringify({ ops }))
    await expect(provider(model).structure(INPUT)).resolves.toEqual({ ops })

    const [call] = model.doGenerateCalls
    const sent = JSON.stringify(call?.prompt)
    expect(sent).toContain('You keep the live map of a meeting.')
    expect(sent).toContain('new_segments')
    expect(call?.responseFormat).toMatchObject({ type: 'json' })
    expect(call?.temperature).toBe(0)
  })

  it('still returns a reply that breaks the schema, for the rules to judge', async () => {
    const reply = {
      ops: [
        { op: 'delete_card', card_id: 'c_1' },
        { op: 'add_card', kind: 'note', text: 'x', segment_ids: ['s001'] },
      ],
    }
    const model = replying(
      `Here you go:\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``
    )
    await expect(provider(model).structure(INPUT)).resolves.toEqual(reply)
  })

  it('fails the run when the reply holds no JSON at all', async () => {
    await expect(
      provider(replying('I cannot help with that.')).structure(INPUT)
    ).rejects.toThrow()
  })

  it('offers the model a schema without transforms', () => {
    expect(() => modelOutputSchema.parse({ ops: [] })).not.toThrow()
    const schema = JSON.stringify(
      // zod 4's own converter: throws on anything JSON Schema cannot say.
      z.toJSONSchema(modelOutputSchema)
    )
    expect(schema).toContain('suggest_pin')
    expect(schema).not.toContain('delete')
  })
})

describe('looseJson', () => {
  it('finds the object in a fenced or chatty reply', () => {
    expect(looseJson('{"ops":[]}')).toEqual({ ops: [] })
    expect(looseJson('```json\n{"ops":[]}\n```')).toEqual({ ops: [] })
    expect(looseJson('Sure! {"ops":[]} Hope that helps.')).toEqual({ ops: [] })
    expect(looseJson('no json here')).toBeUndefined()
  })
})

describe('providers', () => {
  it('are built from plain config', () => {
    const prompt = 'p'
    expect(createProvider({ kind: 'ollama', prompt })).toMatchObject({
      name: `ollama:${OLLAMA_MODEL}`,
      local: true,
    })
    expect(
      createProvider({
        kind: 'ollama',
        prompt,
        baseUrl: 'http://10.0.0.5:11434',
      })
    ).toMatchObject({ local: false })
    // Anthropic is never local: using it is cloud mode (CLAUDE.md rule 4).
    expect(
      createProvider({ kind: 'anthropic', prompt, apiKey: 'test-key' })
    ).toMatchObject({ name: `anthropic:${ANTHROPIC_MODEL}`, local: false })
    expect(
      createProvider({ kind: 'mock', canned: { fixture: 'f', ops: [] } })
    ).toMatchObject({ name: 'mock', local: true })
  })

  it('know a loopback address from a remote one', () => {
    expect(isLoopback('http://127.0.0.1:11434')).toBe(true)
    expect(isLoopback('http://localhost:11434/')).toBe(true)
    expect(isLoopback('http://[::1]:11434')).toBe(true)
    expect(isLoopback('https://ollama.example.com')).toBe(false)
    expect(isLoopback('not a url')).toBe(false)
  })

  it('report no models when nothing answers', async () => {
    // Port 9 (discard) is closed on a normal machine.
    await expect(ollamaModels('http://127.0.0.1:9', 500)).resolves.toBeNull()
  })
})

describe('MockProvider', () => {
  const canned = parseMockOps(
    JSON.stringify({
      fixture: 'test.jsonl',
      ops: [
        {
          op: 'add_topic',
          tmp_key: 'p',
          title: 'Pricing',
          parent: 'CLA quote',
          segment_ids: ['s001'],
        },
        {
          op: 'add_card',
          tmp_topic: 'p',
          kind: 'note',
          text: 'First',
          segment_ids: ['s001'],
        },
        {
          op: 'add_card',
          tmp_topic: 'p',
          kind: 'note',
          text: 'Later',
          segment_ids: ['s001', 's003'],
        },
        {
          op: 'suggest_pin',
          tmp_key_or_topic_id: 'p',
          title: 'Pricing',
          after: ['s002'],
        },
      ],
    })
  )
  const heard = (...ids: string[]): StructurerInput => ({
    ...INPUT,
    new_segments: ids.map(id => ({ id, t0: 0, speaker: 'Matt', text: 'x' })),
  })

  it('releases an op once the segments it is keyed by have been heard', async () => {
    const mock = createMockProvider(canned)
    await expect(mock.structure(heard('s001'))).resolves.toEqual({
      ops: [
        {
          op: 'add_topic',
          tmp_key: 'p',
          title: 'Pricing',
          parent_id: 't_A',
          segment_ids: ['s001'],
        },
        {
          op: 'add_card',
          tmp_topic: 'p',
          kind: 'note',
          text: 'First',
          segment_ids: ['s001'],
        },
      ],
    })

    // The topic is on the map now, so later ops use its real id.
    const outline = [
      {
        id: 't_P',
        title: 'Pricing',
        parent_id: 't_A',
        off_agenda: false,
        last_cards: [],
      },
    ]
    await expect(
      mock.structure({ ...heard('s002', 's003'), outline })
    ).resolves.toEqual({
      ops: [
        {
          op: 'add_card',
          topic_id: 't_P',
          kind: 'note',
          text: 'Later',
          segment_ids: ['s001', 's003'],
        },
        { op: 'suggest_pin', tmp_key_or_topic_id: 't_P', title: 'Pricing' },
      ],
    })
    await expect(mock.structure(heard('s004'))).resolves.toEqual({ ops: [] })
  })

  it('gives the same ops in one batch as in two', async () => {
    const reply = (await createMockProvider(canned).structure(
      heard('s001', 's002', 's003')
    )) as { ops: { op: string }[] }
    expect(reply.ops.map(op => op.op)).toEqual([
      'add_topic',
      'add_card',
      'add_card',
      'suggest_pin',
    ])
  })

  it('rejects a file that is not a list of ops', () => {
    expect(() => parseMockOps('{"fixture":"f"}')).toThrow(/mock ops/)
  })
})
