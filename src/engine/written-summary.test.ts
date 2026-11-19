// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { OllamaTransport } from './providers/ollama'
import type { Turn } from './turns'
import {
  renderWritten,
  sameLine,
  stretchesOf,
  transcriptText,
  writeMeetingSummary,
  type StretchNotes,
  type WrittenSummary,
} from './written-summary'

const turn = (index: number, speaker: string, text: string): Turn => ({
  id: `l${index}`,
  covers: [`l${index}`],
  t0: index * 60_000,
  t1: index * 60_000 + 5_000,
  speaker,
  text,
})

const TURNS = [
  turn(0, 'Dana', 'We print the banner at the shop on Marsh Road, same day.'),
  turn(1, 'Lee', 'Sixty is fine. Go with them. Send me the file tonight.'),
  turn(2, 'Dana', 'Then the launch has to be by the fifth.'),
  turn(3, 'Lee', 'Do we still want the second colour?'),
]

interface Request {
  system: string
  user: string
  format: { required: string[] }
  options: { num_ctx: number; temperature: number }
  think: boolean
}

/** A model that answers each request with the next reply in the list. */
function model(replies: unknown[]) {
  const requests: Request[] = []
  const transport: OllamaTransport = async body => {
    const sent = JSON.parse(body) as {
      messages: { content: string }[]
      format: { required: string[] }
      options: { num_ctx: number; temperature: number }
      think: boolean
    }
    requests.push({
      system: sent.messages[0]?.content ?? '',
      user: sent.messages[1]?.content ?? '',
      format: sent.format,
      options: sent.options,
      think: sent.think,
    })
    const reply = replies[requests.length - 1]
    return JSON.stringify({ message: { content: JSON.stringify(reply) } })
  }
  return { transport, requests }
}

const notes = (extra: Partial<StretchNotes> = {}): StretchNotes => ({
  subject: 'Banner',
  points: ['The Marsh Road shop prints the banner the same day for 60.'],
  decisions: [],
  actions: [],
  open: [],
  ...extra,
})
const written = {
  topics: [
    { title: 'Banner', points: ['The Marsh Road shop prints it for 60.'] },
  ],
  open: ['Whether to keep the second colour.'],
  gist: 'They settled where to print the banner.',
}
const OPTIONS = { title: 'Launch prep', participants: ['Dana', 'Lee'] }

describe('stretchesOf', () => {
  it('cuts the meeting at turns, a few minutes at a time', () => {
    const stretches = stretchesOf(TURNS, 23)
    expect(stretches.map(stretch => stretch.map(t => t.id))).toEqual([
      ['l0', 'l1'],
      ['l2', 'l3'],
    ])
  })

  it('gives a short tail to the stretch before it', () => {
    const stretches = stretchesOf([...TURNS, turn(4, 'Dana', 'Yes we do.')], 34)
    expect(stretches.map(stretch => stretch.length)).toEqual([3, 2])
    expect(stretchesOf(TURNS, 32).map(stretch => stretch.length)).toEqual([4])
  })

  it('has nothing to cut in an empty meeting', () => {
    expect(stretchesOf([])).toEqual([])
  })
})

describe('transcriptText', () => {
  it('shows each turn with its time and speaker', () => {
    expect(transcriptText(TURNS.slice(1, 2))).toBe(
      '[01:00] Lee: Sixty is fine. Go with them. Send me the file tonight.'
    )
  })
})

describe('sameLine', () => {
  it('knows the same thing said in nearly the same words', () => {
    expect(
      sameLine('Launch by December 5th', 'The launch is by December 5th.')
    ).toBe(true)
    expect(sameLine('Launch by December 5th', 'Stop recommending SVG')).toBe(
      false
    )
  })
})

describe('writeMeetingSummary', () => {
  it('takes notes on each stretch, then writes from the notes', async () => {
    const { transport, requests } = model([
      notes({
        decisions: ['Print the banner at the Marsh Road shop.'],
        actions: [
          { owner: 'Dana', text: 'Send Lee the banner file', due: 'tonight' },
        ],
      }),
      notes({
        subject: 'Launch date',
        points: ['The launch has to be by the fifth.'],
        open: ['Whether to keep the second colour.'],
      }),
      written,
    ])
    const steps: string[] = []
    const summary = await writeMeetingSummary(transport, TURNS, {
      ...OPTIONS,
      stretchWords: 23,
      onProgress: (step, of) => steps.push(`${step}/${of}`),
    })

    expect(steps).toEqual(['1/3', '2/3', '3/3'])
    expect(requests).toHaveLength(3)
    // Each stretch is read with its own transcript in front of the model…
    expect(requests[0]?.user).toContain('[00:00] Dana: We print the banner')
    expect(requests[0]?.user).not.toContain('by the fifth')
    // …and a line of what came just before, so "it" means something.
    expect(requests[1]?.user).toContain('JUST BEFORE THIS STRETCH')
    expect(requests[1]?.user).toContain('Banner: The Marsh Road shop')
    expect(requests[1]?.user).toContain('[02:00] Dana: Then the launch')
    // The last request sees the notes, never the transcript.
    expect(requests[2]?.user).toContain('STRETCH 2\nSubject: Launch date')
    expect(requests[2]?.user).toContain(
      '- Dana: Send Lee the banner file (due tonight)'
    )
    expect(requests[2]?.user).not.toContain('[00:00]')
    expect(requests[2]?.format.required).toEqual(['topics', 'open', 'gist'])
    for (const request of requests) {
      expect(request.think).toBe(false)
      expect(request.options).toMatchObject({ num_ctx: 16_384, temperature: 0 })
    }

    expect(summary).toEqual({
      gist: 'They settled where to print the banner.',
      topics: written.topics,
      decisions: ['Print the banner at the Marsh Road shop.'],
      actions: [
        { owner: 'Dana', text: 'Send Lee the banner file', due: 'tonight' },
      ],
      open: ['Whether to keep the second colour.'],
    })
  })

  it('keeps decisions and actions as noted, each one once', async () => {
    const { transport } = model([
      notes({
        decisions: ['Launch by the fifth.'],
        actions: [{ owner: 'Lee', text: 'Check the logo', due: null }],
      }),
      notes({
        decisions: ['The launch is by the fifth.', 'Print at Marsh Road.'],
        actions: [
          { owner: 'Lee', text: 'Check the logo.', due: null },
          // The same words, another person: their own action.
          { owner: 'Dana', text: 'Check the logo', due: null },
        ],
      }),
      // What the writing step makes of them is not asked for and not used.
      { ...written, decisions: ['Something else'] },
    ])
    const summary = await writeMeetingSummary(transport, TURNS, {
      ...OPTIONS,
      stretchWords: 23,
    })
    expect(summary.decisions).toEqual([
      'Launch by the fifth.',
      'Print at Marsh Road.',
    ])
    expect(summary.actions.map(action => action.owner)).toEqual(['Lee', 'Dana'])
  })

  it('puts what the live notes hold first, and adds what they lack', async () => {
    const { transport } = model([
      notes({
        decisions: ['Print the banner at the Marsh Road shop'],
        actions: [{ owner: 'Lee', text: 'Check the logo', due: null }],
      }),
      written,
    ])
    const summary = await writeMeetingSummary(transport, TURNS, {
      ...OPTIONS,
      noted: {
        decisions: ['Print the banner at the Marsh Road shop for 60'],
        actions: [{ owner: 'Dana', text: 'Send the file', due: 'tonight' }],
      },
    })
    expect(summary.decisions).toEqual([
      'Print the banner at the Marsh Road shop for 60',
    ])
    expect(summary.actions).toEqual([
      { owner: 'Dana', text: 'Send the file', due: 'tonight' },
      { owner: 'Lee', text: 'Check the logo', due: null },
    ])
  })

  it('does not pass on what a small model makes up', async () => {
    const { transport } = model([
      notes({
        decisions: ['None', ''],
        actions: [
          // A date nobody said, an owner who is not in the meeting.
          { owner: 'Ross', text: 'Send the file', due: '2024-12-06' },
          { owner: 'lee', text: 'Check the logo', due: 'tonight' },
          { owner: null, text: 'Nothing specific was assigned', due: null },
        ],
        open: ['No open questions.'],
      }),
      {
        ...written,
        open: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        topics: [...written.topics, { title: 'Empty', points: [] }],
      },
    ])
    const summary = await writeMeetingSummary(transport, TURNS, OPTIONS)
    expect(summary.decisions).toEqual([])
    expect(summary.actions).toEqual([
      { owner: null, text: 'Send the file', due: null },
      { owner: 'Lee', text: 'Check the logo', due: 'tonight' },
    ])
    expect(summary.open).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(summary.topics).toEqual(written.topics)
  })

  it('fails when there is nothing to read or the model writes something else', async () => {
    await expect(
      writeMeetingSummary(model([]).transport, [], OPTIONS)
    ).rejects.toThrow('there is no transcript to read')
    await expect(
      writeMeetingSummary(model([{ nope: true }]).transport, TURNS, OPTIONS)
    ).rejects.toThrow('the model did not take notes')
    await expect(
      writeMeetingSummary(model([notes(), 'text']).transport, TURNS, OPTIONS)
    ).rejects.toThrow('the model did not write a summary')
  })
})

describe('renderWritten', () => {
  const summary: WrittenSummary = {
    gist: 'They settled where to print the banner.',
    topics: written.topics,
    decisions: ['Print the banner at the Marsh Road shop.'],
    actions: [
      { owner: 'Dana', text: 'Send Lee the banner file', due: 'tonight' },
      { owner: null, text: 'Book the van', due: null },
    ],
    open: ['Whether to keep the second colour.'],
  }

  it('lays the summary out as Markdown, what people owe before the detail', () => {
    expect(
      renderWritten(summary, {
        title: 'Launch prep',
        date: 'Nov 19, 2026',
        participants: ['Dana', 'Lee'],
      })
    ).toBe(
      [
        '# Launch prep',
        'Nov 19, 2026 · Dana, Lee',
        '',
        'They settled where to print the banner.',
        '',
        '## Decisions',
        '- Print the banner at the Marsh Road shop.',
        '',
        '## Actions',
        '- **Dana**: Send Lee the banner file, due tonight',
        '- **No owner**: Book the van',
        '',
        '## Open questions',
        '- Whether to keep the second colour.',
        '',
        '## Discussed',
        '',
        '### Banner',
        '- The Marsh Road shop prints it for 60.',
        '',
      ].join('\n')
    )
  })

  it('leaves out a section that has nothing in it', () => {
    const text = renderWritten(
      { ...summary, decisions: [], actions: [], open: [], topics: [] },
      { title: 'Launch prep', participants: [] }
    )
    expect(text).toBe(
      '# Launch prep\n\nThey settled where to print the banner.\n'
    )
  })
})
