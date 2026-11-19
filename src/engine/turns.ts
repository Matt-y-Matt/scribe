// Turns: the transcript as the note-taker and the summary read it.
//
// The recorder cuts the audio at every 0.7 s pause, so a person thinking
// aloud arrives as "Um" / "And people" / "few that clothes and they pay as a".
// A real 31-minute call came out as 492 lines with a median of four to five
// words, 111 of them nothing but filler. A model that goes through those one
// by one writes a card per fragment. So before a model sees them:
//
// - a line that is only filler ("Yeah.", "Um", "Okay okay") is left out;
// - a microphone line that repeats what the PC was playing at that moment is
//   left out (headphones or speakers leaking into the microphone);
// - lines by one speaker with no more than a short pause between them are
//   joined into one turn, up to a length a note can still be written from.
//
// Nothing is removed from the transcript itself: this is a reading of it. A
// turn remembers every line it covers, so a card written from a turn still
// points at the audio.

export interface Line {
  id: string
  /** Milliseconds from the start of the meeting. */
  t0: number
  t1?: number
  speaker: string
  /** `laptop` (this PC's microphone), `system` (what the PC plays), a phone. */
  source?: string
  text: string
}

export interface Turn {
  /** The id of its first line. */
  id: string
  /** Every line joined into it, in order. */
  covers: string[]
  t0: number
  t1: number
  speaker: string
  text: string
}

export interface TurnOptions {
  /** A pause longer than this ends a turn. */
  maxGapMs?: number
  /** A turn stops growing once it would pass this many words. */
  maxWords?: number
}

/** Long enough to bridge a thinking pause, short enough to keep replies apart. */
const MAX_GAP_MS = 2_000
/**
 * The core's labels for a microphone it cannot put a name to. Several people
 * may be behind one, so only the shortest pause joins two of its lines:
 * anything longer may be the next person answering.
 */
const UNNAMED = new Set(['Room', 'System audio'])
const SHARED_GAP_MS = 1_000
/** Two full sentences already make a note; more only blurs what it cites. */
const MAX_WORDS = 60
/** The speakers reach the microphone within this of the loopback hearing them. */
const ECHO_WINDOW_MS = 2_500
/** This share of a microphone line's words, also played by the PC: an echo. */
const ECHO_SHARE = 0.6

const FILLER = new Set(
  (
    'yeah yes yep yup no nope oh ah uh um mm mhm hmm hm er erm okay ok right ' +
    'hello hi bye so and but like well then the a i it is that you know lah ' +
    'alright sure nice cool'
  ).split(' ')
)

export const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** The share of their distinct words two texts have in common, 0 to 1. */
export function wordOverlap(a: string, b: string): number {
  const left = new Set(wordsOf(a))
  const right = new Set(wordsOf(b))
  const all = new Set([...left, ...right])
  if (all.size === 0) return 0
  return [...left].filter(word => right.has(word)).length / all.size
}

/** True when a line says nothing a note could be written from. */
export function isFiller(text: string): boolean {
  return wordsOf(text).every(word => FILLER.has(word))
}

const endOf = (line: Line) => line.t1 ?? line.t0

/**
 * True when a microphone line is the PC's own sound coming back: it overlaps
 * what the system audio said and most of its words are the same words.
 */
function isEcho(line: Line, system: readonly Line[]): boolean {
  const said = wordsOf(line.text).filter(word => !FILLER.has(word))
  if (said.length < 2) return false
  const played = new Set(
    system
      .filter(
        other =>
          other.t0 < endOf(line) + ECHO_WINDOW_MS &&
          endOf(other) > line.t0 - ECHO_WINDOW_MS
      )
      .flatMap(other => wordsOf(other.text))
  )
  if (played.size === 0) return false
  return (
    said.filter(word => played.has(word)).length / said.length >= ECHO_SHARE
  )
}

/** The lines worth reading, joined into turns, in meeting order. */
export function toTurns(
  lines: readonly Line[],
  options: TurnOptions = {}
): Turn[] {
  const maxGapMs = options.maxGapMs ?? MAX_GAP_MS
  const maxWords = options.maxWords ?? MAX_WORDS
  const system = lines.filter(line => line.source === 'system')
  const kept = [...lines]
    .sort((a, b) => a.t0 - b.t0)
    .filter(line => !isFiller(line.text))
    .filter(line => line.source !== 'laptop' || !isEcho(line, system))

  // One open turn per speaker: on a call the two sides overlap, and a line
  // from the other side must not cut a sentence in half.
  const open = new Map<string, Turn & { words: number }>()
  const turns: Turn[] = []
  for (const line of kept) {
    const words = wordsOf(line.text).length
    const current = open.get(line.speaker)
    const gapMs = UNNAMED.has(line.speaker)
      ? Math.min(maxGapMs, SHARED_GAP_MS)
      : maxGapMs
    if (
      current &&
      line.t0 - current.t1 <= gapMs &&
      current.words + words <= maxWords
    ) {
      current.covers.push(line.id)
      current.text = `${current.text} ${line.text}`
      current.t1 = Math.max(current.t1, endOf(line))
      current.words += words
      continue
    }
    const turn = {
      id: line.id,
      covers: [line.id],
      t0: line.t0,
      t1: endOf(line),
      speaker: line.speaker,
      text: line.text,
      words,
    }
    open.set(line.speaker, turn)
    turns.push(turn)
  }
  return turns.map(({ id, covers, t0, t1, speaker, text }) => ({
    id,
    covers,
    t0,
    t1,
    speaker,
    text,
  }))
}
