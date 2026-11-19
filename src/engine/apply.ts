import { z } from 'zod'
import {
  cardsIn,
  hasAgenda,
  topicsUnder,
  unplannedHeader,
  type Card,
  type LogEntry,
  type MapState,
  type Suggestion,
  type SuggestionPayload,
  type Topic,
} from './model'
import { matchOwner } from './owner'
import type { MapStore } from './store'
import { wordOverlap } from './turns'

// The structurer's output and the rules for applying it,
// docs/ARCHITECTURE.md §3.2. Everything the model returns is a request: the
// engine checks each op against this schema and these rules, applies what
// passes and drops the rest. Nothing here deletes, renames or moves.

const text = z.string().trim().min(1)
const optionalText = z
  .string()
  .nullish()
  .transform(value => value?.trim() || undefined)
const segmentIds = z.array(z.string())

const addCard = z.object({
  op: z.literal('add_card'),
  topic_id: optionalText,
  tmp_topic: optionalText,
  // Research and quote cards come from jobs and highlights, not from here.
  kind: z.enum(['note', 'decision', 'action']),
  text,
  owner: optionalText,
  due_text: optionalText,
  segment_ids: segmentIds,
})

const addTopic = z.object({
  op: z.literal('add_topic'),
  tmp_key: text,
  title: text,
  parent_id: optionalText,
  off_agenda: z.boolean().nullish().transform(Boolean),
  segment_ids: segmentIds.nullish().transform(ids => ids ?? []),
})

const suggestMove = z.object({
  op: z.literal('suggest_move'),
  card_id: text,
  to_topic_id: text,
  reason: optionalText,
})

const suggestMerge = z.object({
  op: z.literal('suggest_merge'),
  topic_id: text,
  into_topic_id: text,
  reason: optionalText,
})

const suggestPin = z.object({
  op: z.literal('suggest_pin'),
  tmp_key_or_topic_id: text,
  title: text,
  reason: optionalText,
})

export const structurerOpSchema = z.discriminatedUnion('op', [
  addCard,
  addTopic,
  suggestMove,
  suggestMerge,
  suggestPin,
])
export type StructurerOp = z.infer<typeof structurerOpSchema>

/** The whole reply: `{ ops: [...] }`. A bare array is accepted too. */
export const structurerOutputSchema = z.object({ ops: z.array(z.unknown()) })

export type DropReason =
  | 'not_in_schema'
  | 'no_segments'
  | 'unknown_topic'
  | 'unknown_card'
  | 'duplicate'
  | 'same_place'
  | 'repeat'
  | 'already_pinned'

export interface DroppedOp {
  /** Position in the batch. */
  index: number
  /** The op's name as the model gave it, e.g. `delete_card`. */
  op: string
  reason: DropReason
}

export interface ApplyContext {
  /** Meeting clock, for rows that cite no segment. */
  tMs: number
  /** Every segment heard so far. An op may cite these and no others. */
  segments: ReadonlyMap<string, { t0_ms: number }>
  /** Told about each dropped op. Never given transcript or card text. */
  log?: (message: string, context: Record<string, unknown>) => void
}

export interface ApplyResult {
  applied: LogEntry[]
  dropped: DroppedOp[]
}

/** The title a card gets a home under when the model names a header only. */
export const GENERAL_TITLE = 'General'
const DEFAULT_PIN_REASON = 'Not on the agenda'

const sameTitle = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

/** Two cards in one topic sharing this share of their words are one card. */
const SAME_TEXT = 0.75

const nextOrder = (rows: readonly { order_key: number }[]) =>
  rows.reduce((max, row) => Math.max(max, row.order_key), -1) + 1

function opName(raw: unknown): string {
  const name = (raw as { op?: unknown } | null)?.op
  return typeof name === 'string' ? name.slice(0, 40) : 'unknown'
}

export function applyOps(
  store: MapStore,
  raw: unknown,
  context: ApplyContext
): ApplyResult {
  const applied: LogEntry[] = []
  const dropped: DroppedOp[] = []
  // `tmp_key` → topic id, for this batch only.
  const tmpKeys = new Map<string, string>()
  const createdOffAgenda: Topic[] = []

  const list: unknown[] = Array.isArray(raw)
    ? raw
    : (structurerOutputSchema.safeParse(raw).data?.ops ?? [])

  const meetingId = store.getState().meeting.id
  const state = (): MapState => store.getState()
  const known = (ids: readonly string[]) => [
    ...new Set(ids.filter(id => context.segments.has(id))),
  ]
  const startOf = (ids: readonly string[]) =>
    ids.reduce(
      (earliest, id) =>
        Math.min(earliest, context.segments.get(id)?.t0_ms ?? earliest),
      ids.length > 0 ? Infinity : context.tMs
    )
  const topicFor = (ref: string | undefined): Topic | undefined => {
    if (!ref) return undefined
    const byId = state().topics[tmpKeys.get(ref) ?? ref]
    if (byId) return byId
    // A small model sometimes writes the title where an id belongs. Take it
    // when exactly one topic or header has that title.
    const named = Object.values(state().topics).filter(topic =>
      sameTitle(topic.title, ref)
    )
    return named.length === 1 ? named[0] : undefined
  }

  function addTopicRow(
    header: Topic,
    title: string,
    cited: readonly string[]
  ): Topic {
    const topic: Topic = {
      id: store.ids('t'),
      meeting_id: meetingId,
      parent_id: header.id,
      title,
      kind: 'topic',
      order_key: nextOrder(topicsUnder(state(), header.id)),
      status: 'active',
      off_agenda: header.off_agenda,
      created_t_ms: startOf(cited),
      pinned_t_ms: null,
      revisited_t_ms: null,
      scheduled_t_ms: null,
      segment_ids: cited,
    }
    const entry = store.commit(
      'add_topic',
      'engine',
      [{ entity: 'topic', id: topic.id, before: null, after: topic }],
      context.tMs
    )
    if (entry) applied.push(entry)
    if (topic.off_agenda) createdOffAgenda.push(topic)
    return topic
  }

  function addSuggestion(payload: SuggestionPayload): void {
    const suggestion: Suggestion = {
      id: store.ids('g'),
      meeting_id: meetingId,
      kind: payload.kind,
      payload,
      status: 'open',
      created_t_ms: context.tMs,
    }
    const entry = store.commit(
      'add_suggestion',
      'engine',
      [
        {
          entity: 'suggestion',
          id: suggestion.id,
          before: null,
          after: suggestion,
        },
      ],
      context.tMs
    )
    if (entry) applied.push(entry)
  }

  /** Any suggestion, open or answered: a dismissed one is not raised again. */
  const alreadySuggested = (match: (payload: SuggestionPayload) => boolean) =>
    Object.values(state().suggestions).some(suggestion =>
      match(suggestion.payload)
    )

  function apply(op: StructurerOp): DropReason | null {
    switch (op.op) {
      case 'add_topic': {
        const cited = known(op.segment_ids)
        const parent = op.off_agenda ? undefined : topicFor(op.parent_id)
        const named =
          parent?.kind === 'topic'
            ? state().topics[parent.parent_id ?? '']
            : parent
        // No header fits, or none was named: that is what off-agenda means.
        const header = named ?? unplannedHeader(state())
        if (!header) return 'unknown_topic'

        const existing = topicsUnder(state(), header.id).find(topic =>
          sameTitle(topic.title, op.title)
        )
        if (existing) {
          tmpKeys.set(op.tmp_key, existing.id)
          return 'duplicate'
        }
        tmpKeys.set(op.tmp_key, addTopicRow(header, op.title, cited).id)
        return null
      }

      case 'add_card': {
        const cited = known(op.segment_ids)
        if (cited.length === 0) return 'no_segments'

        let topic = topicFor(op.tmp_topic) ?? topicFor(op.topic_id)
        if (topic?.kind === 'header') {
          // Cards live in topics. One aimed at a header goes under "General".
          if (topic.off_agenda) return 'unknown_topic'
          const header = topic
          topic =
            topicsUnder(state(), header.id).find(candidate =>
              sameTitle(candidate.title, GENERAL_TITLE)
            ) ?? addTopicRow(header, GENERAL_TITLE, [])
        }
        if (!topic) return 'unknown_topic'

        const isAction = op.kind === 'action'
        const owner = isAction
          ? matchOwner(op.owner, state().meeting.participants)
          : null

        const topicId = topic.id
        const duplicate = Object.values(state().cards).some(
          card =>
            card.status !== 'dismissed' &&
            card.kind === op.kind &&
            // Two people can each owe something from the same sentence.
            (!isAction || card.owner === owner) &&
            (cited.every(id => card.segment_ids.includes(id)) ||
              // People say a thing twice, and a small model notes it twice.
              (card.topic_id === topicId &&
                wordOverlap(card.text, op.text) >= SAME_TEXT))
        )
        if (duplicate) return 'duplicate'

        const card: Card = {
          id: store.ids('c'),
          meeting_id: meetingId,
          topic_id: topic.id,
          kind: op.kind,
          text: op.text,
          owner,
          due_text: isAction ? (op.due_text ?? null) : null,
          segment_ids: cited,
          status: 'accepted',
          source: 'engine',
          created_t_ms: startOf(cited),
          confirmed: false,
          done_at_ms: null,
          order_key: nextOrder(cardsIn(state(), topic.id)),
        }
        const entry = store.commit(
          'add_card',
          'engine',
          [{ entity: 'card', id: card.id, before: null, after: card }],
          context.tMs
        )
        if (entry) applied.push(entry)
        return null
      }

      case 'suggest_move': {
        const card = state().cards[op.card_id]
        if (!card || card.status === 'dismissed') return 'unknown_card'
        const to = topicFor(op.to_topic_id)
        if (to?.kind !== 'topic') return 'unknown_topic'
        if (card.topic_id === to.id) return 'same_place'
        const repeat = alreadySuggested(
          payload =>
            payload.kind === 'move' &&
            payload.card_id === card.id &&
            payload.to_topic_id === to.id
        )
        if (repeat) return 'repeat'
        addSuggestion({
          kind: 'move',
          card_id: card.id,
          to_topic_id: to.id,
          reason: op.reason ?? '',
        })
        return null
      }

      case 'suggest_merge': {
        const from = topicFor(op.topic_id)
        const into = topicFor(op.into_topic_id)
        if (from?.kind !== 'topic' || into?.kind !== 'topic') {
          return 'unknown_topic'
        }
        if (from.id === into.id) return 'same_place'
        const repeat = alreadySuggested(
          payload =>
            payload.kind === 'merge' &&
            payload.topic_id === from.id &&
            payload.into_topic_id === into.id
        )
        if (repeat) return 'repeat'
        addSuggestion({
          kind: 'merge',
          topic_id: from.id,
          into_topic_id: into.id,
          reason: op.reason ?? '',
        })
        return null
      }

      case 'suggest_pin': {
        const topic = topicFor(op.tmp_key_or_topic_id)
        if (topic?.kind !== 'topic') return 'unknown_topic'
        if (topic.status === 'pinned') return 'already_pinned'
        const repeat = alreadySuggested(
          payload => payload.kind === 'pin' && payload.topic_id === topic.id
        )
        if (repeat) return 'repeat'
        addSuggestion({
          kind: 'pin',
          topic_id: topic.id,
          title: op.title,
          reason: op.reason ?? DEFAULT_PIN_REASON,
        })
        return null
      }
    }
  }

  list.forEach((rawOp, index) => {
    const parsed = structurerOpSchema.safeParse(rawOp)
    const reason = parsed.success ? apply(parsed.data) : 'not_in_schema'
    if (reason === null) return
    const drop: DroppedOp = { index, op: opName(rawOp), reason }
    dropped.push(drop)
    context.log?.('structurer op dropped', { ...drop })
  })

  // An off-agenda topic always comes with a pin suggestion (ARCHITECTURE
  // §3.2). The model's own, if it sent one, was applied above and wins.
  // A meeting with no agenda has nothing to be off: every topic would ask to
  // be pinned, so none does.
  for (const topic of hasAgenda(state()) ? createdOffAgenda : []) {
    const suggested = alreadySuggested(
      payload => payload.kind === 'pin' && payload.topic_id === topic.id
    )
    if (!suggested) {
      addSuggestion({
        kind: 'pin',
        topic_id: topic.id,
        title: topic.title,
        reason: DEFAULT_PIN_REASON,
      })
    }
  }

  return { applied, dropped }
}
