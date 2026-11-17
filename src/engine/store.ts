import { ulidSource, type IdSource } from './ids'
import {
  UNPLANNED_TITLE,
  type Change,
  type EntityMap,
  type EntityName,
  type LogEntry,
  type MapState,
  type Meeting,
  type OpType,
  type Source,
  type Topic,
} from './model'

/** How many user operations Ctrl+Z can take back (UI_SPEC §4.1). */
export const UNDO_DEPTH = 50

/**
 * Where the map is kept between launches. M1 ships `MemoryAdapter`; M2 swaps
 * in SQLite without the store or the UI changing.
 */
export interface PersistenceAdapter {
  /** The saved map, or null when the meeting is new. */
  load(): MapState | null
  /** Called once, with the seeded map of a new meeting. */
  init(state: MapState): void
  /** Called after every commit, undo and redo with the rows that changed. */
  persist(changes: readonly Change[]): void
}

const TABLE = {
  topic: 'topics',
  card: 'cards',
  suggestion: 'suggestions',
} as const satisfies Record<EntityName, keyof MapState>

type Row = EntityMap[EntityName]

function applyChange(state: MapState, change: Change): MapState {
  const table = TABLE[change.entity]
  const rows = new Map<string, Row>(Object.entries(state[table]))
  const current = rows.get(change.id)

  if (change.after === null) {
    rows.delete(change.id)
  } else if (change.before === null) {
    if (current) throw new Error(`${change.entity} ${change.id} exists`)
    rows.set(change.id, change.after as Row)
  } else {
    if (!current) throw new Error(`${change.entity} ${change.id} is missing`)
    rows.set(change.id, { ...current, ...change.after } as Row)
  }
  return { ...state, [table]: Object.fromEntries(rows) }
}

const invert = (change: Change): Change =>
  ({ ...change, before: change.after, after: change.before }) as Change

function applyChanges(state: MapState, changes: readonly Change[]): MapState {
  return changes.reduce(applyChange, state)
}

/** Keeps the map in memory, as a second copy the store does not share. */
export class MemoryAdapter implements PersistenceAdapter {
  private state: MapState | null = null

  load(): MapState | null {
    return this.state
  }

  init(state: MapState): void {
    this.state = state
  }

  persist(changes: readonly Change[]): void {
    if (!this.state) throw new Error('persist before init')
    this.state = applyChanges(this.state, changes)
  }
}

export interface MapStoreOptions {
  meeting: Meeting
  /** Agenda titles, in order. They become the header columns. */
  agenda: readonly string[]
  adapter?: PersistenceAdapter
  ids?: IdSource
}

function seed(options: MapStoreOptions, ids: IdSource): MapState {
  const topics: Record<string, Topic> = {}
  const header = (title: string, index: number, offAgenda: boolean) => {
    const id = ids('t')
    topics[id] = {
      id,
      meeting_id: options.meeting.id,
      parent_id: null,
      title,
      kind: 'header',
      order_key: index,
      status: 'active',
      off_agenda: offAgenda,
      created_t_ms: 0,
      pinned_t_ms: null,
      revisited_t_ms: null,
      scheduled_t_ms: null,
      segment_ids: [],
    }
  }
  options.agenda.forEach((title, index) => header(title, index, false))
  // The Unplanned column always exists; the UI draws it once it has a topic.
  header(UNPLANNED_TITLE, options.agenda.length, true)
  return { meeting: options.meeting, topics, cards: {}, suggestions: {} }
}

interface UndoStep {
  seq: number
  type: OpType
  source: Source
  changes: readonly Change[]
}

/**
 * The map of one meeting: an immutable state, an append-only op log, and undo
 * and redo for what people did. What the engine adds is logged but is not on
 * the undo stack, so Ctrl+Z takes back the host's last action and never a
 * card that arrived in the meantime.
 */
export class MapStore {
  readonly ids: IdSource
  private state: MapState
  private readonly adapter: PersistenceAdapter
  private readonly entries: LogEntry[] = []
  private undoStack: UndoStep[] = []
  private redoStack: UndoStep[] = []
  private readonly listeners = new Set<() => void>()
  private clockMs = 0

  constructor(options: MapStoreOptions) {
    this.ids = options.ids ?? ulidSource()
    this.adapter = options.adapter ?? new MemoryAdapter()
    const saved = this.adapter.load()
    if (saved) {
      this.state = saved
    } else {
      this.state = seed(options, this.ids)
      this.adapter.init(this.state)
    }
  }

  getState = (): MapState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The op log: every change ever applied, oldest first. */
  get log(): readonly LogEntry[] {
    return this.entries
  }

  /** The meeting clock: the latest moment the store has been told about. */
  get now(): number {
    return this.clockMs
  }

  /** Moves the meeting clock forward. It never goes back. */
  tick(tMs: number): void {
    if (tMs > this.clockMs) this.clockMs = tMs
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /**
   * Applies `changes` as one operation. Returns null when there is nothing to
   * change. Engine operations are logged only; the rest can be undone.
   */
  commit(
    type: OpType,
    source: Source,
    changes: readonly Change[],
    tMs: number = this.clockMs
  ): LogEntry | null {
    if (changes.length === 0) return null
    this.tick(tMs)
    const entry = this.record({ type, source, t_ms: tMs, changes })
    if (source !== 'engine') {
      this.undoStack.push({ seq: entry.seq, type, source, changes })
      if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift()
      this.redoStack = []
    }
    return entry
  }

  undo(): boolean {
    const step = this.undoStack.pop()
    if (!step) return false
    this.record({
      type: step.type,
      source: step.source,
      t_ms: this.clockMs,
      changes: step.changes.map(invert).reverse(),
      replay: { of: step.seq, direction: 'undo' },
    })
    this.redoStack.push(step)
    return true
  }

  redo(): boolean {
    const step = this.redoStack.pop()
    if (!step) return false
    this.record({
      type: step.type,
      source: step.source,
      t_ms: this.clockMs,
      changes: step.changes,
      replay: { of: step.seq, direction: 'redo' },
    })
    this.undoStack.push(step)
    return true
  }

  private record(entry: Omit<LogEntry, 'seq'>): LogEntry {
    // Apply first: a change that does not fit throws before anything is kept.
    this.state = applyChanges(this.state, entry.changes)
    const logged: LogEntry = { ...entry, seq: this.entries.length + 1 }
    this.entries.push(logged)
    this.adapter.persist(entry.changes)
    for (const listener of this.listeners) listener()
    return logged
  }
}
