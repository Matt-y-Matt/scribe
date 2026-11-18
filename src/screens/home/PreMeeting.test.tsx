import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NewMeeting } from '@/ipc'
import { MAX_AGENDA, PreMeeting } from './PreMeeting'

function show(onStart = vi.fn(async (_meeting: NewMeeting) => undefined)) {
  const onClose = vi.fn()
  render(<PreMeeting onStart={onStart} onClose={onClose} />)
  return { onStart, onClose }
}

const header = () => screen.getByLabelText('Agenda')
const addHeader = (title: string) => {
  fireEvent.change(header(), { target: { value: title } })
  fireEvent.keyDown(header(), { key: 'Enter' })
}

describe('PreMeeting', () => {
  it('starts a meeting with its title, agenda and people', async () => {
    const { onStart } = show()
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Bench 60' },
    })
    addHeader('A')
    addHeader('B')
    // Typed and not yet entered: it still counts.
    fireEvent.change(header(), { target: { value: 'C' } })
    fireEvent.change(screen.getByLabelText(/People/), {
      target: { value: 'Matt,  Kabs ,' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith({
        title: 'Bench 60',
        agenda: ['A', 'B', 'C'],
        mode: 'group',
        participants: ['Matt', 'Kabs'],
      })
    )
  })

  it('needs no title and no agenda', async () => {
    const { onStart } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Untitled meeting', agenda: [] })
      )
    )
  })

  it('removes a header, and takes eight at most', () => {
    show()
    for (let n = 1; n <= MAX_AGENDA + 1; n++) addHeader(`Header ${n}`)
    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_AGENDA)
    expect(header()).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Header 3' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_AGENDA - 1)
    expect(header()).toBeEnabled()
  })

  it('reminds the host to tell the room', () => {
    show()
    expect(screen.getByText(/Tell the room you’re recording/)).toBeVisible()
  })

  it('says so when the meeting cannot be created, and lets the host retry', async () => {
    const { onStart } = show(vi.fn(async () => Promise.reject(new Error('x'))))
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The meeting could not be created.'
    )
    expect(
      screen.getByRole('button', { name: 'Start recording' })
    ).toBeEnabled()
    expect(onStart).toHaveBeenCalledTimes(1)
  })
})
