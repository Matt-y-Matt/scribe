import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureStore } from './fixture'
import { fixtureSession, type FixtureMode } from './fixture-session'
import { LiveHarness } from './harness'
import { HOLD_MS, StatusStrip } from './StatusStrip'

function show(mode: FixtureMode = 'recording') {
  const { session, actions } = fixtureSession({ until: 's010', mode })
  const pause = vi.fn(actions.pause)
  const resume = vi.fn(actions.resume)
  const stop = vi.fn()
  const openSettings = vi.fn()
  const focused: string[] = []
  render(
    <LiveHarness
      store={fixtureStore({ until: 's010' })}
      session={session}
      actions={{ ...actions, pause, resume, stop, openSettings }}
      onFocusHeader={id => focused.push(id)}
    >
      <StatusStrip />
    </LiveHarness>
  )
  return { session, pause, resume, stop, openSettings, focused }
}

const indicator = () => screen.getByTestId('indicator')

describe('StatusStrip', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows REC and the meeting clock while recording', () => {
    show()
    expect(indicator()).toHaveTextContent('REC')
    expect(indicator()).toHaveTextContent('00:01:21')
    expect(indicator()).toHaveAccessibleName('Recording. Hold to pause.')
  })

  it('pauses only after the indicator has been held for 300 ms', () => {
    const { pause } = show()
    fireEvent.pointerDown(indicator())
    act(() => vi.advanceTimersByTime(HOLD_MS - 1))
    expect(pause).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(pause).toHaveBeenCalledTimes(1)
    expect(indicator()).toHaveTextContent('PAUSED')
  })

  it('stays paused when the hold is let go', () => {
    const { resume } = show()
    fireEvent.pointerDown(indicator())
    act(() => vi.advanceTimersByTime(HOLD_MS))
    // Letting go of the button ends in a click, on a meeting now paused.
    fireEvent.pointerUp(indicator())
    fireEvent.click(indicator(), { detail: 1 })
    expect(resume).not.toHaveBeenCalled()
    expect(indicator()).toHaveTextContent('PAUSED')
    // The next click is a new one, and resumes.
    fireEvent.pointerDown(indicator())
    fireEvent.pointerUp(indicator())
    fireEvent.click(indicator(), { detail: 1 })
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('does not pause on a click or a short press', () => {
    const { pause } = show()
    fireEvent.pointerDown(indicator())
    act(() => vi.advanceTimersByTime(120))
    fireEvent.pointerUp(indicator())
    fireEvent.click(indicator(), { detail: 1 })
    act(() => vi.advanceTimersByTime(1_000))
    expect(pause).not.toHaveBeenCalled()
    expect(indicator()).toHaveTextContent('REC')
  })

  it('pauses from the keyboard, which is as deliberate as a hold', () => {
    const { pause } = show()
    // Enter or Space on a focused button arrives as a click with no pointer.
    fireEvent.click(indicator(), { detail: 0 })
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('resumes with one click when paused', () => {
    const { resume } = show('paused')
    expect(indicator()).toHaveTextContent('PAUSED')
    fireEvent.click(indicator(), { detail: 1 })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(indicator()).toHaveTextContent('REC')
  })

  it('offers Stop while a meeting runs and Home once it is over', () => {
    const { stop } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull()
  })

  it('reads REVIEW for a finished meeting, with no pause control', () => {
    show('review')
    expect(indicator()).toHaveTextContent('REVIEW')
    expect(indicator().tagName).not.toBe('BUTTON')
    expect(screen.getByRole('button', { name: 'Home' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('says NOT RECORDING when there is no microphone', () => {
    show('no-mic')
    expect(indicator()).toHaveTextContent('NOT RECORDING')
  })

  it('has a chip per agenda header that asks the map to show it', () => {
    const { focused } = show()
    const agenda = screen.getByRole('navigation', { name: 'Agenda' })
    expect(agenda).toHaveTextContent('CLA quoteSupplier delaysDesigner hire')
    fireEvent.click(screen.getByRole('button', { name: 'Supplier delays' }))
    expect(focused).toHaveLength(1)
  })

  it('always shows where the audio goes, and opens Settings', () => {
    const { openSettings } = show()
    expect(screen.getByText('local')).toBeVisible()
    expect(screen.getByRole('meter', { name: 'Room level' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(openSettings).toHaveBeenCalledWith('audio')
  })
})
