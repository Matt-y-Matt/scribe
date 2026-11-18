import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

// A sheet: a panel over the screen it was opened from (UI_SPEC §3.2, §3.5).
// It fills its nearest positioned ancestor, so over the live screen it leaves
// the status strip, and with it the recording indicator, in view (rule 3).
// Esc closes it (UI_SPEC §4.6). No shadow, no blur: a border and a scrim.

export function Sheet({
  title,
  onClose,
  children,
  width = 560,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
}) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement
    panel.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [onClose])

  return (
    <div className="fade-in absolute inset-0 z-40 flex justify-center overflow-y-auto bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] p-6">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        tabIndex={-1}
        style={{ width }}
        className="flex h-fit max-w-full flex-col rounded-md border bg-surface outline-none"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <h2 id="sheet-title" className="text-header font-semibold">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-md text-text-muted transition-opacity duration-150 ease-out hover:bg-surface-2"
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}
