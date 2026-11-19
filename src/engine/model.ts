// The map's data model, docs/ARCHITECTURE.md §3.1. These shapes are also the
// SQLite rows M2 will store, so fields keep their column names. Two columns are
// added to `topics`: `segment_ids` (an `add_topic` op cites segments, and the
// golden test counts them) and `scheduled_t_ms` (the Pins rail's Schedule).
// Until M2 has a participants table, `owner` is a participant's name.

export const CARD_KINDS = [
  'note',
  'decision',
  'action',
  'research',
  'quote',
] as const
export type CardKind = (typeof CARD_KINDS)[number]

/** Who made a change. Only `user` and `scribe` changes can be undone. */
export type Source = 'engine' | 'user' | 'scribe'

export interface Topic {
  id: string
  meeting_id: string
  /** A header has no parent; a topic's parent is its header. */
  parent_id: string | null
  title: string
  kind: 'header' | 'topic'
  /** Sort position among siblings, ascending. */
  order_key: number
  status: 'active' | 'pinned' | 'done'
  off_agenda: boolean
  created_t_ms: number
  pinned_t_ms: number | null
  revisited_t_ms: number | null
  scheduled_t_ms: number | null
  segment_ids: readonly string[]
}

export interface Card {
  id: string
  meeting_id: string
  topic_id: string
  kind: CardKind
  text: string
  /** A participant's name, or null when nobody was named. */
  owner: string | null
  due_text: string | null
  segment_ids: readonly string[]
  status: 'proposed' | 'accepted' | 'dismissed'
  source: Source
  /** Start of the first cited segment: where a click on the card seeks to. */
  created_t_ms: number
  /** Set on the end screen (M5), never by the engine. */
  confirmed: boolean
  /**
   * When an action was marked done, on the wall clock (milliseconds since
   * 1970); null while it is open. Open actions carry over to later meetings.
   */
  done_at_ms: number | null
  /** Sort position inside the topic, ascending. */
  order_key: number
}

export type SuggestionPayload =
  | { kind: 'move'; card_id: string; to_topic_id: string; reason: string }
  | { kind: 'merge'; topic_id: string; into_topic_id: string; reason: string }
  | { kind: 'pin'; topic_id: string; title: string; reason: string }

export interface Suggestion {
  id: string
  meeting_id: string
  kind: SuggestionPayload['kind']
  payload: SuggestionPayload
  status: 'open' | 'accepted' | 'dismissed'
  created_t_ms: number
}

export interface Meeting {
  id: string
  title: string
  mode: 'group' | 'solo'
  participants: readonly string[]
}

/** One immutable snapshot of a meeting's map. */
export interface MapState {
  meeting: Meeting
  topics: Readonly<Record<string, Topic>>
  cards: Readonly<Record<string, Card>>
  suggestions: Readonly<Record<string, Suggestion>>
}

export interface EntityMap {
  topic: Topic
  card: Card
  suggestion: Suggestion
}
export type EntityName = keyof EntityMap

/**
 * One row-level change. `before: null` creates the row and `after: null`
 * removes it; otherwise both hold only the fields that changed, so undoing one
 * change cannot overwrite a later change to another field of the same row.
 */
export type Change = {
  [E in EntityName]: {
    entity: E
    id: string
    before: Partial<EntityMap[E]> | null
    after: Partial<EntityMap[E]> | null
  }
}[EntityName]

/** Every operation the map accepts. The engine may use the first three only. */
export const OP_TYPES = [
  'add_topic',
  'add_card',
  'add_suggestion',
  'accept_suggestion',
  'dismiss_suggestion',
  'move_card',
  'edit_card',
  'delete_card',
  'move_topic',
  'rename_topic',
  'merge_topic',
  'delete_topic',
  'pin_topic',
  'unpin_topic',
  'revisit_topic',
  'schedule_topic',
  'clear_notes',
] as const
export type OpType = (typeof OP_TYPES)[number]

/** The op types that only add to the map (rule 1: the map only grows). */
export const ADDITIVE_OPS: readonly OpType[] = [
  'add_topic',
  'add_card',
  'add_suggestion',
]

export interface LogEntry {
  seq: number
  type: OpType
  source: Source
  /** Meeting clock when the change was made. */
  t_ms: number
  changes: readonly Change[]
  /** `undo` and `redo` entries point at the entry they reverse or replay. */
  replay?: { of: number; direction: 'undo' | 'redo' }
}

export const UNPLANNED_TITLE = 'Unplanned'

const byOrder = (a: { order_key: number }, b: { order_key: number }) =>
  a.order_key - b.order_key

/** Agenda headers in agenda order, then the Unplanned column. */
export function headersOf(state: MapState): Topic[] {
  return Object.values(state.topics)
    .filter(topic => topic.kind === 'header')
    .sort(byOrder)
}

export function unplannedHeader(state: MapState): Topic | undefined {
  return headersOf(state).find(header => header.off_agenda)
}

/** The meeting has an agenda, so there is such a thing as off it. */
export function hasAgenda(state: MapState): boolean {
  return headersOf(state).some(header => !header.off_agenda)
}

export function topicsUnder(state: MapState, headerId: string): Topic[] {
  return Object.values(state.topics)
    .filter(topic => topic.kind === 'topic' && topic.parent_id === headerId)
    .sort(byOrder)
}

/** A topic's visible cards, in order. Dismissed cards are kept but hidden. */
export function cardsIn(state: MapState, topicId: string): Card[] {
  return Object.values(state.cards)
    .filter(card => card.topic_id === topicId && card.status !== 'dismissed')
    .sort(byOrder)
}

export function openSuggestions(state: MapState): Suggestion[] {
  return Object.values(state.suggestions)
    .filter(suggestion => suggestion.status === 'open')
    .sort((a, b) => a.created_t_ms - b.created_t_ms || (a.id < b.id ? -1 : 1))
}

export function pinnedTopics(state: MapState): Topic[] {
  return Object.values(state.topics)
    .filter(topic => topic.status === 'pinned')
    .sort((a, b) => (a.pinned_t_ms ?? 0) - (b.pinned_t_ms ?? 0))
}

/** Every segment a topic cites, itself or through its cards. */
export function segmentsCitedBy(state: MapState, topicId: string): Set<string> {
  const cited = new Set(state.topics[topicId]?.segment_ids ?? [])
  for (const card of cardsIn(state, topicId)) {
    for (const id of card.segment_ids) cited.add(id)
  }
  return cited
}
