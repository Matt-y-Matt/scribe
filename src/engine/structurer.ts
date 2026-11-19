import type { SegmentFinal } from '../ipc'
import { aliasInput } from './aliases'
import { applyOps, type DroppedOp } from './apply'
import { cardsIn, headersOf, type MapState } from './model'
import type { StructurerInput, StructurerProvider } from './providers/types'
import type { SegmentSink } from './replay/replay'
import type { MapStore } from './store'
import {
  afterRun,
  countWords,
  initialTrigger,
  onClock,
  onSegment,
} from './trigger'

// The structurer loop, docs/ARCHITECTURE.md §3.2. It listens to the
// transcript, decides when a run is due, sends the model what is new and
// applies what comes back. One run is in flight at a time; whatever arrives
// meanwhile goes into the next run, which starts the moment this one ends.

/** How much already-structured transcript the model sees again. */
export const RECENT_MS = 90_000
const LAST_CARDS = 2
/** A run is tried twice before its segments are left for the next one. */
const ATTEMPTS = 2

export type RunReason = 'silence' | 'elapsed' | 'end'

export interface RunRecord {
  index: number
  /** What first made the run due. */
  reason: RunReason
  /** Meeting clock when the run became due. */
  dueAtMs: number
  segmentIds: string[]
  applied: number
  dropped: DroppedOp[]
  /** Set when the provider failed; the segments go into the next run. */
  error?: string
}

export interface StructurerOptions {
  store: MapStore
  provider: StructurerProvider
  /**
   * The lines come from speech recognition in a meeting being held, not from
   * a written fixture: the model is told how to read broken speech.
   */
  liveSpeech?: boolean
  /** Never given transcript or card text. */
  log?: (message: string, context: Record<string, unknown>) => void
  onRun?: (run: RunRecord) => void
}

export function buildInput(
  state: MapState,
  recent: readonly SegmentFinal[],
  batch: readonly SegmentFinal[],
  nowMs: number,
  liveSpeech = false
): StructurerInput {
  return {
    ...(liveSpeech ? { live: true } : {}),
    agenda: headersOf(state)
      .filter(header => !header.off_agenda)
      .map(({ id, title }) => ({ id, title })),
    outline: Object.values(state.topics)
      .filter(topic => topic.kind === 'topic')
      .sort((a, b) => a.created_t_ms - b.created_t_ms || (a.id < b.id ? -1 : 1))
      .map(topic => ({
        id: topic.id,
        title: topic.title,
        parent_id: topic.parent_id,
        header: state.topics[topic.parent_id ?? '']?.title ?? null,
        off_agenda: topic.off_agenda,
        last_cards: cardsIn(state, topic.id)
          .slice(-LAST_CARDS)
          .map(({ id, kind, text }) => ({ id, kind, text })),
      })),
    recent_structured: recent
      .map(
        segment => `[${segment.id}] ${segment.speaker_label}: ${segment.text}`
      )
      .join('\n'),
    new_segments: batch.map(segment => ({
      id: segment.id,
      t0: segment.t0_ms,
      t1: segment.t1_ms,
      source: segment.source,
      speaker: segment.speaker_label,
      text: segment.text,
    })),
    participants: [...state.meeting.participants],
    now_ms: nowMs,
  }
}

export class Structurer implements SegmentSink {
  /** Every run so far, oldest first. */
  readonly runs: RunRecord[] = []

  private readonly store: MapStore
  private readonly provider: StructurerProvider
  private readonly options: StructurerOptions
  private readonly heard = new Map<string, SegmentFinal>()
  private readonly structured: SegmentFinal[] = []
  /** Heard, not yet due. */
  private waiting: SegmentFinal[] = []
  /** Due: the next run takes these. */
  private due: SegmentFinal[] = []
  private dueReason: RunReason | null = null
  private dueAtMs = 0
  private trigger = initialTrigger()
  private inFlight: Promise<void> | null = null
  /** A run became due while another was in flight. */
  private waited = false

  constructor(options: StructurerOptions) {
    this.options = options
    this.store = options.store
    this.provider = options.provider
  }

  /** True while a run is in flight or one is due. */
  get busy(): boolean {
    return this.inFlight !== null || this.due.length > 0
  }

  /** Every op the rules have dropped, across all runs. */
  get dropped(): DroppedOp[] {
    return this.runs.flatMap(run => run.dropped)
  }

  segmentFinal(event: SegmentFinal): void {
    if (this.heard.has(event.id)) return
    this.heard.set(event.id, event)
    this.store.tick(event.t1_ms)

    const decision = onSegment(this.trigger, event)
    this.trigger = decision.state
    if (decision.fire === 'silence') {
      this.makeDue('silence', decision.atMs)
      this.waiting.push(event)
    } else {
      this.waiting.push(event)
      if (decision.fire === 'elapsed') this.makeDue('elapsed', decision.atMs)
    }
    this.pump()
  }

  /**
   * The meeting clock, when it moves without a segment: a live meeting calls
   * this about once a second, so a run that silence makes due starts while
   * the room is still quiet.
   */
  clock(nowMs: number): void {
    this.store.tick(nowMs)
    const decision = onClock(this.trigger, nowMs)
    this.trigger = decision.state
    if (decision.fire === null) return
    // Everything heard so far belongs to this run.
    this.makeDue(decision.fire, decision.atMs)
    this.pump()
  }

  /** The meeting is over: structure whatever is left, however little. */
  end(): void {
    this.makeDue('end', this.store.now)
    this.pump()
  }

  /** Resolves once no run is in flight and none is due. */
  async idle(): Promise<void> {
    while (this.inFlight) await this.inFlight
  }

  private makeDue(reason: RunReason, atMs: number): void {
    if (this.waiting.length === 0) return
    if (this.due.length === 0) {
      this.dueReason = reason
      this.dueAtMs = atMs
    }
    if (this.inFlight) this.waited = true
    this.due.push(...this.waiting)
    this.waiting = []
  }

  private pump(): void {
    if (this.inFlight || this.due.length === 0) return

    // A run that had to wait for the one before takes everything heard
    // since, not only what was due when it was asked for.
    if (this.waited && this.waiting.length > 0) {
      this.due.push(...this.waiting)
      this.waiting = []
      this.trigger = afterRun(this.trigger, this.store.now)
    }
    this.waited = false

    // In meeting order: a failed run's segments rejoin ahead of later ones.
    const batch = [...this.due].sort((a, b) => a.t0_ms - b.t0_ms)
    const record: RunRecord = {
      index: this.runs.length,
      reason: this.dueReason ?? 'elapsed',
      dueAtMs: this.dueAtMs,
      segmentIds: batch.map(segment => segment.id),
      applied: 0,
      dropped: [],
    }
    this.due = []
    this.dueReason = null
    this.runs.push(record)

    this.inFlight = this.run(batch, record).finally(() => {
      this.inFlight = null
      this.options.onRun?.(record)
      this.pump()
    })
  }

  private async run(batch: SegmentFinal[], record: RunRecord): Promise<void> {
    const first = batch[0]
    const last = batch.at(-1)
    if (!first || !last) return
    const nowMs = last.t1_ms
    const recent = this.structured.filter(
      segment => segment.t1_ms >= first.t0_ms - RECENT_MS
    )
    const input = buildInput(
      this.store.getState(),
      recent,
      batch,
      nowMs,
      this.options.liveSpeech
    )

    // The model sees short aliases (H1, T3) in place of the map's ids.
    const aliased = aliasInput(input)

    let reply: unknown
    let failure: unknown
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        reply = aliased.restore(await this.provider.structure(aliased.input))
        failure = undefined
        break
      } catch (error) {
        failure = error ?? new Error('provider failed')
      }
    }
    if (failure !== undefined) {
      record.error =
        failure instanceof Error ? failure.message : String(failure)
      this.options.log?.('structurer run failed', {
        run: record.index,
        provider: this.provider.name,
        error: record.error,
      })
      // Nothing is lost: these segments lead the next batch.
      this.waiting.unshift(...batch)
      this.trigger = {
        ...this.trigger,
        newWords:
          this.trigger.newWords +
          batch.reduce((sum, segment) => sum + countWords(segment.text), 0),
      }
      return
    }

    const result = applyOps(this.store, reply, {
      tMs: nowMs,
      segments: this.heard,
      log: this.options.log,
    })
    record.applied = result.applied.length
    record.dropped = result.dropped
    this.structured.push(...batch)
  }
}
