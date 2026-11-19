import dagre from '@dagrejs/dagre'
import {
  cardsIn,
  headersOf,
  openSuggestions,
  topicsUnder,
  type MapState,
  type Topic,
} from '@/engine/model'

// Where everything on the map sits, docs/UI_SPEC.md §2.2. One column per
// agenda header, left to right in agenda order, then the off-agenda area
// once it has a topic. Inside an agenda column the topics stack top to
// bottom. Off the agenda each topic is a column of its own, side by side in
// the order they came up: a new subject opens to the right and the board
// fills up across, instead of one long list (Matt, 2026-11-20, after a call
// with no agenda put fifteen topics in one column). Nothing sits to the
// right of that area, so a new topic there moves nothing. dagre does the
// passes: `rankdir: LR` across, `rankdir: TB` within a column.
//
// The layout is a pure function of the map, the measured heights and the
// positions the host chose by dragging. A dragged topic stays where it was
// put until "tidy" forgets it; the rest of its column flows around nothing,
// as if it were not there.

export const TOPIC_WIDTH = 264
export const COLUMN_PADDING = 8
export const COLUMN_WIDTH = TOPIC_WIDTH + COLUMN_PADDING * 2
export const COLUMN_GAP = 16
export const TOPIC_GAP = 8
/** The column's own title row. */
export const COLUMN_HEADER = 36
const EMPTY_COLUMN = COLUMN_HEADER + 48

export interface Point {
  x: number
  y: number
}

export interface ColumnBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface TopicBox {
  id: string
  headerId: string
  /** Relative to the column. */
  x: number
  y: number
  height: number
  /** Placed by hand, not by the layout. */
  manual: boolean
}

export interface MapLayout {
  columns: ColumnBox[]
  topics: TopicBox[]
}

/** A pinned topic that has not been revisited is a one-line marker. */
export const isPinMarker = (topic: Topic) =>
  topic.status === 'pinned' && topic.revisited_t_ms === null

/** A guess at a topic's height, used until the browser has measured it. */
export function estimateHeight(state: MapState, topic: Topic): number {
  if (isPinMarker(topic)) return 32
  const ghosts = openSuggestions(state).filter(
    ({ payload }) =>
      (payload.kind === 'move' && payload.to_topic_id === topic.id) ||
      (payload.kind === 'merge' && payload.into_topic_id === topic.id)
  ).length
  return 37 + cardsIn(state, topic.id).length * 56 + Math.min(ghosts, 3) * 60
}

/** Columns that are drawn: the agenda, and Unplanned when it is in use. */
export function visibleHeaders(state: MapState): Topic[] {
  return headersOf(state).filter(
    header => !header.off_agenda || topicsUnder(state, header.id).length > 0
  )
}

/** Stacks boxes along one axis with dagre and returns each one's offset. */
function stack(
  sizes: readonly { id: string; size: number }[],
  rankdir: 'TB' | 'LR',
  gap: number
): Map<string, number> {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir, ranksep: gap, nodesep: 0, marginx: 0, marginy: 0 })
  graph.setDefaultEdgeLabel(() => ({}))
  sizes.forEach(({ id, size }, index) => {
    graph.setNode(
      id,
      rankdir === 'TB'
        ? { width: TOPIC_WIDTH, height: size }
        : { width: size, height: 1 }
    )
    const previous = sizes[index - 1]
    if (previous) graph.setEdge(previous.id, id)
  })
  dagre.layout(graph)

  const offsets = new Map<string, number>()
  for (const { id, size } of sizes) {
    const node = graph.node(id)
    const centre = rankdir === 'TB' ? node.y : node.x
    offsets.set(id, Math.round(centre - size / 2))
  }
  // dagre's origin is its own; ours is the first box.
  const origin = Math.min(...offsets.values(), Infinity)
  for (const [id, offset] of offsets) offsets.set(id, offset - origin)
  return offsets
}

export function layoutMap(
  state: MapState,
  heights: ReadonlyMap<string, number>,
  manual: Readonly<Record<string, Point>>
): MapLayout {
  const headers = visibleHeaders(state)
  const topics: TopicBox[] = []
  const columnHeights = new Map<string, number>()
  const columnWidths = new Map<string, number>()

  for (const header of headers) {
    const rows = topicsUnder(state, header.id).map(topic => ({
      topic,
      height: heights.get(topic.id) ?? estimateHeight(state, topic),
    }))
    const flowing = rows.filter(row => !manual[row.topic.id])
    const across = header.off_agenda
    const offsets = across
      ? stack(
          flowing.map(row => ({ id: row.topic.id, size: TOPIC_WIDTH })),
          'LR',
          COLUMN_GAP
        )
      : stack(
          flowing.map(row => ({ id: row.topic.id, size: row.height })),
          'TB',
          TOPIC_GAP
        )

    let bottom = COLUMN_HEADER
    let right = COLUMN_PADDING + TOPIC_WIDTH
    for (const { topic, height } of rows) {
      const placed = manual[topic.id]
      const offset = offsets.get(topic.id) ?? 0
      const box: TopicBox = {
        id: topic.id,
        headerId: header.id,
        x: placed?.x ?? COLUMN_PADDING + (across ? offset : 0),
        y: placed?.y ?? COLUMN_HEADER + (across ? 0 : offset),
        height,
        manual: placed !== undefined,
      }
      topics.push(box)
      bottom = Math.max(bottom, box.y + height)
      right = Math.max(right, box.x + TOPIC_WIDTH)
    }
    columnHeights.set(
      header.id,
      rows.length === 0 ? EMPTY_COLUMN : bottom + COLUMN_PADDING
    )
    columnWidths.set(
      header.id,
      across && rows.length > 0 ? right + COLUMN_PADDING : COLUMN_WIDTH
    )
  }

  const offsets = stack(
    headers.map(header => ({
      id: header.id,
      size: columnWidths.get(header.id) ?? COLUMN_WIDTH,
    })),
    'LR',
    COLUMN_GAP
  )
  return {
    columns: headers.map(header => ({
      id: header.id,
      x: offsets.get(header.id) ?? 0,
      y: 0,
      width: columnWidths.get(header.id) ?? COLUMN_WIDTH,
      height: columnHeights.get(header.id) ?? EMPTY_COLUMN,
    })),
    topics,
  }
}

/** The column whose horizontal span holds `x`, in map coordinates. */
export function columnAt(layout: MapLayout, x: number): ColumnBox | undefined {
  return layout.columns.find(
    column => x >= column.x && x <= column.x + column.width
  )
}
