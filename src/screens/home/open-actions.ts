import { useState } from 'react'
import type { OpenAction } from '@/ipc'
import { useBackend } from '@/lib/backend'
import { logger } from '@/lib/logger'

// What Home's Open actions view is made of, apart from its markup.

/** People in the order they first appear; whatever nobody owns goes last. */
export function byOwner(
  open: readonly OpenAction[]
): { owner: string | null; rows: OpenAction[] }[] {
  const groups = new Map<string | null, OpenAction[]>()
  for (const row of open) {
    groups.set(row.card.owner, [...(groups.get(row.card.owner) ?? []), row])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => Number(a === null) - Number(b === null))
    .map(([owner, rows]) => ({ owner, rows }))
}

/** Loads nothing itself: Home owns the query, so its tab can show a count. */
export function useDoneTicks() {
  const backend = useBackend()
  const [done, setDone] = useState<string[]>([])
  const onDone = (cardId: string, isDone: boolean) => {
    setDone(ticked =>
      isDone
        ? [...ticked.filter(id => id !== cardId), cardId]
        : ticked.filter(id => id !== cardId)
    )
    backend.setCardDone(cardId, isDone).catch(() => {
      logger.error('an action could not be marked done')
      // What is on screen must be what is saved.
      setDone(ticked =>
        isDone ? ticked.filter(id => id !== cardId) : [...ticked, cardId]
      )
    })
  }
  return { done, onDone }
}
