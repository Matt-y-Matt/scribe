// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseFixtureJsonl, parseFixtureMeta, toSegmentFinal } from './fixture'

const read = (name: string) =>
  readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8')

describe('parseFixtureJsonl', () => {
  it('reads one segment per line and skips blank lines', () => {
    const segments = parseFixtureJsonl(
      '{"id":"a","t0":0,"t1":1.5,"speaker":"Matt","text":"Hello."}\n\n' +
        '{"id":"b","t0":1.7,"t1":2,"speaker":"Zach","text":"Hi."}\n'
    )
    expect(segments.map(s => s.id)).toEqual(['a', 'b'])
    expect(segments[0]).toEqual({
      id: 'a',
      t0: 0,
      t1: 1.5,
      speaker: 'Matt',
      text: 'Hello.',
    })
  })

  it('names the line when a row is not valid JSON', () => {
    expect(() => parseFixtureJsonl('{"id":"a"\n')).toThrow(/line 1/)
  })

  it('names the line when a field is missing', () => {
    expect(() =>
      parseFixtureJsonl('{"id":"a","t0":0,"t1":1,"speaker":"Matt"}')
    ).toThrow(/line 1/)
  })

  it('rejects a segment that ends before it starts', () => {
    expect(() =>
      parseFixtureJsonl('{"id":"a","t0":2,"t1":1,"speaker":"M","text":"x"}')
    ).toThrow(/line 1/)
  })

  it('rejects duplicate ids', () => {
    const row = '{"id":"a","t0":0,"t1":1,"speaker":"M","text":"x"}'
    expect(() => parseFixtureJsonl(`${row}\n${row}`)).toThrow(/duplicate/i)
  })

  it('rejects segments that go back in time', () => {
    expect(() =>
      parseFixtureJsonl(
        '{"id":"a","t0":5,"t1":6,"speaker":"M","text":"x"}\n' +
          '{"id":"b","t0":1,"t1":2,"speaker":"M","text":"y"}'
      )
    ).toThrow(/line 2/)
  })
})

describe('toSegmentFinal', () => {
  it('converts seconds to whole milliseconds and keeps the fixture id', () => {
    expect(
      toSegmentFinal(
        { id: 's004', t0: 15.0, t1: 31.2, speaker: 'Kabs', text: 'So Ross.' },
        'm_replay'
      )
    ).toEqual({
      id: 's004',
      meeting_id: 'm_replay',
      t0_ms: 15000,
      t1_ms: 31200,
      speaker_label: 'Kabs',
      source: 'laptop',
      text: 'So Ross.',
      confidence: 1,
    })
  })

  it('does not drift on values binary floats cannot hold exactly', () => {
    const event = toSegmentFinal(
      { id: 'x', t0: 66.8, t1: 72.2, speaker: 'Zach', text: 'x' },
      'm'
    )
    expect([event.t0_ms, event.t1_ms]).toEqual([66800, 72200])
  })
})

describe('the Custore weekly fixture', () => {
  const segments = parseFixtureJsonl(read('meeting-custore-weekly.jsonl'))
  const meta = parseFixtureMeta(read('meeting-custore-weekly.meta.json'))
  const expected = JSON.parse(read('meeting-custore-weekly.expected.json')) as {
    agenda: string[]
    cards: { segments: string[] }[]
  }

  it('has 46 segments, s001 to s046, in time order', () => {
    expect(segments).toHaveLength(46)
    expect(segments[0]?.id).toBe('s001')
    expect(segments.at(-1)?.id).toBe('s046')
  })

  it('has a meta file whose agenda matches the golden expectations', () => {
    expect(meta.agenda).toEqual(expected.agenda)
    expect(meta.agenda.length).toBeLessThanOrEqual(8)
  })

  it('lists every speaker as a participant', () => {
    const speakers = new Set(segments.map(s => s.speaker))
    expect([...speakers].sort()).toEqual([...meta.participants].sort())
  })

  it('is referenced only by segment ids that exist', () => {
    const ids = new Set(segments.map(s => s.id))
    const unknown = expected.cards
      .flatMap(card => card.segments)
      .filter(id => !ids.has(id))
    expect(unknown).toEqual([])
  })
})
