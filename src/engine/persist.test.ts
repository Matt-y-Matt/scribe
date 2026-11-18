// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { MapPatch, MapRows } from '@/ipc'
import {
  acceptSuggestion,
  addCard,
  addTopic,
  deleteCard,
  editCard,
  mergeTopic,
  moveCard,
  pinTopic,
} from './actions'
import { countingSource } from './ids'
import { cardsIn, headersOf, openSuggestions, type Meeting } from './model'
import { patchOfState, RowAdapter, stateFromRows } from './persist'
import { MapStore } from './store'

const MEETING: Meeting = {
  id: 'm_test',
  title: 'Weekly',
  mode: 'group',
  participants: ['Matt', 'Kabs'],
}

const EMPTY: MapRows = { topics: [], cards: [], suggestions: [] }

/** A stand-in for SQLite: applies patches the way `map_save` does. */
class FakeDisk {
  rows: MapRows = { topics: [], cards: [], suggestions: [] }
  patches: MapPatch[] = []
  failNext = false

  save = async (patch: MapPatch): Promise<void> => {
    await Promise.resolve()
    if (this.failNext) {
      this.failNext = false
      throw new Error('disk full')
    }
    this.patches.push(patch)
    const upsert = <T extends { id: string }>(table: T[], rows: T[]) => [
      ...table.filter(old => !rows.some(row => row.id === old.id)),
      ...rows,
    ]
    const gone = (entity: string) =>
      new Set(patch.deleted.filter(d => d.entity === entity).map(d => d.id))
    const keep = <T extends { id: string }>(table: T[], entity: string) =>
      table.filter(row => !gone(entity).has(row.id))
    this.rows = {
      topics: keep(upsert(this.rows.topics, patch.topics), 'topic'),
      cards: keep(upsert(this.rows.cards, patch.cards), 'card'),
      suggestions: keep(
        upsert(this.rows.suggestions, patch.suggestions),
        'suggestion'
      ),
    }
  }
}

function open(disk: FakeDisk, onError?: (error: unknown) => void) {
  const adapter = new RowAdapter({
    meeting: MEETING,
    rows: disk.rows,
    backend: disk,
    onError,
  })
  const store = new MapStore({
    meeting: MEETING,
    agenda: ['CLA quote', 'Supplier delays'],
    adapter,
    ids: countingSource(),
  })
  return { adapter, store }
}

describe('RowAdapter', () => {
  it('saves the headers of a new meeting', async () => {
    const disk = new FakeDisk()
    const { adapter, store } = open(disk)
    await adapter.idle()

    expect(disk.rows.topics.map(row => row.title).sort()).toEqual([
      'CLA quote',
      'Supplier delays',
      'Unplanned',
    ])
    expect(patchOfState(store.getState())).toEqual({
      ...disk.rows,
      deleted: [],
    })
  })

  it('reloads exactly the map that was saved, edits and undo included', async () => {
    const disk = new FakeDisk()
    const { adapter, store } = open(disk)
    const [cla, suppliers] = headersOf(store.getState())
    if (!cla || !suppliers) throw new Error('no headers')

    const pricing = addTopic(store, cla.id, 'Pricing')
    const leadTimes = addTopic(store, suppliers.id, 'Lead times')
    if (!pricing || !leadTimes) throw new Error('no topics')
    const quote = addCard(store, pricing.id, {
      kind: 'decision',
      text: 'Quote at 42 a set',
    })
    const call = addCard(store, pricing.id, {
      kind: 'action',
      text: 'Call Ross',
      owner: 'Kabs',
    })
    if (!quote || !call) throw new Error('no cards')
    editCard(store, call.id, { text: 'Call Ross tomorrow' })
    moveCard(store, call.id, leadTimes.id)
    pinTopic(store, leadTimes.id)
    deleteCard(store, quote.id)
    store.undo() // the decision is back
    store.undo() // the pin is gone
    store.redo() // and back again
    await adapter.idle()

    // A second launch: the same rows, a new adapter and store.
    const reopened = open(disk)
    expect(reopened.store.getState()).toEqual(store.getState())
    expect(cardsIn(reopened.store.getState(), leadTimes.id)).toHaveLength(1)
    expect(reopened.store.getState().topics[leadTimes.id]?.status).toBe(
      'pinned'
    )
  })

  it('sends one patch per commit, with only the rows it touched', async () => {
    const disk = new FakeDisk()
    const { adapter, store } = open(disk)
    const [cla] = headersOf(store.getState())
    if (!cla) throw new Error('no header')
    const pricing = addTopic(store, cla.id, 'Pricing')
    const artwork = addTopic(store, cla.id, 'Artwork')
    if (!pricing || !artwork) throw new Error('no topics')
    const note = addCard(store, artwork.id, { kind: 'note', text: 'JPG logo' })
    if (!note) throw new Error('no card')
    await adapter.idle()
    disk.patches = []

    // Merging moves the card and removes the topic: one commit, one patch.
    mergeTopic(store, artwork.id, pricing.id)
    await adapter.idle()

    expect(disk.patches).toHaveLength(1)
    const [patch] = disk.patches
    expect(patch?.cards.map(row => [row.id, row.topic_id])).toEqual([
      [note.id, pricing.id],
    ])
    expect(patch?.deleted).toEqual([{ entity: 'topic', id: artwork.id }])
    expect(disk.rows.topics.some(row => row.id === artwork.id)).toBe(false)
  })

  it('keeps a suggestion and its payload', async () => {
    const disk = new FakeDisk()
    const { adapter, store } = open(disk)
    const [cla] = headersOf(store.getState())
    if (!cla) throw new Error('no header')
    const aircon = addTopic(store, cla.id, 'Office aircon')
    if (!aircon) throw new Error('no topic')
    store.commit('add_suggestion', 'engine', [
      {
        entity: 'suggestion',
        id: 'g_1',
        before: null,
        after: {
          id: 'g_1',
          meeting_id: MEETING.id,
          kind: 'pin',
          payload: {
            kind: 'pin',
            topic_id: aircon.id,
            title: 'Office aircon',
            reason: 'Not on the agenda',
          },
          status: 'open',
          created_t_ms: 196_000,
        },
      },
    ])
    await adapter.idle()

    const reopened = open(disk)
    const [pin] = openSuggestions(reopened.store.getState())
    expect(pin?.payload).toEqual({
      kind: 'pin',
      topic_id: aircon.id,
      title: 'Office aircon',
      reason: 'Not on the agenda',
    })
    if (!pin) throw new Error('no suggestion')
    acceptSuggestion(reopened.store, pin.id)
    await reopened.adapter.idle()
    expect(disk.rows.suggestions[0]?.status).toBe('accepted')
    expect(disk.rows.topics.find(row => row.id === aircon.id)?.status).toBe(
      'pinned'
    )
  })

  it('reports a failed save and carries on with the next commit', async () => {
    const disk = new FakeDisk()
    const errors: unknown[] = []
    const { adapter, store } = open(disk, error => errors.push(error))
    await adapter.idle()
    const [cla] = headersOf(store.getState())
    if (!cla) throw new Error('no header')

    disk.failNext = true
    addTopic(store, cla.id, 'Pricing')
    const artwork = addTopic(store, cla.id, 'Artwork')
    await adapter.idle()

    expect(errors).toHaveLength(1)
    expect(disk.rows.topics.some(row => row.id === artwork?.id)).toBe(true)
  })

  it('treats a meeting with no saved topics as new', () => {
    expect(stateFromRows(MEETING, EMPTY)).toBeNull()
  })
})
