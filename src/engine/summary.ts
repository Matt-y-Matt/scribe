import {
  cardsIn,
  headersOf,
  pinnedTopics,
  topicsUnder,
  type Card,
  type MapState,
  type Topic,
} from './model'
import {
  OLLAMA_CONTEXT_TOKENS,
  OLLAMA_MODEL,
  type OllamaTransport,
} from './providers/ollama'

// The end of a meeting, docs/ARCHITECTURE.md §3.4: what the end screen lists
// for the host to confirm, the summary written from what they confirmed, and
// a draft message for each person who owes something. The three presets are
// written here, from the map, with no model: they are instant, and they say
// nothing the map does not. A model is asked only when the host types a
// layout of their own.

export const SUMMARY_PRESETS = [
  'decisions-actions',
  'minutes',
  'one-pager',
] as const
export type SummaryPreset = (typeof SUMMARY_PRESETS)[number]

export const PRESET_LABEL: Record<SummaryPreset, string> = {
  'decisions-actions': 'Decisions & actions',
  minutes: 'Full minutes',
  'one-pager': 'One-pager',
}

export interface WrapUp {
  decisions: Card[]
  actions: Card[]
  quotes: Card[]
  pinned: Topic[]
}

const byTime = (a: Card, b: Card) =>
  a.created_t_ms - b.created_t_ms || a.order_key - b.order_key

/** Everything the end screen puts in front of the host, in meeting order. */
export function wrapUpOf(state: MapState): WrapUp {
  const kept = Object.values(state.cards)
    .filter(card => card.status !== 'dismissed' && state.topics[card.topic_id])
    .sort(byTime)
  return {
    decisions: kept.filter(card => card.kind === 'decision'),
    actions: kept.filter(card => card.kind === 'action'),
    quotes: kept.filter(card => card.kind === 'quote'),
    pinned: pinnedTopics(state),
  }
}

/** The cards the end screen lists: the ones a tick decides about. */
export function listedCards(state: MapState): Card[] {
  const { decisions, actions, quotes } = wrapUpOf(state)
  return [...decisions, ...actions, ...quotes]
}

export interface SummaryMeta {
  title: string
  /** The day of the meeting, already written out. */
  date?: string
  participants: readonly string[]
}

const pad = (value: number) => String(value).padStart(2, '0')
const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

const actionLine = (card: Card, withOwner = true) => {
  const due = card.due_text ? `, due ${card.due_text}` : ''
  return withOwner
    ? `- **${card.owner ?? 'No owner'}**: ${card.text}${due}`
    : `- ${card.text}${due}`
}

const section = (title: string, lines: readonly string[]) =>
  lines.length === 0 ? [] : [`## ${title}`, ...lines, '']

function heading(meta: SummaryMeta): string[] {
  const facts = [meta.date, meta.participants.join(', ')].filter(Boolean)
  return [`# ${meta.title}`, ...(facts.length ? [facts.join(' · ')] : []), '']
}

/** People who owe something, in the order they were first given it. */
function owners(actions: readonly Card[]): (string | null)[] {
  const seen: (string | null)[] = []
  for (const card of actions) {
    if (!seen.includes(card.owner)) seen.push(card.owner)
  }
  // Whatever nobody owns goes last, where it is hard to miss.
  return [
    ...seen.filter(owner => owner !== null),
    ...seen.filter(o => o === null),
  ]
}

/**
 * The summary as Markdown, from the cards the host left ticked. `minutes`
 * also carries every note, topic by topic: notes are not on the end screen's
 * lists, so they are all in.
 */
export function renderSummary(
  state: MapState,
  preset: SummaryPreset,
  meta: SummaryMeta
): string {
  const wrap = wrapUpOf(state)
  const decisions = wrap.decisions.filter(card => card.confirmed)
  const actions = wrap.actions.filter(card => card.confirmed)
  const quotes = wrap.quotes.filter(card => card.confirmed)
  const parked = wrap.pinned.map(topic => `- ${topic.title}`)
  const lines = heading(meta)

  if (preset === 'one-pager') {
    const people = owners(actions).filter(owner => owner !== null).length
    lines.push(
      `${decisions.length} ${decisions.length === 1 ? 'decision' : 'decisions'}, ${actions.length} ${actions.length === 1 ? 'action' : 'actions'} for ${people} ${people === 1 ? 'person' : 'people'}.`,
      ''
    )
    lines.push(
      ...section(
        'Decided',
        decisions.map(card => `- ${card.text}`)
      )
    )
    for (const owner of owners(actions)) {
      lines.push(
        ...section(
          owner ?? 'No owner yet',
          actions
            .filter(card => card.owner === owner)
            .map(card => actionLine(card, false))
        )
      )
    }
    lines.push(...section('Parked for later', parked))
    return lines.join('\n').trimEnd() + '\n'
  }

  lines.push(
    ...section(
      'Decisions',
      decisions.map(card => `- ${card.text} (${clock(card.created_t_ms)})`)
    ),
    ...section(
      'Actions',
      actions.map(card => actionLine(card))
    ),
    ...section('Parked for later', parked)
  )

  if (preset === 'minutes') {
    const listed = new Set([...wrap.decisions, ...wrap.actions, ...wrap.quotes])
    const notes: string[] = []
    for (const header of headersOf(state)) {
      for (const topic of topicsUnder(state, header.id)) {
        const cards = cardsIn(state, topic.id).filter(
          card => card.confirmed || !listed.has(card)
        )
        if (cards.length === 0) continue
        notes.push(`### ${topic.title}`)
        for (const card of cards) {
          const said =
            card.kind === 'action'
              ? actionLine(card).slice(2)
              : card.kind === 'decision'
                ? `Decided: ${card.text}`
                : card.kind === 'quote'
                  ? `“${card.text}”`
                  : card.text
          notes.push(`- ${said} (${clock(card.created_t_ms)})`)
        }
        notes.push('')
      }
    }
    if (notes.length > 0) lines.push('## Notes', '', ...notes)
  } else {
    lines.push(
      ...section(
        'Quotes',
        quotes.map(card => `- “${card.text}”`)
      )
    )
  }
  return lines.join('\n').trimEnd() + '\n'
}

export interface Draft {
  owner: string
  text: string
}

/**
 * One message per person with a ticked action: what they took away and by
 * when. Nothing is sent from here; the host reads, edits and sends.
 */
export function draftsOf(state: MapState, title: string): Draft[] {
  const actions = wrapUpOf(state).actions.filter(card => card.confirmed)
  return owners(actions).flatMap(owner => {
    if (owner === null) return []
    const mine = actions.filter(card => card.owner === owner)
    return [
      {
        owner,
        text: [
          `Hi ${owner}, from today's ${title}:`,
          ...mine.map(
            card =>
              `- ${card.text}${card.due_text ? ` (due ${card.due_text})` : ''}`
          ),
        ].join('\n'),
      },
    ]
  })
}

const WRITER_PROMPT = `You write the summary of a meeting from its notes.
Use only what is in the notes. Never add a fact, name, number, date or owner that is not there.
Keep every owner and due date exactly as written.
Follow the layout the host asks for. Write Markdown. Write the summary only: no preface, no closing remark.`

/**
 * Asks the local model to lay the notes out the way the host described.
 * Rejects when the model does not answer or answers with nothing.
 */
export async function writeSummary(
  transport: OllamaTransport,
  layout: string,
  notes: string,
  signal: AbortSignal = AbortSignal.timeout(120_000)
): Promise<string> {
  const reply = await transport(
    JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,
      options: { num_ctx: OLLAMA_CONTEXT_TOKENS, temperature: 0 },
      messages: [
        { role: 'system', content: WRITER_PROMPT },
        {
          role: 'user',
          content: `Layout the host asked for: ${layout.trim()}\n\nNotes of the meeting:\n\n${notes}`,
        },
      ],
    }),
    signal
  )
  const body = JSON.parse(reply) as { message?: { content?: string } }
  // A model that wraps its answer in a code fence means the inside.
  const text = (body.message?.content ?? '')
    .trim()
    .replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, '$1')
    .trim()
  if (text === '') throw new Error('the model wrote nothing')
  return text + '\n'
}
