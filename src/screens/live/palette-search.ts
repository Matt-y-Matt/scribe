import type { MapState } from '@/engine/model'
import type { SegmentFinal } from '@/ipc'
import { isPinMarker } from './layout'

// What Ctrl+K finds in a meeting (UI_SPEC §4.6): topics, cards and lines of
// the transcript. Plain matching on what is already in memory: every word
// typed must be there, in any order. Fast enough to run on each keystroke.

export type PaletteHit =
  | { type: 'topic'; id: string; text: string; meta: string }
  | {
      type: 'card'
      id: string
      topicId: string
      text: string
      meta: string
      kind: MapState['cards'][string]['kind']
    }
  | {
      type: 'line'
      id: string
      text: string
      meta: string
      t0Ms: number
      t1Ms: number
    }

export const PALETTE_LIMITS = { topic: 6, card: 8, line: 8 }

const wordsOf = (query: string) =>
  query.toLowerCase().split(/\s+/).filter(Boolean)

const has = (text: string, words: readonly string[]) => {
  const lower = text.toLowerCase()
  return words.every(word => lower.includes(word))
}

export function searchMeeting(
  state: MapState,
  segments: readonly SegmentFinal[],
  query: string,
  clock: (ms: number) => string
): PaletteHit[] {
  const words = wordsOf(query)
  const topics = Object.values(state.topics)
    .filter(topic => topic.kind === 'topic')
    .sort((a, b) => a.created_t_ms - b.created_t_ms)
  const headerOf = (parentId: string | null) =>
    (parentId && state.topics[parentId]?.title) || ''

  const topicHits: PaletteHit[] = topics
    .filter(topic => has(topic.title, words))
    .slice(0, PALETTE_LIMITS.topic)
    .map(topic => ({
      type: 'topic',
      id: topic.id,
      text: topic.title,
      meta: isPinMarker(topic) ? 'pinned' : headerOf(topic.parent_id),
    }))
  // With nothing typed the palette is a list of places to go.
  if (words.length === 0) return topicHits

  const cardHits: PaletteHit[] = Object.values(state.cards)
    .filter(
      card =>
        card.status !== 'dismissed' &&
        state.topics[card.topic_id] &&
        has(`${card.text} ${card.owner ?? ''} ${card.due_text ?? ''}`, words)
    )
    .sort((a, b) => a.created_t_ms - b.created_t_ms)
    .slice(0, PALETTE_LIMITS.card)
    .map(card => ({
      type: 'card',
      id: card.id,
      topicId: card.topic_id,
      kind: card.kind,
      text: card.text,
      meta: [
        clock(card.created_t_ms),
        state.topics[card.topic_id]?.title,
        card.owner,
      ]
        .filter(Boolean)
        .join(' · '),
    }))

  const lineHits: PaletteHit[] = segments
    .filter(segment => has(segment.text, words))
    .slice(0, PALETTE_LIMITS.line)
    .map(segment => ({
      type: 'line',
      id: segment.id,
      text: segment.text,
      meta: `${clock(segment.t0_ms)} · ${segment.speaker_label}`,
      t0Ms: segment.t0_ms,
      t1Ms: segment.t1_ms,
    }))

  return [...topicHits, ...cardHits, ...lineHits]
}
