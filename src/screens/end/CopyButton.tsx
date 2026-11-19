import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

/** Puts `text` on the clipboard and says so for two seconds. */
export function CopyButton({
  text,
  label = 'Copy',
}: {
  text: string
  label?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2_000)
    return () => clearTimeout(timer)
  }, [state])

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setState('copied'),
          () => setState('failed')
        )
      }}
    >
      {state === 'copied'
        ? 'Copied'
        : state === 'failed'
          ? 'Could not copy'
          : label}
    </Button>
  )
}
