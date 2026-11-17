import { z } from 'zod'
import { acceptSuggestion } from '../actions'
import {
  ADDITIVE_OPS,
  headersOf,
  openSuggestions,
  segmentsCitedBy,
  topicsUnder,
  type Card,
  type MapState,
  type Topic,
} from '../model'
import type { MapStore } from '../store'

// Scoring for the golden replay test, docs/TEST_PLAN.md §2. The answers
// behind these rules are in docs/DECISIONS.md (G1–G6).

const expectedSchema = z.object({
  fixture: z.string(),
  topics: z.array(
    z.object({
      key: z.string(),
      header: z.string().nullable(),
      off_agenda: z.boolean().optional(),
      expect_pin_suggestion_between: z
        .tuple([z.string(), z.string()])
        .optional(),
      must_cover_segments: z.array(z.string()),
    })
  ),
  cards: z.array(
    z.object({
      kind: z.enum(['note', 'decision', 'action', 'research', 'quote']),
      topic: z.string(),
      owner: z.string().optional(),
      segments: z.array(z.string()).min(1),
      gist: z.string(),
    })
  ),
  pins_at_end: z.array(z.string()),
})
export type GoldenExpected = z.infer<typeof expectedSchema>
type ExpectedCard = GoldenExpected['cards'][number]

/** Parses a `.expected.json` file. */
export function parseExpected(text: string): GoldenExpected {
  const parsed = expectedSchema.safeParse(JSON.parse(text))
  if (!parsed.success) {
    throw new Error(`golden expectations: ${parsed.error.issues[0]?.message}`)
  }
  return parsed.data
}

/**
 * Segments that state the agenda or sum up, per fixture. The answer key's
 * third "never" rule: no card is created from one of these alone.
 */
const NOT_NEW_FACTS: Record<string, readonly string[]> = {
  'meeting-custore-weekly.jsonl': ['s001', 's044'],
}

export const PASS = {
  /** Share of a topic's must-cover segments that have to be cited. */
  coverage: 0.8,
  /** Share of the expected cards that have to be matched. */
  cardMatch: 0.8,
} as const

export interface TopicScore {
  key: string
  covered: number
  of: number
  ok: boolean
}

export interface PinScore {
  key: string
  /** A pin suggestion cites a segment in the expected window. */
  suggested: boolean
  /** That topic is pinned once the host has accepted the suggestions. */
  pinnedAtEnd: boolean
}

export interface GoldenScore {
  topics: TopicScore[]
  topicsCovered: number
  cardsMatched: number
  cardsExpected: number
  cardMatch: number
  /** Gists of the expected cards nothing matched. */
  unmatched: string[]
  /** Engine actions given to someone the answer key does not allow. */
  wrongOwners: { text: string; owner: string; segments: string[] }[]
  pins: PinScore[]
  neverViolations: string[]
  pass: boolean
}

const live = (state: MapState): Card[] =>
  Object.values(state.cards).filter(card => card.status !== 'dismissed')

const overlaps = (a: readonly string[], b: readonly string[]) =>
  a.some(id => b.includes(id))

const share = (cited: Set<string>, mustCover: readonly string[]) =>
  mustCover.filter(id => cited.has(id)).length

/** Largest one-to-one pairing of expected cards with engine cards. */
function matchCards(expected: ExpectedCard[], cards: Card[]): (Card | null)[] {
  const fits = (want: ExpectedCard, card: Card) =>
    card.kind === want.kind &&
    (card.owner ?? '') === (want.owner ?? '') &&
    overlaps(card.segment_ids, want.segments)

  const takenBy = new Map<Card, number>()
  const tryMatch = (index: number, seen: Set<Card>): boolean => {
    const want = expected[index]
    if (!want) return false
    for (const card of cards) {
      if (seen.has(card) || !fits(want, card)) continue
      seen.add(card)
      const holder = takenBy.get(card)
      if (holder === undefined || tryMatch(holder, seen)) {
        takenBy.set(card, index)
        return true
      }
    }
    return false
  }
  expected.forEach((_, index) => tryMatch(index, new Set()))

  const result: (Card | null)[] = expected.map(() => null)
  for (const [card, index] of takenBy) result[index] = card
  return result
}

/**
 * Accepts every open pin suggestion, standing in for the host tapping Pin.
 * Speech in the meeting never pins by itself (DECISIONS, G4).
 */
export function acceptPinSuggestions(store: MapStore): number {
  const pins = openSuggestions(store.getState()).filter(
    suggestion => suggestion.kind === 'pin'
  )
  for (const suggestion of pins) acceptSuggestion(store, suggestion.id)
  return pins.length
}

/** Scores the map in `store`. Call `acceptPinSuggestions` first. */
export function scoreGolden(
  store: MapStore,
  expected: GoldenExpected
): GoldenScore {
  const state = store.getState()
  const cards = live(state)
  const offAgenda = Object.values(state.topics).filter(
    topic => topic.kind === 'topic' && topic.off_agenda
  )
  const pinSuggested = new Set(
    Object.values(state.suggestions).flatMap(({ payload }) =>
      payload.kind === 'pin' ? [payload.topic_id] : []
    )
  )

  // Pins first: each expected off-agenda topic claims one engine topic.
  const claimed = new Set<string>()
  const pinnedKeys = new Map<string, Topic | undefined>()
  for (const want of expected.topics) {
    const window = want.expect_pin_suggestion_between
    if (!window) continue
    const [from, to] = window
    const candidate = offAgenda
      .filter(
        topic =>
          !claimed.has(topic.id) &&
          pinSuggested.has(topic.id) &&
          [...segmentsCitedBy(state, topic.id)].some(
            id => id >= from && id <= to
          )
      )
      .sort(
        (a, b) =>
          share(segmentsCitedBy(state, b.id), want.must_cover_segments) -
          share(segmentsCitedBy(state, a.id), want.must_cover_segments)
      )[0]
    if (candidate) claimed.add(candidate.id)
    pinnedKeys.set(want.key, candidate)
  }

  const topics = expected.topics.map((want): TopicScore => {
    let covered: number
    if (want.header === null) {
      // Off-agenda: the citing cards and topic sit under one topic.
      const own = pinnedKeys.get(want.key)
      const pool = own ? [own] : offAgenda
      covered = Math.max(
        0,
        ...pool.map(topic =>
          share(segmentsCitedBy(state, topic.id), want.must_cover_segments)
        )
      )
    } else {
      // On the agenda: everything under the header counts, however the
      // engine split it into topics.
      const header = headersOf(state).find(row => row.title === want.header)
      const cited = new Set<string>()
      for (const topic of header ? topicsUnder(state, header.id) : []) {
        for (const id of segmentsCitedBy(state, topic.id)) cited.add(id)
      }
      covered = share(cited, want.must_cover_segments)
    }
    const of = want.must_cover_segments.length
    return {
      key: want.key,
      covered,
      of,
      ok: covered / of >= PASS.coverage,
    }
  })

  const matches = matchCards(expected.cards, cards)
  const cardsMatched = matches.filter(Boolean).length

  const expectedActions = expected.cards.filter(card => card.kind === 'action')
  const wrongOwners = cards
    .filter(card => card.kind === 'action' && card.owner !== null)
    .filter(card => {
      const overlapped = expectedActions.filter(want =>
        overlaps(card.segment_ids, want.segments)
      )
      return (
        overlapped.length > 0 &&
        !overlapped.some(want => want.owner === card.owner)
      )
    })
    .map(card => ({
      text: card.text,
      owner: card.owner ?? '',
      segments: [...card.segment_ids],
    }))

  const pins = expected.topics
    .filter(want => want.expect_pin_suggestion_between)
    .map((want): PinScore => {
      const topic = pinnedKeys.get(want.key)
      return {
        key: want.key,
        suggested: topic !== undefined,
        pinnedAtEnd:
          !expected.pins_at_end.includes(want.key) ||
          state.topics[topic?.id ?? '']?.status === 'pinned',
      }
    })

  const neverViolations: string[] = []
  const notNew = NOT_NEW_FACTS[expected.fixture] ?? []
  for (const card of cards) {
    if (
      card.segment_ids.length > 0 &&
      card.segment_ids.every(id => notNew.includes(id))
    ) {
      neverViolations.push(
        `a card was made from ${card.segment_ids.join(', ')} alone`
      )
    }
  }
  for (const entry of store.log) {
    if (entry.source !== 'engine') continue
    const additive =
      ADDITIVE_OPS.includes(entry.type) &&
      entry.changes.every(change => change.before === null)
    if (!additive) {
      neverViolations.push(
        `the engine applied a ${entry.type} (op ${entry.seq})`
      )
    }
  }
  for (const entry of store.log) {
    if (/^(delete|rename|merge)_/.test(entry.type)) {
      neverViolations.push(`a ${entry.type} was applied (op ${entry.seq})`)
    }
  }

  const topicsCovered = topics.filter(topic => topic.ok).length
  const cardMatch = cardsMatched / expected.cards.length
  return {
    topics,
    topicsCovered,
    cardsMatched,
    cardsExpected: expected.cards.length,
    cardMatch,
    unmatched: expected.cards
      .filter((_, index) => !matches[index])
      .map(card => `${card.kind}: ${card.gist}`),
    wrongOwners,
    pins,
    neverViolations,
    pass:
      topicsCovered === expected.topics.length &&
      cardMatch >= PASS.cardMatch &&
      pins.every(pin => pin.suggested && pin.pinnedAtEnd) &&
      wrongOwners.length === 0 &&
      neverViolations.length === 0,
  }
}

/** The score as the lines `pnpm golden` prints and docs/NOTES.md records. */
export function formatScore(score: GoldenScore, provider: string): string {
  const percent = `${Math.round(score.cardMatch * 100)}%`
  const lines = [
    `Golden replay — ${provider}: ${score.pass ? 'PASS' : 'FAIL'}`,
    `  topic coverage  ${score.topicsCovered}/${score.topics.length}  (${score.topics
      .map(topic => `${topic.key} ${topic.covered}/${topic.of}`)
      .join(', ')})`,
    `  card match      ${score.cardsMatched}/${score.cardsExpected} = ${percent}`,
    `  wrong owners    ${score.wrongOwners.length}`,
    `  pins            ${score.pins
      .map(
        pin =>
          `${pin.key}: ${pin.suggested ? 'suggested' : 'NOT suggested'}, ${
            pin.pinnedAtEnd ? 'pinned at end' : 'NOT pinned at end'
          }`
      )
      .join('; ')}`,
    `  never rules     ${score.neverViolations.length} violated`,
  ]
  for (const gist of score.unmatched) lines.push(`  unmatched       ${gist}`)
  for (const wrong of score.wrongOwners) {
    lines.push(
      `  wrong owner     ${wrong.owner}: ${wrong.text} [${wrong.segments.join(', ')}]`
    )
  }
  for (const violation of score.neverViolations) {
    lines.push(`  never           ${violation}`)
  }
  return lines.join('\n')
}
