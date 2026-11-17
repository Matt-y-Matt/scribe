import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { pinTopic } from '@/engine/actions'
import type { MapStore } from '@/engine/store'
import { FIXTURE_PINS, fixtureStore } from './fixture'
import { LiveHarness } from './harness'
import { useLive } from './live-context'
import { PinsRail } from './PinsRail'

function ActiveTopic() {
  const { state, activeTopicId } = useLive()
  return <p data-testid="active">{state.topics[activeTopicId ?? '']?.title}</p>
}

function show(store: MapStore) {
  render(
    <LiveHarness store={store}>
      <PinsRail />
      <ActiveTopic />
    </LiveHarness>
  )
}

const pinNamed = (title: string) =>
  screen.getByRole('heading', { name: title }).closest('li') as HTMLElement

describe('PinsRail', () => {
  it('says so when nothing is pinned', () => {
    show(fixtureStore({ until: 's026' }))
    expect(screen.getByRole('heading', { name: /PINS/ })).toHaveTextContent(
      'PINS (0)'
    )
    expect(
      screen.getByText(
        'Nothing pinned. Say “pin it” or tap Pin on an off-topic card.'
      )
    ).toBeVisible()
  })

  it('lists each pin with when it was pinned and how many cards it has', () => {
    show(fixtureStore({ pins: FIXTURE_PINS }))
    expect(screen.getByRole('heading', { name: /PINS/ })).toHaveTextContent(
      'PINS (2)'
    )
    expect(pinNamed('Office aircon')).toHaveTextContent(
      'pinned at 00:03:32 · 4 cards'
    )
    expect(pinNamed('Christmas pop-up')).toHaveTextContent(
      'pinned at 00:05:58 · 2 cards'
    )
  })

  it('gains a pin the moment a topic is pinned', async () => {
    const store = fixtureStore({ until: 's026' })
    show(store)
    const aircon = Object.values(store.getState().topics).find(
      topic => topic.title === 'Office aircon'
    )
    pinTopic(store, aircon?.id ?? '')
    expect(
      await screen.findByRole('heading', { name: 'Office aircon' })
    ).toBeVisible()
    expect(screen.getByRole('heading', { name: /PINS/ })).toHaveTextContent(
      'PINS (1)'
    )
  })

  it('Revisit now makes the pin the active topic and keeps the time', async () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    show(store)
    expect(screen.getByTestId('active')).toHaveTextContent('Name embroidery')

    within(pinNamed('Office aircon'))
      .getByRole('button', { name: 'Revisit now' })
      .click()

    await waitFor(() =>
      expect(screen.getByTestId('active')).toHaveTextContent('Office aircon')
    )
    expect(pinNamed('Office aircon')).toHaveTextContent(
      'pinned at 00:03:32 · revisited 00:06:21 · 4 cards'
    )
    const aircon = Object.values(store.getState().topics).find(
      topic => topic.title === 'Office aircon'
    )
    // Still pinned: it stays in the rail until someone unpins it.
    expect(aircon).toMatchObject({ status: 'pinned', revisited_t_ms: 381_200 })
  })

  it('Schedule puts the pin on the schedule list, once, and undo takes it off', async () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    show(store)
    const schedule = within(pinNamed('Christmas pop-up')).getByRole('button', {
      name: 'Schedule',
    })
    schedule.click()

    const done = await within(pinNamed('Christmas pop-up')).findByRole(
      'button',
      { name: 'Scheduled' }
    )
    expect(done).toBeDisabled()
    const scheduled = () =>
      Object.values(store.getState().topics)
        .filter(topic => topic.scheduled_t_ms !== null)
        .map(topic => topic.title)
    expect(scheduled()).toEqual(['Christmas pop-up'])

    store.undo()
    expect(scheduled()).toEqual([])
    expect(
      await within(pinNamed('Christmas pop-up')).findByRole('button', {
        name: 'Schedule',
      })
    ).toBeEnabled()
  })
})
