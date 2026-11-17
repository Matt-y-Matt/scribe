import type { StructurerInput } from './providers/types'

// Short names for the model. The map's ids are ULIDs: 28 characters, and two
// headers made in the same millisecond differ in the last one. A large model
// copies them faithfully; a small local one confuses them and files a topic
// under the wrong header. So the model is shown `H1`, `T3`, `C7`, and what it
// sends back is translated to the real ids before the rules see it. The model
// still never mints an id: an alias it invents maps to nothing.

/** The fields of an op that hold the id of a header, topic or card. */
const ID_FIELDS = [
  'parent_id',
  'topic_id',
  'tmp_topic',
  'to_topic_id',
  'into_topic_id',
  'card_id',
  'tmp_key_or_topic_id',
] as const

export interface AliasedInput {
  /** The input with every id replaced by its alias. */
  input: StructurerInput
  /** A reply written with aliases, turned back into one with real ids. */
  restore(reply: unknown): unknown
}

export function aliasInput(input: StructurerInput): AliasedInput {
  const alias = new Map<string, string>()
  const real = new Map<string, string>()
  const name = (id: string, prefix: string, index: number) => {
    const short = `${prefix}${index + 1}`
    alias.set(id, short)
    real.set(short.toLowerCase(), id)
    return short
  }

  input.agenda.forEach((header, index) => name(header.id, 'H', index))
  input.outline.forEach((topic, index) => name(topic.id, 'T', index))
  input.outline
    .flatMap(topic => topic.last_cards)
    .forEach((card, index) => name(card.id, 'C', index))

  const short = (id: string) => alias.get(id) ?? id
  const aliased: StructurerInput = {
    ...input,
    agenda: input.agenda.map(header => ({ ...header, id: short(header.id) })),
    outline: input.outline.map(topic => ({
      ...topic,
      id: short(topic.id),
      parent_id: topic.parent_id === null ? null : short(topic.parent_id),
      last_cards: topic.last_cards.map(card => ({
        ...card,
        id: short(card.id),
      })),
    })),
  }

  return {
    input: aliased,
    restore(reply) {
      const wrapped =
        !Array.isArray(reply) &&
        Array.isArray((reply as { ops?: unknown } | null)?.ops)
      const ops: unknown = wrapped ? (reply as { ops: unknown[] }).ops : reply
      if (!Array.isArray(ops)) return reply

      // A tmp_key the model declared in this reply is its own name for a new
      // topic, even if it happens to look like an alias.
      const declared = new Set(
        ops.flatMap(op => {
          const key = (op as { tmp_key?: unknown } | null)?.tmp_key
          return typeof key === 'string' ? [key] : []
        })
      )
      const restored = ops.map(op => {
        if (typeof op !== 'object' || op === null) return op
        const copy: Record<string, unknown> = { ...op }
        for (const field of ID_FIELDS) {
          const value = copy[field]
          if (typeof value !== 'string' || declared.has(value)) continue
          copy[field] = real.get(value.trim().toLowerCase()) ?? value
        }
        return copy
      })
      return wrapped ? { ...(reply as object), ops: restored } : restored
    },
  }
}
