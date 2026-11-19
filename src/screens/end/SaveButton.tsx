import { useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Saves text as a file the person names in Windows' Save dialog. Says where
 * it went through `onSaved`, so the screen can show the path.
 */
export function SaveButton({
  save,
  onSaved,
}: {
  /** Resolves with the path written, or null when the dialog was closed. */
  save: () => Promise<string | null>
  onSaved: (outcome: { path: string } | { failed: true } | null) => void
}) {
  const [saving, setSaving] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={saving}
      onClick={() => {
        setSaving(true)
        onSaved(null)
        save()
          .then(
            path => onSaved(path === null ? null : { path }),
            () => onSaved({ failed: true })
          )
          .finally(() => setSaving(false))
      }}
    >
      {saving ? 'Saving…' : 'Save as…'}
    </Button>
  )
}
