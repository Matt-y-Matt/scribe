import { Diamond, Minus, Play, Quote, Search } from 'lucide-react'
import type { CardKind } from '@/engine/model'
import { cn } from '@/lib/utils'
import { KIND_LABEL } from './kinds'

const ICON = {
  // A dash, as in a list of notes. A square reads as an unticked checkbox.
  note: Minus,
  decision: Diamond,
  action: Play,
  research: Search,
  quote: Quote,
} as const

const COLOUR: Record<CardKind, string> = {
  note: 'text-text-muted',
  decision: 'text-accent',
  action: 'text-action',
  research: 'text-research',
  quote: 'text-text-muted',
}

/** A card kind's icon, named for screen readers. */
export function KindIcon({
  kind,
  size = 12,
  className,
}: {
  kind: CardKind
  size?: number
  className?: string
}) {
  const Icon = ICON[kind]
  return (
    <Icon
      role="img"
      aria-label={KIND_LABEL[kind]}
      size={size}
      strokeWidth={2}
      className={cn('shrink-0', COLOUR[kind], className)}
    />
  )
}
