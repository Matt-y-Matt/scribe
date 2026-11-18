import type { CardRow, MapRows, MeetingInfo } from '@/ipc'

// What Home reads out of a meeting without opening it.

const wordsOf = (query: string) =>
  query.toLowerCase().split(/\s+/).filter(Boolean)

/** Every word of the search is in the title, the agenda or a name. */
export function matchesMeeting(meeting: MeetingInfo, query: string): boolean {
  const text = [meeting.title, ...meeting.agenda, ...meeting.participants]
    .join(' ')
    .toLowerCase()
  return wordsOf(query).every(word => text.includes(word))
}

export interface Outline {
  decisions: CardRow[]
  actions: CardRow[]
  pinned: { id: string; title: string; cards: number }[]
  cards: number
  topicTitle: (topicId: string) => string
}

/** What the map says, in the order it was said. */
export function outlineOf(rows: MapRows): Outline {
  const titles = new Map(rows.topics.map(topic => [topic.id, topic.title]))
  const kept = rows.cards
    .filter(card => card.status !== 'dismissed' && titles.has(card.topic_id))
    .sort((a, b) => a.created_t_ms - b.created_t_ms)
  return {
    decisions: kept.filter(card => card.kind === 'decision'),
    actions: kept.filter(card => card.kind === 'action'),
    pinned: rows.topics
      .filter(topic => topic.kind === 'topic' && topic.status === 'pinned')
      .sort((a, b) => (a.pinned_t_ms ?? 0) - (b.pinned_t_ms ?? 0))
      .map(topic => ({
        id: topic.id,
        title: topic.title,
        cards: kept.filter(card => card.topic_id === topic.id).length,
      })),
    cards: kept.length,
    topicTitle: topicId => titles.get(topicId) ?? '',
  }
}
