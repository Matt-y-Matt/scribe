// @vitest-environment node
import { NodeChangeset } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { addCard, addTopic, moveTopic } from '@/engine/actions'
import {
  headersOf,
  topicsUnder,
  unplannedHeader,
  type MapState,
} from '@/engine/model'
import { canvasReducer, INITIAL_CANVAS, type CanvasState } from './canvas-state'
import { FIXTURE_PINS, fixtureStore } from './fixture'
import { clock, initials } from './format'
import {
  COLUMN_GAP,
  COLUMN_HEADER,
  COLUMN_PADDING,
  COLUMN_WIDTH,
  columnAt,
  layoutMap,
  TOPIC_GAP,
  TOPIC_WIDTH,
  visibleHeaders,
} from './layout'
import { buildNodes, type MapNode } from './nodes'

const topicNamed = (state: MapState, title: string) => {
  const topic = Object.values(state.topics).find(row => row.title === title)
  if (!topic) throw new Error(`no topic "${title}"`)
  return topic
}

/** Every topic 100 px tall, except the ones named here. */
function heightsFor(state: MapState, special: Record<string, number> = {}) {
  return new Map(
    Object.values(state.topics)
      .filter(topic => topic.kind === 'topic')
      .map(topic => [topic.id, special[topic.title] ?? 100])
  )
}

describe('format', () => {
  it('writes meeting time as a time link', () => {
    expect(clock(0)).toBe('00:00:00')
    expect(clock(196_500)).toBe('00:03:16')
    expect(clock(3_725_000)).toBe('01:02:05')
  })

  it('makes owner-chip letters', () => {
    expect(initials('Matt')).toBe('Ma')
    expect(initials('kabs')).toBe('Ka')
    expect(initials('Mei Ling Tan')).toBe('ML')
    expect(initials('  ')).toBe('')
  })
})

describe('layoutMap', () => {
  const store = fixtureStore({ pins: FIXTURE_PINS })
  const state = store.getState()

  it('puts one column per header, left to right in agenda order', () => {
    const { columns } = layoutMap(state, heightsFor(state), {})
    const titles = columns.map(column => state.topics[column.id]?.title)
    expect(titles).toEqual([
      'CLA quote',
      'Supplier delays',
      'Designer hire',
      'Unplanned',
    ])
    expect(columns.map(column => column.x)).toEqual(
      [0, 1, 2, 3].map(index => index * (COLUMN_WIDTH + COLUMN_GAP))
    )
    expect(columns.every(column => column.y === 0)).toBe(true)
  })

  it('leaves the Unplanned column out until it has a topic', () => {
    const early = fixtureStore({ until: 's010' }).getState()
    expect(visibleHeaders(early).map(header => header.title)).toEqual([
      'CLA quote',
      'Supplier delays',
      'Designer hire',
    ])
  })

  it('stacks a column top to bottom without overlap', () => {
    const heights = heightsFor(state, { Pricing: 300, Artwork: 150 })
    const { topics, columns } = layoutMap(state, heights, {})
    const cla = headersOf(state)[0]
    const boxes = topicsUnder(state, cla?.id ?? '').map(topic =>
      topics.find(box => box.id === topic.id)
    )
    expect(boxes.map(box => [box?.x, box?.y, box?.height])).toEqual([
      [COLUMN_PADDING, COLUMN_HEADER, 300],
      [COLUMN_PADDING, COLUMN_HEADER + 300 + TOPIC_GAP, 150],
      [COLUMN_PADDING, COLUMN_HEADER + 300 + TOPIC_GAP + 150 + TOPIC_GAP, 100],
    ])
    expect(columns[0]?.height).toBe(
      COLUMN_HEADER + 300 + 150 + 100 + TOPIC_GAP * 2 + COLUMN_PADDING
    )
  })

  it('moves only the topics below one that grows', () => {
    const before = layoutMap(state, heightsFor(state), {})
    const after = layoutMap(state, heightsFor(state, { Artwork: 180 }), {})
    const moved = after.topics.filter(box => {
      const old = before.topics.find(other => other.id === box.id)
      return old?.x !== box.x || old.y !== box.y
    })
    expect(moved.map(box => state.topics[box.id]?.title)).toEqual([
      'Name embroidery',
    ])
    const names = topicNamed(state, 'Name embroidery')
    const y = (layout: typeof before) =>
      layout.topics.find(box => box.id === names.id)?.y ?? 0
    expect(y(after) - y(before)).toBe(80)
  })

  it('keeps a hand-placed topic where it was put, and flows the rest', () => {
    const artwork = topicNamed(state, 'Artwork')
    const names = topicNamed(state, 'Name embroidery')
    const { topics, columns } = layoutMap(state, heightsFor(state), {
      [artwork.id]: { x: 40, y: 900 },
    })
    expect(topics.find(box => box.id === artwork.id)).toMatchObject({
      x: 40,
      y: 900,
      manual: true,
    })
    // Name embroidery closes the gap Artwork left.
    expect(topics.find(box => box.id === names.id)).toMatchObject({
      y: COLUMN_HEADER + 100 + TOPIC_GAP,
      manual: false,
    })
    // The column still reaches round the topic that was dragged down.
    expect(columns[0]?.height).toBe(900 + 100 + COLUMN_PADDING)
  })

  it('lays topics off the agenda side by side, each a column of its own', () => {
    const heights = heightsFor(state, { 'Office aircon': 240 })
    const { topics, columns } = layoutMap(state, heights, {})
    const unplanned = columns.at(-1)
    const off = topicsUnder(state, unplanned?.id ?? '')
    expect(off.length).toBeGreaterThan(1)
    const boxes = off.map(topic => topics.find(box => box.id === topic.id))
    expect(boxes.map(box => [box?.x, box?.y])).toEqual(
      off.map((_, index) => [
        COLUMN_PADDING + index * (TOPIC_WIDTH + COLUMN_GAP),
        COLUMN_HEADER,
      ])
    )
    // The area is as wide as its topics and as tall as the tallest.
    expect(unplanned?.width).toBe(
      COLUMN_PADDING * 2 +
        off.length * TOPIC_WIDTH +
        (off.length - 1) * COLUMN_GAP
    )
    expect(unplanned?.height).toBe(COLUMN_HEADER + 240 + COLUMN_PADDING)
  })

  it('opens a new topic off the agenda to the right, moving nothing', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    const before = layoutMap(store.getState(), heightsFor(store.getState()), {})
    const unplanned = unplannedHeader(store.getState())
    addTopic(store, unplanned?.id ?? '', 'Office move')
    const after = layoutMap(store.getState(), heightsFor(store.getState()), {})
    for (const box of before.topics) {
      expect(after.topics.find(other => other.id === box.id)).toMatchObject({
        x: box.x,
        y: box.y,
      })
    }
    const added = topicNamed(store.getState(), 'Office move')
    const last = before.topics.filter(box => box.headerId === unplanned?.id)
    expect(after.topics.find(box => box.id === added.id)?.x).toBe(
      Math.max(...last.map(box => box.x)) + TOPIC_WIDTH + COLUMN_GAP
    )
  })

  it('finds the column under a point', () => {
    const layout = layoutMap(state, heightsFor(state), {})
    expect(columnAt(layout, 10)?.id).toBe(layout.columns[0]?.id)
    expect(columnAt(layout, COLUMN_WIDTH + COLUMN_GAP + 5)?.id).toBe(
      layout.columns[1]?.id
    )
    expect(columnAt(layout, COLUMN_WIDTH + 4)).toBeUndefined()
    expect(columnAt(layout, -50)).toBeUndefined()
  })
})

describe('canvas', () => {
  /** A canvas whose topics React Flow has measured at 100 px. */
  function measured(state: MapState): CanvasState {
    const first = buildNodes([], state, {}).nodes
    const changes = new NodeChangeset<MapNode>(
      first
        .filter(node => node.type === 'topic')
        .map(node => ({
          id: node.id,
          type: 'dimensions',
          dimensions: { width: 264, height: 100 },
        }))
    )
    return canvasReducer(INITIAL_CANVAS, {
      type: 'changes',
      changes,
      map: state,
    })
  }
  const positions = (nodes: MapNode[]) =>
    Object.fromEntries(nodes.map(node => [node.id, node.position]))

  it('gives React Flow a column per header and a child node per topic', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    const { nodes } = buildNodes([], store.getState(), {})
    const headers = nodes.filter(node => node.type === 'header')
    const topics = nodes.filter(node => node.type === 'topic')
    expect(headers).toHaveLength(4)
    expect(topics).toHaveLength(7)
    // Parents come first, and every topic names its column.
    expect(nodes.slice(0, 4)).toEqual(headers)
    expect(
      topics.every(node => headers.some(header => header.id === node.parentId))
    ).toBe(true)
    expect(headers.every(node => node.draggable === false)).toBe(true)
  })

  it('returns the same node objects when nothing moved', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    const canvas = measured(store.getState())
    const once = buildNodes(canvas.nodes, store.getState(), canvas.manual).nodes
    const twice = buildNodes(once, store.getState(), canvas.manual).nodes
    twice.forEach((node, index) => expect(node).toBe(once[index]))
  })

  it('does not move any topic when cards arrive, only pushes those below', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    let canvas = measured(store.getState())
    const before = buildNodes(canvas.nodes, store.getState(), canvas.manual)
    const artwork = topicNamed(store.getState(), 'Artwork')
    const names = topicNamed(store.getState(), 'Name embroidery')

    for (let n = 1; n <= 20; n++) {
      addCard(store, artwork.id, { kind: 'note', text: `Card ${n}` })
    }
    // Twenty rows later the browser reports Artwork's new height.
    canvas = canvasReducer(canvas, {
      type: 'changes',
      map: store.getState(),
      changes: new NodeChangeset<MapNode>([
        {
          id: artwork.id,
          type: 'dimensions',
          dimensions: { width: 264, height: 100 + 20 * 56 },
        },
      ]),
    })
    const after = buildNodes(canvas.nodes, store.getState(), canvas.manual)

    const was = positions(before.nodes)
    const now = positions(after.nodes)
    for (const id of Object.keys(was)) {
      if (id === names.id) continue
      expect(now[id]).toEqual(was[id])
    }
    expect(now[names.id]).toEqual({
      x: was[names.id]?.x,
      y: (was[names.id]?.y ?? 0) + 20 * 56,
    })
  })

  it('keeps a dragged topic where it is dropped until tidy', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    const state = store.getState()
    const artwork = topicNamed(state, 'Artwork')
    let canvas = measured(state)
    const home = positions(buildNodes(canvas.nodes, state, {}).nodes)[
      artwork.id
    ]
    const drag = (position: { x: number; y: number }, dragging: boolean) => {
      canvas = canvasReducer(canvas, {
        type: 'changes',
        map: state,
        changes: new NodeChangeset<MapNode>([
          { id: artwork.id, type: 'position', position, dragging },
        ]),
      })
      return positions(buildNodes(canvas.nodes, state, canvas.manual).nodes)[
        artwork.id
      ]
    }

    // While it is held, the pointer decides.
    expect(drag({ x: 60, y: 500 }, true)).toEqual({ x: 60, y: 500 })
    expect(canvas.manual).toEqual({})
    // Let go: it stays.
    expect(drag({ x: 70, y: 520 }, false)).toEqual({ x: 70, y: 520 })
    expect(canvas.manual).toEqual({ [artwork.id]: { x: 70, y: 520 } })

    // New cards elsewhere do not bring it back.
    addCard(store, topicNamed(state, 'Pricing').id, { kind: 'note', text: 'x' })
    expect(
      positions(
        buildNodes(canvas.nodes, store.getState(), canvas.manual).nodes
      )[artwork.id]
    ).toEqual({ x: 70, y: 520 })

    canvas = canvasReducer(canvas, { type: 'tidy' })
    expect(
      positions(
        buildNodes(canvas.nodes, store.getState(), canvas.manual).nodes
      )[artwork.id]
    ).toEqual(home)
  })

  it('lets a topic that changed column flow with its new column', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    const artwork = topicNamed(store.getState(), 'Artwork')
    let canvas = measured(store.getState())
    canvas = canvasReducer(canvas, {
      type: 'place',
      id: artwork.id,
      position: { x: 300, y: 40 },
    })
    const suppliers = headersOf(store.getState())[1]
    moveTopic(store, artwork.id, suppliers?.id ?? '')
    canvas = canvasReducer(canvas, { type: 'forget', id: artwork.id })

    const node = buildNodes(
      canvas.nodes,
      store.getState(),
      canvas.manual
    ).nodes.find(row => row.id === artwork.id)
    expect(node).toMatchObject({
      parentId: suppliers?.id,
      position: { x: COLUMN_PADDING, y: COLUMN_HEADER + 100 + TOPIC_GAP },
    })
  })
})
