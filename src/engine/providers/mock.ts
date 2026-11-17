import { z } from 'zod'
import type { StructurerInput, StructurerProvider } from './types'

// The MockProvider: canned ops from `fixtures/<name>.mock-ops.json`, for CI
// and for the screens rendered from fixtures. An op is released once every
// segment it is keyed by has been heard, so however the transcript is batched
// the same ops come out in the same order.

const cannedOp = z.looseObject({
  op: z.string(),
  /** Segments that key an op which cites none itself. */
  after: z.array(z.string()).optional(),
  segment_ids: z.array(z.string()).optional(),
  /** An agenda header, by title. Becomes `parent_id`. */
  parent: z.string().optional(),
  tmp_key: z.string().optional(),
  tmp_topic: z.string().optional(),
  tmp_key_or_topic_id: z.string().optional(),
  title: z.string().optional(),
})
type CannedOp = z.infer<typeof cannedOp>

const mockOpsSchema = z.object({
  fixture: z.string(),
  ops: z.array(cannedOp),
})
export type MockOps = z.infer<typeof mockOpsSchema>

/** Parses a `.mock-ops.json` file. */
export function parseMockOps(text: string): MockOps {
  const parsed = mockOpsSchema.safeParse(JSON.parse(text))
  if (!parsed.success) {
    throw new Error(`mock ops: ${parsed.error.issues[0]?.message}`)
  }
  return parsed.data
}

export interface MockReply {
  ops: Record<string, unknown>[]
}

/**
 * The mock without the promise: call it with each input in turn and it hands
 * back the ops that are due. Fixture screens use it to build a map in one go.
 */
export function createMockReleaser(
  canned: MockOps
): (input: StructurerInput) => MockReply {
  const heard = new Set<string>()
  const released = new Set<number>()
  /** `tmp_key` → the title of the topic it stood for, once released. */
  const topicTitles = new Map<string, string>()

  return input => {
    for (const segment of input.new_segments) heard.add(segment.id)
    const keysThisRun = new Set<string>()
    const headerId = (title: string) =>
      input.agenda.find(header => header.title === title)?.id
    const earlierTopicId = (tmpKey: string) =>
      input.outline.find(topic => topic.title === topicTitles.get(tmpKey))?.id

    const ops: Record<string, unknown>[] = []
    canned.ops.forEach((entry: CannedOp, index) => {
      if (released.has(index)) return
      const key = entry.after ?? entry.segment_ids ?? []
      if (!key.every(id => heard.has(id))) return

      // A card or suggestion waits for the topic it points at.
      const ref = entry.tmp_topic ?? entry.tmp_key_or_topic_id
      const sameRun = ref !== undefined && keysThisRun.has(ref)
      const earlier = ref === undefined ? undefined : earlierTopicId(ref)
      if (ref !== undefined && !sameRun && !earlier) return

      const { after: _after, parent, ...op } = entry
      if (parent !== undefined) op.parent_id = headerId(parent)
      // A topic from an earlier run is on the map now: use its real id.
      if (earlier && !sameRun) {
        if (op.tmp_topic !== undefined) {
          delete op.tmp_topic
          op.topic_id = earlier
        } else {
          op.tmp_key_or_topic_id = earlier
        }
      }
      if (entry.op === 'add_topic' && entry.tmp_key && entry.title) {
        keysThisRun.add(entry.tmp_key)
        topicTitles.set(entry.tmp_key, entry.title)
      }
      released.add(index)
      ops.push(op)
    })
    return { ops }
  }
}

export function createMockProvider(canned: MockOps): StructurerProvider {
  const release = createMockReleaser(canned)
  return {
    name: 'mock',
    local: true,
    structure: async input => release(input),
  }
}
