// What the structurer sends a model and what it expects back,
// docs/ARCHITECTURE.md §3.2. A provider turns one input into a list of ops;
// it never touches the map. The reply is `unknown` on purpose: applyOps
// checks every op, so a provider cannot smuggle one past the rules.

export interface StructurerInput {
  agenda: { id: string; title: string }[]
  /** Every topic, with its last two cards. */
  outline: {
    id: string
    title: string
    parent_id: string | null
    off_agenda: boolean
    last_cards: { id: string; kind: string; text: string }[]
  }[]
  /** The last 90 s of transcript already structured, for continuity. */
  recent_structured: string
  new_segments: { id: string; t0: number; speaker: string; text: string }[]
  participants: string[]
  now_ms: number
}

export interface StructurerProvider {
  /** Shown in scores and logs, e.g. `mock` or `anthropic:claude-haiku-4-5`. */
  readonly name: string
  /**
   * True when the model runs on this PC. Anything else sends transcript text
   * off the machine and counts as cloud mode (CLAUDE.md rule 4).
   */
  readonly local: boolean
  /** Resolves to `{ ops: [...] }` or a bare array of ops. */
  structure(input: StructurerInput, signal?: AbortSignal): Promise<unknown>
}
