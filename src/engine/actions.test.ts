// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  acceptSuggestion,
  addCard,
  addHeader,
  addTopic,
  deleteCard,
  deleteTopic,
  dismissSuggestion,
  editCard,
  mergeTopic,
  moveCard,
  moveTopic,
  pinTopic,
  renameTopic,
  revisitTopic,
  scheduleTopic,
  unpinTopic,
} from './actions'
import { applyOps } from './apply'
import {
  cardsIn,
  headersOf,
  openSuggestions,
  pinnedTopics,
  topicsUnder,
  unplannedHeader,
} from './model'
import { headerNamed, testSegments, testStore } from './testing'

const context = { tMs: 60_000, segments: testSegments(20) }

/** Pricing (two notes) and Artwork (one) under CLA; Aircon under Unplanned. */
function setUp() {
  const store = testStore()
  const cla = headerNamed(store, 'CLA quote')
  const note = (tmp: string, text: string, segment: string) => ({
    op: 'add_card',
    tmp_topic: tmp,
    kind: 'note',
    text,
    segment_ids: [segment],
  })
  const topic = (key: string, title: string, offAgenda = false) => ({
    op: 'add_topic',
    tmp_key: key,
    title,
    parent_id: offAgenda ? undefined : cla.id,
    off_agenda: offAgenda,
    segment_ids: [],
  })
  applyOps(
    store,
    [
      topic('p', 'Pricing'),
      topic('a', 'Artwork'),
      topic('x', 'Office aircon', true),
      note('p', 'First', 's001'),
      note('p', 'Second', 's002'),
      note('a', 'Third', 's003'),
      note('x', 'Dead again', 's004'),
    ],
    context
  )
  const state = store.getState()
  const [pricing, artwork] = topicsUnder(state, cla.id)
  const [aircon] = topicsUnder(state, unplannedHeader(state)?.id ?? '')
  if (!pricing || !artwork || !aircon) throw new Error('set-up failed')
  const texts = (topicId: string) =>
    cardsIn(store.getState(), topicId).map(card => card.text)
  const cardNamed = (text: string) => {
    const card = Object.values(store.getState().cards).find(
      row => row.text === text
    )
    if (!card) throw new Error(`no card "${text}"`)
    return card
  }
  return { store, cla, pricing, artwork, aircon, texts, cardNamed }
}

describe('suggestions', () => {
  it('a move happens only when accepted, and undo puts it back', () => {
    const { store, pricing, artwork, texts, cardNamed } = setUp()
    applyOps(
      store,
      [
        {
          op: 'suggest_move',
          card_id: cardNamed('Second').id,
          to_topic_id: artwork.id,
        },
      ],
      context
    )
    const ghost = openSuggestions(store.getState()).find(s => s.kind === 'move')
    expect(texts(pricing.id)).toEqual(['First', 'Second'])

    acceptSuggestion(store, ghost?.id ?? '')
    expect(texts(pricing.id)).toEqual(['First'])
    expect(texts(artwork.id)).toEqual(['Third', 'Second'])
    expect(store.getState().suggestions[ghost?.id ?? '']?.status).toBe(
      'accepted'
    )
    expect(store.log.at(-1)).toMatchObject({
      type: 'accept_suggestion',
      source: 'user',
    })

    store.undo()
    expect(texts(pricing.id)).toEqual(['First', 'Second'])
    expect(texts(artwork.id)).toEqual(['Third'])
    expect(store.getState().suggestions[ghost?.id ?? '']?.status).toBe('open')
  })

  it('a dismissed ghost is gone, and can be answered only once', () => {
    const { store, aircon } = setUp()
    const [ghost] = openSuggestions(store.getState())
    expect(ghost?.payload).toMatchObject({ kind: 'pin', topic_id: aircon.id })

    expect(dismissSuggestion(store, ghost?.id ?? '')).not.toBeNull()
    expect(openSuggestions(store.getState())).toEqual([])
    expect(store.getState().topics[aircon.id]?.status).toBe('active')
    expect(dismissSuggestion(store, ghost?.id ?? '')).toBeNull()
    expect(acceptSuggestion(store, ghost?.id ?? '')).toBeNull()
  })

  it('accepting a pin parks the topic at the meeting clock', () => {
    const { store, aircon } = setUp()
    const [ghost] = openSuggestions(store.getState())
    store.tick(196_000)
    acceptSuggestion(store, ghost?.id ?? '')
    expect(pinnedTopics(store.getState())).toMatchObject([
      { id: aircon.id, status: 'pinned', pinned_t_ms: 196_000 },
    ])
    expect(openSuggestions(store.getState())).toEqual([])
  })

  it('accepting a merge moves the cards and removes the topic', () => {
    const { store, cla, pricing, artwork, texts } = setUp()
    applyOps(
      store,
      [
        {
          op: 'suggest_merge',
          topic_id: artwork.id,
          into_topic_id: pricing.id,
        },
        {
          op: 'suggest_move',
          card_id: cardsIn(store.getState(), pricing.id)[0]?.id,
          to_topic_id: artwork.id,
        },
      ],
      context
    )
    const merge = openSuggestions(store.getState()).find(
      s => s.kind === 'merge'
    )
    const before = store.getState()

    acceptSuggestion(store, merge?.id ?? '')
    expect(topicsUnder(store.getState(), cla.id).map(t => t.title)).toEqual([
      'Pricing',
    ])
    expect(texts(pricing.id)).toEqual(['First', 'Second', 'Third'])
    // The move into the merged topic has nowhere to go any more.
    expect(openSuggestions(store.getState()).map(s => s.kind)).toEqual(['pin'])

    store.undo()
    expect(store.getState()).toEqual(before)
  })

  it('dismisses a ghost whose card has gone instead of acting on it', () => {
    const { store, artwork, cardNamed } = setUp()
    const second = cardNamed('Second')
    applyOps(
      store,
      [{ op: 'suggest_move', card_id: second.id, to_topic_id: artwork.id }],
      context
    )
    const ghost = openSuggestions(store.getState()).find(s => s.kind === 'move')
    deleteTopic(store, artwork.id)
    expect(store.getState().suggestions[ghost?.id ?? '']?.status).toBe(
      'dismissed'
    )
  })
})

describe('cards', () => {
  it('move to the end of another topic, or before a card in it', () => {
    const { store, pricing, artwork, texts, cardNamed } = setUp()
    moveCard(store, cardNamed('First').id, artwork.id)
    expect(texts(artwork.id)).toEqual(['Third', 'First'])

    moveCard(store, cardNamed('Second').id, artwork.id, cardNamed('First').id)
    expect(texts(artwork.id)).toEqual(['Third', 'Second', 'First'])

    moveCard(store, cardNamed('First').id, artwork.id, cardNamed('Third').id)
    expect(texts(artwork.id)).toEqual(['First', 'Third', 'Second'])
    expect(texts(pricing.id)).toEqual([])

    store.undo()
    store.undo()
    store.undo()
    expect(texts(pricing.id)).toEqual(['First', 'Second'])
    expect(texts(artwork.id)).toEqual(['Third'])
  })

  it('ignore a move that changes nothing or points nowhere', () => {
    const { store, pricing, cla, cardNamed } = setUp()
    const second = cardNamed('Second')
    expect(moveCard(store, second.id, pricing.id)).toBeNull()
    expect(moveCard(store, second.id, pricing.id, second.id)).toBeNull()
    expect(moveCard(store, second.id, cla.id)).toBeNull()
    expect(moveCard(store, 'c_9999', pricing.id)).toBeNull()
    expect(store.canUndo).toBe(false)
  })

  it('can be edited, added by hand and deleted, each with undo', () => {
    const { store, pricing, texts, cardNamed } = setUp()
    const first = cardNamed('First')

    editCard(store, first.id, { kind: 'action', owner: 'Kabs', text: 'First' })
    expect(store.getState().cards[first.id]).toMatchObject({
      kind: 'action',
      owner: 'Kabs',
    })
    expect(editCard(store, first.id, { kind: 'action' })).toBeNull()

    store.tick(90_000)
    const added = addCard(store, pricing.id, { kind: 'note', text: ' Mine ' })
    expect(added).toMatchObject({
      text: 'Mine',
      source: 'user',
      created_t_ms: 90_000,
      segment_ids: [],
    })
    expect(addCard(store, pricing.id, { kind: 'note', text: '  ' })).toBeNull()

    deleteCard(store, first.id)
    expect(texts(pricing.id)).toEqual(['Second', 'Mine'])

    store.undo()
    store.undo()
    store.undo()
    expect(texts(pricing.id)).toEqual(['First', 'Second'])
    expect(store.getState().cards[first.id]).toEqual(first)
  })
})

describe('headers', () => {
  it('adds one at the end of the agenda, with Unplanned still last', () => {
    const { store } = setUp()
    const before = headersOf(store.getState()).map(header => header.title)

    store.tick(125_000)
    const added = addHeader(store, '  Any other business ')
    expect(added).toMatchObject({
      title: 'Any other business',
      kind: 'header',
      parent_id: null,
      off_agenda: false,
      created_t_ms: 125_000,
    })
    expect(headersOf(store.getState()).map(header => header.title)).toEqual([
      ...before.slice(0, -1),
      'Any other business',
      'Unplanned',
    ])
    // A topic can go under it like under any header.
    expect(addTopic(store, added?.id ?? '', 'Parking')).not.toBeNull()

    store.undo()
    store.undo()
    expect(headersOf(store.getState()).map(header => header.title)).toEqual(
      before
    )
  })

  it('gives back the header the agenda already has, and refuses an empty title', () => {
    const { store, cla } = setUp()
    const count = headersOf(store.getState()).length
    expect(addHeader(store, 'cla QUOTE')?.id).toBe(cla.id)
    expect(addHeader(store, 'unplanned')?.id).toBe(
      unplannedHeader(store.getState())?.id
    )
    expect(addHeader(store, '   ')).toBeNull()
    expect(headersOf(store.getState())).toHaveLength(count)
  })
})

describe('topics', () => {
  it('can be added, renamed and dropped on another header', () => {
    const { store, cla, pricing } = setUp()
    const suppliers = headerNamed(store, 'Supplier delays')

    const added = addTopic(store, suppliers.id, ' Lead times ')
    expect(added).toMatchObject({
      title: 'Lead times',
      parent_id: suppliers.id,
    })
    expect(addTopic(store, pricing.id, 'Nested')).toBeNull()

    renameTopic(store, pricing.id, 'Price')
    expect(store.getState().topics[pricing.id]?.title).toBe('Price')
    expect(renameTopic(store, pricing.id, 'Price')).toBeNull()

    moveTopic(store, pricing.id, suppliers.id)
    expect(
      topicsUnder(store.getState(), suppliers.id).map(t => t.title)
    ).toEqual(['Lead times', 'Price'])
    expect(moveTopic(store, pricing.id, suppliers.id)).toBeNull()

    store.undo()
    store.undo()
    expect(topicsUnder(store.getState(), cla.id).map(t => t.title)).toEqual([
      'Pricing',
      'Artwork',
    ])
  })

  it('merge by hand and delete, with undo', () => {
    const { store, cla, pricing, artwork, texts } = setUp()
    const before = store.getState()

    mergeTopic(store, artwork.id, pricing.id)
    expect(texts(pricing.id)).toEqual(['First', 'Second', 'Third'])
    expect(mergeTopic(store, pricing.id, pricing.id)).toBeNull()

    deleteTopic(store, pricing.id)
    expect(topicsUnder(store.getState(), cla.id)).toEqual([])
    expect(
      Object.values(store.getState().cards).map(card => card.text)
    ).toEqual(['Dead again'])
    expect(deleteTopic(store, cla.id)).toBeNull()

    store.undo()
    store.undo()
    expect(store.getState()).toEqual(before)
  })

  it('pin, revisit, schedule and unpin', () => {
    const { store, pricing, aircon } = setUp()
    store.tick(200_000)
    pinTopic(store, aircon.id)
    expect(store.log.at(-1)?.type).toBe('pin_topic')
    // Pinning by hand answers the pin ghost too.
    expect(openSuggestions(store.getState())).toEqual([])
    expect(pinTopic(store, aircon.id)).toBeNull()

    // Only a pinned topic can be revisited or scheduled.
    expect(revisitTopic(store, pricing.id)).toBeNull()
    expect(scheduleTopic(store, pricing.id)).toBeNull()

    store.tick(300_000)
    revisitTopic(store, aircon.id)
    scheduleTopic(store, aircon.id)
    expect(scheduleTopic(store, aircon.id)).toBeNull()
    expect(store.getState().topics[aircon.id]).toMatchObject({
      status: 'pinned',
      pinned_t_ms: 200_000,
      revisited_t_ms: 300_000,
      scheduled_t_ms: 300_000,
    })

    unpinTopic(store, aircon.id)
    expect(pinnedTopics(store.getState())).toEqual([])

    store.undo()
    store.undo()
    store.undo()
    store.undo()
    expect(store.getState().topics[aircon.id]).toEqual(aircon)
    expect(openSuggestions(store.getState())).toHaveLength(1)
  })
})
