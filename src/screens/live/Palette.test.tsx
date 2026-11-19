import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FIXTURE_PINS, fixtureStore } from './fixture'
import { fixtureSession, fixtureSegments } from './fixture-session'
import { clock } from './format'
import { LiveHarness } from './harness'
import { Palette } from './Palette'
import { PALETTE_LIMITS, searchMeeting } from './palette-search'

const store = () => fixtureStore({ pins: FIXTURE_PINS })

describe('searchMeeting', () => {
  it('lists the topics when nothing is typed', () => {
    const hits = searchMeeting(store().getState(), fixtureSegments(), '', clock)
    expect(hits.length).toBe(PALETTE_LIMITS.topic)
    expect(hits.every(hit => hit.type === 'topic')).toBe(true)
    expect(hits[0]).toMatchObject({ text: 'Pricing', meta: 'CLA quote' })
  })

  it('finds topics, cards and lines, every word in any order', () => {
    const hits = searchMeeting(
      store().getState(),
      fixtureSegments(),
      'ROSS headcount',
      clock
    )
    expect(hits.map(hit => [hit.type, hit.text.slice(0, 24)])).toEqual([
      ['card', 'Call Ross and confirm th'],
      ['line', "Seven five. We're cheape"],
    ])
    expect(hits[0]).toMatchObject({ meta: '00:01:12 · Pricing · Kabs' })
    const said = fixtureSegments().find(segment => segment.id === hits[1]?.id)
    expect(hits[1]).toMatchObject({ t0Ms: said?.t0_ms, t1Ms: said?.t1_ms })
  })

  it('finds a card by its owner, and marks a pinned topic', () => {
    const state = store().getState()
    const byOwner = searchMeeting(state, [], 'ant', clock).filter(
      hit => hit.type === 'card'
    )
    expect(byOwner.map(hit => hit.text)).toContain('Write the job description')
    expect(searchMeeting(state, [], 'aircon', clock)[0]).toMatchObject({
      type: 'topic',
      text: 'Office aircon',
      meta: 'pinned',
    })
  })
})

function show() {
  const map = store()
  const { session } = fixtureSession()
  const onClose = vi.fn()
  const onFocusTopic = vi.fn()
  const playSpan = vi.fn()
  render(
    <LiveHarness
      store={map}
      session={session}
      actions={{ playSpan }}
      onFocusTopic={onFocusTopic}
    >
      <Palette onClose={onClose} />
    </LiveHarness>
  )
  const box = screen.getByRole('combobox', { name: 'Search this meeting' })
  return { map, onClose, onFocusTopic, playSpan, box }
}

const type = (box: HTMLElement, value: string) =>
  fireEvent.change(box, { target: { value } })

describe('Palette', () => {
  it('opens ready to type, with the topics listed', () => {
    const { box } = show()
    expect(box).toHaveFocus()
    expect(screen.getAllByRole('option')).toHaveLength(PALETTE_LIMITS.topic)
    expect(screen.getAllByRole('option')[0]).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('Enter on a card shows its topic on the map', () => {
    const { map, box, onFocusTopic, onClose } = show()
    type(box, 'job description')
    const first = screen.getAllByRole('option')[0] as HTMLElement
    expect(first).toHaveTextContent('Write the job description')
    fireEvent.keyDown(box, { key: 'Enter' })

    const topic = Object.values(map.getState().topics).find(
      row => row.title === 'Full-time or freelance'
    )
    expect(onFocusTopic).toHaveBeenCalledWith(topic?.id)
    expect(onClose).toHaveBeenCalled()
  })

  it('the arrows move through the results, and a line plays', () => {
    const { map, box, playSpan, onFocusTopic } = show()
    type(box, 'landlord')
    const hits = searchMeeting(
      map.getState(),
      fixtureSegments(),
      'landlord',
      clock
    )
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(hits.length)
    // Past the end stays on the last result, which is a line of transcript.
    for (let n = 0; n < hits.length + 2; n++) {
      fireEvent.keyDown(box, { key: 'ArrowDown' })
    }
    expect(options[hits.length - 1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(options[hits.length - 2]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(box, { key: 'ArrowDown' })

    const last = hits[hits.length - 1]
    if (last?.type !== 'line') throw new Error('expected a line last')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(playSpan).toHaveBeenCalledWith(last.t0Ms, last.t1Ms)
    expect(onFocusTopic).not.toHaveBeenCalled()
  })

  it('a click picks a result', () => {
    const { box, onFocusTopic } = show()
    type(box, 'artwork')
    fireEvent.click(
      within(screen.getByRole('listbox')).getAllByRole(
        'option'
      )[0] as HTMLElement
    )
    expect(onFocusTopic).toHaveBeenCalledTimes(1)
  })

  it('says so when nothing matches, and Escape closes', () => {
    const { box, onClose } = show()
    type(box, 'zebra')
    expect(
      screen.getByText('Nothing in this meeting matches “zebra”.')
    ).toBeVisible()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps what is typed away from the keys of the map', () => {
    const { box } = show()
    const heard = vi.fn()
    window.addEventListener('keydown', heard)
    fireEvent.keyDown(box, { key: 'p' })
    window.removeEventListener('keydown', heard)
    expect(heard).not.toHaveBeenCalled()
  })
})
