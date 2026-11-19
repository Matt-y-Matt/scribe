// A due date as a date. What was said in the room ("Friday", "next week",
// "21 Nov") is kept as text and stays the truth; this reads that text
// against the day it was said, so an action can be sorted by date and shown
// as late. Text this cannot read ("after CLA signs", "soon") gives no date
// and is shown as it is.

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  weds: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
}

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
}

const COUNTS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  'a couple of': 2,
  'couple of': 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  ten: 10,
}

const WEEKDAY = Object.keys(WEEKDAYS).join('|')
const MONTH = Object.keys(MONTHS).join('|')
const COUNT = `\\d{1,3}|${Object.keys(COUNTS).join('|')}`
const ORDINAL = '(\\d{1,2})(?:st|nd|rd|th)?'

/** A day far enough back that a date with no year means next year's. */
const LOOK_BACK_DAYS = 30
/** The last working day: what "this week" and "next week" are read as. */
const FRIDAY = 5

export interface DueReading {
  /** The day meant, at midnight local time. */
  date: Date
  /** The text names the calendar date itself ("21 Nov", "2026-11-21"). */
  exact: boolean
}

const dayOf = (ms: number): Date => {
  const at = new Date(ms)
  return new Date(at.getFullYear(), at.getMonth(), at.getDate())
}
const plusDays = (day: Date, days: number): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate() + days)
const lastOfMonth = (day: Date, monthsOn: number): Date =>
  new Date(day.getFullYear(), day.getMonth() + monthsOn + 1, 0)
/** Whole days from `from` to `to`; daylight-saving hours do not count. */
const daysBetween = (from: Date, to: Date): number =>
  Math.round((to.getTime() - from.getTime()) / 86_400_000)

/** A real calendar day, or null for the 31st of a short month. */
function calendarDay(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month, day)
  return date.getFullYear() === year &&
    date.getMonth() === month &&
    date.getDate() === day
    ? date
    : null
}

/** A day and month with no year: this year's, unless that is long gone. */
function nearest(said: Date, month: number, day: number): Date | null {
  const thisYear = calendarDay(said.getFullYear(), month, day)
  if (thisYear && daysBetween(thisYear, said) <= LOOK_BACK_DAYS) return thisYear
  return calendarDay(said.getFullYear() + 1, month, day) ?? thisYear
}

/** The weekday on or after `from`. */
const onOrAfter = (from: Date, weekday: number): Date =>
  plusDays(from, (weekday - from.getDay() + 7) % 7)
/** Monday of the week `day` is in. */
const mondayOf = (day: Date): Date => plusDays(day, -((day.getDay() + 6) % 7))

/** The text as said, without the words that carry no date. */
function plain(text: string): string {
  let said = text
    .toLowerCase()
    // A dot inside "21.11" is part of the date; one after a word is not.
    .replace(/[,;!]+|\.(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // "by 5pm Friday", "Friday morning", "Friday at the latest".
  said = said
    .replace(/\b(at )?\d{1,2}([:.]\d{2})? ?(am|pm)\b/g, ' ')
    .replace(/\bat \d{1,2}([:.]\d{2})?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(
      /\b(first thing|morning|afternoon|evening|night|noon|midday|lunchtime|at the latest|latest|sharp)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()
  // "by", "on", "due", "before" and "the", in any order, at the front.
  for (;;) {
    const shorter = said.replace(
      /^(by|on|due|before|until|till|the|sometime|some time) /,
      ''
    )
    if (shorter === said) return said
    said = shorter
  }
}

/**
 * Reads a due text against the day it was said. `saidOnMs` is any moment of
 * that day. Null when the text names no day this can work out.
 */
export function readDue(text: string, saidOnMs: number): DueReading | null {
  const said = dayOf(saidOnMs)
  const words = plain(text)
  if (words === '') return null
  const exact = (date: Date | null) => (date ? { date, exact: true } : null)
  const read = (date: Date) => ({ date, exact: false })
  /** A day and month, with the year when one was said. */
  const dated = (day: number, month: number, year: string | undefined) =>
    exact(
      year === undefined
        ? nearest(said, month, day)
        : calendarDay(Number(year) + (year.length === 2 ? 2000 : 0), month, day)
    )

  // 2026-11-21
  const iso = words.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) {
    return exact(
      calendarDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    )
  }
  // 21/11, 21/11/26, 21.11.2026: day first, unless only month-first fits.
  const numeric = words.match(
    /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/
  )
  if (numeric) {
    const [first, second] = [Number(numeric[1]), Number(numeric[2])]
    const [day, month] =
      second > 12 && first <= 12 ? [second, first] : [first, second]
    return dated(day, month - 1, numeric[3])
  }
  // 21 Nov, 21st of November 2026
  const dayMonth = words.match(
    new RegExp(`^${ORDINAL}(?: of)? (${MONTH})(?: ([0-9]{4}))?$`)
  )
  if (dayMonth) {
    return dated(
      Number(dayMonth[1]),
      MONTHS[dayMonth[2] ?? ''] ?? 0,
      dayMonth[3]
    )
  }
  // Nov 21, November 21st 2026
  const monthDay = words.match(
    new RegExp(`^(${MONTH}) ${ORDINAL}(?: ([0-9]{4}))?$`)
  )
  if (monthDay) {
    return dated(
      Number(monthDay[2]),
      MONTHS[monthDay[1] ?? ''] ?? 0,
      monthDay[3]
    )
  }
  // "the 21st": the next one, this month or the one after.
  const ordinal = words.match(/^(\d{1,2})(?:st|nd|rd|th)$/)
  if (ordinal) {
    const day = Number(ordinal[1])
    const here = calendarDay(said.getFullYear(), said.getMonth(), day)
    if (here && here >= said) return exact(here)
    const next = new Date(said.getFullYear(), said.getMonth() + 1, day)
    return exact(next.getDate() === day ? next : null)
  }

  if (
    /^(today|tonight|now|eod|cob|end of (the )?day|end of today)$/.test(words)
  ) {
    return read(said)
  }
  if (/^(tomorrow|tmr|tmrw|tomo|end of tomorrow)$/.test(words)) {
    return read(plusDays(said, 1))
  }
  if (/^day after tomorrow$/.test(words)) return read(plusDays(said, 2))

  // "Friday" is the next Friday after the day it was said, never that day.
  // "next Friday" is the Friday of the week after.
  const weekdayNamed = words.match(
    new RegExp(`^(?:(this|next|coming|end of) )?(${WEEKDAY})$`)
  )
  if (weekdayNamed) {
    const weekday = WEEKDAYS[weekdayNamed[2] ?? ''] ?? 0
    return read(
      weekdayNamed[1] === 'next'
        ? onOrAfter(plusDays(mondayOf(said), 7), weekday)
        : onOrAfter(plusDays(said, 1), weekday)
    )
  }

  // A week is owed by its Friday, or by today if Friday has gone.
  if (
    /^(this week|eow|end of (the |this )?week|within the week)$/.test(words)
  ) {
    const friday = plusDays(mondayOf(said), FRIDAY - 1)
    return read(friday < said ? said : friday)
  }
  if (/^(early|start of|beginning of) next week$/.test(words)) {
    return read(plusDays(mondayOf(said), 7))
  }
  if (/^(end of )?next week$/.test(words)) {
    return read(plusDays(mondayOf(said), 7 + FRIDAY - 1))
  }
  if (/^(this month|eom|month end|end of (the |this )?month)$/.test(words)) {
    return read(lastOfMonth(said, 0))
  }
  if (/^(end of )?next month$/.test(words)) return read(lastOfMonth(said, 1))

  // "in 3 days", "two weeks", "within a month"
  const span = words.match(
    new RegExp(`^(?:in |within )?(${COUNT}) (day|week|month)s?(?: time)?$`)
  )
  if (span) {
    const count = COUNTS[span[1] ?? ''] ?? Number(span[1])
    if (span[2] === 'day') return read(plusDays(said, count))
    if (span[2] === 'week') return read(plusDays(said, count * 7))
    // The same day of that month, or its last day when it is shorter.
    const then = new Date(
      said.getFullYear(),
      said.getMonth() + count,
      said.getDate()
    )
    return read(
      then.getDate() === said.getDate() ? then : lastOfMonth(said, count)
    )
  }
  return null
}

const short = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})
const withYear = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

export interface DueNote {
  /** "due Friday (Fri 21 Nov)"; the text alone when it reads as no date. */
  label: string
  /** The day it is due, when the text could be read. */
  date: Date | null
  /** Whole days past that day; 0 when not late or when there is no date. */
  lateDays: number
}

/**
 * What to show for a due text: the text as said, the date it means beside
 * it, and how late it is at `nowMs`. Null when there is no due text.
 */
export function dueNote(
  dueText: string | null,
  saidOnMs: number,
  nowMs: number
): DueNote | null {
  const text = dueText?.trim()
  if (!text) return null
  const reading = readDue(text, saidOnMs)
  if (!reading) return { label: `due ${text}`, date: null, lateDays: 0 }

  const today = dayOf(nowMs)
  const away = daysBetween(today, reading.date)
  const shown =
    away === 0
      ? 'today'
      : (reading.date.getFullYear() === today.getFullYear()
          ? short
          : withYear
        ).format(reading.date)
  return {
    // A text that is already the date, or the word, is not said twice.
    label:
      (reading.exact && away !== 0) || text.toLowerCase() === shown
        ? `due ${text}`
        : `due ${text} (${shown})`,
    date: reading.date,
    lateDays: Math.max(0, -away),
  }
}

export const lateText = (days: number): string =>
  days === 1 ? '1 day late' : `${days} days late`
