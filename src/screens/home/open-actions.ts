import { useState } from 'react'
import type { OpenAction } from '@/ipc'
import { useBackend } from '@/lib/backend'
import { dueNote, type DueNote } from '@/lib/due'
import { logger } from '@/lib/logger'

// What Home's Open actions view is made of, apart from its markup.

/** An open action with its due text read as a date, where it can be. */
export interface OwedRow extends OpenAction {
  due: DueNote | null
}

/** Soonest first; what has no date keeps its place after what has one. */
const byDate = (a: OwedRow, b: OwedRow) =>
  (a.due?.date?.getTime() ?? Infinity) - (b.due?.date?.getTime() ?? Infinity)

/**
 * People in the order they first appear; whatever nobody owns goes last.
 * Each person's actions are in the order they fall due as of `nowMs`.
 */
export function byOwner(
  open: readonly OpenAction[],
  nowMs: number
): { owner: string | null; rows: OwedRow[] }[] {
  const groups = new Map<string | null, OwedRow[]>()
  for (const row of open) {
    const due = dueNote(row.card.due_text, row.meeting_created_at_ms, nowMs)
    groups.set(row.card.owner, [
      ...(groups.get(row.card.owner) ?? []),
      { ...row, due },
    ])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => Number(a === null) - Number(b === null))
    .map(([owner, rows]) => ({ owner, rows: rows.sort(byDate) }))
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
