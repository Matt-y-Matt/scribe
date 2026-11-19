import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { cardsIn, type MapState } from '@/engine/model'
import type { MapStore } from '@/engine/store'
import { FIXTURE_PINS, fixtureStore } from './fixture'
import { LiveHarness } from './harness'
import { TopicCard } from './TopicCard'
import { claimTyping, holdTyping } from './type-ahead'

const topicNamed = (state: MapState, title: string) => {
  const topic = Object.values(state.topics).find(row => row.title === title)
  if (!topic) throw new Error(`no topic "${title}"`)
  return topic
}

function show(store: MapStore, title: string) {
  const topic = topicNamed(store.getState(), title)
  const onNotify = vi.fn()
  const playSpan = vi.fn()
  render(
    <LiveHarness store={store} onNotify={onNotify} actions={{ playSpan }}>
      <TopicCard topicId={topic.id} />
    </LiveHarness>
  )
  return { topic, onNotify, playSpan }
}

const rowOf = (text: string | RegExp) =>
  screen.getByText(text).closest('li') as HTMLElement

const openEditor = (text: string | RegExp) => {
  fireEvent.click(
    within(rowOf(text)).getByRole('button', { name: 'Edit card' })
  )
  return screen.getByRole('form', { name: 'Edit card' })
}

describe('editing a card in place', () => {
  it('opens on the pencil without playing the card', () => {
    const { playSpan } = show(fixtureStore({ pins: FIXTURE_PINS }), 'Artwork')
    const form = openEditor('Vector logo and mockups')

    expect(within(form).getByLabelText('Card text')).toHaveValue(
      'Vector logo and mockups'
    )
    expect(within(form).getByRole('radio', { name: 'Action' })).toBeChecked()
    expect(within(form).getByLabelText('Owner')).toHaveValue('Ant')
    expect(within(form).getByLabelText('Due')).toHaveValue('Wednesday')
    expect(playSpan).not.toHaveBeenCalled()
  })

  it('opens on Enter when the card has the focus', () => {
    show(fixtureStore({ pins: FIXTURE_PINS }), 'Artwork')
    fireEvent.keyDown(rowOf('Vector logo and mockups'), { key: 'Enter' })
    expect(screen.getByRole('form', { name: 'Edit card' })).toBeVisible()
  })

  it('saves text, kind, owner and due as one undoable change', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    show(store, 'Artwork')
    const before = store.getState()
    const card = Object.values(before.cards).find(
      row => row.text === 'Vector logo and mockups'
    )
    if (!card) throw new Error('no card')

    const form = openEditor('Vector logo and mockups')
    fireEvent.change(within(form).getByLabelText('Card text'), {
      target: { value: '  Vector logo, two mockups  ' },
    })
    fireEvent.change(within(form).getByLabelText('Owner'), {
      target: { value: 'Zach' },
    })
    fireEvent.change(within(form).getByLabelText('Due'), {
      target: { value: 'Friday' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))

    expect(store.getState().cards[card.id]).toMatchObject({
      text: 'Vector logo, two mockups',
      kind: 'action',
      owner: 'Zach',
      due_text: 'Friday',
    })
    expect(screen.queryByRole('form')).toBeNull()

    store.undo()
    expect(store.getState().cards[card.id]).toEqual(card)
  })

  it('changes a note into a decision, with no owner asked for', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    show(store, 'Artwork')
    const form = openEditor(/Logo came as a WhatsApp JPG/)
    expect(within(form).queryByLabelText('Owner')).toBeNull()

    fireEvent.click(within(form).getByRole('radio', { name: 'Decision' }))
    expect(within(form).queryByLabelText('Owner')).toBeNull()
    fireEvent.keyDown(within(form).getByLabelText('Card text'), {
      key: 'Enter',
    })

    expect(rowOf(/Logo came as a WhatsApp JPG/).dataset.kind).toBe('decision')
  })

  it('asks who and when once a card is an action', () => {
    show(fixtureStore({ pins: FIXTURE_PINS }), 'Artwork')
    const form = openEditor(/Logo came as a WhatsApp JPG/)
    fireEvent.click(within(form).getByRole('radio', { name: 'Action' }))
    expect(within(form).getByLabelText('Owner')).toHaveValue('')
    expect(within(form).getByLabelText('Due')).toHaveValue('')
  })

  it('marks an action done, shows it struck through, and opens it again', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    show(store, 'Artwork')
    const id = Object.values(store.getState().cards).find(
      row => row.text === 'Vector logo and mockups'
    )?.id
    if (!id) throw new Error('no card')

    let form = openEditor('Vector logo and mockups')
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Done' }))
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(store.getState().cards[id]?.done_at_ms).toEqual(expect.any(Number))
    expect(rowOf('Vector logo and mockups')).toHaveTextContent('Ant · done')

    form = openEditor('Vector logo and mockups')
    expect(within(form).getByRole('checkbox', { name: 'Done' })).toBeChecked()
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Done' }))
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(store.getState().cards[id]?.done_at_ms).toBeNull()
    // A note has nothing to be done.
    form = openEditor(/Logo came as a WhatsApp JPG/)
    expect(within(form).queryByRole('checkbox', { name: 'Done' })).toBeNull()
  })

  it('leaves the card alone on Escape and on Cancel', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    show(store, 'Artwork')
    const before = store.getState()

    let form = openEditor('Vector logo and mockups')
    fireEvent.change(within(form).getByLabelText('Card text'), {
      target: { value: 'something else' },
    })
    fireEvent.keyDown(within(form).getByLabelText('Card text'), {
      key: 'Escape',
    })
    expect(screen.queryByRole('form')).toBeNull()

    form = openEditor('Vector logo and mockups')
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    expect(store.getState()).toBe(before)
  })

  it('will not save a card with no text', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    show(store, 'Artwork')
    const before = store.getState()
    const form = openEditor('Vector logo and mockups')
    fireEvent.change(within(form).getByLabelText('Card text'), {
      target: { value: '   ' },
    })
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.keyDown(within(form).getByLabelText('Card text'), {
      key: 'Enter',
    })
    expect(store.getState()).toBe(before)
  })

  it('deletes the card, says so, and undo brings it back', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    const { topic, onNotify } = show(store, 'Artwork')
    const form = openEditor('Vector logo and mockups')
    fireEvent.click(within(form).getByRole('button', { name: 'Delete' }))

    expect(cardsIn(store.getState(), topic.id)).toHaveLength(2)
    expect(onNotify).toHaveBeenCalledWith('Deleted the card.')
    store.undo()
    expect(cardsIn(store.getState(), topic.id)).toHaveLength(3)
  })

  it('keeps typing away from the keys of the map', () => {
    show(fixtureStore({ pins: FIXTURE_PINS }), 'Artwork')
    const heard = vi.fn()
    window.addEventListener('keydown', heard)
    const form = openEditor('Vector logo and mockups')
    fireEvent.keyDown(within(form).getByLabelText('Card text'), { key: 'p' })
    window.removeEventListener('keydown', heard)
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('typing before the box is there', () => {
  it('keeps the keys from the map and gives them to the box when it opens', async () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    show(store, 'Artwork')
    const heard = vi.fn()
    window.addEventListener('keydown', heard)

    holdTyping()
    for (const key of ['S', 'e', 'n', 'x', 'Backspace', 'd']) {
      fireEvent.keyDown(window, { key })
    }
    // Not one of them reached the map: no pin, no second box from the "n".
    expect(heard).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Menu for Artwork' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add card' }))
    const form = await screen.findByRole('form', { name: 'New card' })
    expect(within(form).getByLabelText('Card text')).toHaveValue('Send')

    // Once claimed, keys are the page's again.
    fireEvent.keyDown(window, { key: 'q' })
    expect(heard).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', heard)
  })

  it('lets go on Escape, and has nothing for a box that opens later', () => {
    holdTyping()
    fireEvent.keyDown(window, { key: 'a' })
    fireEvent.keyDown(window, { key: 'Escape' })
    const take = vi.fn()
    claimTyping(take)
    expect(take).not.toHaveBeenCalled()
  })
})

describe('@owner while typing', () => {
  it('gives a new note to the person named, as an action', async () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    const { topic } = show(store, 'Artwork')
    fireEvent.click(screen.getByRole('button', { name: 'Menu for Artwork' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add card' }))
    const form = await screen.findByRole('form', { name: 'New card' })
    fireEvent.change(within(form).getByLabelText('Card text'), {
      target: { value: 'Ask for the font name @kabs' },
    })
    expect(within(form).getByRole('status')).toHaveTextContent(
      'Kabs will own this, as an action.'
    )
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }))

    expect(cardsIn(store.getState(), topic.id).at(-1)).toMatchObject({
      text: 'Ask for the font name',
      kind: 'action',
      owner: 'Kabs',
    })
  })

  it('leaves an @ that names nobody in the meeting as it was typed', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    show(store, 'Artwork')
    const form = openEditor(/Logo came as a WhatsApp JPG/)
    fireEvent.change(within(form).getByLabelText('Card text'), {
      target: { value: 'Logo came from ross@udo.sg' },
    })
    expect(within(form).queryByRole('status')).toBeNull()
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(rowOf('Logo came from ross@udo.sg').dataset.kind).toBe('note')
  })
})

describe('adding a card by hand', () => {
  it('adds a note at the end of the topic from the topic menu', async () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    const { topic } = show(store, 'Artwork')
    screen.getByRole('button', { name: 'Menu for Artwork' }).click()
    ;(await screen.findByRole('menuitem', { name: 'Add card' })).click()

    const form = await screen.findByRole('form', { name: 'New card' })
    fireEvent.change(within(form).getByLabelText('Card text'), {
      target: { value: 'Ask for the font name too' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }))

    const cards = cardsIn(store.getState(), topic.id)
    expect(cards).toHaveLength(4)
    expect(cards[3]).toMatchObject({
      text: 'Ask for the font name too',
      kind: 'note',
      source: 'user',
      owner: null,
      // Mid-meeting nothing is ticked: that is the end screen's doing.
      confirmed: false,
    })
    expect(screen.queryByRole('form')).toBeNull()
  })
})
