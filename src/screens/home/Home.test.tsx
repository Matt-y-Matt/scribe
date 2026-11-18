import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useApp } from '@/lib/app-state'
import { FIXTURE_MEETINGS } from './home-fixture-data'
import { HomeEmpty, HomeList } from './HomeFixtures'

afterEach(() => useApp.setState({ route: { name: 'home' }, sheet: null }))

describe('Home', () => {
  it('shows one line of guidance and the New meeting button when empty', async () => {
    render(<HomeEmpty />)
    expect(
      await screen.findByText(
        'No meetings yet. Start one and Scribe keeps the notes.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'New meeting' })
    ).toBeInTheDocument()
  })

  it('lists the meetings on this PC, newest first', async () => {
    render(<HomeList />)
    const list = await screen.findByRole('list', { name: 'Meetings' })
    const titles = within(list)
      .getAllByRole('button')
      .map(row => row.querySelector('span')?.textContent)
    expect(titles).toEqual(FIXTURE_MEETINGS.map(meeting => meeting.title))
    expect(list).toHaveTextContent(
      'CLA quote · Supplier delays · Designer hire'
    )
    expect(list).toHaveTextContent('00:52:00')
  })

  it('offers to recover a meeting that was being recorded when the app died', async () => {
    render(<HomeList />)
    expect(await screen.findByText('Recover meeting “Bench 60”?')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))
    // Recovered: the app opens the meeting.
    await waitFor(() =>
      expect(useApp.getState().route).toEqual({
        name: 'meeting',
        meetingId: 'm_4',
      })
    )
  })

  it('lets the host leave a recovery for later without losing it', async () => {
    render(<HomeList />)
    await screen.findByText('Recover meeting “Bench 60”?')
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('Recover meeting “Bench 60”?')).toBeNull()
    // The meeting is still in the list.
    expect(screen.getByRole('list', { name: 'Meetings' })).toHaveTextContent(
      'Bench 60'
    )
  })

  it('opens the Pre-meeting sheet from New meeting', async () => {
    render(<HomeEmpty />)
    fireEvent.click(await screen.findByRole('button', { name: 'New meeting' }))
    expect(screen.getByRole('dialog', { name: 'New meeting' })).toBeVisible()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
