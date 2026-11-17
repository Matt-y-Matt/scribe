import type { Node } from '@xyflow/react'
import type { MapState } from '@/engine/model'
import { layoutMap, type MapLayout, type Point } from './layout'

// The map as React Flow nodes. Header columns are group nodes; topics are
// their children and render their cards as rows (cards are not nodes, which
// keeps a map of 500 cards cheap). Nodes carry ids only: the components read
// the map itself from context.

export type HeaderNode = Node<{ headerId: string }, 'header'>
export type TopicNode = Node<{ topicId: string }, 'topic'>
export type MapNode = HeaderNode | TopicNode

export interface BuiltNodes {
  nodes: MapNode[]
  layout: MapLayout
}

const samePlace = (a: Point, b: Point) => a.x === b.x && a.y === b.y

/**
 * Lays the map out and returns the nodes for it. `previous` is what React
 * Flow last had: its measured heights feed the layout, a node being dragged
 * keeps the position the pointer gave it, and a node that has not changed is
 * returned as the same object so nothing re-renders for it.
 */
export function buildNodes(
  previous: readonly MapNode[],
  state: MapState,
  manual: Readonly<Record<string, Point>>
): BuiltNodes {
  const before = new Map(previous.map(node => [node.id, node]))
  const heights = new Map<string, number>()
  for (const node of previous) {
    const height = node.measured?.height
    if (node.type === 'topic' && height !== undefined) {
      heights.set(node.id, height)
    }
  }
  const layout = layoutMap(state, heights, manual)

  const headers = layout.columns.map((column): MapNode => {
    const old = before.get(column.id)
    const position = { x: column.x, y: column.y }
    if (
      old?.type === 'header' &&
      samePlace(old.position, position) &&
      old.width === column.width &&
      old.height === column.height
    ) {
      return old
    }
    return {
      ...(old?.type === 'header' ? old : {}),
      id: column.id,
      type: 'header',
      position,
      width: column.width,
      height: column.height,
      data: { headerId: column.id },
      draggable: false,
      selectable: false,
      focusable: false,
    }
  })

  const topics = layout.topics.map((box): MapNode => {
    const old = before.get(box.id)
    const kept = old?.type === 'topic' ? old : undefined
    // While the pointer holds a topic, the pointer decides where it is.
    const position = kept?.dragging ? kept.position : { x: box.x, y: box.y }
    if (
      kept &&
      kept.parentId === box.headerId &&
      samePlace(kept.position, position)
    ) {
      return kept
    }
    return {
      ...kept,
      id: box.id,
      type: 'topic',
      parentId: box.headerId,
      position,
      data: { topicId: box.id },
      selectable: false,
    }
  })

  // React Flow wants a parent before its children.
  return { nodes: [...headers, ...topics], layout }
}
