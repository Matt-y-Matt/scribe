import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

// shadcn/ui button on Base UI, restyled to docs/UI_SPEC.md §1: token colours
// only, 6 px radius, 1 px border, no shadow, opacity-only motion.
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-md border text-body font-semibold whitespace-nowrap transition-opacity duration-150 ease-out select-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-accent bg-accent text-on-accent hover:opacity-90',
        outline: 'border-border bg-surface text-text hover:bg-surface-2',
        ghost: 'border-transparent text-text hover:bg-surface-2',
      },
      size: {
        default: 'h-7 px-3',
        sm: 'h-6 px-2 text-secondary',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

function Button({
  className,
  variant,
  size,
  ...props
}: Omit<ButtonPrimitive.Props, 'className'> &
  VariantProps<typeof buttonVariants> & { className?: string }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
