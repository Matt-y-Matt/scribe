import { monotonicFactory } from 'ulid'

// Ids are ULIDs minted here, never by the LLM (docs/ARCHITECTURE.md §3.1):
// `t_…` topics and headers, `c_…` cards, `g_…` suggestions.
export type IdPrefix = 't' | 'c' | 'g'
export type IdSource = (prefix: IdPrefix) => string

/** ULIDs that sort in the order they were made, even within one millisecond. */
export function ulidSource(): IdSource {
  const next = monotonicFactory()
  return prefix => `${prefix}_${next()}`
}

/** `t_0001`, `c_0002`, … for tests and fixtures that need stable ids. */
export function countingSource(): IdSource {
  let count = 0
  return prefix => `${prefix}_${String(++count).padStart(4, '0')}`
}
