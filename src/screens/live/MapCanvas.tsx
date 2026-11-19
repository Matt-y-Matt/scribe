import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useOnViewportChange,
  useReactFlow,
  type NodeChangeset,
  type NodeTypes,
  type OnNodeDrag,
  type Viewport,
} from '@xyflow/react'
import { ArrowDown } from 'lucide-react'
import { useEffect, useRef, useState, type ActionDispatch } from 'react'
import { Button } from '@/components/ui/button'
import { addTopic, moveCard, moveTopic, pinTopic } from '@/engine/actions'
import { headersOf, type Card, type CardKind } from '@/engine/model'
import type { CanvasAction, CanvasState } from './canvas-state'
import { CardFace, type DropTarget } from './CardRow'
import { KIND_BAR } from './kinds'
import { columnAt, TOPIC_WIDTH } from './layout'
import { useLive } from './live-context'
import { HeaderColumn, TopicNodeView } from './MapNodes'
import { buildNodes, type MapNode } from './nodes'
import { holdTyping } from './type-ahead'

// The map, UI_SPEC §2.2: a React Flow canvas of header columns and topics.
// The viewport belongs to the host. Nothing here pans or zooms by itself
// (rule 4.2): fit, tidy and the "new cards" pill act only when pressed.

export const MIN_ZOOM = 0.4
export const MAX_ZOOM = 1.5
/** Below this, cards collapse to kind icons with counts. */
export const COLLAPSE_ZOOM = 0.7

/** Room for the new-card box under a topic, in map pixels. */
const EDITOR_HEIGHT = 190
/** The strip at the bottom of the map where Tidy, Fit and zoom sit. */
const CONTROLS_HEIGHT = 56

const NODE_TYPES: NodeTypes = { header: HeaderColumn, topic: TopicNodeView }

const FIT = { padding: 0.04, minZoom: MIN_ZOOM, maxZoom: 1, duration: 0 }

/** A card under the pointer wins over the topic it sits in. */
const cardThenTopic: CollisionDetection = args => {
  const hits = pointerWithin(args)
  const card = hits.find(hit => String(hit.id).startsWith('card:'))
  return card ? [card] : hits
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export interface MapCanvasProps {
  canvas: CanvasState
  dispatch: ActionDispatch<[action: CanvasAction]>
  initialViewport: Viewport
  onZoom: (zoom: number) => void
  /**
   * The column or topic the host asked to see, and a count that changes per
   * ask.
   */
  focus: { nodeId: string; ask: number } | null
}

function Flow({
  canvas,
  dispatch,
  initialViewport,
  onZoom,
  focus,
}: MapCanvasProps) {
  const { store, state, tidy, activeTopicId, setEditingId } = useLive()
  const flow = useReactFlow<MapNode>()
  const wrapper = useRef<HTMLDivElement>(null)
  const [dragged, setDragged] = useState<Card | null>(null)
  /** A topic that gained cards where the host cannot see them. */
  const [unseen, setUnseen] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  const { nodes, layout } = buildNodes(canvas.nodes, state, canvas.manual)

  useOnViewportChange({
    onChange: viewport => onZoom(viewport.zoom),
    onEnd: () => setUnseen(null),
  })

  // New cards never move the viewport. If they land out of sight, say so.
  useEffect(() => {
    let known = new Set(Object.keys(store.getState().cards))
    const inView = (topicId: string) => {
      const node = flow.getInternalNode(topicId)
      const frame = wrapper.current?.getBoundingClientRect()
      if (!node || !frame) return true
      const { x, y, zoom } = flow.getViewport()
      const left = node.internals.positionAbsolute.x * zoom + x
      const bottom =
        (node.internals.positionAbsolute.y + (node.measured.height ?? 0)) *
          zoom +
        y
      return (
        bottom >= 0 &&
        bottom <= frame.height &&
        left + TOPIC_WIDTH * zoom > 0 &&
        left < frame.width
      )
    }
    return store.subscribe(() => {
      const cards = store.getState().cards
      const added = Object.values(cards).filter(card => !known.has(card.id))
      known = new Set(Object.keys(cards))
      if (added.length === 0) return
      // Look once the new rows have been laid out and measured.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const hidden = added.find(card => !inView(card.topic_id))
          if (hidden) setUnseen(hidden.topic_id)
        })
      )
    })
  }, [store, flow])

  // An agenda chip was clicked, or a search result picked: put that column
  // at the left edge, and a topic near the top as well. The host asked, so
  // this is not the map moving by itself (rule 4.2).
  useEffect(() => {
    if (!focus) return
    const node = flow.getInternalNode(focus.nodeId)
    if (!node) return
    const { y, zoom } = flow.getViewport()
    const at = node.internals.positionAbsolute
    void flow.setViewport(
      {
        x: 16 - at.x * zoom,
        // A topic is shown with its column's title still above it.
        y: node.type === 'topic' ? 56 - at.y * zoom : y,
        zoom,
      },
      { duration: 0 }
    )
  }, [focus, flow])

  // N, A, D: write a note, an action or a decision on the topic on the
  // table, without reaching for the mouse.
  const writeCard = (kind: CardKind) => {
    const map = store.getState()
    const [header] = headersOf(map)
    const topicId =
      activeTopicId ??
      Object.values(map.topics).find(topic => topic.kind === 'topic')?.id ??
      // Nothing has been said yet: the host's notes get a topic of their own.
      (header && addTopic(store, header.id, 'Notes')?.id)
    if (!topicId) return
    // People type at once; the box needs a moment. Nothing typed is lost.
    holdTyping()
    setEditingId(`new:${kind}:${topicId}`)
    // The host asked to write there, so the map may go there (rule 4.2),
    // but only if the box, which opens at the end of the topic, would be
    // out of sight. Then the end of the topic is brought to the bottom edge.
    const node = flow.getInternalNode(topicId)
    const frame = wrapper.current?.getBoundingClientRect()
    if (!node || !frame) return
    const { x, y, zoom } = flow.getViewport()
    const at = node.internals.positionAbsolute
    const end = at.y + (node.measured.height ?? 0) + EDITOR_HEIGHT
    const left = at.x * zoom + x
    const seenAcross = left >= 0 && left + TOPIC_WIDTH * zoom <= frame.width
    const seenDown =
      end * zoom + y <= frame.height - CONTROLS_HEIGHT &&
      (end - EDITOR_HEIGHT) * zoom + y >= 0
    if (seenAcross && seenDown) return
    void flow.setViewport(
      {
        x: seenAcross ? x : 16 - at.x * zoom,
        y: seenDown ? y : frame.height - CONTROLS_HEIGHT - end * zoom,
        zoom,
      },
      { duration: 0 }
    )
  }
  const keys = useRef({ writeCard })
  useEffect(() => {
    keys.current = { writeCard }
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.altKey) return
      const key = event.key.toLowerCase()
      if (event.ctrlKey || event.metaKey) {
        if (key === 'z') {
          event.preventDefault()
          if (event.shiftKey) store.redo()
          else store.undo()
        } else if (key === 'y') {
          event.preventDefault()
          store.redo()
        }
        return
      }
      if (key === 'f') void flow.fitView(FIT)
      if (key === 't') tidy()
      // P pins the topic on the table (UI_SPEC §4.6); Ctrl+Z takes it back.
      if (key === 'p' && activeTopicId) pinTopic(store, activeTopicId)
      const kind = ({ n: 'note', a: 'action', d: 'decision' } as const)[key]
      if (kind) {
        // Not into the box that is about to open.
        event.preventDefault()
        keys.current.writeCard(kind)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [store, flow, tidy, activeTopicId])

  const onNodesChange = (changes: NodeChangeset<MapNode>) => {
    const apply = () =>
      dispatch({ type: 'changes', changes, map: store.getState() })
    // A drag is applied at once. A measurement re-lays its column out, which
    // resizes the column; inside the browser's resize callback that raises
    // "ResizeObserver loop" errors, so it waits for the next frame.
    if (changes.getByType('position').length > 0) apply()
    else requestAnimationFrame(apply)
  }

  const onNodeDragStop: OnNodeDrag<MapNode> = (_event, node) => {
    if (node.type !== 'topic') return
    const from = layout.columns.find(column => column.id === node.parentId)
    const centre = (from?.x ?? 0) + node.position.x + TOPIC_WIDTH / 2
    const over = columnAt(layout, centre)
    if (over && over.id !== node.parentId) {
      // Dropped on another header: the topic belongs to that column now.
      moveTopic(store, node.id, over.id)
      dispatch({ type: 'forget', id: node.id })
    } else {
      dispatch({ type: 'place', id: node.id, position: node.position })
    }
  }

  const onDragStart = (event: DragStartEvent) =>
    setDragged(store.getState().cards[String(event.active.id)] ?? null)

  const onDragEnd = (event: DragEndEvent) => {
    setDragged(null)
    const target = event.over?.data.current as DropTarget | undefined
    if (!target) return
    const cardId = String(event.active.id)
    // Dropping a card is the confirmation (UI_SPEC §2.2); Ctrl+Z undoes it.
    if (target.type === 'card') {
      moveCard(store, cardId, target.topicId, target.cardId)
    } else {
      moveCard(store, cardId, target.topicId)
    }
  }

  const showUnseen = () => {
    const node = unseen ? flow.getInternalNode(unseen) : undefined
    setUnseen(null)
    if (!node) return
    void flow.setCenter(
      node.internals.positionAbsolute.x + TOPIC_WIDTH / 2,
      node.internals.positionAbsolute.y + (node.measured.height ?? 0),
      { zoom: flow.getZoom(), duration: 0 }
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={cardThenTopic}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragged(null)}
    >
      <div ref={wrapper} className="h-full w-full" data-testid="map">
        <ReactFlow<MapNode>
          nodes={nodes}
          edges={[]}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          defaultViewport={initialViewport}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          autoPanOnNodeDrag={false}
          disableKeyboardA11y
          attributionPosition="top-right"
        >
          <MiniMap
            pannable
            zoomable
            ariaLabel="Minimap"
            style={{ width: 160, height: 100 }}
            nodeColor={node =>
              node.type === 'header' ? 'transparent' : 'var(--border)'
            }
            nodeStrokeColor="transparent"
          />
          <Panel position="bottom-left" className="flex gap-1">
            <Button variant="outline" size="sm" onClick={tidy} title="Tidy (T)">
              Tidy
            </Button>
            <Button
              variant="outline"
              size="sm"
              title="Fit (F)"
              onClick={() => void flow.fitView(FIT)}
            >
              Fit
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="Zoom out"
              onClick={() => void flow.zoomOut({ duration: 0 })}
            >
              −
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="Zoom in"
              onClick={() => void flow.zoomIn({ duration: 0 })}
            >
              +
            </Button>
          </Panel>
          {unseen && (
            <Panel position="bottom-right" style={{ bottom: 112 }}>
              <Button variant="outline" size="sm" onClick={showUnseen}>
                new cards <ArrowDown size={12} aria-hidden />
              </Button>
            </Panel>
          )}
        </ReactFlow>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragged && (
          <div
            className={`flex w-[258px] cursor-grabbing items-start gap-2 rounded-md border border-l-[3px] bg-surface py-1 pr-2 pl-[5px] ${KIND_BAR[dragged.kind]}`}
          >
            <CardFace card={dragged} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

export function MapCanvas(props: MapCanvasProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  )
}
