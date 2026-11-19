import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { editCard } from '@/engine/actions'
import type { MapStore } from '@/engine/store'
import { FIXTURE_PINS, fixtureStore } from './fixture'
import { LiveHarness } from './harness'
import { ownerMention } from './owners'
import { TopicCard } from './TopicCard'

const cardWith = (store: MapStore, text: string) => {
  const card = Object.values(store.getState().cards).find(
    row => row.text === text
  )
  if (!card) throw new Error(`no card "${text}"`)
  return card
}

function show(store: MapStore) {
  const topic = Object.values(store.getState().topics).find(
    row => row.title === 'Artwork'
  )
  if (!topic) throw new Error('no topic')
  const playSpan = vi.fn()
  render(
    <LiveHarness store={store} actions={{ playSpan }}>
      <TopicCard topicId={topic.id} />
    </LiveHarness>
  )
  return { playSpan }
}

describe('the owner chip on the map', () => {
  it('lists the people in the meeting and gives the action to one of them', async () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    const { playSpan } = show(store)
    fireEvent.click(screen.getByRole('button', { name: 'Owner: Ant. Change' }))

    const names = (await screen.findAllByRole('menuitem')).map(
      item => item.textContent
    )
    expect(names).toEqual([
      'Matt',
      'Zach',
      'Ant',
      'Kabs',
      'No owner',
      'Someone else…',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Zach' }))
    expect(cardWith(store, 'Vector logo and mockups').owner).toBe('Zach')
    // Neither click played the card or dragged it.
    expect(playSpan).not.toHaveBeenCalled()

    store.undo()
    expect(cardWith(store, 'Vector logo and mockups').owner).toBe('Ant')
  })

  it('shows a dashed ? on an action nobody owns, which assigns in two clicks', async () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    editCard(store, cardWith(store, 'Vector logo and mockups').id, {
      owner: null,
    })
    show(store)
    const chip = screen.getByRole('button', {
      name: 'No owner. Give this action to someone',
    })
    expect(chip).toHaveTextContent('?')

    fireEvent.click(chip)
    // Nobody to take it away from.
    expect(
      (await screen.findAllByRole('menuitem')).map(item => item.textContent)
    ).not.toContain('No owner')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Kabs' }))
    expect(cardWith(store, 'Vector logo and mockups').owner).toBe('Kabs')
  })

  it('opens the editor for a name that is not on the list', async () => {
    show(fixtureStore({ pins: FIXTURE_PINS }))
    fireEvent.click(screen.getByRole('button', { name: 'Owner: Ant. Change' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Someone else…' })
    )
    expect(await screen.findByRole('form', { name: 'Edit card' })).toBeVisible()
  })

  it('leaves a note without a chip', () => {
    show(fixtureStore({ pins: FIXTURE_PINS }))
    const note = screen.getByText(/Logo came as a WhatsApp JPG/).closest('li')
    expect(note?.querySelector('[aria-label^="Owner"]')).toBeNull()
    expect(note?.querySelector('[aria-label^="No owner"]')).toBeNull()
  })
})

describe('ownerMention', () => {
  const names = ['Matt', 'Zach', 'Ant', 'Kabs']

  it('reads @name as the owner and takes it out of the text', () => {
    expect(ownerMention('Ask for the font name @kabs', names)).toEqual({
      owner: 'Kabs',
      text: 'Ask for the font name',
    })
    expect(ownerMention('@Zach chase the PO today', names)).toEqual({
      owner: 'Zach',
      text: 'chase the PO today',
    })
  })

  it('leaves an @ that is nobody in the meeting, or part of a word', () => {
    expect(ownerMention('Mail ross@udo.sg the quote', names)).toBeNull()
    expect(ownerMention('Ask @landlord about the aircon', names)).toBeNull()
    expect(ownerMention('No mention here', names)).toBeNull()
  })
})
