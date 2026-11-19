import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fixtureStore } from './fixture'
import { fixtureSession } from './fixture-session'
import { LiveHarness } from './harness'
import { LastTime } from './LastTime'

function show(lastTime: boolean) {
  const { session, actions } = fixtureSession({ lastTime })
  render(
    <LiveHarness store={fixtureStore()} session={session} actions={actions}>
      <LastTime />
    </LiveHarness>
  )
  return session
}

describe('LastTime', () => {
  it('is not there when nothing is owed from earlier meetings', () => {
    show(false)
    expect(screen.queryByText('FROM LAST TIME')).toBeNull()
  })

  it('lists what is still open, with owner, due date and which meeting', () => {
    show(true)
    expect(
      screen.getByRole('region', { name: /FROM LAST TIME/ })
    ).toHaveTextContent('3 open')
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('Chase UDO for the signed PO')
    expect(rows[0]).toHaveTextContent(/Zach · due Monday · from /)
    // No due date: the line simply does not mention one.
    expect(rows[2]).toHaveTextContent(/Ant · from /)
  })

  it('a tick marks an action done, and unticking opens it again', () => {
    const session = show(true)
    const box = screen.getByRole('checkbox', {
      name: 'Done: Send Ross the revised size chart',
    })
    fireEvent.click(box)
    expect(session.getState().lastTimeDone).toEqual(['c_then_2'])
    expect(box).toBeChecked()
    expect(
      screen.getByRole('region', { name: /FROM LAST TIME/ })
    ).toHaveTextContent('2 open')

    fireEvent.click(box)
    expect(session.getState().lastTimeDone).toEqual([])
  })

  it('says all done once everything is ticked, and folds away', () => {
    show(true)
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
    const header = screen.getByRole('button', { name: /FROM LAST TIME/ })
    expect(header).toHaveTextContent('all done')

    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})
