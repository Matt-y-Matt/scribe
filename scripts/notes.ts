// `pnpm notes <transcript.jsonl> [--title <t>] [--people a,b] [--agenda x,y]
//   [--loopback] [--live] [--summary] [--model <id>]`
//
// Runs a transcript through what a meeting runs it through, on the Ollama of
// this PC, and prints the result to read: the turns the note-taker sees, the
// map its live notes make (`--live`) and the written summary (`--summary`).
// With neither flag it does both.
//
// The transcript is fixture JSONL, one `{id, t0, t1, speaker, text}` a line
// with seconds for times, and `source` (`laptop` or `system`) on a recorded
// call. It is for transcripts of real meetings, which stay out of the
// repository: nothing here writes anywhere but the console.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { cardsIn, headersOf, topicsUnder } from '../src/engine/model'
import { createProvider } from '../src/engine/providers'
import {
  OLLAMA_MODEL,
  ollamaModels,
  OLLAMA_URL,
} from '../src/engine/providers/ollama'
import { replayIntoEngine } from '../src/engine/replay/engine'
import {
  parseFixtureJsonl,
  toSegmentFinal,
  type FixtureMeta,
} from '../src/engine/replay/fixture'
import { named, speakerNames } from '../src/engine/speakers'
import { toTurns } from '../src/engine/turns'
import {
  renderWritten,
  transcriptText,
  writeMeetingSummary,
} from '../src/engine/written-summary'

const CARDS_PROMPT = 'src/engine/prompts/structurer-cards.md'

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter(arg => arg !== '--'),
  allowPositionals: true,
  options: {
    title: { type: 'string', default: 'Meeting' },
    people: { type: 'string', default: '' },
    agenda: { type: 'string', default: '' },
    /** The transcript is a call: the first person is at this PC. */
    loopback: { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    summary: { type: 'boolean', default: false },
    /** Print the turns the models are shown. */
    turns: { type: 'boolean', default: false },
    model: { type: 'string' },
  },
})
const [path] = positionals
if (!path) fail('Usage: pnpm notes <transcript.jsonl> [--live] [--summary]')
const both = !values.live && !values.summary

const list = (value: string) =>
  value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
const meta: FixtureMeta = {
  fixture: path,
  title: values.title,
  mode: 'group',
  agenda: list(values.agenda),
  participants: list(values.people),
}

const model = values.model ?? OLLAMA_MODEL
const models = await ollamaModels()
if (models === null) fail(`Ollama does not answer at ${OLLAMA_URL}.`)
if (!models.includes(model)) fail(`Ollama has no model "${model}".`)

const names = speakerNames(meta.participants, values.loopback)
const rows = parseFixtureJsonl(readFileSync(path, 'utf8')).map(row => ({
  ...row,
  // Named the way the app names them before a model reads the line.
  speaker: named(toSegmentFinal(row, 'm'), names).speaker_label,
}))
const turns = toTurns(
  rows.map(row => {
    const segment = toSegmentFinal(row, 'm')
    return {
      id: segment.id,
      t0: segment.t0_ms,
      t1: segment.t1_ms,
      speaker: segment.speaker_label,
      source: segment.source,
      text: segment.text,
    }
  })
)
console.log(
  `${meta.title}: ${rows.length} lines, ${turns.length} turns, model ${model}\n`
)
if (values.turns) console.log(`${transcriptText(turns)}\n`)

const seconds = (since: number) =>
  `${((performance.now() - since) / 1000).toFixed(1)} s`

if (values.live || both) {
  const started = performance.now()
  const provider = createProvider({
    kind: 'ollama',
    prompt: readFileSync(CARDS_PROMPT, 'utf8'),
    model,
  })
  const { store, structurer } = await replayIntoEngine(rows, meta, provider, {
    paced: true,
    liveSpeech: true,
    onRun(run) {
      if (run.error) console.log(`  run ${run.index + 1} FAILED: ${run.error}`)
    },
  })
  const state = store.getState()
  const kinds = new Map<string, number>()
  console.log('LIVE NOTES')
  for (const header of headersOf(state)) {
    console.log(header.title)
    for (const topic of topicsUnder(state, header.id)) {
      console.log(`  ${topic.title}`)
      for (const card of cardsIn(state, topic.id)) {
        kinds.set(card.kind, (kinds.get(card.kind) ?? 0) + 1)
        const who = card.owner ? ` @${card.owner}` : ''
        const due = card.due_text ? ` (${card.due_text})` : ''
        console.log(
          `    ${card.kind.padEnd(8)}${who}${due}  ${card.text}  [${card.segment_ids.length}]`
        )
      }
    }
  }
  const suggestions = Object.values(state.suggestions).length
  console.log(
    `\n  ${[...kinds].map(([kind, count]) => `${count} ${kind}`).join(', ')}; ` +
      `${suggestions} suggestions; ${structurer.runs.length} runs ` +
      `(${structurer.runs.filter(run => run.error).length} failed), ` +
      `${structurer.dropped.length} ops dropped; ${seconds(started)}\n`
  )
}

if (values.summary || both) {
  const started = performance.now()
  const written = await writeMeetingSummary(
    async (body, signal) => {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body,
      })
      if (!response.ok) throw new Error(`Ollama answered ${response.status}`)
      return response.text()
    },
    turns,
    {
      title: meta.title,
      participants: meta.participants,
      agenda: meta.agenda,
      model,
      onProgress: (step, steps) =>
        console.log(`  request ${step} of ${steps}…`),
    }
  )
  console.log('WRITTEN SUMMARY\n')
  console.log(
    renderWritten(written, {
      title: meta.title,
      participants: meta.participants,
    })
  )
  console.log(`  ${seconds(started)}`)
}
