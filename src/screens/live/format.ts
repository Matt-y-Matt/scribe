const pad = (value: number) => String(value).padStart(2, '0')

/** Meeting time as a time link reads: `00:03:16`. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

/** The time on the wall, in milliseconds since 1970: when a thing was done. */
export const wallClockMs = (): number => Date.now()

/**
 * The letters on an owner chip: the initials of a full name, or the first two
 * letters of a single one, so Matt and Mei do not both become "M".
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const [first, second] = words
  if (!first) return ''
  const letters = second
    ? `${first[0]}${second[0]}`
    : first.slice(0, 2).toLowerCase()
  return `${letters[0]?.toUpperCase() ?? ''}${letters.slice(1)}`
}
