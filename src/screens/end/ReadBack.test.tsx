import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { confirmCards, editCard } from '@/engine/actions'
import type { MapStore } from '@/engine/store'
import { listedCards } from '@/engine/summary'
import { FIXTURE_PINS, fixtureStore } from '../live/fixture'
import { useMapState } from '../live/live-context'
import { ReadBack } from './ReadBack'

function wrapped() {
  const store = fixtureStore({ pins: FIXTURE_PINS })
  confirmCards(
    store,
    listedCards(store.getState()).map(card => card.id),
    true,
    'engine'
  )
  return store
}

function Shown({ store, onClose }: { store: MapStore; onClose: () => void }) {
  const state = useMapState(store)
  return <ReadBack store={store} state={state} onClose={onClose} />
}

function show(store = wrapped()) {
  const onClose = vi.fn()
  render(<Shown store={store} onClose={onClose} />)
  return { store, onClose }
}

const heading = () => screen.getByRole('heading', { level: 3 })

describe('ReadBack', () => {
  it('reads one person at a time, in the order they were first given something', () => {
    show()
    expect(screen.getByRole('dialog', { name: 'Read back' })).toHaveTextContent(
      '1 of 4'
    )
    expect(heading()).toHaveTextContent('Matt')
    expect(heading()).toHaveTextContent('3 actions')
    expect(screen.getAllByRole('listitem')[1]).toHaveTextContent(
      'Put together the designer budget — by this week'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Next: Kabs' }))
    expect(heading()).toHaveTextContent('Kabs')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(heading()).toHaveTextContent('Matt')
  })

  it('goes on with the right arrow and Enter, back with the left, and closes at the end', () => {
    const { onClose } = show()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(heading()).toHaveTextContent('Ant')
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(heading()).toHaveTextContent('Kabs')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(heading()).toHaveTextContent('Zach')
    expect(screen.getByRole('button', { name: 'Done' })).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('hands an action to someone else in one click, undoably', () => {
    const { store } = show()
    const quote = screen.getByRole('group', {
      name: 'Who owns: Write the CLA quote',
    })
    fireEvent.click(within(quote).getByRole('button', { name: 'Zach' }))
    // It has left Matt's page.
    expect(screen.queryByText('Write the CLA quote')).toBeNull()
    expect(heading()).toHaveTextContent('2 actions')
    const card = Object.values(store.getState().cards).find(
      row => row.text === 'Write the CLA quote'
    )
    expect(card?.owner).toBe('Zach')
    store.undo()
  })

  it('puts what nobody owns last, where it can be given to someone', () => {
    const store = wrapped()
    const orphan = Object.values(store.getState().cards).find(
      row => row.text === 'Draft the two options for UDO'
    )
    if (!orphan) throw new Error('no card')
    editCard(store, orphan.id, { owner: null })
    show(store)
    expect(screen.getByRole('dialog')).toHaveTextContent('1 of 5')
    for (let n = 0; n < 4; n++) fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(heading()).toHaveTextContent('Nobody owns these yet')

    fireEvent.click(screen.getByRole('button', { name: 'Kabs' }))
    // The page is gone with its only action; the last person is shown.
    expect(screen.getByRole('dialog')).toHaveTextContent('4 of 4')
  })

  it('leaves out what the host unticked, and says so when nothing is left', () => {
    const store = wrapped()
    confirmCards(
      store,
      listedCards(store.getState()).map(card => card.id),
      false
    )
    const { onClose } = show(store)
    expect(screen.getByText('No ticked actions to read back.')).toBeVisible()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
