import { countingSource } from './ids'
import { headersOf, type Topic } from './model'
import { MapStore, type PersistenceAdapter } from './store'

// Shared set-up for engine tests: a small meeting with stable ids.

export const TEST_MEETING = {
  id: 'm_test',
  title: 'Weekly',
  mode: 'group',
  participants: ['Matt', 'Zach', 'Ant', 'Kabs'],
} as const

export const TEST_AGENDA = ['CLA quote', 'Supplier delays', 'Designer hire']

export function testStore(adapter?: PersistenceAdapter): MapStore {
  return new MapStore({
    meeting: TEST_MEETING,
    agenda: TEST_AGENDA,
    adapter,
    ids: countingSource(),
  })
}

/** The header with this title; throws when there is none. */
export function headerNamed(store: MapStore, title: string): Topic {
  const header = headersOf(store.getState()).find(row => row.title === title)
  if (!header) throw new Error(`no header "${title}"`)
  return header
}

/** `s001`…`s<count>`, ten seconds apart. */
export function testSegments(count: number): Map<string, { t0_ms: number }> {
  return new Map(
    Array.from({ length: count }, (_, index) => [
      `s${String(index + 1).padStart(3, '0')}`,
      { t0_ms: index * 10_000 },
    ])
  )
}
