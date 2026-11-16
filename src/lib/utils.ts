import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The type scale uses our own names (UI_SPEC §1). tailwind-merge has to be
// told they are font sizes, or it treats `text-body` as a colour and drops it
// when a text colour follows.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['title', 'header', 'body', 'secondary', 'meta'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
