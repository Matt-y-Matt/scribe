import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  cardsIn,
  openSuggestions,
  pinnedTopics,
  type MapState,
} from '@/engine/model'
import type { MapStore } from '@/engine/store'
import { FIXTURE_PINS, fixtureStore } from './fixture'
import { LiveHarness } from './harness'
import { TopicCard } from './TopicCard'

const topicNamed = (state: MapState, title: string) => {
  const topic = Object.values(state.topics).find(row => row.title === title)
  if (!topic) throw new Error(`no topic "${title}"`)
  return topic
}

function show(
  store: MapStore,
  title: string,
  collapsed = false,
  nowMs?: number
) {
  const topic = topicNamed(store.getState(), title)
  render(
    <LiveHarness store={store} collapsed={collapsed} nowMs={nowMs}>
      <TopicCard topicId={topic.id} />
    </LiveHarness>
  )
  return topic
}

describe('TopicCard', () => {
  it('shows the title, the card count and each card with its kind', () => {
    show(fixtureStore({ pins: FIXTURE_PINS }), 'Artwork')
    const topic = screen.getByRole('region', { name: 'Artwork' })
    expect(
      within(topic).getByRole('heading', { name: 'Artwork' })
    ).toBeVisible()
    expect(within(topic).getByLabelText('3 cards')).toHaveTextContent('3')

    const rows = within(topic).getAllByRole('listitem')
    expect(rows.map(row => row.dataset.kind)).toEqual([
      'note',
      'action',
      'action',
    ])
    // Kind is an icon and a word, never colour alone.
    expect(
      within(rows[0] as HTMLElement).getByRole('img')
    ).toHaveAccessibleName('Note')
    expect(
      within(rows[1] as HTMLElement).getByRole('img')
    ).toHaveAccessibleName('Action')
    expect(rows[1]).toHaveTextContent('Vector logo and mockups')
  })

  it('gives an action its owner, its due text with the date it means, and its owner chip', () => {
    // The harness holds the meeting on Tuesday 17 November 2026.
    show(fixtureStore({ pins: FIXTURE_PINS }), 'Artwork')
    const row = screen.getByText('Vector logo and mockups').closest('li')
    expect(row).toHaveTextContent(/Ant · due Wednesday \(.+\)/)
    expect(row).not.toHaveTextContent('late')
    expect(within(row as HTMLElement).getByTitle('Ant')).toHaveTextContent('An')
    // When it was said is on the card's corner, for whoever points at it.
    expect(row).toHaveTextContent('00:01:38')

    const note = screen.getByText(/Logo came as a WhatsApp JPG/).closest('li')
    expect(note).toHaveTextContent('00:01:23')
    expect(within(note as HTMLElement).queryByTitle(/./)).toBeNull()
  })

  it('says how late an open action is when the meeting is read days after', () => {
    // Friday: "Wednesday" was two days ago.
    const friday = new Date(2026, 10, 20, 11).getTime()
    show(fixtureStore({ pins: FIXTURE_PINS }), 'Artwork', false, friday)
    const row = screen.getByText('Vector logo and mockups').closest('li')
    expect(row).toHaveTextContent('2 days late')
    // A note has no date and is never late.
    expect(
      screen.getByText(/Logo came as a WhatsApp JPG/).closest('li')
    ).not.toHaveTextContent('late')
  })

  it('collapses cards to kind counts when zoomed out', () => {
    show(fixtureStore({ pins: FIXTURE_PINS }), 'Pricing', true)
    expect(screen.queryByText('Write the CLA quote')).toBeNull()
    const counts = screen.getAllByRole('listitem')
    expect(counts.map(item => `${item.title} ${item.textContent}`)).toEqual([
      'Decision 2',
      'Action 2',
      'Note 3',
    ])
    // The title stays.
    expect(screen.getByRole('heading', { name: 'Pricing' })).toBeVisible()
  })

  it('moves nothing for a ghost until it is accepted', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS, ghosts: true })
    const pricing = show(store, 'Pricing')
    const names = topicNamed(store.getState(), 'Name embroidery')
    expect(cardsIn(store.getState(), pricing.id)).toHaveLength(7)

    const move = screen.getByText('Move here').closest('[data-suggestion-id]')
    expect(move).toHaveTextContent('from Name embroidery')
    expect(move).toHaveTextContent('It changes the quote')

    within(move as HTMLElement)
      .getByRole('button', { name: 'Accept' })
      .click()
    expect(cardsIn(store.getState(), pricing.id)).toHaveLength(8)
    expect(cardsIn(store.getState(), names.id)).toHaveLength(2)
    expect(store.canUndo).toBe(true)
  })

  it('removes a dismissed ghost and leaves the map alone', async () => {
    const store = fixtureStore({ pins: FIXTURE_PINS, ghosts: true })
    show(store, 'Pricing')
    const before = store.getState().cards

    const merge = screen.getByText('Merge').closest('[data-suggestion-id]')
    within(merge as HTMLElement)
      .getByRole('button', { name: 'Dismiss' })
      .click()

    expect(await screen.findByText('Move here')).toBeVisible()
    expect(screen.queryByText('Merge')).toBeNull()
    expect(store.getState().cards).toBe(before)
    expect(openSuggestions(store.getState()).map(s => s.kind)).toEqual(['move'])
  })

  it('shows at most three ghosts and tucks older ones away', async () => {
    const store = fixtureStore({ pins: FIXTURE_PINS, ghosts: true })
    const pricing = topicNamed(store.getState(), 'Pricing')
    const others = ['Artwork', 'Lead times', 'Full-time or freelance']
    const { applyOps } = await import('@/engine/apply')
    applyOps(
      store,
      others.map(title => ({
        op: 'suggest_merge',
        topic_id: topicNamed(store.getState(), title).id,
        into_topic_id: pricing.id,
      })),
      { tMs: store.now, segments: new Map() }
    )
    show(store, 'Pricing')

    expect(screen.getAllByRole('button', { name: 'Accept' })).toHaveLength(3)
    const more = screen.getByRole('button', { name: '+2 suggestions' })
    more.click()
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Accept' })).toHaveLength(5)
    )
  })

  it('asks to pin an off-agenda topic, and pins it on Pin', () => {
    const store = fixtureStore({ until: 's026' })
    const aircon = show(store, 'Office aircon')
    expect(screen.getByText(/New topic:/)).toHaveTextContent(
      'New topic: Office aircon — Pin it?'
    )
    expect(pinnedTopics(store.getState())).toEqual([])

    screen.getByRole('button', { name: 'Pin' }).click()
    expect(pinnedTopics(store.getState()).map(topic => topic.id)).toEqual([
      aircon.id,
    ])
  })

  it('keeps an off-agenda topic in its column on Keep here', async () => {
    const store = fixtureStore({ until: 's026' })
    show(store, 'Office aircon')
    screen.getByRole('button', { name: 'Keep here' }).click()

    expect(
      await screen.findByRole('heading', { name: 'Office aircon' })
    ).toBeVisible()
    expect(screen.queryByText(/Pin it\?/)).toBeNull()
    expect(pinnedTopics(store.getState())).toEqual([])
  })

  it('leaves a small marker where a pinned topic was', () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    show(store, 'Office aircon')
    expect(screen.getByText('Office aircon')).toBeVisible()
    expect(screen.getByText('pinned')).toBeVisible()
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})

describe('fixture states', () => {
  it('live: the whole meeting, both off-agenda topics pinned', () => {
    const state = fixtureStore({ pins: FIXTURE_PINS }).getState()
    expect(
      pinnedTopics(state).map(topic => [topic.title, topic.pinned_t_ms])
    ).toEqual([
      ['Office aircon', 212_700],
      ['Christmas pop-up', 358_900],
    ])
    expect(openSuggestions(state)).toEqual([])
    expect(Object.keys(state.cards)).toHaveLength(33)
  })

  it('live-unplanned: the aircon has just come up and nothing is pinned', () => {
    const state = fixtureStore({ until: 's026' }).getState()
    expect(openSuggestions(state).map(s => s.payload)).toMatchObject([
      { kind: 'pin', title: 'Office aircon' },
    ])
    expect(pinnedTopics(state)).toEqual([])
  })

  it('live-ghost: a move and a merge wait in Pricing', () => {
    const state = fixtureStore({ pins: FIXTURE_PINS, ghosts: true }).getState()
    expect(openSuggestions(state).map(s => s.kind)).toEqual(['move', 'merge'])
  })
})
