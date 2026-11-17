// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { countingSource } from '../ids'
import { headersOf } from '../model'
import type { StructurerInput, StructurerProvider } from '../providers/types'
import { replayIntoEngine } from './engine'
import { instantClock } from '../testing'
import { parseFixtureJsonl, parseFixtureMeta } from './fixture'

const read = (name: string) =>
  readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8')
const segments = parseFixtureJsonl(read('meeting-custore-weekly.jsonl'))
const meta = parseFixtureMeta(read('meeting-custore-weekly.meta.json'))

describe('replay into the engine (PRD F4.2)', () => {
  it('runs on the meeting clock, skips nothing and never overlaps', async () => {
    const inputs: StructurerInput[] = []
    let inFlight = 0
    let overlapped = false
    const provider: StructurerProvider = {
      name: 'recording',
      local: true,
      async structure(input) {
        overlapped ||= inFlight > 0
        inFlight++
        inputs.push(input)
        await Promise.resolve()
        inFlight--
        return { ops: [] }
      },
    }

    const { store, structurer, summary } = await replayIntoEngine(
      segments,
      meta,
      provider,
      { speed: 10, clock: instantClock(), ids: countingSource() }
    )

    expect(summary).toMatchObject({
      segments: 46,
      meetingMs: 381_200,
      speed: 10,
    })
    expect(overlapped).toBe(false)

    // The fixture never pauses for 2 s, so every run is the 45 s rule, at the
    // same points in the meeting whatever the replay speed.
    expect(
      structurer.runs.map(run => [run.reason, run.dueAtMs, run.segmentIds[0]])
    ).toEqual([
      ['elapsed', 52_000, 's001'],
      ['elapsed', 97_800, 's007'],
      ['elapsed', 145_100, 's014'],
      ['elapsed', 196_200, 's019'],
      ['elapsed', 242_600, 's025'],
      ['elapsed', 294_500, 's030'],
      ['elapsed', 349_300, 's034'],
      ['end', 381_200, 's042'],
    ])

    // Every segment reached the model exactly once, in order.
    expect(
      inputs.flatMap(input => input.new_segments.map(row => row.id))
    ).toEqual(segments.map(segment => segment.id))
    expect(store.now).toBe(381_200)
    expect(headersOf(store.getState()).map(header => header.title)).toEqual([
      ...meta.agenda,
      'Unplanned',
    ])
  })
})
