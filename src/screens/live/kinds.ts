import {
  openSuggestions,
  type CardKind,
  type MapState,
  type Suggestion,
} from '@/engine/model'

// Card kinds never rely on colour alone (UI_SPEC §4.7): each has an icon and
// a name, and its colour is the same token as the card's 3 px bar.

export const KIND_LABEL: Record<CardKind, string> = {
  note: 'Note',
  decision: 'Decision',
  action: 'Action',
  research: 'Research',
  quote: 'Quote',
}

/** The order kinds are counted in when cards are collapsed. */
export const KIND_ORDER: readonly CardKind[] = [
  'decision',
  'action',
  'note',
  'research',
  'quote',
]

/**
 * What a card looks like on the map. What was decided and what is owed are
 * filled blocks, so they are found at a glance; a note is plain text and
 * stays out of their way.
 */
export const KIND_BLOCK: Record<CardKind, string> = {
  note: 'hover:bg-surface-2',
  decision: 'bg-accent-soft',
  action: 'bg-action-soft',
  research: 'bg-surface-2',
  quote: 'bg-quote/45',
}

/** Open move and merge suggestions that would land in this topic. */
export function ghostsFor(state: MapState, topicId: string): Suggestion[] {
  return openSuggestions(state).filter(({ payload }) => {
    if (payload.kind === 'move') {
      return payload.to_topic_id === topicId && !!state.cards[payload.card_id]
    }
    if (payload.kind === 'merge') {
      return (
        payload.into_topic_id === topicId && !!state.topics[payload.topic_id]
      )
    }
    return false
  })
}
