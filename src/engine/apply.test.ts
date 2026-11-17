// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { dismissSuggestion, pinTopic } from './actions'
import { applyOps, GENERAL_TITLE, type ApplyContext } from './apply'
import {
  ADDITIVE_OPS,
  cardsIn,
  openSuggestions,
  topicsUnder,
  unplannedHeader,
  type MapState,
} from './model'
import type { MapStore } from './store'
import { headerNamed, testSegments, testStore } from './testing'

const context = (overrides: Partial<ApplyContext> = {}): ApplyContext => ({
  tMs: 60_000,
  segments: testSegments(20),
  ...overrides,
})

function setUp() {
  const store = testStore()
  const cla = headerNamed(store, 'CLA quote')
  applyOps(
    store,
    [
      {
        op: 'add_topic',
        tmp_key: 'pricing',
        title: 'Pricing',
        parent_id: cla.id,
        off_agenda: false,
        segment_ids: ['s004'],
      },
    ],
    context()
  )
  const pricing = topicsUnder(store.getState(), cla.id)[0]
  if (!pricing) throw new Error('no topic')
  return { store, cla, pricing }
}

const allCards = (state: MapState) => Object.values(state.cards)
const note = (segmentIds: string[], extra: object = {}) => ({
  op: 'add_card',
  kind: 'note',
  text: 'A note',
  segment_ids: segmentIds,
  ...extra,
})

function expectUnchanged(store: MapStore, run: () => void) {
  const before = store.getState()
  const logged = store.log.length
  run()
  expect(store.getState()).toBe(before)
  expect(store.log).toHaveLength(logged)
}

describe('applyOps', () => {
  it('adds a topic and resolves its tmp_key for the cards that follow', () => {
    const store = testStore()
    const cla = headerNamed(store, 'CLA quote')
    const { applied, dropped } = applyOps(
      store,
      {
        ops: [
          {
            op: 'add_topic',
            tmp_key: 't1',
            title: 'Pricing',
            parent_id: cla.id,
            off_agenda: false,
            segment_ids: ['s004', 's005'],
          },
          {
            op: 'add_card',
            tmp_topic: 't1',
            kind: 'decision',
            text: 'Quote at 42 a set',
            segment_ids: ['s008'],
          },
        ],
      },
      context()
    )

    expect(dropped).toEqual([])
    expect(applied.map(entry => entry.type)).toEqual(['add_topic', 'add_card'])
    const [pricing] = topicsUnder(store.getState(), cla.id)
    expect(pricing).toMatchObject({
      title: 'Pricing',
      kind: 'topic',
      off_agenda: false,
      segment_ids: ['s004', 's005'],
      created_t_ms: 30_000,
    })
    expect(cardsIn(store.getState(), pricing?.id ?? '')).toMatchObject([
      {
        kind: 'decision',
        text: 'Quote at 42 a set',
        status: 'accepted',
        source: 'engine',
        confirmed: false,
        segment_ids: ['s008'],
        created_t_ms: 70_000,
      },
    ])
  })

  it('drops unknown and deleting ops, logs them and applies the rest', () => {
    const { store, pricing } = setUp()
    const log = vi.fn()
    const logged = store.log.length
    const { applied, dropped } = applyOps(
      store,
      [
        { op: 'delete_card', card_id: 'c_0001' },
        { op: 'delete_topic', topic_id: pricing.id },
        { op: 'rename_topic', topic_id: pricing.id, title: 'Price war' },
        { op: 'move_card', card_id: 'c_0001', to_topic_id: pricing.id },
        { op: 'add_card', topic_id: pricing.id, kind: 'poem', text: 'x' },
        'not an op',
        null,
        note(['s006'], { topic_id: pricing.id }),
      ],
      context({ log })
    )

    expect(dropped.map(drop => [drop.index, drop.op, drop.reason])).toEqual([
      [0, 'delete_card', 'not_in_schema'],
      [1, 'delete_topic', 'not_in_schema'],
      [2, 'rename_topic', 'not_in_schema'],
      [3, 'move_card', 'not_in_schema'],
      [4, 'add_card', 'not_in_schema'],
      [5, 'unknown', 'not_in_schema'],
      [6, 'unknown', 'not_in_schema'],
    ])
    expect(applied.map(entry => entry.type)).toEqual(['add_card'])
    expect(store.getState().topics[pricing.id]?.title).toBe('Pricing')
    expect(store.log.slice(logged).map(entry => entry.type)).toEqual([
      'add_card',
    ])
    expect(log).toHaveBeenCalledTimes(7)
    expect(log).toHaveBeenCalledWith('structurer op dropped', {
      index: 0,
      op: 'delete_card',
      reason: 'not_in_schema',
    })
  })

  it('only ever logs additive engine ops', () => {
    const { store, pricing } = setUp()
    applyOps(
      store,
      [
        note(['s006'], { topic_id: pricing.id }),
        { op: 'add_topic', tmp_key: 'x', title: 'Aircon', off_agenda: true },
        { op: 'suggest_move', card_id: 'c_0006', to_topic_id: 'x' },
      ],
      context()
    )
    expect(store.log.length).toBeGreaterThan(3)
    for (const entry of store.log) {
      expect(entry.source).toBe('engine')
      expect(ADDITIVE_OPS).toContain(entry.type)
      expect(entry.changes.every(change => change.before === null)).toBe(true)
    }
    expect(store.canUndo).toBe(false)
  })

  it('drops a card that cites no segment it has heard', () => {
    const { store, pricing } = setUp()
    expectUnchanged(store, () => {
      const { dropped } = applyOps(
        store,
        [
          note([], { topic_id: pricing.id }),
          note(['s999', 'made-up'], { topic_id: pricing.id }),
        ],
        context()
      )
      expect(dropped.map(drop => drop.reason)).toEqual([
        'no_segments',
        'no_segments',
      ])
    })

    applyOps(
      store,
      [note(['s006', 's999', 's006'], { topic_id: pricing.id })],
      context()
    )
    expect(allCards(store.getState())[0]?.segment_ids).toEqual(['s006'])
  })

  it('drops a card for a topic that does not exist', () => {
    const { store } = setUp()
    expectUnchanged(store, () => {
      const { dropped } = applyOps(
        store,
        [
          note(['s006'], { topic_id: 't_9999' }),
          note(['s006'], { tmp_topic: 'never-declared' }),
          note(['s006']),
          note(['s006'], { topic_id: unplannedHeader(store.getState())?.id }),
        ],
        context()
      )
      expect(dropped.map(drop => drop.reason)).toEqual([
        'unknown_topic',
        'unknown_topic',
        'unknown_topic',
        'unknown_topic',
      ])
    })
  })

  it('does not carry a tmp_key over to the next batch', () => {
    const store = testStore()
    const cla = headerNamed(store, 'CLA quote')
    const addTopic = {
      op: 'add_topic',
      tmp_key: 'k1',
      title: 'Pricing',
      parent_id: cla.id,
    }
    applyOps(store, [addTopic], context())
    const { dropped } = applyOps(
      store,
      [note(['s006'], { tmp_topic: 'k1' })],
      context()
    )
    expect(dropped.map(drop => drop.reason)).toEqual(['unknown_topic'])
  })

  it('takes a title where an id belongs, when only one topic has it', () => {
    const { store, cla, pricing } = setUp()
    applyOps(
      store,
      [
        note(['s006'], { topic_id: 'pricing' }),
        note(['s007'], { topic_id: 'CLA quote' }),
        note(['s008'], { topic_id: 'cla QUOTE ' }),
      ],
      context()
    )
    const topics = topicsUnder(store.getState(), cla.id)
    expect(topics.map(topic => topic.title)).toEqual(['Pricing', GENERAL_TITLE])
    expect(cardsIn(store.getState(), pricing.id)).toHaveLength(1)
    expect(cardsIn(store.getState(), topics[1]?.id ?? '')).toHaveLength(2)

    // Two topics called "General" now exist nowhere else, but a title two
    // topics share names neither.
    applyOps(
      store,
      [note(['s009'], { topic_id: headerNamed(store, 'Supplier delays').id })],
      context()
    )
    const { dropped } = applyOps(
      store,
      [note(['s010'], { topic_id: GENERAL_TITLE })],
      context()
    )
    expect(dropped.map(drop => drop.reason)).toEqual(['unknown_topic'])
  })

  it('puts a card aimed at a header under a General topic', () => {
    const store = testStore()
    const suppliers = headerNamed(store, 'Supplier delays')
    applyOps(
      store,
      [
        note(['s017'], { topic_id: suppliers.id }),
        note(['s018'], { topic_id: suppliers.id }),
      ],
      context()
    )
    const topics = topicsUnder(store.getState(), suppliers.id)
    expect(topics.map(topic => topic.title)).toEqual([GENERAL_TITLE])
    expect(cardsIn(store.getState(), topics[0]?.id ?? '')).toHaveLength(2)
  })

  it('reuses a topic that already has that title under the header', () => {
    const { store, cla, pricing } = setUp()
    const { dropped } = applyOps(
      store,
      [
        {
          op: 'add_topic',
          tmp_key: 'again',
          title: '  pricing ',
          parent_id: cla.id,
          off_agenda: false,
          segment_ids: ['s009'],
        },
        note(['s009'], { tmp_topic: 'again' }),
      ],
      context()
    )
    expect(dropped.map(drop => [drop.op, drop.reason])).toEqual([
      ['add_topic', 'duplicate'],
    ])
    expect(topicsUnder(store.getState(), cla.id)).toHaveLength(1)
    expect(cardsIn(store.getState(), pricing.id)).toHaveLength(1)
  })

  it('files a topic named under another topic beside it', () => {
    const { store, cla, pricing } = setUp()
    applyOps(
      store,
      [
        {
          op: 'add_topic',
          tmp_key: 'art',
          title: 'Artwork',
          parent_id: pricing.id,
          off_agenda: false,
          segment_ids: ['s012'],
        },
      ],
      context()
    )
    expect(
      topicsUnder(store.getState(), cla.id).map(topic => topic.title)
    ).toEqual(['Pricing', 'Artwork'])
  })

  describe('off-agenda topics', () => {
    it('go under Unplanned with a pin suggestion', () => {
      const store = testStore()
      applyOps(
        store,
        [
          {
            op: 'add_topic',
            tmp_key: 'aircon',
            title: 'Office aircon',
            off_agenda: true,
            // A header is named, but off_agenda wins.
            parent_id: headerNamed(store, 'CLA quote').id,
            segment_ids: ['s013'],
          },
        ],
        context()
      )
      const state = store.getState()
      const unplanned = unplannedHeader(state)
      const [aircon] = topicsUnder(state, unplanned?.id ?? '')
      expect(aircon).toMatchObject({ title: 'Office aircon', off_agenda: true })
      expect(openSuggestions(state)).toMatchObject([
        {
          kind: 'pin',
          status: 'open',
          payload: { topic_id: aircon?.id, title: 'Office aircon' },
        },
      ])
    })

    it('include a topic that names no header, or one that does not exist', () => {
      const store = testStore()
      applyOps(
        store,
        [
          { op: 'add_topic', tmp_key: 'a', title: 'Aircon', segment_ids: [] },
          {
            op: 'add_topic',
            tmp_key: 'b',
            title: 'Pop-up',
            parent_id: 't_9999',
            off_agenda: false,
          },
        ],
        context()
      )
      const state = store.getState()
      expect(
        topicsUnder(state, unplannedHeader(state)?.id ?? '').map(t => t.title)
      ).toEqual(['Aircon', 'Pop-up'])
      expect(openSuggestions(state)).toHaveLength(2)
    })

    it('keep the pin suggestion the model sent, and only that one', () => {
      const store = testStore()
      const { dropped } = applyOps(
        store,
        [
          { op: 'add_topic', tmp_key: 'a', title: 'Aircon', off_agenda: true },
          {
            op: 'suggest_pin',
            tmp_key_or_topic_id: 'a',
            title: 'Office aircon',
            reason: 'Matt asked to park it',
          },
          { op: 'suggest_pin', tmp_key_or_topic_id: 'a', title: 'Again' },
        ],
        context()
      )
      expect(dropped.map(drop => drop.reason)).toEqual(['repeat'])
      expect(openSuggestions(store.getState())).toMatchObject([
        {
          payload: { title: 'Office aircon', reason: 'Matt asked to park it' },
        },
      ])
    })
  })

  describe('owners', () => {
    it('match a participant or stay blank', () => {
      const { store, pricing } = setUp()
      const action = (owner: unknown, segment: string) => ({
        op: 'add_card',
        topic_id: pricing.id,
        kind: 'action',
        text: 'Call Ross',
        owner,
        due_text: ' tomorrow ',
        segment_ids: [segment],
      })
      applyOps(
        store,
        [
          action('Kabs', 's010'),
          action('Kabir', 's011'),
          action('Ross', 's012'),
          action(null, 's013'),
        ],
        context()
      )
      expect(
        cardsIn(store.getState(), pricing.id).map(card => [
          card.owner,
          card.due_text,
        ])
      ).toEqual([
        ['Kabs', 'tomorrow'],
        ['Kabs', 'tomorrow'],
        [null, 'tomorrow'],
        [null, 'tomorrow'],
      ])
    })

    it('belong to actions only', () => {
      const { store, pricing } = setUp()
      applyOps(
        store,
        [
          {
            op: 'add_card',
            topic_id: pricing.id,
            kind: 'decision',
            text: 'Quote at 42',
            owner: 'Matt',
            due_text: 'this week',
            segment_ids: ['s008'],
          },
        ],
        context()
      )
      expect(allCards(store.getState())[0]).toMatchObject({
        owner: null,
        due_text: null,
      })
    })
  })

  describe('dedupe by segment coverage', () => {
    it('drops a card whose segments a card of the same kind already covers', () => {
      const { store, pricing } = setUp()
      const { dropped } = applyOps(
        store,
        [
          note(['s006', 's007'], { topic_id: pricing.id }),
          note(['s007'], { topic_id: pricing.id, text: 'Said again' }),
          note(['s006', 's007'], { topic_id: pricing.id }),
          // Reaches past what is covered: kept.
          note(['s007', 's008'], { topic_id: pricing.id }),
          // Another kind on the same segment: kept.
          {
            op: 'add_card',
            topic_id: pricing.id,
            kind: 'decision',
            text: 'Agreed',
            segment_ids: ['s007'],
          },
        ],
        context()
      )
      expect(dropped.map(drop => [drop.index, drop.reason])).toEqual([
        [1, 'duplicate'],
        [2, 'duplicate'],
      ])
      expect(cardsIn(store.getState(), pricing.id)).toHaveLength(3)
    })

    it('keeps two actions from one sentence when the owners differ', () => {
      const { store, pricing } = setUp()
      const action = (owner: string) => ({
        op: 'add_card',
        topic_id: pricing.id,
        kind: 'action',
        text: `${owner} does something`,
        owner,
        segment_ids: ['s010'],
      })
      const { dropped } = applyOps(
        store,
        [action('Matt'), action('Kabs'), action('Kabir')],
        context()
      )
      expect(dropped.map(drop => [drop.index, drop.reason])).toEqual([
        [2, 'duplicate'],
      ])
      expect(
        cardsIn(store.getState(), pricing.id).map(card => card.owner)
      ).toEqual(['Matt', 'Kabs'])
    })
  })

  describe('suggestions', () => {
    function withTwoTopics() {
      const { store, cla, pricing } = setUp()
      applyOps(
        store,
        [
          {
            op: 'add_topic',
            tmp_key: 'art',
            title: 'Artwork',
            parent_id: cla.id,
            off_agenda: false,
          },
          note(['s014'], { topic_id: pricing.id }),
        ],
        context()
      )
      const artwork = topicsUnder(store.getState(), cla.id)[1]
      const card = cardsIn(store.getState(), pricing.id)[0]
      if (!artwork || !card) throw new Error('set-up failed')
      return { store, pricing, artwork, card }
    }

    it('are raised as open ghosts and change nothing else', () => {
      const { store, pricing, artwork, card } = withTwoTopics()
      const before = store.getState()
      const { dropped } = applyOps(
        store,
        [
          {
            op: 'suggest_move',
            card_id: card.id,
            to_topic_id: artwork.id,
            reason: 'About the logo',
          },
          {
            op: 'suggest_merge',
            topic_id: artwork.id,
            into_topic_id: pricing.id,
          },
          { op: 'suggest_pin', tmp_key_or_topic_id: artwork.id, title: 'Art' },
        ],
        context()
      )
      expect(dropped).toEqual([])
      const state = store.getState()
      expect(openSuggestions(state).map(s => s.payload)).toEqual([
        {
          kind: 'move',
          card_id: card.id,
          to_topic_id: artwork.id,
          reason: 'About the logo',
        },
        {
          kind: 'merge',
          topic_id: artwork.id,
          into_topic_id: pricing.id,
          reason: '',
        },
        {
          kind: 'pin',
          topic_id: artwork.id,
          title: 'Art',
          reason: 'Not on the agenda',
        },
      ])
      expect(state.cards).toBe(before.cards)
      expect(state.topics).toBe(before.topics)
    })

    it('are dropped when they point nowhere or change nothing', () => {
      const { store, pricing, artwork, card } = withTwoTopics()
      pinTopic(store, artwork.id)
      const logged = store.log.length
      const { dropped } = applyOps(
        store,
        [
          { op: 'suggest_move', card_id: 'c_9999', to_topic_id: artwork.id },
          { op: 'suggest_move', card_id: card.id, to_topic_id: 't_9999' },
          { op: 'suggest_move', card_id: card.id, to_topic_id: pricing.id },
          {
            op: 'suggest_merge',
            topic_id: pricing.id,
            into_topic_id: pricing.id,
          },
          {
            op: 'suggest_merge',
            topic_id: pricing.id,
            into_topic_id: pricing.parent_id,
          },
          { op: 'suggest_pin', tmp_key_or_topic_id: 't_9999', title: 'x' },
          { op: 'suggest_pin', tmp_key_or_topic_id: artwork.id, title: 'x' },
        ],
        context()
      )
      expect(dropped.map(drop => drop.reason)).toEqual([
        'unknown_card',
        'unknown_topic',
        'same_place',
        'same_place',
        'unknown_topic',
        'unknown_topic',
        'already_pinned',
      ])
      expect(store.log).toHaveLength(logged)
    })

    it('are not raised again once dismissed', () => {
      const { store, artwork, card } = withTwoTopics()
      const move = {
        op: 'suggest_move',
        card_id: card.id,
        to_topic_id: artwork.id,
      }
      applyOps(store, [move], context())
      const [ghost] = openSuggestions(store.getState())
      dismissSuggestion(store, ghost?.id ?? '')

      const { dropped } = applyOps(store, [move, move], context())
      expect(dropped.map(drop => drop.reason)).toEqual(['repeat', 'repeat'])
      expect(openSuggestions(store.getState())).toEqual([])
    })
  })

  it('accepts nothing from a reply that is not a list of ops', () => {
    const store = testStore()
    for (const reply of [null, undefined, 'ops', 42, {}, { ops: 'none' }]) {
      expectUnchanged(store, () => {
        expect(applyOps(store, reply, context())).toEqual({
          applied: [],
          dropped: [],
        })
      })
    }
  })
})
