import { applyOps } from '@/engine/apply'
import type { MapStore } from '@/engine/store'

// What the Playwright tests reach for on a fixture screen (`?screen=live…`
// under `vite dev`): the map store, and a way to add cards the way the engine
// does. Installed in development builds only.

export interface ScribeTestHook {
  store: MapStore
  /** Adds `count` engine cards to the topic with this title, one op each. */
  insertCards(topicTitle: string, count: number): string[]
}

declare global {
  interface Window {
    __scribe?: ScribeTestHook
  }
}

let inserted = 0

export function installTestHook(store: MapStore): () => void {
  if (!import.meta.env.DEV) return () => undefined

  window.__scribe = {
    store,
    insertCards(topicTitle, count) {
      const topic = Object.values(store.getState().topics).find(
        row => row.kind === 'topic' && row.title === topicTitle
      )
      if (!topic) throw new Error(`no topic "${topicTitle}"`)
      const texts: string[] = []
      for (let n = 0; n < count; n++) {
        const segment = `x${String(++inserted).padStart(3, '0')}`
        const text = `Inserted card ${inserted}`
        texts.push(text)
        applyOps(
          store,
          [
            {
              op: 'add_card',
              topic_id: topic.id,
              kind: 'note',
              text,
              segment_ids: [segment],
            },
          ],
          {
            tMs: store.now,
            segments: new Map([[segment, { t0_ms: store.now }]]),
          }
        )
      }
      return texts
    },
  }
  return () => {
    delete window.__scribe
  }
}
