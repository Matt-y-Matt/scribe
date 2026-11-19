import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MapStore } from '@/engine/store'
import { wrapUpOf } from '@/engine/summary'
import type { Summary } from '@/ipc'
import { BackendContext, BackendError, type Backend } from '@/lib/backend'
import { fixtureBackend } from '@/lib/fixture-backend'
import { FIXTURE_PINS, fixtureStore } from '../live/fixture'
import { fixtureSession } from '../live/fixture-session'
import { EndScreen } from './EndScreen'

function show(
  options: {
    store?: MapStore
    summaries?: Record<string, Summary>
    backend?: Partial<Backend>
  } = {}
) {
  const store = options.store ?? fixtureStore({ pins: FIXTURE_PINS })
  const { session, actions } = fixtureSession({ mode: 'wrap' })
  const leave = vi.fn()
  const playSpan = vi.fn()
  const backend = {
    ...fixtureBackend({ summaries: options.summaries ?? {} }),
    ...options.backend,
  }
  const saveSummary = vi.spyOn(backend, 'saveSummary')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <BackendContext value={backend}>
        <EndScreen
          store={store}
          session={session}
          actions={{ ...actions, leave, playSpan }}
        />
      </BackendContext>
    </QueryClientProvider>
  )
  return { store, session, leave, playSpan, saveSummary }
}

const summaryText = () =>
  screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Summary text' })

describe('EndScreen', () => {
  it('opens with everything ticked and a summary already written', async () => {
    const { store } = show()
    const text = await summaryText()
    await waitFor(() => expect(text.value).toContain('## Decisions'))
    expect(text.value).toContain('- **Kabs**: Call Ross')

    const decisions = screen.getByRole('region', { name: 'Decisions' })
    expect(decisions).toHaveTextContent('DECISIONS (4)')
    expect(within(decisions).getAllByRole('checkbox')).toHaveLength(4)
    for (const box of within(decisions).getAllByRole('checkbox')) {
      expect(box).toBeChecked()
    }
    expect(screen.getByRole('region', { name: 'Pinned' })).toHaveTextContent(
      'Office aircon'
    )
    // The default ticks are not the host's doing: Ctrl+Z leaves them.
    expect(store.log.at(-1)?.source).toBe('engine')
  })

  it('ticks a card the model adds after the screen has opened', async () => {
    const { store } = show()
    const text = await summaryText()
    await waitFor(() => expect(text.value).toContain('## Decisions'))
    const topic = Object.values(store.getState().topics).find(
      row => row.title === 'Pricing'
    )
    if (!topic) throw new Error('no topic')

    act(() => {
      store.commit('add_card', 'engine', [
        {
          entity: 'card',
          id: 'c_late',
          before: null,
          after: {
            id: 'c_late',
            meeting_id: 'm_fixture',
            topic_id: topic.id,
            kind: 'decision',
            text: 'Send the quote on Monday',
            owner: null,
            due_text: null,
            segment_ids: [],
            status: 'accepted',
            source: 'engine',
            created_t_ms: 380_000,
            confirmed: false,
            done_at_ms: null,
            order_key: 99,
          },
        },
      ])
    })
    await waitFor(() =>
      expect(text.value).toContain('- Send the quote on Monday (00:06:20)')
    )
    expect(
      screen.getByRole('checkbox', {
        name: 'In the summary: Send the quote on Monday',
      })
    ).toBeChecked()
  })

  it('takes an unticked row out of the summary and the drafts', async () => {
    show()
    const text = await summaryText()
    await waitFor(() => expect(text.value).toContain('Platform setup fee'))

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'In the summary: Platform setup fee 7,500, one-time',
      })
    )
    expect(text.value).not.toContain('Platform setup fee')

    expect(screen.getByRole('textbox', { name: 'Draft for Ant' })).toHaveValue(
      "Hi Ant, from today's Custore weekly team meeting:\n- Vector logo and mockups (due Wednesday)\n- Write the job description (due Friday)"
    )
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'In the summary: Vector logo and mockups',
      })
    )
    expect(screen.getByRole('textbox', { name: 'Draft for Ant' })).toHaveValue(
      "Hi Ant, from today's Custore weekly team meeting:\n- Write the job description (due Friday)"
    )
  })

  it('edits text, owner and due date where they stand, undoably', async () => {
    const { store } = show()
    const text = await summaryText()
    await waitFor(() => expect(text.value).toContain('## Actions'))
    const actions = screen.getByRole('region', { name: 'Actions' })

    const owner = within(actions).getByLabelText(
      'Owner of: Draft the two options for UDO'
    )
    fireEvent.change(owner, { target: { value: 'Matt' } })
    fireEvent.blur(owner)
    const due = within(actions).getByLabelText(
      'Due date of: Draft the two options for UDO'
    )
    fireEvent.change(due, { target: { value: 'Thursday' } })
    fireEvent.blur(due)

    fireEvent.click(
      within(actions).getByRole('button', { name: 'Write the CLA quote' })
    )
    const box = within(actions).getByRole('textbox', { name: 'Card text' })
    fireEvent.change(box, { target: { value: 'Write and send the CLA quote' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(text.value).toContain(
      '- **Matt**: Draft the two options for UDO, due Thursday'
    )
    expect(text.value).toContain('- **Matt**: Write and send the CLA quote')

    // Three edits, three steps back.
    act(() => {
      store.undo()
      store.undo()
      store.undo()
    })
    expect(text.value).toContain('- **Zach**: Draft the two options for UDO\n')
    expect(text.value).toContain('- **Matt**: Write the CLA quote\n')
  })

  it('says how many ticked actions nobody owns', async () => {
    const store = fixtureStore({ pins: FIXTURE_PINS })
    show({ store })
    const text = await summaryText()
    await waitFor(() => expect(text.value).toContain('## Actions'))
    const actions = screen.getByRole('region', { name: 'Actions' })
    expect(actions).not.toHaveTextContent('no owner')

    const owner = within(actions).getByLabelText(
      'Owner of: Write the CLA quote'
    )
    fireEvent.change(owner, { target: { value: '' } })
    fireEvent.blur(owner)
    expect(actions).toHaveTextContent('1 has no owner')
    expect(
      wrapUpOf(store.getState()).actions.find(
        card => card.text === 'Write the CLA quote'
      )?.owner
    ).toBeNull()
  })

  it('switches preset, and saves what is on screen', async () => {
    const { saveSummary } = show()
    const text = await summaryText()
    fireEvent.click(screen.getByRole('radio', { name: 'One-pager' }))
    await waitFor(() =>
      expect(text.value).toContain('4 decisions, 11 actions for 4 people.')
    )
    await waitFor(() =>
      expect(saveSummary).toHaveBeenLastCalledWith('m_fixture', {
        markdown: text.value,
        layout: 'one-pager',
      })
    )
  })

  it('keeps a saved summary as it was written, and points out a change since', async () => {
    show({
      summaries: {
        m_fixture: {
          markdown: '# Mine\n\nEdited by hand.\n',
          layout: 'minutes',
        },
      },
    })
    const text = await summaryText()
    expect(text.value).toBe('# Mine\n\nEdited by hand.\n')
    expect(screen.queryByText(/The lists changed/)).toBeNull()

    const first = screen.getAllByRole('checkbox', {
      name: /^In the summary/,
    })[0]
    if (!first) throw new Error('no rows')
    // Nothing was ticked when this summary was saved: tick one.
    fireEvent.click(first)
    expect(
      screen.getByText('The lists changed after this was written.')
    ).toBeVisible()
    expect(text.value).toBe('# Mine\n\nEdited by hand.\n')

    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }))
    expect(text.value).toContain('## Decisions')
  })

  it('asks the local model for a layout of the host’s own', async () => {
    const ollamaChat = vi.fn(async (_body: string) =>
      JSON.stringify({ message: { content: '# In plain words\n\nAll good.' } })
    )
    show({ backend: { ollamaChat } })
    const text = await summaryText()
    fireEvent.change(screen.getByRole('textbox', { name: 'Your own layout' }), {
      target: { value: 'plain words, one paragraph' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Write' }))
    await waitFor(() =>
      expect(text.value).toBe('# In plain words\n\nAll good.\n')
    )
    expect(ollamaChat.mock.calls[0]?.[0]).toContain(
      'plain words, one paragraph'
    )
  })

  it('changes nothing and says so when the local model does not answer', async () => {
    show({
      backend: {
        ollamaChat: async () => {
          throw new BackendError({ kind: 'local_ai', detail: 'refused' })
        },
      },
    })
    const text = await summaryText()
    await waitFor(() => expect(text.value).toContain('## Decisions'))
    const before = text.value
    fireEvent.change(screen.getByRole('textbox', { name: 'Your own layout' }), {
      target: { value: 'haiku' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Write' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The model on this PC did not answer'
    )
    expect(text.value).toBe(before)
  })

  it('goes back to the map, and Finish leaves without sending anything', async () => {
    const { session, leave } = show()
    await summaryText()
    expect(screen.getByText('Nothing is sent from this screen.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    expect(leave).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Map and recording' }))
    expect(session.getState().view).toBe('map')
  })

  it('plays what a row was made from when its time is clicked', async () => {
    const { playSpan } = show()
    await summaryText()
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Decisions' })).getByRole(
        'button',
        { name: '00:00:52' }
      )
    )
    expect(playSpan).toHaveBeenCalledWith(52_300, 64_300)
  })
})
