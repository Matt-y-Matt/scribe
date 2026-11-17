// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { cardsMessage, cardsSchema, cardsToOps, OFF_AGENDA } from './cards'
import type { StructurerInput } from './types'

// The input as the structurer hands it over: ids already aliased.
const INPUT: StructurerInput = {
  agenda: [
    { id: 'H1', title: 'CLA quote' },
    { id: 'H2', title: 'Supplier delays' },
  ],
  outline: [
    {
      id: 'T1',
      title: 'Pricing',
      parent_id: 'H1',
      header: 'CLA quote',
      off_agenda: false,
      last_cards: [
        { id: 'C1', kind: 'decision', text: 'Quote 42 a set' },
        { id: 'C2', kind: 'action', text: 'Write the CLA quote' },
      ],
    },
    {
      id: 'T2',
      title: 'Office aircon',
      parent_id: 't_unplanned',
      header: 'Unplanned',
      off_agenda: true,
      last_cards: [],
    },
  ],
  recent_structured: '[s015] Kabs: I will ask when I call him.',
  new_segments: [
    { id: 's016', t0: 108_000, speaker: 'Matt', text: 'So CLA: … Next.' },
    { id: 's017', t0: 120_500, speaker: 'Zach', text: 'Lead time is 28 days.' },
    { id: 's018', t0: 138_300, speaker: 'Matt', text: 'Can we split?' },
  ],
  participants: ['Matt', 'Zach'],
  now_ms: 145_100,
}

const card = (text: string, extra: object = {}) => ({
  kind: 'note',
  owner: null,
  due_text: null,
  text,
  ...extra,
})
const entry = (id: string, header: string, topic: string, cards: object[]) => ({
  id,
  type: 'new',
  header,
  topic,
  cards,
})

describe('cardsSchema', () => {
  it('lets the model name only what exists in this request', () => {
    const schema = cardsSchema(INPUT) as {
      properties: {
        segments: {
          items: {
            properties: Record<string, { enum?: unknown[] }> & {
              cards: {
                items: { properties: Record<string, { enum?: unknown[] }> }
              }
            }
          }
        }
      }
    }
    const segment = schema.properties.segments.items.properties
    expect(segment.id?.enum).toEqual(['s016', 's017', 's018'])
    expect(segment.header?.enum).toEqual(['H1', 'H2', OFF_AGENDA])
    expect(segment.type?.enum).toEqual(['new', 'recap', 'agenda', 'other'])
    const cardProperties = segment.cards.items.properties
    expect(cardProperties.owner?.enum).toEqual(['Matt', 'Zach', null])
    expect(cardProperties.kind?.enum).toEqual(['note', 'decision', 'action'])
  })
})

describe('cardsMessage', () => {
  it('lays the input out as text a small model can follow', () => {
    expect(cardsMessage(INPUT)).toBe(
      [
        'AGENDA',
        'H1 = CLA quote',
        'H2 = Supplier delays',
        '',
        'TOPICS SO FAR',
        'Under H1 (CLA quote):',
        '  - Pricing (latest: [decision] Quote 42 a set; [action] Write the CLA quote)',
        'Under H2 (Supplier delays): none yet',
        'Off the agenda (OFF):',
        '  - Office aircon',
        '',
        'PARTICIPANTS: Matt, Zach',
        '',
        'ALREADY DEALT WITH (context only, no cards from these)',
        '[s015] Kabs: I will ask when I call him.',
        '',
        'NEW SEGMENTS',
        '[s016] Matt: So CLA: … Next.',
        '[s017] Zach: Lead time is 28 days.',
        '[s018] Matt: Can we split?',
      ].join('\n')
    )
  })

  it('says so when there is nothing yet', () => {
    const text = cardsMessage({ ...INPUT, outline: [], recent_structured: '' })
    expect(text).toContain('Under H1 (CLA quote): none yet')
    expect(text).toContain('Off the agenda (OFF): none yet')
    expect(text).toContain('(nothing yet)')
  })
})

describe('cardsToOps', () => {
  it('adds a topic once, ahead of its first card, and files later cards under it', () => {
    const { ops } = cardsToOps(
      {
        segments: [
          entry('s017', 'H2', 'Lead times', [card('Polos now 28 days')]),
          entry('s018', 'H2', 'lead times ', [
            card('Option: split the order'),
            card('Get numbers', {
              kind: 'action',
              owner: 'Zach',
              due_text: 'Friday',
            }),
          ]),
        ],
      },
      INPUT
    )
    expect(ops).toEqual([
      {
        op: 'add_topic',
        tmp_key: 'n1',
        title: 'Lead times',
        parent_id: 'H2',
        off_agenda: false,
        segment_ids: ['s017', 's018'],
      },
      {
        op: 'add_card',
        topic_id: 'n1',
        kind: 'note',
        text: 'Polos now 28 days',
        owner: null,
        due_text: null,
        segment_ids: ['s017'],
      },
      {
        op: 'add_card',
        topic_id: 'n1',
        kind: 'note',
        text: 'Option: split the order',
        owner: null,
        due_text: null,
        segment_ids: ['s018'],
      },
      {
        op: 'add_card',
        topic_id: 'n1',
        kind: 'action',
        text: 'Get numbers',
        owner: 'Zach',
        due_text: 'Friday',
        segment_ids: ['s018'],
      },
    ])
  })

  it('takes cards only from segments the model called new', () => {
    const { ops } = cardsToOps(
      {
        segments: [
          // A recap that still came with cards: they are not used.
          {
            ...entry('s016', 'H1', 'Pricing', [card('Quote at 42')]),
            type: 'recap',
          },
          {
            ...entry('s017', 'H1', 'Pricing', [card('Agenda')]),
            type: 'agenda',
          },
          { ...entry('s018', 'H1', 'Pricing', [card('Okay')]), type: 'other' },
        ],
      },
      INPUT
    )
    expect(ops).toEqual([])
  })

  it('reuses a topic that is already on the map, by title or by a telling word', () => {
    const { ops } = cardsToOps(
      {
        segments: [
          entry('s016', 'H1', 'PRICING', [card('a')]),
          entry('s017', 'H1', 'Platform pricing', [card('b')]),
          entry('s018', OFF_AGENDA, 'Aircon repair', [card('c')]),
        ],
      },
      INPUT
    )
    expect(ops.map(op => [op.op, op.topic_id])).toEqual([
      ['add_card', 'T1'],
      ['add_card', 'T1'],
      ['add_card', 'T2'],
    ])
  })

  it('keeps the same title under two headers apart', () => {
    const { ops } = cardsToOps(
      {
        segments: [
          // "Pricing" exists under H1; under H2 it is a new topic.
          entry('s017', 'H2', 'Pricing', [card('a')]),
          entry('s018', OFF_AGENDA, 'Pricing', [card('b')]),
        ],
      },
      INPUT
    )
    expect(ops.filter(op => op.op === 'add_topic')).toMatchObject([
      { tmp_key: 'n1', parent_id: 'H2', off_agenda: false },
      { tmp_key: 'n2', parent_id: null, off_agenda: true },
    ])
  })

  it('treats a header it does not know as off the agenda, and names a blank topic', () => {
    const { ops } = cardsToOps(
      { segments: [entry('s017', 'H9', '  ', [card('a')])] },
      INPUT
    )
    expect(ops[0]).toMatchObject({
      op: 'add_topic',
      title: 'General',
      parent_id: null,
      off_agenda: true,
    })
  })

  it('gives no ops for a reply in another shape', () => {
    for (const reply of [
      null,
      'text',
      {},
      { segments: 'none' },
      { cards: [] },
    ]) {
      expect(cardsToOps(reply, INPUT)).toEqual({ ops: [] })
    }
  })
})
