import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('keeps a type-scale class next to a text colour', () => {
    expect(cn('text-body', 'text-text-muted')).toBe('text-body text-text-muted')
  })

  it('lets a later type-scale class replace an earlier one', () => {
    expect(cn('text-body', 'text-meta')).toBe('text-meta')
  })

  it('lets a later colour replace an earlier one', () => {
    expect(cn('bg-surface', 'bg-accent')).toBe('bg-accent')
  })
})
