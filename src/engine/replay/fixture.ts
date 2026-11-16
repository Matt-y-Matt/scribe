import { z } from 'zod'
import type { SegmentFinal } from '../../ipc'

// Replay fixtures: `fixtures/<name>.jsonl` holds one transcript segment per
// line, `fixtures/<name>.meta.json` holds what a meeting knows before anyone
// speaks. Parsing takes text, not paths, so the engine stays free of Node and
// DOM APIs; callers read the files.

const fixtureSegmentSchema = z
  .object({
    id: z.string().min(1),
    /** Seconds from the start of the meeting. */
    t0: z.number().nonnegative(),
    t1: z.number().nonnegative(),
    speaker: z.string().min(1),
    text: z.string().min(1),
  })
  .refine(segment => segment.t1 >= segment.t0, {
    message: 't1 must not be before t0',
  })

export type FixtureSegment = z.infer<typeof fixtureSegmentSchema>

const fixtureMetaSchema = z.object({
  fixture: z.string().min(1),
  title: z.string().min(1),
  mode: z.enum(['group', 'solo']),
  /** 0–8 headers (PRD F1.1). */
  agenda: z.array(z.string().min(1)).max(8),
  participants: z.array(z.string().min(1)),
})

export type FixtureMeta = z.infer<typeof fixtureMetaSchema>

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.join('.') || 'row'}: ${issue.message}`)
    .join('; ')
}

/** Parses a `.jsonl` transcript. Errors name the offending line. */
export function parseFixtureJsonl(text: string): FixtureSegment[] {
  const segments: FixtureSegment[] = []
  const seen = new Set<string>()

  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return
    const where = `fixture line ${index + 1}`

    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      throw new Error(`${where}: not valid JSON`)
    }

    const parsed = fixtureSegmentSchema.safeParse(row)
    if (!parsed.success) {
      throw new Error(`${where}: ${describeIssues(parsed.error)}`)
    }
    const segment = parsed.data

    if (seen.has(segment.id)) {
      throw new Error(`${where}: duplicate segment id "${segment.id}"`)
    }
    const previous = segments.at(-1)
    if (previous && segment.t0 < previous.t0) {
      throw new Error(`${where}: starts before the segment above it`)
    }

    seen.add(segment.id)
    segments.push(segment)
  })

  return segments
}

/** Parses a `.meta.json` file. */
export function parseFixtureMeta(text: string): FixtureMeta {
  const parsed = fixtureMetaSchema.safeParse(JSON.parse(text))
  if (!parsed.success) {
    throw new Error(`fixture meta: ${describeIssues(parsed.error)}`)
  }
  return parsed.data
}

const toMs = (seconds: number) => Math.round(seconds * 1000)

/**
 * Turns a fixture row into the `segment:final` payload the Rust core sends.
 * Fixture ids are kept because the golden expectations refer to them. A
 * replay has no microphone, so `source` is the laptop and `confidence` is 1.
 */
export function toSegmentFinal(
  segment: FixtureSegment,
  meetingId: string
): SegmentFinal {
  return {
    id: segment.id,
    meeting_id: meetingId,
    t0_ms: toMs(segment.t0),
    t1_ms: toMs(segment.t1),
    speaker_label: segment.speaker,
    source: 'laptop',
    text: segment.text,
    confidence: 1,
  }
}
