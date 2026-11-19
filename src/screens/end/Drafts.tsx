import { useState } from 'react'
import type { Draft } from '@/engine/summary'
import { OwnerChip } from '../live/CardRow'
import { CopyButton } from './CopyButton'

// One message per person who owes something (UI_SPEC §3.3), written from
// their ticked actions and editable. Scribe sends nothing yet: Telegram and
// email arrive with M5, and until then a draft is copied and sent by hand.

export function Drafts({ drafts }: { drafts: readonly Draft[] }) {
  // What the host changed, by owner, and the draft it was changed from: a
  // draft that has since gained or lost an action shows the new text again.
  const [edits, setEdits] = useState<
    Record<string, { text: string; from: string }>
  >({})

  return (
    <section aria-label="Drafts" className="flex flex-col gap-1">
      <h2 className="text-meta font-semibold text-text-muted">
        DRAFTS <span className="font-mono">({drafts.length})</span>
      </h2>
      {drafts.length === 0 ? (
        <p className="rounded-md border border-dashed px-2 py-3 text-body text-text-muted">
          A draft is written for each person who owns a ticked action. Give the
          actions above an owner and their drafts appear here.
        </p>
      ) : (
        <>
          <p className="text-secondary text-text-muted">
            Nothing is sent from here: copy a draft into Telegram, WhatsApp or
            an email. Sending from Scribe comes with a later version.
          </p>
          <ul className="grid grid-cols-2 gap-3">
            {drafts.map(draft => {
              const edit = edits[draft.owner]
              const text = edit?.from === draft.text ? edit.text : draft.text
              return (
                <li
                  key={draft.owner}
                  className="flex flex-col gap-2 rounded-md border bg-surface p-2"
                >
                  <div className="flex items-center gap-2">
                    <OwnerChip name={draft.owner} />
                    <span className="min-w-0 flex-1 truncate text-body font-semibold">
                      {draft.owner}
                    </span>
                    <CopyButton text={text} />
                  </div>
                  <textarea
                    aria-label={`Draft for ${draft.owner}`}
                    rows={Math.min(8, text.split('\n').length + 1)}
                    value={text}
                    onChange={event =>
                      setEdits({
                        ...edits,
                        [draft.owner]: {
                          text: event.target.value,
                          from: draft.text,
                        },
                      })
                    }
                    className="resize-none rounded-md border bg-surface px-2 py-1 text-body outline-none focus:border-accent"
                  />
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
