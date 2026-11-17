// `pnpm golden --provider mock|ollama|anthropic [--paced] [--map] [--trace <file>]`
// Replays the golden fixture through the engine with the chosen provider and
// prints the score (docs/TEST_PLAN.md §2). The mock is what CI runs; a real
// provider is run by hand and its score recorded in docs/NOTES.md.
//
// Only the fixture transcript is ever sent to a provider from here. Anthropic
// reads the key from ANTHROPIC_API_KEY.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  acceptPinSuggestions,
  formatScore,
  parseExpected,
  scoreGolden,
} from '../src/engine/golden/score'
import { cardsIn, headersOf, topicsUnder } from '../src/engine/model'
import { createProvider, type ProviderConfig } from '../src/engine/providers'
import { parseMockOps } from '../src/engine/providers/mock'
import type { StructurerProvider } from '../src/engine/providers/types'
import {
  OLLAMA_MODEL,
  ollamaModels,
  OLLAMA_URL,
} from '../src/engine/providers/ollama'
import { replayIntoEngine } from '../src/engine/replay/engine'
import {
  parseFixtureJsonl,
  parseFixtureMeta,
} from '../src/engine/replay/fixture'

const FIXTURE = 'fixtures/meeting-custore-weekly'
const PROMPT = 'src/engine/prompts/structurer.md'
const CARDS_PROMPT = 'src/engine/prompts/structurer-cards.md'
const USAGE =
  'Usage: pnpm golden --provider mock|ollama|anthropic [--speed <n>] [--paced] [--model <id>] [--think] [--map] [--trace <file>]'

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

const { values } = parseArgs({
  args: process.argv.slice(2).filter(arg => arg !== '--'),
  options: {
    provider: { type: 'string', default: 'mock' },
    speed: { type: 'string', default: '10' },
    model: { type: 'string' },
    /** Print the map the provider built, for reading a failed score. */
    map: { type: 'boolean', default: false },
    /**
     * Wait for each run to finish before playing on, so every run gets the
     * batch its trigger asked for. That is what a live meeting gives a model
     * that answers inside 45 s; at 10× a slow model gets several at once.
     */
    paced: { type: 'boolean', default: false },
    /** Ollama only: let a thinking model reason before it answers. */
    think: { type: 'boolean', default: false },
    /** Write every run's input and raw reply to this file, as JSON lines. */
    trace: { type: 'string' },
  },
})

const speed = Number(values.speed)
if (!Number.isFinite(speed) || speed <= 0) {
  fail(`--speed must be a positive number, got "${values.speed}"`)
}

const read = (path: string) => readFileSync(path, 'utf8')

async function providerConfig(): Promise<ProviderConfig> {
  switch (values.provider) {
    case 'mock':
      return {
        kind: 'mock',
        canned: parseMockOps(read(`${FIXTURE}.mock-ops.json`)),
      }
    case 'ollama': {
      const model = values.model ?? OLLAMA_MODEL
      const models = await ollamaModels()
      if (models === null) fail(`Ollama does not answer at ${OLLAMA_URL}.`)
      if (!models.includes(model)) {
        fail(`Ollama has no model "${model}". Run: ollama pull ${model}`)
      }
      return {
        kind: 'ollama',
        // A local model gets the cut-down card protocol and its own prompt.
        prompt: read(CARDS_PROMPT),
        model,
        think: values.think,
      }
    }
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) fail('Set ANTHROPIC_API_KEY to run the Anthropic provider.')
      return {
        kind: 'anthropic',
        apiKey,
        prompt: read(PROMPT),
        model: values.model,
      }
    }
    default:
      return fail(`Unknown provider "${values.provider}".\n${USAGE}`)
  }
}

const segments = parseFixtureJsonl(read(`${FIXTURE}.jsonl`))
const meta = parseFixtureMeta(read(`${FIXTURE}.meta.json`))
const expected = parseExpected(read(`${FIXTURE}.expected.json`))
const real = createProvider(await providerConfig())
const tracePath = values.trace
if (tracePath) writeFileSync(tracePath, '')
/** The provider, with each exchange copied to the trace file if one is set. */
const provider: StructurerProvider = {
  name: real.name,
  local: real.local,
  async structure(input, signal) {
    const started = performance.now()
    let reply: unknown
    try {
      reply = await real.structure(input, signal)
      return reply
    } catch (error) {
      reply = { error: error instanceof Error ? error.message : String(error) }
      throw error
    } finally {
      if (tracePath) {
        const seconds = Math.round((performance.now() - started) / 100) / 10
        appendFileSync(
          tracePath,
          `${JSON.stringify({ seconds, input, reply })}\n`
        )
      }
    }
  },
}

console.log(
  `Golden replay: ${meta.title}, ${segments.length} segments at ${speed}×, ` +
    `provider ${provider.name}${values.paced ? ', paced' : ''}${provider.local ? '' : ' (cloud: the fixture transcript leaves this PC)'}\n`
)

const startedAt = performance.now()
const { store, structurer } = await replayIntoEngine(segments, meta, provider, {
  speed,
  paced: values.paced,
  onRun(run) {
    const range = `${run.segmentIds[0]}–${run.segmentIds.at(-1)}`
    const outcome = run.error
      ? `FAILED: ${run.error}`
      : `${run.applied} applied, ${run.dropped.length} dropped`
    console.log(
      `  run ${run.index + 1}  ${run.reason.padEnd(7)}  ${range}  ${outcome}`
    )
  },
})

const dropped = structurer.dropped
if (dropped.length > 0) {
  const counts = new Map<string, number>()
  for (const drop of dropped) {
    const key = `${drop.op}: ${drop.reason}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  console.log(
    `\nDropped by the apply rules: ${[...counts]
      .map(([key, count]) => `${key} ×${count}`)
      .join(', ')}`
  )
}

if (values.map) {
  const state = store.getState()
  console.log()
  for (const header of headersOf(state)) {
    console.log(header.title)
    for (const topic of topicsUnder(state, header.id)) {
      console.log(`  ${topic.title}  [${topic.segment_ids.join(' ')}]`)
      for (const card of cardsIn(state, topic.id)) {
        const who = card.owner ? ` @${card.owner}` : ''
        const due = card.due_text ? ` (${card.due_text})` : ''
        console.log(
          `    ${card.kind.padEnd(8)}${who}${due}  ${card.text}  [${card.segment_ids.join(' ')}]`
        )
      }
    }
  }
}

const failedRuns = structurer.runs.filter(run => run.error !== undefined)
acceptPinSuggestions(store)
const score = scoreGolden(store, expected)
console.log(
  `\n${formatScore(score, provider.name)}\n` +
    `  runs            ${structurer.runs.length} (${failedRuns.length} failed), ` +
    `${((performance.now() - startedAt) / 1000).toFixed(1)} s`
)
process.exit(score.pass && failedRuns.length === 0 ? 0 : 1)
