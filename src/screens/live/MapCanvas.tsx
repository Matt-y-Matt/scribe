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
  type NodeTypes,
  type OnNodeDrag,
  type Viewport,
} from '@xyflow/react'
import { ArrowDown } from 'lucide-react'
import { useEffect, useRef, useState, type ActionDispatch } from 'react'
import { Button } from '@/components/ui/button'
import { moveCard, moveTopic, pinTopic } from '@/engine/actions'
import type { Card } from '@/engine/model'
import type { CanvasAction, CanvasState } from './canvas-state'
import { CardFace, type DropTarget } from './CardRow'
import { KIND_BAR } from './kinds'
import { columnAt, TOPIC_WIDTH } from './layout'
import { useLive } from './live-context'
import { HeaderColumn, TopicNodeView } from './MapNodes'
import { buildNodes, type MapNode } from './nodes'

// The map, UI_SPEC §2.2: a React Flow canvas of header columns and topics.
// The viewport belongs to the host. Nothing here pans or zooms by itself
// (rule 4.2): fit, tidy and the "new cards" pill act only when pressed.

export const MIN_ZOOM = 0.4
export const MAX_ZOOM = 1.5
/** Below this, cards collapse to kind icons with counts. */
export const COLLAPSE_ZOOM = 0.7

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
}

function Flow({ canvas, dispatch, initialViewport, onZoom }: MapCanvasProps) {
  const { store, state, tidy, activeTopicId } = useLive()
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
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [store, flow, tidy, activeTopicId])

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
          onNodesChange={changes =>
            dispatch({ type: 'changes', changes, map: store.getState() })
          }
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
