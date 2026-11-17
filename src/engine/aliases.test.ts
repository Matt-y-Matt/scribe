// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { aliasInput } from './aliases'
import type { StructurerInput } from './providers/types'

const INPUT: StructurerInput = {
  agenda: [
    { id: 't_01M7MDVNW78TDA0KPG5FZDEAGH', title: 'CLA quote' },
    { id: 't_01M7MDVNWB9Z74WS8WQKG8C31S', title: 'Supplier delays' },
  ],
  outline: [
    {
      id: 't_01M7MDVXABQJT9G6E451MMAFH4',
      title: 'Pricing',
      parent_id: 't_01M7MDVNW78TDA0KPG5FZDEAGH',
      header: 'CLA quote',
      off_agenda: false,
      last_cards: [
        { id: 'c_01M7MDVXAC7GT9KBXDRM0DEE9H', kind: 'note', text: 'One' },
        { id: 'c_01M7MDVXAC7GT9KBXDRM0DEE9J', kind: 'note', text: 'Two' },
      ],
    },
    {
      id: 't_01M7MDVXAD0000000000000000',
      title: 'Aircon',
      parent_id: 't_unplanned',
      header: 'Unplanned',
      off_agenda: true,
      last_cards: [
        { id: 'c_01M7MDVXAE0000000000000000', kind: 'note', text: 'Three' },
      ],
    },
  ],
  recent_structured: '[s001] Matt: Hello',
  new_segments: [{ id: 's002', t0: 8100, speaker: 'Zach', text: 'Hi' }],
  participants: ['Matt', 'Zach'],
  now_ms: 11_000,
}

describe('aliasInput', () => {
  it('shows the model short names instead of ULIDs', () => {
    const { input } = aliasInput(INPUT)
    expect(input.agenda).toEqual([
      { id: 'H1', title: 'CLA quote' },
      { id: 'H2', title: 'Supplier delays' },
    ])
    expect(input.outline).toMatchObject([
      {
        id: 'T1',
        parent_id: 'H1',
        header: 'CLA quote',
        last_cards: [{ id: 'C1' }, { id: 'C2' }],
      },
      // A header the model is not shown (Unplanned) keeps its id.
      { id: 'T2', parent_id: 't_unplanned', last_cards: [{ id: 'C3' }] },
    ])
    // Segment ids and everything else are untouched.
    expect(input.new_segments).toEqual(INPUT.new_segments)
    expect(input.recent_structured).toBe(INPUT.recent_structured)
    expect(JSON.stringify(input)).not.toContain('01M7MDV')
  })

  it('turns a reply written with aliases back into real ids', () => {
    const { restore } = aliasInput(INPUT)
    const reply = {
      ops: [
        { op: 'add_topic', tmp_key: 'k1', title: 'Artwork', parent_id: 'H1' },
        { op: 'add_card', topic_id: 'k1', kind: 'note', text: 'a' },
        { op: 'add_card', topic_id: 't1', kind: 'note', text: 'b' },
        { op: 'add_card', tmp_topic: ' T2 ', kind: 'note', text: 'c' },
        { op: 'suggest_move', card_id: 'C3', to_topic_id: 'T1' },
        { op: 'suggest_merge', topic_id: 'T2', into_topic_id: 'T1' },
        { op: 'suggest_pin', tmp_key_or_topic_id: 'T2', title: 'Aircon' },
      ],
    }
    expect(restore(reply)).toEqual({
      ops: [
        {
          op: 'add_topic',
          tmp_key: 'k1',
          title: 'Artwork',
          parent_id: 't_01M7MDVNW78TDA0KPG5FZDEAGH',
        },
        { op: 'add_card', topic_id: 'k1', kind: 'note', text: 'a' },
        {
          op: 'add_card',
          topic_id: 't_01M7MDVXABQJT9G6E451MMAFH4',
          kind: 'note',
          text: 'b',
        },
        {
          op: 'add_card',
          tmp_topic: 't_01M7MDVXAD0000000000000000',
          kind: 'note',
          text: 'c',
        },
        {
          op: 'suggest_move',
          card_id: 'c_01M7MDVXAE0000000000000000',
          to_topic_id: 't_01M7MDVXABQJT9G6E451MMAFH4',
        },
        {
          op: 'suggest_merge',
          topic_id: 't_01M7MDVXAD0000000000000000',
          into_topic_id: 't_01M7MDVXABQJT9G6E451MMAFH4',
        },
        {
          op: 'suggest_pin',
          tmp_key_or_topic_id: 't_01M7MDVXAD0000000000000000',
          title: 'Aircon',
        },
      ],
    })
  })

  it('leaves alone what is not an alias, so the rules can drop it', () => {
    const { restore } = aliasInput(INPUT)
    // An alias the model made up, a real id, and a title.
    const ops = [
      { op: 'add_card', topic_id: 'T9' },
      { op: 'add_card', topic_id: 't_01M7MDVXABQJT9G6E451MMAFH4' },
      { op: 'add_card', topic_id: 'Pricing' },
      'not an op',
      null,
    ]
    expect(restore(ops)).toEqual(ops)
    expect(restore('nonsense')).toBe('nonsense')
    expect(restore({ ops: 'none' })).toEqual({ ops: 'none' })
  })

  it('keeps a tmp_key the model declared, even one that looks like an alias', () => {
    const { restore } = aliasInput(INPUT)
    const ops = [
      { op: 'add_topic', tmp_key: 'T1', title: 'New', parent_id: 'H2' },
      { op: 'add_card', topic_id: 'T1', kind: 'note', text: 'goes to New' },
    ]
    expect(restore(ops)).toEqual([
      { ...ops[0], parent_id: 't_01M7MDVNWB9Z74WS8WQKG8C31S' },
      ops[1],
    ])
  })
})
