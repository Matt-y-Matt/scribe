// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { countingSource, ulidSource } from './ids'
import {
  cardsIn,
  headersOf,
  topicsUnder,
  unplannedHeader,
  type Card,
  type Change,
  type Topic,
} from './model'
import { MapStore, MemoryAdapter, UNDO_DEPTH } from './store'

const MEETING = {
  id: 'm_test',
  title: 'Weekly',
  mode: 'group',
  participants: ['Matt', 'Zach'],
} as const

function newStore(adapter = new MemoryAdapter()) {
  return new MapStore({
    meeting: MEETING,
    agenda: ['CLA quote', 'Supplier delays'],
    adapter,
    ids: countingSource(),
  })
}

function topic(store: MapStore, parentId: string, title: string): Topic {
  return {
    id: store.ids('t'),
    meeting_id: MEETING.id,
    parent_id: parentId,
    title,
    kind: 'topic',
    order_key: 0,
    status: 'active',
    off_agenda: false,
    created_t_ms: 0,
    pinned_t_ms: null,
    revisited_t_ms: null,
    scheduled_t_ms: null,
    segment_ids: [],
  }
}

function card(store: MapStore, topicId: string, text: string): Card {
  return {
    id: store.ids('c'),
    meeting_id: MEETING.id,
    topic_id: topicId,
    kind: 'note',
    text,
    owner: null,
    due_text: null,
    segment_ids: ['s001'],
    status: 'accepted',
    source: 'user',
    created_t_ms: 0,
    confirmed: false,
    done_at_ms: null,
    order_key: 0,
  }
}

const create = (row: Topic | Card): Change =>
  'topic_id' in row
    ? { entity: 'card', id: row.id, before: null, after: row }
    : { entity: 'topic', id: row.id, before: null, after: row }

/** A store with one topic under the first header and one card in it. */
function seeded() {
  const store = newStore()
  const [header] = headersOf(store.getState())
  if (!header) throw new Error('no header')
  const pricing = topic(store, header.id, 'Pricing')
  store.commit('add_topic', 'engine', [create(pricing)])
  const note = card(store, pricing.id, 'Quote at 42')
  store.commit('add_card', 'engine', [create(note)])
  return { store, header, pricing, note }
}

describe('MapStore', () => {
  it('seeds one header per agenda item and the Unplanned column', () => {
    const state = newStore().getState()
    expect(headersOf(state).map(header => header.title)).toEqual([
      'CLA quote',
      'Supplier delays',
      'Unplanned',
    ])
    expect(unplannedHeader(state)?.off_agenda).toBe(true)
    expect(Object.keys(state.cards)).toEqual([])
  })

  it('applies a commit, logs it and tells subscribers', () => {
    const { store, header, pricing, note } = seeded()
    const listener = vi.fn()
    store.subscribe(listener)

    const before = store.getState()
    store.commit(
      'edit_card',
      'user',
      [
        {
          entity: 'card',
          id: note.id,
          before: { text: note.text },
          after: { text: 'Quote at 42 a set' },
        },
      ],
      1200
    )

    expect(topicsUnder(store.getState(), header.id)).toEqual([pricing])
    expect(cardsIn(store.getState(), pricing.id)[0]?.text).toBe(
      'Quote at 42 a set'
    )
    expect(before.cards[note.id]?.text).toBe('Quote at 42')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(
      store.log.map(entry => [entry.seq, entry.type, entry.source])
    ).toEqual([
      [1, 'add_topic', 'engine'],
      [2, 'add_card', 'engine'],
      [3, 'edit_card', 'user'],
    ])
    expect(store.now).toBe(1200)
  })

  it('ignores a commit with no changes', () => {
    const { store } = seeded()
    expect(store.commit('edit_card', 'user', [])).toBeNull()
    expect(store.log).toHaveLength(2)
    expect(store.canUndo).toBe(false)
  })

  it('rejects a change that does not fit the state and keeps nothing', () => {
    const { store, note } = seeded()
    const state = store.getState()
    expect(() => store.commit('add_card', 'engine', [create(note)])).toThrow(
      /exists/
    )
    expect(() =>
      store.commit('edit_card', 'user', [
        { entity: 'card', id: 'c_nope', before: { text: 'a' }, after: {} },
      ])
    ).toThrow(/missing/)
    expect(store.getState()).toBe(state)
    expect(store.log).toHaveLength(2)
  })

  it('undoes and redoes user operations, and logs both', () => {
    const { store, pricing, note } = seeded()
    const rename = (from: string, to: string) =>
      store.commit('rename_topic', 'user', [
        {
          entity: 'topic',
          id: pricing.id,
          before: { title: from },
          after: { title: to },
        },
      ])
    rename('Pricing', 'Price')
    store.commit('delete_card', 'user', [
      { entity: 'card', id: note.id, before: note, after: null },
    ])
    expect(store.getState().cards[note.id]).toBeUndefined()

    expect(store.undo()).toBe(true)
    expect(store.getState().cards[note.id]).toEqual(note)
    expect(store.undo()).toBe(true)
    expect(store.getState().topics[pricing.id]?.title).toBe('Pricing')
    expect(store.undo()).toBe(false)

    expect(store.redo()).toBe(true)
    expect(store.getState().topics[pricing.id]?.title).toBe('Price')
    expect(store.log.at(-1)?.replay).toEqual({ of: 3, direction: 'redo' })
    expect(store.log.at(-2)?.replay).toEqual({ of: 3, direction: 'undo' })

    rename('Price', 'Prices')
    expect(store.canRedo).toBe(false)
  })

  it('keeps what the engine adds out of the undo stack', () => {
    const { store, pricing } = seeded()
    expect(store.canUndo).toBe(false)

    store.commit('rename_topic', 'user', [
      {
        entity: 'topic',
        id: pricing.id,
        before: { title: 'Pricing' },
        after: { title: 'Price' },
      },
    ])
    const late = card(store, pricing.id, 'Arrived after the rename')
    store.commit('add_card', 'engine', [create(late)])

    expect(store.undo()).toBe(true)
    const state = store.getState()
    expect(state.topics[pricing.id]?.title).toBe('Pricing')
    expect(state.cards[late.id]).toEqual(late)
  })

  it('undoes one field without touching a later change to another', () => {
    const { store, note } = seeded()
    store.commit('edit_card', 'user', [
      {
        entity: 'card',
        id: note.id,
        before: { kind: 'note' },
        after: { kind: 'decision' },
      },
    ])
    // The same row changes again from a source that is not on the undo stack.
    store.commit('add_card', 'engine', [
      {
        entity: 'card',
        id: note.id,
        before: { text: note.text },
        after: { text: 'Later' },
      },
    ])
    store.undo()
    expect(store.getState().cards[note.id]).toMatchObject({
      kind: 'note',
      text: 'Later',
    })
  })

  it(`undoes ${UNDO_DEPTH} operations deep and no further`, () => {
    const { store, pricing } = seeded()
    const total = UNDO_DEPTH + 5
    for (let i = 1; i <= total; i++) {
      store.commit('rename_topic', 'user', [
        {
          entity: 'topic',
          id: pricing.id,
          before: { title: i === 1 ? 'Pricing' : `v${i - 1}` },
          after: { title: `v${i}` },
        },
      ])
    }

    let undone = 0
    while (store.undo()) undone++
    expect(undone).toBe(UNDO_DEPTH)
    expect(store.getState().topics[pricing.id]?.title).toBe('v5')

    let redone = 0
    while (store.redo()) redone++
    expect(redone).toBe(UNDO_DEPTH)
    expect(store.getState().topics[pricing.id]?.title).toBe(`v${total}`)
  })

  it('persists every change through the adapter', () => {
    const adapter = new MemoryAdapter()
    const store = newStore(adapter)
    const [header] = headersOf(store.getState())
    if (!header) throw new Error('no header')
    const pricing = topic(store, header.id, 'Pricing')
    store.commit('add_topic', 'user', [create(pricing)])
    store.commit('rename_topic', 'user', [
      {
        entity: 'topic',
        id: pricing.id,
        before: { title: 'Pricing' },
        after: { title: 'Price' },
      },
    ])
    store.undo()

    expect(adapter.load()).toEqual(store.getState())
    expect(adapter.load()).not.toBe(store.getState())

    // A second store on the same adapter opens the saved map, not a new one.
    const reopened = newStore(adapter)
    expect(reopened.getState()).toEqual(store.getState())
  })

  it('moves the meeting clock forward only', () => {
    const store = newStore()
    store.tick(5000)
    store.tick(3000)
    expect(store.now).toBe(5000)
  })
})

describe('ids', () => {
  it('mints prefixed ULIDs that sort in the order they were made', () => {
    const ids = ulidSource()
    const made = Array.from({ length: 500 }, () => ids('c'))
    expect(made.every(id => /^c_[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true)
    expect([...made].sort()).toEqual(made)
    expect(new Set(made).size).toBe(made.length)
  })

  it('counts for tests', () => {
    const ids = countingSource()
    expect([ids('t'), ids('c'), ids('g')]).toEqual([
      't_0001',
      'c_0002',
      'g_0003',
    ])
  })
})
