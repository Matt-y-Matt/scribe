// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isFiller, toTurns, wordOverlap, type Line } from './turns'

let next = 0
const line = (
  speaker: string,
  t0: number,
  t1: number,
  text: string,
  source?: string
): Line => ({ id: `l${++next}`, t0, t1, speaker, source, text })

describe('isFiller', () => {
  it('knows a line that says nothing', () => {
    for (const text of [
      'Yeah.',
      'Um',
      'Okay, okay.',
      'Oh yeah, yeah.',
      'Mm.',
    ]) {
      expect(isFiller(text)).toBe(true)
    }
    for (const text of ['Yeah, by Friday.', 'No, the fifth.', 'Sixty.']) {
      expect(isFiller(text)).toBe(false)
    }
  })
})

describe('wordOverlap', () => {
  it('is the share of distinct words two texts have in common', () => {
    expect(wordOverlap('Send all photos', 'send ALL photos.')).toBe(1)
    expect(wordOverlap('Send all photos', 'Launch by the fifth')).toBe(0)
    expect(wordOverlap('', '')).toBe(0)
  })
})

describe('toTurns', () => {
  it('joins what one person says across short pauses', () => {
    const turns = toTurns([
      line('Matt', 0, 1_000, 'So the launch'),
      line('Matt', 1_800, 3_000, 'has to be'),
      line('Matt', 4_500, 6_000, 'by the fifth of December.'),
      // A long pause: a new turn.
      line('Matt', 9_000, 10_000, 'Otherwise Christmas is gone.'),
    ])
    expect(turns.map(turn => [turn.text, turn.covers.length])).toEqual([
      ['So the launch has to be by the fifth of December.', 3],
      ['Otherwise Christmas is gone.', 1],
    ])
    expect(turns[0]).toMatchObject({
      id: turns[0]?.covers[0],
      t0: 0,
      t1: 6_000,
    })
  })

  it('leaves filler out, and does not let it cut a sentence in two', () => {
    const turns = toTurns([
      line('Matt', 0, 1_000, 'We print it at'),
      line('Zach', 1_100, 1_500, 'Yeah.'),
      line('Matt', 1_600, 3_000, 'the shop on Marsh Road.'),
      line('Zach', 3_200, 3_600, 'Okay.'),
    ])
    expect(turns.map(turn => `${turn.speaker}: ${turn.text}`)).toEqual([
      'Matt: We print it at the shop on Marsh Road.',
    ])
  })

  it('keeps two people apart when they talk over each other', () => {
    const turns = toTurns([
      line('Matt', 0, 2_000, 'The sample takes two days'),
      line('Zach', 1_000, 3_000, 'But shipping is another three.'),
      line('Matt', 2_500, 4_000, 'and production three more.'),
    ])
    expect(turns.map(turn => `${turn.speaker}: ${turn.text}`)).toEqual([
      'Matt: The sample takes two days and production three more.',
      'Zach: But shipping is another three.',
    ])
  })

  it('stops a turn that would grow past what a note can cite', () => {
    const long = Array.from({ length: 35 }, () => 'word').join(' ')
    const turns = toTurns([
      line('Matt', 0, 9_000, long),
      line('Matt', 9_300, 18_000, long),
    ])
    expect(turns).toHaveLength(2)
  })

  it('drops a microphone line that repeats what the PC was playing', () => {
    const turns = toTurns([
      line(
        'Zach',
        10_000,
        13_000,
        'We decided to remove the recommendation.',
        'system'
      ),
      line(
        'Matt',
        10_600,
        13_400,
        'we decided to remove the recommendation',
        'laptop'
      ),
      // His own words at the same moment: kept.
      line('Matt', 13_500, 15_000, 'But PDF has the same problem.', 'laptop'),
    ])
    expect(turns.map(turn => `${turn.speaker}: ${turn.text}`)).toEqual([
      'Zach: We decided to remove the recommendation.',
      'Matt: But PDF has the same problem.',
    ])
  })

  it('does not take two people saying the same thing in a room for an echo', () => {
    const turns = toTurns([
      line('Ant', 0, 2_000, 'Friday works for me.'),
      line('Kabs', 2_100, 4_000, 'Friday works for me too.'),
    ])
    expect(turns).toHaveLength(2)
  })

  it('joins less readily behind a microphone several people share', () => {
    const lines = (speaker: string) => [
      line(speaker, 0, 2_000, 'Can we split the order?'),
      // 1.5 s later: one person thinking, or the next person answering.
      line(speaker, 3_500, 5_000, 'Their minimum is three hundred.'),
      line(speaker, 5_800, 7_000, 'Per colour.'),
    ]
    expect(toTurns(lines('Matt')).map(turn => turn.covers.length)).toEqual([3])
    expect(toTurns(lines('Room')).map(turn => turn.covers.length)).toEqual([
      1, 2,
    ])
  })

  it('puts lines in meeting order whatever order they arrive in', () => {
    const turns = toTurns([
      line('Zach', 5_000, 6_000, 'Second thing said.'),
      line('Matt', 0, 1_000, 'First thing said.'),
    ])
    expect(turns.map(turn => turn.speaker)).toEqual(['Matt', 'Zach'])
  })
})
