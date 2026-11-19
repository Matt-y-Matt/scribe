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
import { HomeActions, HomeEmpty, HomeList } from './HomeFixtures'

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

  it('previews the first meeting, and another when it is picked', async () => {
    render(<HomeList />)
    const preview = screen.getByRole('region', { name: 'Summary preview' })
    expect(
      await within(preview).findByRole('heading', { name: 'Bench 60' })
    ).toBeVisible()

    fireEvent.click(
      screen.getByRole('button', { name: /Custore weekly team meeting/ })
    )
    expect(
      await within(preview).findByRole('heading', {
        name: 'Custore weekly team meeting',
      })
    ).toBeVisible()
    // What was decided, who owes what, what was parked: from the saved map.
    const decisions = await within(preview).findByRole('region', {
      name: 'Decisions',
    })
    expect(decisions).toHaveTextContent('DECISIONS (4)')
    expect(decisions).toHaveTextContent('Quote 42 a set')
    const actions = within(preview).getByRole('region', { name: 'Actions' })
    expect(actions).toHaveTextContent('Write the CLA quote')
    expect(actions).toHaveTextContent('Pricing · Matt')
    expect(
      within(preview).getByRole('region', { name: 'Pinned' })
    ).toHaveTextContent('Office aircon')
    // Picking a meeting does not leave Home.
    expect(useApp.getState().route).toEqual({ name: 'home' })
  })

  it('opens the meeting from Open, and at a moment from a card’s time', async () => {
    render(<HomeList />)
    fireEvent.click(
      await screen.findByRole('button', { name: /Custore weekly team meeting/ })
    )
    const preview = screen.getByRole('region', { name: 'Summary preview' })
    await within(preview).findByRole('region', { name: 'Decisions' })

    fireEvent.click(within(preview).getByRole('button', { name: '00:00:52' }))
    expect(useApp.getState().route).toEqual({
      name: 'meeting',
      meetingId: 'm_3',
      atMs: 52_300,
    })

    fireEvent.click(within(preview).getByRole('button', { name: 'Open' }))
    expect(useApp.getState().route).toMatchObject({
      name: 'meeting',
      meetingId: 'm_3',
      atMs: undefined,
    })
  })

  it('says so when a meeting has no notes', async () => {
    render(<HomeList />)
    fireEvent.click(
      await screen.findByRole('button', { name: /BNI one-to-one/ })
    )
    expect(
      await screen.findByText(/No notes were taken in this meeting/)
    ).toBeVisible()
  })

  it('searches titles, people and what was said', async () => {
    render(<HomeList />)
    const box = await screen.findByRole('searchbox', {
      name: 'Search meetings',
    })

    // A title.
    fireEvent.change(box, { target: { value: 'udo order' } })
    const list = () => screen.getByRole('list', { name: 'Meetings' })
    await waitFor(() =>
      expect(
        within(list()).getAllByRole('button', {
          name: /review|meeting|one|Bench/,
        })
      ).toHaveLength(1)
    )
    expect(list()).toHaveTextContent('UDO order review')

    // Something said: the meeting it was said in, with the lines.
    fireEvent.change(box, { target: { value: 'landlord' } })
    const lines = await screen.findByRole('list', {
      name: 'Matches in Custore weekly team meeting',
    })
    expect(lines).toHaveTextContent('00:03:08')
    expect(lines).toHaveTextContent('contractor is useless')
    expect(list()).not.toHaveTextContent('UDO order review')

    // A line opens the meeting at that moment.
    fireEvent.click(within(lines).getByRole('button', { name: /I'll message/ }))
    expect(useApp.getState().route).toEqual({
      name: 'meeting',
      meetingId: 'm_3',
      atMs: 377_000,
    })
  })

  it('says so when nothing matches, and Escape clears the search', async () => {
    render(<HomeList />)
    const box = await screen.findByRole('searchbox', {
      name: 'Search meetings',
    })
    fireEvent.change(box, { target: { value: 'zebra' } })
    expect(
      await screen.findByText(
        'No meeting has “zebra” in its title, people or transcript.'
      )
    ).toBeVisible()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(await screen.findByRole('list', { name: 'Meetings' })).toBeVisible()
  })

  it('lists every open action by person, and a tick marks one done', async () => {
    render(<HomeList />)
    const tab = await screen.findByRole('tab', { name: 'Open actions (11)' })
    fireEvent.click(tab)
    expect(tab).toHaveAttribute('aria-selected', 'true')

    const kabs = await screen.findByRole('region', { name: 'Kabs' })
    expect(kabs).toHaveTextContent('3 open')
    expect(kabs).toHaveTextContent('Call Ross and confirm the real headcount')
    expect(kabs).toHaveTextContent(
      /due tomorrow · Custore weekly team meeting, .* · 00:01:12/
    )

    const box = within(kabs).getByRole('checkbox', {
      name: 'Done: Get the Pantone from Ross',
    })
    fireEvent.click(box)
    expect(box).toBeChecked()
    expect(kabs).toHaveTextContent('2 open')
    // It stays in sight, so a slip can be undone; the count moves at once.
    expect(screen.getByRole('tab', { name: 'Open actions (10)' })).toBeVisible()

    // A time opens the meeting it was said in, at that moment.
    fireEvent.click(within(kabs).getByRole('button', { name: '00:01:12' }))
    expect(useApp.getState().route).toEqual({
      name: 'meeting',
      meetingId: 'm_3',
      atMs: 72_200,
    })
  })

  it('goes back to the meeting when one is picked from the list', async () => {
    render(<HomeActions />)
    expect(await screen.findByRole('region', { name: 'Matt' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /UDO order review/ }))
    expect(
      await screen.findByRole('heading', { name: 'UDO order review' })
    ).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Meeting' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('starts a new meeting like a past one, with what it parked on offer', async () => {
    render(<HomeList />)
    fireEvent.click(
      await screen.findByRole('button', { name: /Custore weekly team meeting/ })
    )
    await screen.findByRole('region', { name: 'Pinned' })
    fireEvent.click(
      screen.getByRole('button', { name: 'New meeting like this' })
    )
    expect(useApp.getState().sheet).toEqual({
      name: 'premeeting',
      like: {
        title: 'Custore weekly team meeting',
        agenda: ['CLA quote', 'Supplier delays', 'Designer hire'],
        participants: ['Matt', 'Zach', 'Ant', 'Kabs'],
        parked: ['Office aircon', 'Christmas pop-up'],
      },
    })
  })

  it('Start now records at once, with no sheet and no agenda', async () => {
    render(<HomeList />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start now' }))
    await waitFor(() =>
      expect(useApp.getState().route).toMatchObject({
        name: 'meeting',
        start: true,
      })
    )
    expect(useApp.getState().sheet).toBeNull()
  })

  it('opens the Pre-meeting sheet from New meeting', async () => {
    render(<HomeEmpty />)
    fireEvent.click(await screen.findByRole('button', { name: 'New meeting' }))
    expect(screen.getByRole('dialog', { name: 'New meeting' })).toBeVisible()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
