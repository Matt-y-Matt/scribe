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
    expect(kabs).toHaveTextContent('3 late')
    expect(kabs).toHaveTextContent('Call Ross and confirm the real headcount')
    expect(kabs).toHaveTextContent(
      /due tomorrow \(.+\) · 1 day late · Custore weekly team meeting, .* · 00:01:12/
    )

    const box = within(kabs).getByRole('checkbox', {
      name: 'Done: Get the Pantone from Ross',
    })
    fireEvent.click(box)
    expect(box).toBeChecked()
    expect(kabs).toHaveTextContent('2 open')
    // What is ticked is no longer late.
    expect(kabs).toHaveTextContent('2 late')
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

  it('renames a meeting where its title stands', async () => {
    render(<HomeList />)
    fireEvent.click(
      await screen.findByRole('button', { name: /UDO order review/ })
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'More for UDO order review' })
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))

    const box = await screen.findByRole('textbox', { name: 'Meeting title' })
    expect(box).toHaveValue('UDO order review')
    fireEvent.change(box, { target: { value: '  UDO reorder  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(
      await screen.findByRole('heading', { name: 'UDO reorder' })
    ).toBeVisible()
    expect(screen.getByRole('list', { name: 'Meetings' })).toHaveTextContent(
      'UDO reorder'
    )
    expect(screen.queryByRole('textbox', { name: 'Meeting title' })).toBeNull()
  })

  it('leaves the title alone on Escape, and when it is emptied', async () => {
    render(<HomeList />)
    fireEvent.click(
      await screen.findByRole('button', { name: /UDO order review/ })
    )
    const rename = async () => {
      fireEvent.click(
        await screen.findByRole('button', { name: 'More for UDO order review' })
      )
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
      return screen.findByRole('textbox', { name: 'Meeting title' })
    }
    let box = await rename()
    fireEvent.change(box, { target: { value: 'Something else' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(
      await screen.findByRole('heading', { name: 'UDO order review' })
    ).toBeVisible()

    box = await rename()
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(
      await screen.findByRole('heading', { name: 'UDO order review' })
    ).toBeVisible()
  })

  it('deletes a meeting only after saying what goes, and takes its actions off the list', async () => {
    render(<HomeList />)
    fireEvent.click(
      await screen.findByRole('button', { name: /Custore weekly team meeting/ })
    )
    await screen.findByRole('tab', { name: 'Open actions (11)' })
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'More for Custore weekly team meeting',
      })
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }))

    const asking = await screen.findByRole('dialog', {
      name: 'Delete this meeting?',
    })
    expect(asking).toHaveTextContent('“Custore weekly team meeting”')
    expect(asking).toHaveTextContent('00:52:00 recorded')
    expect(asking).toHaveTextContent(
      'Its recording, transcript, notes and summary are removed from this PC.'
    )
    await waitFor(() =>
      expect(asking).toHaveTextContent('The 11 open actions from it go too.')
    )
    expect(asking).toHaveTextContent('This cannot be undone.')

    // Keeping it changes nothing.
    fireEvent.click(within(asking).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('list', { name: 'Meetings' })).toHaveTextContent(
      'Custore weekly team meeting'
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'More for Custore weekly team meeting',
      })
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Delete meeting',
      })
    )
    await waitFor(() =>
      expect(
        screen.getByRole('list', { name: 'Meetings' })
      ).not.toHaveTextContent('Custore weekly team meeting')
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      await screen.findByRole('tab', { name: 'Open actions (0)' })
    ).toBeVisible()
    // The right side shows the next meeting, not the one that is gone.
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Bench 60' })
    ).toBeVisible()
  })

  it('opens the Pre-meeting sheet from New meeting', async () => {
    render(<HomeEmpty />)
    fireEvent.click(await screen.findByRole('button', { name: 'New meeting' }))
    expect(screen.getByRole('dialog', { name: 'New meeting' })).toBeVisible()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
