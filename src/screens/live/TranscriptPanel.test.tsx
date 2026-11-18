import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { fixtureStore } from './fixture'
import { fixtureSession, type FixtureMode } from './fixture-session'
import { LiveHarness } from './harness'
import { TranscriptPanel } from './TranscriptPanel'

function show(mode: FixtureMode = 'recording', until = 's006') {
  const { session, actions } = fixtureSession({ until, mode })
  const playSpan = vi.fn()
  render(
    <LiveHarness
      store={fixtureStore({ until })}
      session={session}
      actions={{ ...actions, playSpan }}
    >
      <TranscriptPanel />
    </LiveHarness>
  )
  return { session, playSpan }
}

const lines = () =>
  screen.getByTestId('transcript').querySelectorAll('li button')

describe('TranscriptPanel', () => {
  it('lists what was said, each line with its time and source', () => {
    show()
    expect(lines()).toHaveLength(6)
    expect(lines()[1]).toHaveTextContent('00:00:08')
    expect(lines()[1]).toHaveTextContent('Room')
    expect(lines()[1]).toHaveTextContent('Can we add the Christmas pop-up?')
  })

  it('plays the span of a line that is clicked', () => {
    const { playSpan } = show()
    fireEvent.click(lines()[1] as Element)
    expect(playSpan).toHaveBeenCalledWith(8_100, 11_000)
  })

  it('gains a line the moment a segment arrives', () => {
    const { session } = show()
    act(() =>
      session.setState(state => ({
        segments: [
          ...state.segments,
          {
            id: 'new',
            meeting_id: 'm_fixture',
            t0_ms: 60_000,
            t1_ms: 62_000,
            speaker_label: 'System audio',
            source: 'system',
            text: 'From the call.',
            confidence: 1,
          },
        ],
      }))
    )
    expect(lines()).toHaveLength(7)
    expect(lines()[6]).toHaveTextContent('System audio')
  })

  it('searches this meeting and says when nothing matches', async () => {
    show('recording', 's022')
    const box = screen.getByRole('searchbox', { name: 'Search this meeting' })
    fireEvent.change(box, { target: { value: 'guangzhou lead' } })
    expect(await screen.findByText(/pushed the polo lead time/)).toBeVisible()
    expect(lines()).toHaveLength(1)

    fireEvent.change(box, { target: { value: 'zebra' } })
    expect(
      await screen.findByText('Nothing in this meeting matches “zebra”.')
    ).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(lines().length).toBeGreaterThan(10)
  })

  it('says why it is empty: nothing said yet, paused, or no model', () => {
    const { session } = show('recording')
    act(() => session.setState({ segments: [] }))
    expect(
      screen.getByText('Nothing said yet. What the room says appears here.')
    ).toBeVisible()

    act(() => session.setState({ rec: 'paused' }))
    expect(screen.getByText('Paused. Nothing is being recorded.')).toBeVisible()

    act(() => session.setState({ rec: 'recording', modelMissing: true }))
    expect(
      screen.getByText('The transcript is off: no speech model is installed.')
    ).toBeVisible()
  })
})
