import { z } from 'zod'
import { toTurns, type Turn } from '../turns'
import type { StructurerInput } from './types'

// The card protocol: the structurer's task cut down to what a small local
// model can do reliably. The op protocol (apply.ts, ai-sdk.ts) asks a model
// to add topics, hand out tmp_keys and refer back to them; a 4B model drops
// those references or invents ids. Here it walks the new segments one by
// one. For each it first says what the segment is (new content, a recap, the
// agenda being read out, or nothing), then which header and topic it belongs
// to, then the cards. This file turns that into the ops the engine's rules
// judge, and takes cards only from segments the model called new.
//
// What the model walks through are turns, not the recorder's lines (turns.ts):
// live speech arrives in fragments of four or five words, and a card per
// fragment is a paraphrase of the transcript, not a note. A card written from
// a turn cites every line the turn covers.
//
// The schema is built per request, so a grammar-constrained model (Ollama
// `format`) cannot name a segment, a header or an owner that does not exist.

/** The `header` value for talk that is not on the agenda. */
export const OFF_AGENDA = 'OFF'
const FALLBACK_TITLE = 'General'

/** What a segment is. Only `new` segments give cards. */
export const SEGMENT_TYPES = ['new', 'recap', 'agenda', 'other'] as const
/**
 * Live speech only: too broken or mis-heard to say what was meant. A bin of
 * its own, so a model is not tempted to write a card from it.
 */
export const UNCLEAR = 'unclear'

/**
 * What a model is told about live speech, at the end of the message where a
 * small model weighs it most. It is not in the system prompt: that prompt is
 * what the golden test passes with, and a 4B model's filing of a clean
 * transcript changes with almost any sentence added to it (docs/NOTES.md,
 * 2026-11-20). A replayed fixture never gets this section.
 */
export const LIVE_RULES = [
  'THIS IS A LIVE TRANSCRIPT',
  'It was made by speech recognition while people talk. Lines break off, repeat themselves and mis-hear words. For the segments above:',
  '- Write a card only when you can say what the person meant in a line that stands by itself. Thinking aloud, starting over, and a question nobody answers give no card.',
  `- Never copy a word or a number that makes no sense where it stands. Leave that part out. If nothing clear is left, the segment's type is "${UNCLEAR}" and it has no cards.`,
  '- When someone asks the person they are talking to ("can you send me the file tonight?"), the action belongs to the person asked, never to the speaker.',
  '- `Room` and `System audio` are not people. An action from such a line has owner null unless a name is said.',
  '- Do not write a card that says again what a topic already holds.',
  '- When there is no agenda, every header is OFF: give each subject one topic title and keep using it.',
].join('\n')

/** The new segments as the model is shown them. Empty when all is filler. */
export function cardTurns(input: StructurerInput): Turn[] {
  return toTurns(input.new_segments)
}

/** JSON Schema for the reply to this input. */
export function cardsSchema(input: StructurerInput): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['segments'],
    properties: {
      segments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          // In the order the model should decide them.
          required: ['id', 'type', 'header', 'topic', 'cards'],
          properties: {
            id: {
              type: 'string',
              enum: cardTurns(input).map(turn => turn.id),
            },
            type: {
              type: 'string',
              enum: input.live
                ? [...SEGMENT_TYPES, UNCLEAR]
                : [...SEGMENT_TYPES],
            },
            header: {
              type: 'string',
              enum: [...input.agenda.map(header => header.id), OFF_AGENDA],
            },
            topic: { type: 'string' },
            cards: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'owner', 'due_text', 'text'],
                properties: {
                  kind: {
                    type: 'string',
                    enum: ['note', 'decision', 'action'],
                  },
                  owner: { enum: [...input.participants, null] },
                  due_text: { type: ['string', 'null'] },
                  text: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }
}

/**
 * The input as plain text. A small model keeps `[s017] Zach: …` attached to
 * its id far better than the same thing as a JSON object in an array.
 */
export function cardsMessage(input: StructurerInput): string {
  const topicsUnder = (match: (topic: Topic) => boolean) =>
    input.outline.filter(match).map(topic => {
      const latest = topic.last_cards
        .map(card => `[${card.kind}] ${card.text}`)
        .join('; ')
      return `  - ${topic.title}${latest ? ` (latest: ${latest})` : ''}`
    })
  type Topic = StructurerInput['outline'][number]

  const lines: string[] = ['AGENDA']
  for (const header of input.agenda) {
    lines.push(`${header.id} = ${header.title}`)
  }
  lines.push('', 'TOPICS SO FAR')
  for (const header of input.agenda) {
    const topics = topicsUnder(topic => topic.parent_id === header.id)
    lines.push(
      `Under ${header.id} (${header.title}):${topics.length ? '' : ' none yet'}`,
      ...topics
    )
  }
  const off = topicsUnder(topic => topic.off_agenda)
  lines.push(`Off the agenda (${OFF_AGENDA}):${off.length ? '' : ' none yet'}`)
  lines.push(...off)

  lines.push('', `PARTICIPANTS: ${input.participants.join(', ')}`)
  lines.push(
    '',
    'ALREADY DEALT WITH (context only, no cards from these)',
    input.recent_structured || '(nothing yet)',
    '',
    'NEW SEGMENTS',
    ...cardTurns(input).map(
      turn => `[${turn.id}] ${turn.speaker}: ${turn.text}`
    )
  )
  if (input.live) lines.push('', LIVE_RULES)
  return lines.join('\n')
}

const replySchema = z.object({
  segments: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      header: z.string(),
      topic: z.string(),
      cards: z.array(
        z.object({
          kind: z.string(),
          text: z.string(),
          owner: z.string().nullish(),
          due_text: z.string().nullish(),
        })
      ),
    })
  ),
})

const STOP_WORDS = new Set(['with', 'from', 'that', 'this', 'about', 'issue'])

/** The words of a title that say what it is about. */
const keyWords = (title: string) =>
  title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length >= 4 && !STOP_WORDS.has(word))

/**
 * Whether two titles name the same topic: equal ignoring case, or sharing a
 * word that carries meaning ("Office aircon" and "Aircon repair"). A small
 * model rarely repeats a title letter for letter, and one topic too few is
 * better on the map than two that say the same thing.
 */
function sameTopic(a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true
  const words = new Set(keyWords(a))
  return keyWords(b).some(word => words.has(word))
}

/** Turns a `{ segments: [...] }` reply into `{ ops: [...] }` for the engine. */
export function cardsToOps(
  reply: unknown,
  input: StructurerInput
): { ops: Record<string, unknown>[] } {
  const parsed = replySchema.safeParse(reply)
  if (!parsed.success) return { ops: [] }

  const headerIds = new Set(input.agenda.map(header => header.id))
  /** The lines each turn covers; a card cites all of them. */
  const covers = new Map(cardTurns(input).map(turn => [turn.id, turn.covers]))
  /** Topics this reply adds: where they go, and the op that adds them. */
  const added: {
    key: string
    header: string
    title: string
    op: { segment_ids: string[] } & Record<string, unknown>
  }[] = []
  const ops: Record<string, unknown>[] = []

  for (const segment of parsed.data.segments) {
    // A recap, the agenda and small talk give no cards, whatever was written.
    if (segment.type !== 'new' || segment.cards.length === 0) continue

    const cited = covers.get(segment.id) ?? [segment.id]
    const header = headerIds.has(segment.header) ? segment.header : OFF_AGENDA
    const offAgenda = header === OFF_AGENDA
    const title = segment.topic.trim() || FALLBACK_TITLE

    const existing = input.outline.find(
      topic =>
        (offAgenda ? topic.off_agenda : topic.parent_id === header) &&
        sameTopic(topic.title, title)
    )
    let topicRef = existing?.id
    if (!topicRef) {
      let fresh = added.find(
        topic => topic.header === header && sameTopic(topic.title, title)
      )
      if (!fresh) {
        const key = `n${added.length + 1}`
        fresh = {
          key,
          header,
          title,
          op: {
            op: 'add_topic',
            tmp_key: key,
            title,
            parent_id: offAgenda ? null : header,
            off_agenda: offAgenda,
            segment_ids: [],
          },
        }
        added.push(fresh)
        // The topic goes in just ahead of its first card.
        ops.push(fresh.op)
      }
      for (const id of cited) {
        if (!fresh.op.segment_ids.includes(id)) fresh.op.segment_ids.push(id)
      }
      topicRef = fresh.key
    }

    for (const card of segment.cards) {
      ops.push({
        op: 'add_card',
        topic_id: topicRef,
        kind: card.kind,
        text: card.text,
        owner: card.owner ?? null,
        due_text: card.due_text ?? null,
        segment_ids: [...cited],
      })
    }
  }
  return { ops }
}
