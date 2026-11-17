import type { NodeChangeset } from '@xyflow/react'
import type { MapState } from '@/engine/model'
import type { Point } from './layout'
import { buildNodes, type MapNode } from './nodes'

// What the canvas remembers that the map does not: the nodes as React Flow
// last reported them (measured sizes, a drag in progress) and the positions
// the host chose by dragging. The nodes handed to React Flow are derived from
// this and the map on every render (nodes.ts), so there is nothing to keep in
// sync.

export interface CanvasState {
  nodes: MapNode[]
  /** Topic id → where it was dropped, relative to its column. */
  manual: Readonly<Record<string, Point>>
}

export type CanvasAction =
  /** React Flow measured or moved something. `map` is the map right now. */
  | { type: 'changes'; changes: NodeChangeset<MapNode>; map: MapState }
  /** A topic was dropped: it stays here until tidy. */
  | { type: 'place'; id: string; position: Point }
  /** A topic changed column: it flows with its new column. */
  | { type: 'forget'; id: string }
  /** Lay everything out afresh. */
  | { type: 'tidy' }

export const INITIAL_CANVAS: CanvasState = { nodes: [], manual: {} }

export function canvasReducer(
  state: CanvasState,
  action: CanvasAction
): CanvasState {
  switch (action.type) {
    case 'changes': {
      const shown = buildNodes(state.nodes, action.map, state.manual).nodes
      const nodes = action.changes.applyTo(shown)
      // The moment a drag ends, where the topic is becomes where it stays.
      const wasDragging = new Set(
        shown.filter(node => node.dragging).map(node => node.id)
      )
      let manual = state.manual
      for (const node of nodes) {
        if (
          node.type === 'topic' &&
          wasDragging.has(node.id) &&
          !node.dragging
        ) {
          manual = { ...manual, [node.id]: node.position }
        }
      }
      return { nodes, manual }
    }
    case 'place':
      return {
        ...state,
        manual: { ...state.manual, [action.id]: action.position },
      }
    case 'forget': {
      const { [action.id]: _gone, ...manual } = state.manual
      return { ...state, manual }
    }
    case 'tidy':
      return { ...state, manual: {} }
  }
}
