import type { CardRow, MapPatch, MapRows, SuggestionRow, TopicRow } from '@/ipc'
import type {
  Card,
  Change,
  MapState,
  Meeting,
  Suggestion,
  SuggestionPayload,
  Topic,
} from './model'
import type { PersistenceAdapter } from './store'

// The map on disk. The Rust core keeps topics, cards and suggestions as rows
// in SQLite (docs/ARCHITECTURE.md §3.1); this adapter turns each commit of the
// store into the rows it touched and hands them to a backend, which saves
// them in one transaction. The engine stays free of Tauri: the backend is
// the `map_save` command in the app and a plain function in tests.

export interface MapBackend {
  save(patch: MapPatch): Promise<void>
}

const topicRow = (topic: Topic): TopicRow => ({
  ...topic,
  segment_ids: [...topic.segment_ids],
})

const cardRow = (card: Card): CardRow => ({
  ...card,
  segment_ids: [...card.segment_ids],
})

const suggestionRow = (suggestion: Suggestion): SuggestionRow => ({
  id: suggestion.id,
  meeting_id: suggestion.meeting_id,
  kind: suggestion.kind,
  payload_json: JSON.stringify(suggestion.payload),
  status: suggestion.status,
  created_t_ms: suggestion.created_t_ms,
})

const suggestionOf = (row: SuggestionRow): Suggestion => ({
  id: row.id,
  meeting_id: row.meeting_id,
  kind: row.kind,
  payload: JSON.parse(row.payload_json) as SuggestionPayload,
  status: row.status,
  created_t_ms: row.created_t_ms,
})

const byId = <T extends { id: string }>(rows: readonly T[]) =>
  Object.fromEntries(rows.map(row => [row.id, row]))

/** The saved rows of a meeting as a map, or null when nothing was saved. */
export function stateFromRows(
  meeting: Meeting,
  rows: MapRows
): MapState | null {
  if (rows.topics.length === 0) return null
  return {
    meeting,
    topics: byId<Topic>(rows.topics),
    cards: byId<Card>(rows.cards),
    suggestions: byId(rows.suggestions.map(suggestionOf)),
  }
}

/** Every row of a map, as one patch: what a new meeting saves first. */
export function patchOfState(state: MapState): MapPatch {
  return {
    topics: Object.values(state.topics).map(topicRow),
    cards: Object.values(state.cards).map(cardRow),
    suggestions: Object.values(state.suggestions).map(suggestionRow),
    deleted: [],
  }
}

export interface RowAdapterOptions {
  meeting: Meeting
  /** What `map_load` returned for this meeting. */
  rows: MapRows
  backend: MapBackend
  /** A save failed. The map on screen is still right; the disk is behind. */
  onError?: (error: unknown) => void
}

/**
 * Keeps the map of one meeting in SQLite. Saves are queued and sent one at a
 * time in commit order, so the disk never sees a later commit before an
 * earlier one; the store never waits for the disk.
 */
export class RowAdapter implements PersistenceAdapter {
  private state: MapState | null
  private queue: Promise<void> = Promise.resolve()
  private readonly backend: MapBackend
  private readonly onError: (error: unknown) => void

  constructor(options: RowAdapterOptions) {
    this.state = stateFromRows(options.meeting, options.rows)
    this.backend = options.backend
    this.onError = options.onError ?? (() => undefined)
  }

  load(): MapState | null {
    return this.state
  }

  init(state: MapState): void {
    this.state = state
    this.enqueue(patchOfState(state))
  }

  persist(changes: readonly Change[]): void {
    if (!this.state) throw new Error('persist before init')
    const patch: MapPatch = {
      topics: [],
      cards: [],
      suggestions: [],
      deleted: [],
    }
    let { topics, cards, suggestions } = this.state

    // A commit may touch a row more than once; the row is sent as it stands
    // after the last of them.
    const touched = new Map<string, Change['entity']>()
    for (const change of changes) {
      touched.set(change.id, change.entity)
      const merge = <T extends object>(table: Readonly<Record<string, T>>) => {
        const rows = new Map(Object.entries(table))
        if (change.after === null) rows.delete(change.id)
        else
          rows.set(change.id, {
            ...rows.get(change.id),
            ...change.after,
          } as unknown as T)
        return Object.fromEntries(rows)
      }
      if (change.entity === 'topic') topics = merge(topics)
      else if (change.entity === 'card') cards = merge(cards)
      else suggestions = merge(suggestions)
    }
    this.state = { ...this.state, topics, cards, suggestions }

    for (const [id, entity] of touched) {
      if (entity === 'topic') {
        const row = topics[id]
        if (row) patch.topics.push(topicRow(row))
        else patch.deleted.push({ entity, id })
      } else if (entity === 'card') {
        const row = cards[id]
        if (row) patch.cards.push(cardRow(row))
        else patch.deleted.push({ entity, id })
      } else {
        const row = suggestions[id]
        if (row) patch.suggestions.push(suggestionRow(row))
        else patch.deleted.push({ entity, id })
      }
    }
    this.enqueue(patch)
  }

  /** Resolves once everything committed so far has been saved. */
  idle(): Promise<void> {
    return this.queue
  }

  private enqueue(patch: MapPatch): void {
    this.queue = this.queue
      .then(() => this.backend.save(patch))
      .catch(error => this.onError(error))
  }
}
