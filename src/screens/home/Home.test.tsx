import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Home } from './Home'

describe('Home, empty state', () => {
  it('shows one line of guidance and the New meeting button', () => {
    render(<Home />)
    expect(
      screen.getByText('No meetings yet. Start one and Scribe keeps the notes.')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'New meeting' })
    ).toBeInTheDocument()
  })
})
