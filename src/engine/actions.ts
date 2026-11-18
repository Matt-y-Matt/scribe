import {
  cardsIn,
  openSuggestions,
  topicsUnder,
  type Card,
  type CardKind,
  type Change,
  type LogEntry,
  type Source,
  type Suggestion,
  type Topic,
} from './model'
import type { MapStore } from './store'

// What a person (or the scribe, on a person's word) does to the map. The UI,
// the keyboard and voice all go through these, so every one of them is a
// single undoable operation. The structurer never calls anything here: it can
// only add (apply.ts).

const topicChange = (
  topic: Topic,
  after: Partial<Topic>
): Extract<Change, { entity: 'topic' }> => ({
  entity: 'topic',
  id: topic.id,
  before: Object.fromEntries(
    Object.keys(after).map(key => [key, topic[key as keyof Topic]])
  ),
  after,
})

const cardChange = (
  card: Card,
  after: Partial<Card>
): Extract<Change, { entity: 'card' }> => ({
  entity: 'card',
  id: card.id,
  before: Object.fromEntries(
    Object.keys(after).map(key => [key, card[key as keyof Card]])
  ),
  after,
})

const answer = (
  suggestion: Suggestion,
  status: Suggestion['status']
): Change => ({
  entity: 'suggestion',
  id: suggestion.id,
  before: { status: suggestion.status },
  after: { status },
})

const nextOrder = (rows: readonly { order_key: number }[]) =>
  rows.reduce((max, row) => Math.max(max, row.order_key), -1) + 1

/** Open suggestions that stop making sense once `topicId` is gone. */
function orphanedBy(store: MapStore, topicId: string, cardIds: Set<string>) {
  return openSuggestions(store.getState())
    .filter(({ payload }) => {
      switch (payload.kind) {
        case 'move':
          return payload.to_topic_id === topicId || cardIds.has(payload.card_id)
        case 'merge':
          return (
            payload.topic_id === topicId || payload.into_topic_id === topicId
          )
        case 'pin':
          return payload.topic_id === topicId
      }
    })
    .map(suggestion => answer(suggestion, 'dismissed'))
}

/** Moving a card to the end of `to`, or before `beforeCardId` in it. */
function moveChanges(
  store: MapStore,
  card: Card,
  to: Topic,
  beforeCardId?: string
): Change[] {
  const siblings = cardsIn(store.getState(), to.id).filter(
    sibling => sibling.id !== card.id
  )
  const at = siblings.findIndex(sibling => sibling.id === beforeCardId)
  if (at === -1) {
    const order = nextOrder(siblings)
    // Already the last card of this topic: nothing to do.
    return card.topic_id === to.id && card.order_key >= order
      ? []
      : [cardChange(card, { topic_id: to.id, order_key: order })]
  }
  const next = siblings[at] as Card
  const previous = siblings[at - 1]
  const order = previous
    ? (previous.order_key + next.order_key) / 2
    : next.order_key - 1
  return [cardChange(card, { topic_id: to.id, order_key: order })]
}

function mergeChanges(store: MapStore, from: Topic, into: Topic): Change[] {
  const state = store.getState()
  const moving = cardsIn(state, from.id)
  let order = nextOrder(cardsIn(state, into.id))
  const hidden = Object.values(state.cards).filter(
    card => card.topic_id === from.id && card.status === 'dismissed'
  )
  return [
    ...[...moving, ...hidden].map(card =>
      cardChange(card, { topic_id: into.id, order_key: order++ })
    ),
    // The merged topic's own citations move with its cards.
    topicChange(into, {
      segment_ids: [...new Set([...into.segment_ids, ...from.segment_ids])],
    }),
    ...orphanedBy(store, from.id, new Set()),
    { entity: 'topic', id: from.id, before: from, after: null },
  ]
}

function pinChanges(store: MapStore, topic: Topic): Change[] {
  return [
    topicChange(topic, { status: 'pinned', pinned_t_ms: store.now }),
    ...openSuggestions(store.getState())
      .filter(
        ({ payload }) => payload.kind === 'pin' && payload.topic_id === topic.id
      )
      .map(suggestion => answer(suggestion, 'accepted')),
  ]
}

/**
 * Accepts a ghost: the move, merge or pin it proposes happens now. A ghost
 * whose card or topic has gone since is dismissed instead.
 */
export function acceptSuggestion(
  store: MapStore,
  suggestionId: string,
  source: Source = 'user'
): LogEntry | null {
  const state = store.getState()
  const suggestion = state.suggestions[suggestionId]
  if (suggestion?.status !== 'open') return null
  const { payload } = suggestion
  const accepted = answer(suggestion, 'accepted')
  const stale = () =>
    store.commit('dismiss_suggestion', source, [
      answer(suggestion, 'dismissed'),
    ])

  switch (payload.kind) {
    case 'move': {
      const card = state.cards[payload.card_id]
      const to = state.topics[payload.to_topic_id]
      if (!card || !to) return stale()
      return store.commit('accept_suggestion', source, [
        ...moveChanges(store, card, to),
        accepted,
      ])
    }
    case 'merge': {
      const from = state.topics[payload.topic_id]
      const into = state.topics[payload.into_topic_id]
      if (!from || !into) return stale()
      return store.commit('accept_suggestion', source, [
        accepted,
        ...mergeChanges(store, from, into).filter(
          change => change.id !== suggestion.id
        ),
      ])
    }
    case 'pin': {
      const topic = state.topics[payload.topic_id]
      if (!topic) return stale()
      return store.commit('accept_suggestion', source, pinChanges(store, topic))
    }
  }
}

/** Dismisses a ghost. The engine will not raise the same one again. */
export function dismissSuggestion(
  store: MapStore,
  suggestionId: string,
  source: Source = 'user'
): LogEntry | null {
  const suggestion = store.getState().suggestions[suggestionId]
  if (suggestion?.status !== 'open') return null
  return store.commit('dismiss_suggestion', source, [
    answer(suggestion, 'dismissed'),
  ])
}

export function moveCard(
  store: MapStore,
  cardId: string,
  toTopicId: string,
  beforeCardId?: string,
  source: Source = 'user'
): LogEntry | null {
  const state = store.getState()
  const card = state.cards[cardId]
  const to = state.topics[toTopicId]
  if (!card || to?.kind !== 'topic' || beforeCardId === cardId) return null
  return store.commit(
    'move_card',
    source,
    moveChanges(store, card, to, beforeCardId)
  )
}

export interface CardEdit {
  text?: string
  kind?: CardKind
  owner?: string | null
  due_text?: string | null
}

export function editCard(
  store: MapStore,
  cardId: string,
  edit: CardEdit,
  source: Source = 'user'
): LogEntry | null {
  const card = store.getState().cards[cardId]
  if (!card) return null
  const after = Object.fromEntries(
    Object.entries(edit).filter(
      ([key, value]) => value !== undefined && card[key as keyof Card] !== value
    )
  ) as Partial<Card>
  if (Object.keys(after).length === 0) return null
  return store.commit('edit_card', source, [cardChange(card, after)])
}

export interface NewCard {
  kind: CardKind
  text: string
  owner?: string | null
  due_text?: string | null
  segment_ids?: readonly string[]
  /**
   * Where in the meeting the card points: a quote made from a highlight
   * links to the highlight, not to the moment it was marked. Default: now.
   */
  t_ms?: number
}

/** A card someone adds by hand. It needs no segment: a person vouches for it. */
export function addCard(
  store: MapStore,
  topicId: string,
  card: NewCard,
  source: Exclude<Source, 'engine'> = 'user'
): Card | null {
  const state = store.getState()
  const topic = state.topics[topicId]
  if (topic?.kind !== 'topic' || card.text.trim() === '') return null
  const row: Card = {
    id: store.ids('c'),
    meeting_id: state.meeting.id,
    topic_id: topic.id,
    kind: card.kind,
    text: card.text.trim(),
    owner: card.owner ?? null,
    due_text: card.due_text ?? null,
    segment_ids: card.segment_ids ?? [],
    status: 'accepted',
    source,
    created_t_ms: card.t_ms ?? store.now,
    confirmed: false,
    order_key: nextOrder(cardsIn(state, topic.id)),
  }
  store.commit('add_card', source, [
    { entity: 'card', id: row.id, before: null, after: row },
  ])
  return row
}

export function deleteCard(
  store: MapStore,
  cardId: string,
  source: Source = 'user'
): LogEntry | null {
  const card = store.getState().cards[cardId]
  if (!card) return null
  const orphans = openSuggestions(store.getState())
    .filter(
      ({ payload }) => payload.kind === 'move' && payload.card_id === card.id
    )
    .map(suggestion => answer(suggestion, 'dismissed'))
  return store.commit('delete_card', source, [
    ...orphans,
    { entity: 'card', id: card.id, before: card, after: null },
  ])
}

export function addTopic(
  store: MapStore,
  headerId: string,
  title: string,
  source: Exclude<Source, 'engine'> = 'user'
): Topic | null {
  const state = store.getState()
  const header = state.topics[headerId]
  if (header?.kind !== 'header' || title.trim() === '') return null
  const row: Topic = {
    id: store.ids('t'),
    meeting_id: state.meeting.id,
    parent_id: header.id,
    title: title.trim(),
    kind: 'topic',
    order_key: nextOrder(topicsUnder(state, header.id)),
    status: 'active',
    off_agenda: header.off_agenda,
    created_t_ms: store.now,
    pinned_t_ms: null,
    revisited_t_ms: null,
    scheduled_t_ms: null,
    segment_ids: [],
  }
  store.commit('add_topic', source, [
    { entity: 'topic', id: row.id, before: null, after: row },
  ])
  return row
}

export function renameTopic(
  store: MapStore,
  topicId: string,
  title: string,
  source: Source = 'user'
): LogEntry | null {
  const topic = store.getState().topics[topicId]
  const next = title.trim()
  if (!topic || next === '' || next === topic.title) return null
  return store.commit('rename_topic', source, [
    topicChange(topic, { title: next }),
  ])
}

/** Drops a topic on another header: it goes to the end of that column. */
export function moveTopic(
  store: MapStore,
  topicId: string,
  headerId: string,
  source: Source = 'user'
): LogEntry | null {
  const state = store.getState()
  const topic = state.topics[topicId]
  const header = state.topics[headerId]
  if (topic?.kind !== 'topic' || header?.kind !== 'header') return null
  if (topic.parent_id === header.id) return null
  return store.commit('move_topic', source, [
    topicChange(topic, {
      parent_id: header.id,
      off_agenda: header.off_agenda,
      order_key: nextOrder(topicsUnder(state, header.id)),
    }),
  ])
}

/** Moves every card of `topicId` into `intoTopicId` and removes the topic. */
export function mergeTopic(
  store: MapStore,
  topicId: string,
  intoTopicId: string,
  source: Source = 'user'
): LogEntry | null {
  const state = store.getState()
  const from = state.topics[topicId]
  const into = state.topics[intoTopicId]
  if (from?.kind !== 'topic' || into?.kind !== 'topic' || from === into) {
    return null
  }
  return store.commit('merge_topic', source, mergeChanges(store, from, into))
}

/** Removes a topic and its cards. Undo brings all of them back. */
export function deleteTopic(
  store: MapStore,
  topicId: string,
  source: Source = 'user'
): LogEntry | null {
  const state = store.getState()
  const topic = state.topics[topicId]
  if (topic?.kind !== 'topic') return null
  const cards = Object.values(state.cards).filter(
    card => card.topic_id === topic.id
  )
  return store.commit('delete_topic', source, [
    ...orphanedBy(store, topic.id, new Set(cards.map(card => card.id))),
    ...cards.map((card): Change => ({
      entity: 'card',
      id: card.id,
      before: card,
      after: null,
    })),
    { entity: 'topic', id: topic.id, before: topic, after: null },
  ])
}

/** Parks a topic in the Pins rail, answering its pin suggestion if it has one. */
export function pinTopic(
  store: MapStore,
  topicId: string,
  source: Source = 'user'
): LogEntry | null {
  const topic = store.getState().topics[topicId]
  if (topic?.kind !== 'topic' || topic.status === 'pinned') return null
  return store.commit('pin_topic', source, pinChanges(store, topic))
}

/** Takes a topic back out of the Pins rail. */
export function unpinTopic(
  store: MapStore,
  topicId: string,
  source: Source = 'user'
): LogEntry | null {
  const topic = store.getState().topics[topicId]
  if (topic?.status !== 'pinned') return null
  return store.commit('unpin_topic', source, [
    topicChange(topic, {
      status: 'active',
      pinned_t_ms: null,
      revisited_t_ms: null,
    }),
  ])
}

/** "Revisit now": the pinned topic is back on the table, and the time kept. */
export function revisitTopic(
  store: MapStore,
  topicId: string,
  source: Source = 'user'
): LogEntry | null {
  const topic = store.getState().topics[topicId]
  if (topic?.status !== 'pinned') return null
  return store.commit('revisit_topic', source, [
    topicChange(topic, { revisited_t_ms: store.now }),
  ])
}

/** "Schedule": puts the pinned topic on the end screen's schedule list. */
export function scheduleTopic(
  store: MapStore,
  topicId: string,
  source: Source = 'user'
): LogEntry | null {
  const topic = store.getState().topics[topicId]
  if (topic?.status !== 'pinned' || topic.scheduled_t_ms !== null) return null
  return store.commit('schedule_topic', source, [
    topicChange(topic, { scheduled_t_ms: store.now }),
  ])
}
