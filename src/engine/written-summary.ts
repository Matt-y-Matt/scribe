import { z } from 'zod'
import { looseJson } from './providers/ai-sdk'
import {
  OLLAMA_CONTEXT_TOKENS,
  OLLAMA_MODEL,
  type OllamaTransport,
} from './providers/ollama'
import type { SummaryMeta } from './summary'
import { wordsOf, type Turn } from './turns'

// The written summary: what the meeting was about, read from the whole
// transcript by the model on this PC once the meeting is over.
//
// The presets in summary.ts list the map's decision and action cards and say
// nothing else. That is exact when the live notes are good and nearly empty
// when they are not: a real 31-minute call gave 2 decisions and 1 action out
// of 85 cards, so its summary was three lines. This reads the conversation
// itself. It is a draft for the host to check, never something that is sent.
//
// It is done in two steps, because a small model given half an hour of
// transcript at once loses the thread: it moved a launch date by three weeks
// and gave one person's task to the other. First it takes notes on each few
// minutes of the meeting, where the words it needs are right in front of it.
// Then it writes the topics and the gist from those notes. Decisions and
// actions are carried over from the notes as they were written; the second
// step never rewrites them. The model answers in a fixed JSON shape (Ollama's
// grammar-constrained `format`), and the Markdown is laid out here.

export interface Action {
  owner: string | null
  text: string
  due: string | null
}

/** What the model notes down from one stretch of the meeting. */
export interface StretchNotes {
  subject: string
  points: string[]
  decisions: string[]
  actions: Action[]
  open: string[]
}

export interface WrittenSummary {
  /** Two or three sentences: what it was about and where it ended up. */
  gist: string
  topics: { title: string; points: string[] }[]
  decisions: string[]
  actions: Action[]
  /** Questions left open, disagreements not settled. */
  open: string[]
}

/** Words of transcript in one stretch: about five minutes of talk. */
export const STRETCH_WORDS = 700
const REPLY_TOKENS = 2_000
/** The 9B model, part of it on the CPU, took up to two minutes a request. */
const TIMEOUT_MS = 600_000
/**
 * The summary's model. It runs once, after the meeting, so it can be the
 * larger one: on the Edwin call the 9B kept the dates and decisions the 4B
 * got wrong, at about 8 minutes for 31 minutes of talk (docs/NOTES.md,
 * 2026-11-20). Where it is not pulled, the live note-taker's model writes it.
 */
export const SUMMARY_MODEL = 'qwen3.5:9b'
/** More open questions than this is a list nobody reads. */
const MAX_OPEN = 5
/** Two lines sharing this share of their words say the same thing. */
const SAME_SHARE = 0.6

const actionSchema = z.object({
  owner: z.string().nullish(),
  text: z.string(),
  due: z.string().nullish(),
})
const notesSchema = z.object({
  subject: z.string(),
  points: z.array(z.string()),
  decisions: z.array(z.string()),
  actions: z.array(actionSchema),
  open: z.array(z.string()),
})
const writeSchema = z.object({
  topics: z.array(z.object({ title: z.string(), points: z.array(z.string()) })),
  open: z.array(z.string()),
  gist: z.string(),
})

const text = { type: 'string' }
const list = { type: 'array', items: text }
const object = (
  required: string[],
  properties: Record<string, unknown>
): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  // In the order the model should write them.
  required,
  properties,
})

/** The reply to a stretch; an owner can only be someone in the meeting. */
const notesFormat = (participants: readonly string[]) =>
  object(['subject', 'points', 'decisions', 'actions', 'open'], {
    subject: text,
    points: list,
    decisions: list,
    actions: {
      type: 'array',
      items: object(['owner', 'text', 'due'], {
        owner: { enum: [...participants, null] },
        text,
        due: { type: ['string', 'null'] },
      }),
    },
    open: list,
  })

/** The reply to the notes: the detail first, the gist once it has read all. */
const writeFormat = object(['topics', 'open', 'gist'], {
  topics: {
    type: 'array',
    items: object(['title', 'points'], { title: text, points: list }),
  },
  open: list,
  gist: text,
})

export const NOTES_PROMPT = `You take notes on one stretch of a meeting, a few minutes long. The meeting's summary is written afterwards from your notes, so what you leave out is lost and what you get wrong stays wrong.

You get the transcript of the stretch, made by speech recognition from a live conversation. It has mis-heard words, broken sentences, repeated fragments and filler. Read it for what the people meant, the way a good note-taker listens.

Reply with one JSON object:

- "subject": what this stretch is about, in a few words.
- "points": three to eight full sentences, in order: what was proposed, the reasons given, the figures and dates as they were said, where people disagreed, how it was left. Someone who was not in the meeting must be able to understand each one.
- "decisions": what was settled in this stretch. Only what the people clearly agreed on or one of them decided ("that's the decision", "let's just do it", "okay, then we go with…"). An idea, a wish or an option still being argued is not a decision.
- "actions": a specific thing one person will do after the meeting. It is an action only when the words are there: the person offers, even in passing ("I'll book the room tonight", "I can mail you the file": the speaker owns it), or is asked ("Kabs, can you call Ross tomorrow", "get me the numbers": the person asked owns it; when two people are talking, that is the other one). "owner" is who will do it, "text" starts with a verb and says what and for whom, "due" is the deadline in the words that were said ("tomorrow", "by Friday") or null when none was said. If it is not clear who will do it, "owner" is null. Go through the stretch once more for these before you answer: they are what people most need from the summary.
- "open": questions nobody answered and disagreements that were not settled in this stretch.

Rules:

1. Use only what is in the transcript. Never add a fact, a name, a number or a date that is not there. Never work out a calendar date or a year.
2. A word or number that makes no sense where it stands is a mis-hearing: an odd noun in a list, a day of the month above thirty-one, a name nobody would have. Work it out from the lines around it when they make it clear ("the fortieth" just after "by the fourteenth" is the fourteenth). Otherwise leave it out. Never pass a garbled word on.
3. The speaker labels come from which microphone heard the line, and one microphone can pick up the other person. Say who held a view only when their own words make it plain; otherwise write what was said without a name.
4. Say each thing once. People repeat themselves; notes do not.
5. Leave out greetings, small talk, "can you hear me" and talk about the call itself.
6. Lists may be empty. Do not invent a decision or an action to fill one.`

export const WRITE_PROMPT = `You write the summary of a meeting from the notes that were taken on each stretch of it, in order.

Reply with one JSON object:

- "topics": the subjects the meeting went through, in order, three to seven of them. Stretches on the same subject become one topic. Each has a short "title" and two to six "points" taken from the notes: full sentences, with every figure and date kept as written.
- "open": the questions still open when the meeting ended, the five that matter most at the very most. Leave out one that a later stretch answers, and one that is only a detail.
- "gist": two or three sentences on what the meeting was about and where it ended up. Write it last.

Rules:

1. Use only what is in the notes. Add no fact, name, number or date.
2. Say each thing once.
3. Write plainly, for someone who was not there. Do not mention the notes, the stretches or the transcript.`

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
}

/** The turns as the model reads them: `[04:33] Matt: …`. */
export function transcriptText(turns: readonly Turn[]): string {
  return turns
    .map(turn => `[${clock(turn.t0)}] ${turn.speaker}: ${turn.text}`)
    .join('\n')
}

/**
 * The turns cut into stretches of about `words` words. A last stretch too
 * short to stand alone joins the one before it.
 */
export function stretchesOf(
  turns: readonly Turn[],
  words: number = STRETCH_WORDS
): Turn[][] {
  const stretches: { turns: Turn[]; words: number }[] = []
  for (const turn of turns) {
    const count = wordsOf(turn.text).length
    const last = stretches.at(-1)
    if (last && last.words + count <= words) {
      last.turns.push(turn)
      last.words += count
    } else {
      stretches.push({ turns: [turn], words: count })
    }
  }
  const tail = stretches.at(-1)
  const before = stretches.at(-2)
  if (tail && before && tail.words < words / 4) {
    before.turns.push(...tail.turns)
    stretches.pop()
  }
  return stretches.map(stretch => stretch.turns)
}

const tidy = (value: string) => value.replace(/\s+/g, ' ').trim()
/** "None", "Nothing specific was assigned": a list filled in to say it is empty. */
const saysNothing = (value: string) =>
  value === '' || /^(none|nothing|n\/a|no\b)/i.test(value)
const tidyList = (values: readonly string[]) =>
  values.map(tidy).filter(value => !saysNothing(value))

/** True when two lines say the same thing in nearly the same words. */
export function sameLine(a: string, b: string): boolean {
  const left = new Set(wordsOf(a))
  const right = new Set(wordsOf(b))
  if (left.size === 0 || right.size === 0) return false
  const shared = [...left].filter(word => right.has(word)).length
  return shared / Math.min(left.size, right.size) >= SAME_SHARE
}

function unique<T>(rows: readonly T[], same: (a: T, b: T) => boolean): T[] {
  const kept: T[] = []
  for (const row of rows) {
    if (!kept.some(other => same(other, row))) kept.push(row)
  }
  return kept
}

interface Said {
  participants: readonly string[]
  /** Every word of the transcript. */
  words: ReadonlySet<string>
}

function cleanActions(
  actions: readonly z.infer<typeof actionSchema>[],
  said: Said
): Action[] {
  const known = new Map(said.participants.map(n => [n.toLowerCase(), n]))
  return actions
    .map(action => {
      const due = tidy(action.due ?? '')
      const dueWords = wordsOf(due)
      return {
        // Only someone in the meeting can own an action.
        owner: known.get((action.owner ?? '').trim().toLowerCase()) ?? null,
        text: tidy(action.text),
        // A deadline is kept only in words the meeting used: a small model
        // likes to turn "by the fifth" into a date with a year it made up.
        due:
          dueWords.length > 0 && dueWords.every(word => said.words.has(word))
            ? due
            : null,
      }
    })
    .filter(action => !saysNothing(action.text))
}

export interface Noted {
  decisions: readonly string[]
  actions: readonly Action[]
}

export interface WriteOptions {
  title: string
  participants: readonly string[]
  /** The agenda, when the meeting had one. */
  agenda?: readonly string[]
  /**
   * What the live notes already hold as decisions and actions. They lead the
   * summary's lists as they stand; the model's reading adds what they lack.
   * A function is asked once the reading is done, for what holds then.
   */
  noted?: Noted | (() => Noted)
  model?: string
  stretchWords?: number
  signal?: AbortSignal
  /** Called before each request: which one, out of how many. */
  onProgress?: (step: number, steps: number) => void
}

async function ask(
  transport: OllamaTransport,
  system: string,
  user: string,
  format: Record<string, unknown>,
  options: WriteOptions
): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const reply = await transport(
    JSON.stringify({
      model: options.model ?? OLLAMA_MODEL,
      stream: false,
      think: false,
      format,
      options: {
        num_ctx: OLLAMA_CONTEXT_TOKENS,
        num_predict: REPLY_TOKENS,
        temperature: 0,
      },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  )
  const body = JSON.parse(reply) as { message?: { content?: string } }
  return looseJson(body.message?.content ?? '')
}

const facts = (options: WriteOptions) =>
  [
    `Meeting: ${options.title}`,
    `People: ${options.participants.join(', ') || 'not listed'}`,
    ...(options.agenda?.length ? [`Agenda: ${options.agenda.join('; ')}`] : []),
  ].join('\n')

const actionText = (action: Action) =>
  `${action.owner ?? 'nobody named'}: ${action.text}${action.due ? ` (due ${action.due})` : ''}`

/** One stretch's notes, as the writing step reads them. */
function notesText(notes: StretchNotes): string {
  const lines = [
    `Subject: ${notes.subject}`,
    ...notes.points.map(p => `- ${p}`),
  ]
  const section = (title: string, rows: readonly string[]) => {
    if (rows.length > 0) lines.push(`${title}:`, ...rows.map(row => `- ${row}`))
  }
  section('Decided', notes.decisions)
  section('To do', notes.actions.map(actionText))
  section('Open', notes.open)
  return lines.join('\n')
}

/**
 * Reads the meeting and writes its summary. Rejects when the model does not
 * answer or answers with something that is not what was asked for; throws at
 * once when there is nothing to read.
 */
export async function writeMeetingSummary(
  transport: OllamaTransport,
  turns: readonly Turn[],
  options: WriteOptions
): Promise<WrittenSummary> {
  const stretches = stretchesOf(turns, options.stretchWords)
  if (stretches.length === 0) throw new Error('there is no transcript to read')
  const steps = stretches.length + 1
  const said: Said = {
    participants: options.participants,
    words: new Set(turns.flatMap(turn => wordsOf(turn.text))),
  }

  const all: StretchNotes[] = []
  for (const [index, stretch] of stretches.entries()) {
    options.onProgress?.(index + 1, steps)
    const before = all.at(-1)
    const parsed = notesSchema.safeParse(
      await ask(
        transport,
        NOTES_PROMPT,
        [
          facts(options),
          `Stretch ${index + 1} of ${stretches.length}.`,
          // Enough to know what "it" and "that" refer to; no notes from it.
          ...(before
            ? [
                '',
                'JUST BEFORE THIS STRETCH (already noted, for context only)',
                `${before.subject}: ${before.points.slice(-3).join(' ')}`,
              ]
            : []),
          '',
          'TRANSCRIPT OF THIS STRETCH',
          transcriptText(stretch),
        ].join('\n'),
        notesFormat(options.participants),
        options
      )
    )
    if (!parsed.success) throw new Error('the model did not take notes')
    all.push({
      subject: tidy(parsed.data.subject),
      points: tidyList(parsed.data.points),
      decisions: tidyList(parsed.data.decisions),
      actions: cleanActions(parsed.data.actions, said),
      open: tidyList(parsed.data.open),
    })
  }

  options.onProgress?.(steps, steps)
  const written = writeSchema.safeParse(
    await ask(
      transport,
      WRITE_PROMPT,
      `${facts(options)}\n\n${all
        .map((notes, index) => `STRETCH ${index + 1}\n${notesText(notes)}`)
        .join('\n\n')}`,
      writeFormat,
      options
    )
  )
  if (!written.success) throw new Error('the model did not write a summary')
  const noted =
    typeof options.noted === 'function' ? options.noted() : options.noted

  return {
    gist: tidy(written.data.gist),
    topics: written.data.topics
      .map(topic => ({
        title: tidy(topic.title),
        points: tidyList(topic.points),
      }))
      .filter(topic => topic.title !== '' && topic.points.length > 0),
    // The live notes' own first, then what the reading found, in meeting
    // order and as written: the writing step never rewords these.
    decisions: unique(
      [...(noted?.decisions ?? []), ...all.flatMap(notes => notes.decisions)],
      sameLine
    ),
    actions: unique(
      [...(noted?.actions ?? []), ...all.flatMap(notes => notes.actions)],
      (a, b) => a.owner === b.owner && sameLine(a.text, b.text)
    ),
    open: tidyList(written.data.open).slice(0, MAX_OPEN),
  }
}

/** The summary as Markdown, under the same heading as the presets. */
export function renderWritten(
  summary: WrittenSummary,
  meta: SummaryMeta
): string {
  const head = [meta.date, meta.participants.join(', ')].filter(Boolean)
  const lines = [`# ${meta.title}`, ...(head.length ? [head.join(' · ')] : [])]
  const section = (title: string, rows: readonly string[]) => {
    if (rows.length > 0) lines.push('', `## ${title}`, ...rows)
  }

  if (summary.gist) lines.push('', summary.gist)
  section(
    'Decisions',
    summary.decisions.map(row => `- ${row}`)
  )
  section(
    'Actions',
    summary.actions.map(
      action =>
        `- **${action.owner ?? 'No owner'}**: ${action.text}${action.due ? `, due ${action.due}` : ''}`
    )
  )
  section(
    'Open questions',
    summary.open.map(row => `- ${row}`)
  )
  if (summary.topics.length > 0) {
    lines.push('', '## Discussed')
    for (const topic of summary.topics) {
      lines.push('', `### ${topic.title}`, ...topic.points.map(p => `- ${p}`))
    }
  }
  return lines.join('\n').trimEnd() + '\n'
}
