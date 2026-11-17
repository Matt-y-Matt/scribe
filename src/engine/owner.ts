// Owner matching, docs/ARCHITECTURE.md §3.2: an action's owner must be one of
// the meeting's participants. The name the model gives is matched by
// Jaro-Winkler similarity; below 0.8 the owner is left blank rather than
// guessed ("Kabir" is Kabs at 0.85; "Ross" is nobody in the room).

export const OWNER_THRESHOLD = 0.8

function jaro(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const reach = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatched = new Array<boolean>(a.length).fill(false)
  const bMatched = new Array<boolean>(b.length).fill(false)
  let matches = 0

  for (let i = 0; i < a.length; i++) {
    const end = Math.min(b.length, i + reach + 1)
    for (let j = Math.max(0, i - reach); j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue
      aMatched[i] = true
      bMatched[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0

  // Matched characters that are out of order, counted in pairs.
  let outOfOrder = 0
  let j = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue
    while (!bMatched[j]) j++
    if (a[i] !== b[j]) outOfOrder++
    j++
  }
  const transpositions = outOfOrder / 2

  return (
    (matches / a.length +
      matches / b.length +
      (matches - transpositions) / matches) /
    3
  )
}

/** Jaro-Winkler similarity, 0–1: Jaro plus a bonus for a shared prefix. */
export function jaroWinkler(a: string, b: string): number {
  const base = jaro(a, b)
  let prefix = 0
  while (prefix < 4 && prefix < a.length && a[prefix] === b[prefix]) prefix++
  return base + prefix * 0.1 * (1 - base)
}

const normalise = (name: string) =>
  name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .trim()

/**
 * The participant `name` refers to, or null when no one is close enough.
 * Comparison ignores case and punctuation; the first best match wins a tie.
 */
export function matchOwner(
  name: string | null | undefined,
  participants: readonly string[]
): string | null {
  const wanted = normalise(name ?? '')
  if (wanted === '') return null

  let best: string | null = null
  let bestScore = 0
  for (const participant of participants) {
    const score = jaroWinkler(wanted, normalise(participant))
    if (score > bestScore) {
      best = participant
      bestScore = score
    }
  }
  return bestScore >= OWNER_THRESHOLD ? best : null
}
