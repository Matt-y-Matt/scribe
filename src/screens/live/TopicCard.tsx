import { useDroppable } from '@dnd-kit/core'
import { Pin } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { renameTopic } from '@/engine/actions'
import {
  CARD_KINDS,
  cardsIn,
  openSuggestions,
  type Card,
  type CardKind,
  type Topic,
} from '@/engine/model'
import { cn } from '@/lib/utils'
import { CardEditor } from './CardEditor'
import { CardRow, type DropTarget } from './CardRow'
import { GhostFrame, TopicGhosts } from './Ghosts'
import { KindIcon } from './KindIcon'
import { KIND_LABEL, KIND_ORDER } from './kinds'
import { isPinMarker } from './layout'
import { useLive } from './live-context'
import { TopicMenu } from './TopicMenu'

// A topic on the map, UI_SPEC §2.2: a title row, then its cards as rows,
// then any ghosts. 264 px wide (the spec allows 240–320).

const FRAME = 'w-[264px] rounded-md border bg-surface text-text'

/** Below zoom 0.7: kind icons with counts instead of the rows. */
function KindCounts({ cards }: { cards: Card[] }) {
  const counts = new Map<CardKind, number>()
  for (const card of cards) {
    counts.set(card.kind, (counts.get(card.kind) ?? 0) + 1)
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 px-2 py-2 text-header">
      {KIND_ORDER.filter(kind => counts.has(kind)).map(kind => (
        <li
          key={kind}
          title={KIND_LABEL[kind]}
          className="flex items-center gap-1"
        >
          <KindIcon kind={kind} size={16} />
          <span className="font-mono">{counts.get(kind)}</span>
        </li>
      ))}
    </ul>
  )
}

function TitleInput({ topic, onDone }: { topic: Topic; onDone: () => void }) {
  const { store } = useLive()
  const [title, setTitle] = useState(topic.title)
  const commit = () => {
    renameTopic(store, topic.id, title)
    onDone()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === 'Enter') commit()
    if (event.key === 'Escape') onDone()
  }
  return (
    <input
      autoFocus
      aria-label="Topic title"
      value={title}
      onChange={event => setTitle(event.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      className="nodrag nopan min-w-0 flex-1 rounded-md border bg-surface px-1 text-header font-semibold"
    />
  )
}

/** A pinned topic leaves a small marker in its column; the rail has the rest. */
function PinMarker({ topic }: { topic: Topic }) {
  return (
    <div
      data-topic-id={topic.id}
      data-pinned
      className="flex h-8 w-[264px] items-center gap-2 rounded-md border border-dashed border-aside bg-aside-soft px-2 text-secondary"
    >
      <Pin size={12} aria-hidden className="shrink-0 text-aside" />
      <span className="min-w-0 flex-1 truncate">{topic.title}</span>
      <span className="text-meta text-aside">pinned</span>
    </div>
  )
}

export function TopicCard({ topicId }: { topicId: string }) {
  const {
    state,
    activeTopicId,
    setActiveTopicId,
    collapsed,
    editingId,
    setEditingId,
  } = useLive()
  const [renaming, setRenaming] = useState(false)
  const target: DropTarget = { type: 'topic', topicId }
  const { setNodeRef, isOver } = useDroppable({
    id: `topic:${topicId}`,
    data: target,
  })

  const topic = state.topics[topicId]
  if (!topic) return null
  if (isPinMarker(topic)) return <PinMarker topic={topic} />

  const cards = cardsIn(state, topic.id)
  const pinGhost = openSuggestions(state).find(
    ({ payload }) => payload.kind === 'pin' && payload.topic_id === topic.id
  )
  const active = activeTopicId === topic.id
  // "new:<kind>:<topic id>": a card being written here, of that kind.
  const adding =
    editingId?.startsWith('new:') && editingId.endsWith(`:${topic.id}`)
  const addingKind = CARD_KINDS.find(
    kind => editingId === `new:${kind}:${topic.id}`
  )

  return (
    <section
      ref={setNodeRef}
      data-topic-id={topic.id}
      data-active={active || undefined}
      aria-label={topic.title}
      onClick={() => setActiveTopicId(topic.id)}
      className={cn(
        FRAME,
        pinGhost && 'border-dashed border-aside',
        // A ghost stays grey until it is answered, even when it is active.
        ((active && !pinGhost) || isOver) && 'border-accent'
      )}
    >
      {pinGhost ? (
        // Off-agenda talk: a ghost topic asking to be pinned (UI_SPEC §2.2).
        <div className="p-1">
          <GhostFrame
            suggestionId={pinGhost.id}
            accept="Pin"
            dismiss="Keep here"
          >
            <p>
              New topic: <span className="font-semibold">{topic.title}</span> —
              Pin it?
            </p>
          </GhostFrame>
        </div>
      ) : (
        <header className="flex h-9 items-center gap-2 pr-1 pl-3">
          {renaming ? (
            <TitleInput topic={topic} onDone={() => setRenaming(false)} />
          ) : (
            <h3 className="min-w-0 flex-1 truncate text-header font-semibold">
              {topic.title}
            </h3>
          )}
          <span
            className="text-meta text-text-muted"
            aria-label={`${cards.length} cards`}
          >
            {cards.length}
          </span>
          <TopicMenu
            topic={topic}
            onRename={() => setRenaming(true)}
            onAddCard={() => setEditingId(`new:note:${topic.id}`)}
          />
        </header>
      )}

      {collapsed && !adding ? (
        <KindCounts cards={cards} />
      ) : (
        <ul
          className={cn(
            'flex min-h-2 flex-col gap-0.5 px-1 pb-1',
            pinGhost && 'pt-1'
          )}
        >
          {cards.map(card => (
            <CardRow key={card.id} card={card} />
          ))}
          {adding && (
            <li className="nodrag nopan flex rounded-md border border-accent bg-surface px-2">
              <CardEditor
                key={addingKind}
                topicId={topic.id}
                kind={addingKind}
                onDone={() => setEditingId(null)}
              />
            </li>
          )}
        </ul>
      )}
      {!collapsed && <TopicGhosts topicId={topic.id} />}
      {topic.status === 'pinned' && (
        <p className="flex items-center gap-1 border-t px-2 py-1 text-meta text-text-muted">
          <Pin size={10} aria-hidden /> pinned, revisited
        </p>
      )}
    </section>
  )
}
