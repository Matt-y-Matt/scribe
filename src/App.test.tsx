import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import App from './App'

afterEach(() => window.history.replaceState(null, '', '/'))

describe('App', () => {
  it('opens on Home', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Meetings' })).toBeVisible()
  })

  it('renders the screen state named by ?screen=', () => {
    window.history.replaceState(null, '', '/?screen=home-empty')
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Meetings' })).toBeVisible()
  })

  it('says so when ?screen= names a state that does not exist', () => {
    window.history.replaceState(null, '', '/?screen=nope')
    render(<App />)
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown screen')
  })
})
