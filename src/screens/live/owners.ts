import type { MapState } from '@/engine/model'
import { matchOwner } from '@/engine/owner'

// Who an action can be given to, and the shorthand for saying so while
// typing a card.

/** The names an owner is most likely to be: the room, then who already owes. */
export function knownOwners(state: MapState): string[] {
  const names = new Set(state.meeting.participants)
  for (const card of Object.values(state.cards)) {
    if (card.owner) names.add(card.owner)
  }
  return [...names]
}

const MENTION = /(^|\s)@([\p{L}\p{N}'-]+)/u

/**
 * `@kabs` in a card's text names its owner. Returns the person meant and the
 * text without the mention, or null when the text has none or it matches
 * nobody in the meeting: an `@` that is not a name is left as typed.
 */
export function ownerMention(
  text: string,
  names: readonly string[]
): { owner: string; text: string } | null {
  const found = MENTION.exec(text)
  if (!found) return null
  const owner = matchOwner(found[2], names)
  if (!owner) return null
  return {
    owner,
    text: text
      .replace(MENTION, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim(),
  }
}
