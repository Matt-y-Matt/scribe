import { describe, expect, it } from 'vitest'
import { FIXTURE_PINS, fixtureStore } from '@/screens/live/fixture'
import { confirmCards, editCard } from './actions'
import {
  draftsOf,
  listedCards,
  renderSummary,
  wrapUpOf,
  writeSummary,
} from './summary'

const META = {
  title: 'Custore weekly',
  date: '17 Nov 2026',
  participants: ['Matt', 'Zach', 'Ant', 'Kabs'],
}

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

const cardWith = (store: ReturnType<typeof wrapped>, text: string) => {
  const card = Object.values(store.getState().cards).find(
    row => row.text === text
  )
  if (!card) throw new Error(`no card "${text}"`)
  return card
}

describe('wrapUpOf', () => {
  it('lists decisions, actions and pins in meeting order', () => {
    const wrap = wrapUpOf(fixtureStore({ pins: FIXTURE_PINS }).getState())
    expect(wrap.decisions.map(card => card.text)).toEqual([
      'Quote 42 a set; 40 if they sign a Q2 replenishment batch',
      'Platform setup fee 7,500, one-time',
      'Hire a full-time junior designer, conditional on CLA signing',
      'Names are a separate line at 3.50 each, if in scope',
    ])
    expect(wrap.actions).toHaveLength(11)
    expect(wrap.pinned.map(topic => topic.title)).toEqual([
      'Office aircon',
      'Christmas pop-up',
    ])
  })
})

describe('confirmCards', () => {
  it('ticks everything in one operation that Ctrl+Z does not take back', () => {
    const store = wrapped()
    expect(listedCards(store.getState()).every(card => card.confirmed)).toBe(
      true
    )
    expect(store.log.at(-1)?.source).toBe('engine')
  })

  it('is undoable when the host does it', () => {
    const store = wrapped()
    const ids = wrapUpOf(store.getState()).decisions.map(card => card.id)
    confirmCards(store, ids, false)
    expect(wrapUpOf(store.getState()).decisions.some(c => c.confirmed)).toBe(
      false
    )
    store.undo()
    expect(wrapUpOf(store.getState()).decisions.every(c => c.confirmed)).toBe(
      true
    )
  })
})

describe('renderSummary', () => {
  it('writes decisions, actions with owner and due, and what was parked', () => {
    const text = renderSummary(wrapped().getState(), 'decisions-actions', META)
    expect(text).toContain(
      '# Custore weekly\n17 Nov 2026 · Matt, Zach, Ant, Kabs'
    )
    expect(text).toContain(
      '## Decisions\n- Quote 42 a set; 40 if they sign a Q2 replenishment batch (00:00:52)'
    )
    expect(text).toContain(
      '- **Kabs**: Call Ross and confirm the real headcount, due tomorrow'
    )
    expect(text).toContain('- **Matt**: Write the CLA quote\n')
    expect(text).toContain(
      '## Parked for later\n- Office aircon\n- Christmas pop-up'
    )
    expect(text.endsWith('\n')).toBe(true)
    expect(text).not.toContain('## Notes')
  })

  it('leaves out what the host unticked, and says when nobody owns an action', () => {
    const store = wrapped()
    editCard(store, cardWith(store, 'Platform setup fee 7,500, one-time').id, {
      confirmed: false,
    })
    editCard(store, cardWith(store, 'Write the CLA quote').id, { owner: null })
    const text = renderSummary(store.getState(), 'decisions-actions', META)
    expect(text).not.toContain('Platform setup fee')
    expect(text).toContain('- **No owner**: Write the CLA quote')
  })

  it('one-pager: a count, then actions under each person', () => {
    const text = renderSummary(wrapped().getState(), 'one-pager', META)
    expect(text).toContain('4 decisions, 11 actions for 4 people.')
    expect(text).toContain('## Decided\n- Quote 42 a set')
    expect(text).toContain(
      '## Kabs\n- Call Ross and confirm the real headcount, due tomorrow\n- Get the Pantone from Ross, due tomorrow'
    )
    expect(text).not.toContain('00:00:52')
  })

  it('minutes: every note too, topic by topic', () => {
    const text = renderSummary(wrapped().getState(), 'minutes', META)
    expect(text).toContain('## Notes')
    expect(text).toContain('### Pricing\n- Ross wants 280 polos')
    expect(text).toContain(
      '- Decided: Quote 42 a set; 40 if they sign a Q2 replenishment batch (00:00:52)'
    )
    expect(text).toContain('### Artwork')
  })

  it('writes only the title when nothing is ticked', () => {
    const state = fixtureStore({ pins: {} }).getState()
    const text = renderSummary(state, 'decisions-actions', {
      title: 'Empty',
      participants: [],
    })
    expect(text.startsWith('# Empty\n')).toBe(true)
    expect(text).not.toContain('## Decisions')
    expect(text).not.toContain('## Actions')
  })
})

describe('draftsOf', () => {
  it('writes one message per owner with their ticked actions', () => {
    const store = wrapped()
    const drafts = draftsOf(store.getState(), 'Custore weekly')
    expect(drafts.map(draft => draft.owner)).toEqual([
      'Matt',
      'Kabs',
      'Ant',
      'Zach',
    ])
    expect(drafts[1]?.text).toBe(
      [
        "Hi Kabs, from today's Custore weekly:",
        '- Call Ross and confirm the real headcount (due tomorrow)',
        '- Get the Pantone from Ross (due tomorrow)',
        '- Ask Ross whether names are in scope (due tomorrow)',
      ].join('\n')
    )
  })

  it('drops an unticked action, and a person with none left', () => {
    const store = wrapped()
    for (const card of wrapUpOf(store.getState()).actions) {
      if (card.owner === 'Ant') editCard(store, card.id, { confirmed: false })
    }
    expect(draftsOf(store.getState(), 'x').map(draft => draft.owner)).toEqual([
      'Matt',
      'Kabs',
      'Zach',
    ])
  })
})

describe('writeSummary', () => {
  it('sends the layout and the notes to the local model and returns its text', async () => {
    const bodies: string[] = []
    const text = await writeSummary(
      async body => {
        bodies.push(body)
        return JSON.stringify({
          message: { content: '```markdown\n# One page\n\n- Quote 42\n```' },
        })
      },
      ' one page ',
      '# Notes\n- Quote 42 a set'
    )
    expect(text).toBe('# One page\n\n- Quote 42\n')
    const sent = JSON.parse(bodies[0] ?? '{}') as {
      stream: boolean
      messages: { role: string; content: string }[]
    }
    expect(sent.stream).toBe(false)
    expect(sent.messages[1]?.content).toContain(
      'Layout the host asked for: one page'
    )
    expect(sent.messages[1]?.content).toContain('- Quote 42 a set')
  })

  it('rejects when the model writes nothing', async () => {
    await expect(
      writeSummary(
        async () => JSON.stringify({ message: { content: ' ' } }),
        'x',
        'y'
      )
    ).rejects.toThrow('nothing')
  })
})
