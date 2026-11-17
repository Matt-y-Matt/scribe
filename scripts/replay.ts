// `pnpm replay fixtures/<name>.jsonl --speed 10`
// Plays a transcript fixture without audio and prints each segment as it
// becomes final. The sink here is the console. To play the same fixture into
// the map engine and score the result, use `pnpm golden` (scripts/golden.ts),
// which feeds the structurer through the same SegmentSink interface.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  parseFixtureJsonl,
  parseFixtureMeta,
  type FixtureMeta,
} from '../src/engine/replay/fixture'
import { replay, type SegmentSink } from '../src/engine/replay/replay'

const USAGE = 'Usage: pnpm replay <fixture.jsonl> [--speed <n>]'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function clockTime(ms: number): string {
  const tenths = Math.round(ms / 100)
  const pad = (value: number) => String(value).padStart(2, '0')
  const seconds = Math.floor(tenths / 10)
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}.${tenths % 10}`
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return fail(`Cannot read ${what} at ${path}`)
  }
}

function parse<T>(what: string, run: () => T): T {
  try {
    return run()
  } catch (error) {
    return fail(`${what}: ${error instanceof Error ? error.message : error}`)
  }
}

const { values, positionals } = parse('Arguments', () =>
  parseArgs({
    args: process.argv.slice(2).filter(arg => arg !== '--'),
    allowPositionals: true,
    options: { speed: { type: 'string', default: '1' } },
  })
)

const fixturePath = positionals[0]
if (!fixturePath || positionals.length > 1) fail(USAGE)
if (!fixturePath.endsWith('.jsonl')) fail(`${USAGE}\nNot a .jsonl file.`)

const speed = Number(values.speed)
if (!Number.isFinite(speed) || speed <= 0) {
  fail(`--speed must be a positive number, got "${values.speed}"`)
}

const segments = parse(fixturePath, () =>
  parseFixtureJsonl(readText(fixturePath, 'the fixture'))
)
const metaPath = fixturePath.replace(/\.jsonl$/, '.meta.json')
const meta: FixtureMeta = parse(metaPath, () =>
  parseFixtureMeta(readText(metaPath, 'the fixture meta file'))
)

const nameWidth = Math.max(...meta.participants.map(name => name.length), 7)
const seconds = (ms: number) => (ms / 1000).toFixed(1)

console.log(`Replay: ${meta.title} (${meta.mode})`)
console.log(`Agenda: ${meta.agenda.join(' · ') || 'none'}`)
console.log(`Participants: ${meta.participants.join(', ')}`)
console.log(`Speed: ${speed}×\n`)

const consoleSink: SegmentSink = {
  segmentFinal(event) {
    console.log(
      `${clockTime(event.t0_ms)}–${clockTime(event.t1_ms)}  ${event.id}  ` +
        `${event.speaker_label.padEnd(nameWidth)}  ${event.text}`
    )
  },
  end(summary) {
    console.log(
      `\n${summary.segments} segments · ${seconds(summary.meetingMs)} s of ` +
        `meeting in ${seconds(summary.wallMs)} s · ${summary.speed}×`
    )
  },
}

await replay(segments, consoleSink, { speed })
