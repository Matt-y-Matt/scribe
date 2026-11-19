import { describe, expect, it } from 'vitest'
import { dueNote, lateText, readDue } from './due'

/** A moment in the middle of a local day. Months count from 1 here. */
const at = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day, 11, 30).getTime()
/** Tuesday 17 November 2026: the day of the fixture meeting. */
const TUESDAY = at(2026, 11, 17)

const ymd = (date: Date | undefined) =>
  date &&
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
const day = (text: string, saidOn = TUESDAY) => ymd(readDue(text, saidOn)?.date)

describe('readDue', () => {
  it('reads the words people use for the next few days', () => {
    expect(day('today')).toBe('2026-11-17')
    expect(day('EOD')).toBe('2026-11-17')
    expect(day('tonight')).toBe('2026-11-17')
    expect(day('tomorrow')).toBe('2026-11-18')
    expect(day('Tomorrow morning')).toBe('2026-11-18')
    expect(day('tmr')).toBe('2026-11-18')
    expect(day('the day after tomorrow')).toBe('2026-11-19')
  })

  it('reads a weekday as the next one after the day it was said', () => {
    expect(day('Wednesday')).toBe('2026-11-18')
    expect(day('Friday')).toBe('2026-11-20')
    expect(day('by Friday')).toBe('2026-11-20')
    expect(day('fri')).toBe('2026-11-20')
    expect(day('this Friday')).toBe('2026-11-20')
    expect(day('Friday 5pm')).toBe('2026-11-20')
    expect(day('by 5 pm on Friday.')).toBe('2026-11-20')
    expect(day('Friday at the latest')).toBe('2026-11-20')
    expect(day('Monday')).toBe('2026-11-23')
    // Said on a Tuesday, "Tuesday" is a week away, never the same day.
    expect(day('Tuesday')).toBe('2026-11-24')
  })

  it('reads "next Friday" as the Friday of the week after', () => {
    expect(day('next Friday')).toBe('2026-11-27')
    expect(day('next Monday')).toBe('2026-11-23')
    // Said on a Friday, both mean the one a week on.
    expect(day('Friday', at(2026, 11, 20))).toBe('2026-11-27')
    expect(day('next Friday', at(2026, 11, 20))).toBe('2026-11-27')
  })

  it('reads a week or a month as its last working day or its last day', () => {
    expect(day('this week')).toBe('2026-11-20')
    expect(day('end of the week')).toBe('2026-11-20')
    expect(day('EOW')).toBe('2026-11-20')
    // On a Saturday the week's Friday has gone: it is owed that day.
    expect(day('this week', at(2026, 11, 21))).toBe('2026-11-21')
    expect(day('next week')).toBe('2026-11-27')
    expect(day('sometime next week')).toBe('2026-11-27')
    expect(day('early next week')).toBe('2026-11-23')
    expect(day('end of the month')).toBe('2026-11-30')
    expect(day('this month')).toBe('2026-11-30')
    expect(day('next month')).toBe('2026-12-31')
  })

  it('reads a count of days, weeks or months', () => {
    expect(day('in 3 days')).toBe('2026-11-20')
    expect(day('two weeks')).toBe('2026-12-01')
    expect(day('in a week')).toBe('2026-11-24')
    expect(day('within a couple of weeks')).toBe('2026-12-01')
    expect(day('in a month')).toBe('2026-12-17')
    expect(day('in 2 months')).toBe('2027-01-17')
    // A month on from the 31st of a month with 31 days: the last day.
    expect(day('in a month', at(2027, 1, 31))).toBe('2027-02-28')
  })

  it('reads a date that was said as a date, and says it is exact', () => {
    expect(day('21 Nov')).toBe('2026-11-21')
    expect(day('21st of November')).toBe('2026-11-21')
    expect(day('Nov 21')).toBe('2026-11-21')
    expect(day('November 21st, 2026')).toBe('2026-11-21')
    expect(day('Nov. 21')).toBe('2026-11-21')
    expect(day('2026-11-21')).toBe('2026-11-21')
    expect(day('21/11')).toBe('2026-11-21')
    expect(day('21.11.2026')).toBe('2026-11-21')
    expect(day('21/11/26')).toBe('2026-11-21')
    // Day first; month first only when nothing else fits.
    expect(day('3/12')).toBe('2026-12-03')
    expect(day('12/25')).toBe('2026-12-25')
    expect(day('the 21st')).toBe('2026-11-21')
    expect(day('the 5th')).toBe('2026-12-05')
    expect(readDue('21 Nov', TUESDAY)?.exact).toBe(true)
    expect(readDue('Friday', TUESDAY)?.exact).toBe(false)
  })

  it('takes a date with no year as the coming one, unless it has only just passed', () => {
    expect(day('5 Jan')).toBe('2027-01-05')
    expect(day('1 March')).toBe('2027-03-01')
    // Two days ago is late, not eleven months away.
    expect(day('15 Nov')).toBe('2026-11-15')
  })

  it('gives no date for what is not one', () => {
    for (const text of [
      '',
      '  ',
      'soon',
      'ASAP',
      'after CLA signs',
      'Q2',
      'when the samples arrive',
      '31 Feb',
      '2026-13-01',
      '40/40',
      'the 32nd',
    ]) {
      expect(readDue(text, TUESDAY), text).toBeNull()
    }
  })
})

describe('dueNote', () => {
  const sayOn = (date: Date) =>
    new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(date)

  it('shows the text as said with the date it means beside it', () => {
    const note = dueNote('Friday', TUESDAY, at(2026, 11, 18))
    expect(note?.label).toBe(`due Friday (${sayOn(new Date(2026, 10, 20))})`)
    expect(note?.lateDays).toBe(0)
    expect(ymd(note?.date ?? undefined)).toBe('2026-11-20')
  })

  it('says today on the day, and counts the days after it', () => {
    expect(dueNote('Friday', TUESDAY, at(2026, 11, 20))).toMatchObject({
      label: 'due Friday (today)',
      lateDays: 0,
    })
    expect(dueNote('Friday', TUESDAY, at(2026, 11, 21))?.lateDays).toBe(1)
    expect(dueNote('tomorrow', TUESDAY, at(2026, 11, 24))?.lateDays).toBe(6)
    expect(lateText(1)).toBe('1 day late')
    expect(lateText(6)).toBe('6 days late')
  })

  it('does not say a date twice', () => {
    expect(dueNote('21 Nov', TUESDAY, at(2026, 11, 18))?.label).toBe(
      'due 21 Nov'
    )
    expect(dueNote('today', TUESDAY, TUESDAY)?.label).toBe('due today')
    // On the day itself, "today" is worth saying even beside a date.
    expect(dueNote('21 Nov', TUESDAY, at(2026, 11, 21))?.label).toBe(
      'due 21 Nov (today)'
    )
  })

  it('adds the year when it is not this one', () => {
    const note = dueNote('in 2 months', TUESDAY, at(2026, 11, 18))
    expect(note?.label).toContain('2027')
  })

  it('leaves text it cannot read as it is, and never calls it late', () => {
    expect(dueNote('after CLA signs', TUESDAY, at(2027, 6, 1))).toEqual({
      label: 'due after CLA signs',
      date: null,
      lateDays: 0,
    })
    expect(dueNote(null, TUESDAY, TUESDAY)).toBeNull()
    expect(dueNote('  ', TUESDAY, TUESDAY)).toBeNull()
  })
})
