import { X } from 'lucide-react'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { acceptSuggestion, dismissSuggestion } from '@/engine/actions'
import type { Suggestion } from '@/engine/model'
import { ghostsFor } from './kinds'
import { useLive } from './live-context'

// Ghosts, UI_SPEC §2.2: a suggested move or merge is a dashed outline at 60%
// until someone accepts it. Nothing on the map changes before that. At most
// three show per topic; older ones wait behind "+2 suggestions".

const MAX_GHOSTS = 3

const textButton =
  'nodrag nopan rounded-md px-1 text-secondary font-semibold transition-opacity duration-150 ease-out hover:opacity-80'

/** The dashed frame every ghost shares, with its two answers. */
export function GhostFrame({
  suggestionId,
  accept = 'Accept',
  dismiss,
  children,
}: {
  suggestionId: string
  accept?: string
  /** Text for the second button; an ✕ when left out. */
  dismiss?: string
  children: ReactNode
}) {
  const { store } = useLive()
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    dismissSuggestion(store, suggestionId)
  }
  return (
    <div
      data-suggestion-id={suggestionId}
      onKeyDown={onKeyDown}
      className="rounded-md border border-dashed border-pin px-2 py-1"
    >
      <div className="text-secondary opacity-60">{children}</div>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          className={`${textButton} -ml-1 text-accent`}
          onClick={() => acceptSuggestion(store, suggestionId)}
        >
          {accept}
        </button>
        <button
          type="button"
          aria-label={dismiss ? undefined : 'Dismiss'}
          className={`${textButton} text-text-muted`}
          onClick={() => dismissSuggestion(store, suggestionId)}
        >
          {dismiss ?? <X size={12} aria-hidden />}
        </button>
      </div>
    </div>
  )
}

function Ghost({ suggestion }: { suggestion: Suggestion }) {
  const { state } = useLive()
  const { payload } = suggestion
  const reason = 'reason' in payload && payload.reason

  let body: ReactNode = null
  if (payload.kind === 'move') {
    const card = state.cards[payload.card_id]
    const from = state.topics[card?.topic_id ?? '']
    body = (
      <>
        <span className="font-semibold">Move here</span> from {from?.title}: “
        {card?.text}”
      </>
    )
  } else if (payload.kind === 'merge') {
    body = (
      <>
        <span className="font-semibold">Merge</span> “
        {state.topics[payload.topic_id]?.title}” into this topic
      </>
    )
  }

  return (
    <GhostFrame suggestionId={suggestion.id}>
      <p>{body}</p>
      {reason && <p className="text-meta">{reason}</p>}
    </GhostFrame>
  )
}

/** The ghosts at the end of a topic's card list. */
export function TopicGhosts({ topicId }: { topicId: string }) {
  const { state } = useLive()
  const [showAll, setShowAll] = useState(false)
  const ghosts = ghostsFor(state, topicId)
  if (ghosts.length === 0) return null

  const hidden = showAll ? 0 : Math.max(0, ghosts.length - MAX_GHOSTS)
  return (
    <div className="flex flex-col gap-1 border-t p-1">
      {hidden > 0 && (
        <button
          type="button"
          className={`${textButton} self-start text-text-muted`}
          onClick={() => setShowAll(true)}
        >
          +{hidden} {hidden === 1 ? 'suggestion' : 'suggestions'}
        </button>
      )}
      {ghosts.slice(hidden).map(suggestion => (
        <Ghost key={suggestion.id} suggestion={suggestion} />
      ))}
    </div>
  )
}
