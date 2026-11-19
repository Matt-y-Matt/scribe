import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { OpenAction } from '@/ipc'
import { byOwner } from './open-actions'
import { OpenActions } from './OpenActions'

/** A moment in the middle of a local day. Months count from 1 here. */
const at = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day, 11, 30).getTime()
/** Tuesday 17 November 2026. */
const MEETING = at(2026, 11, 17)

const owed = (
  id: string,
  owner: string | null,
  due: string | null,
  saidOn = MEETING
): OpenAction => ({
  card: {
    id,
    meeting_id: 'm_1',
    topic_id: 't_1',
    kind: 'action',
    text: `Action ${id}`,
    owner,
    due_text: due,
    segment_ids: [],
    status: 'accepted',
    source: 'engine',
    created_t_ms: 60_000,
    confirmed: true,
    done_at_ms: null,
    order_key: 0,
  },
  meeting_title: 'Weekly',
  meeting_created_at_ms: saidOn,
  topic_title: 'Pricing',
})

const OPEN = [
  owed('next-week', 'Zach', 'next week'),
  owed('no-date', 'Zach', null),
  owed('unreadable', 'Zach', 'after CLA signs'),
  owed('friday', 'Zach', 'Friday'),
  owed('tomorrow', 'Zach', 'tomorrow'),
  owed('kabs', 'Kabs', 'Friday'),
]

describe('byOwner', () => {
  it('puts each person’s actions in the order they fall due, undated last', () => {
    const [zach, kabs] = byOwner(OPEN, at(2026, 11, 19))
    expect(zach?.rows.map(row => row.card.id)).toEqual([
      'tomorrow',
      'friday',
      'next-week',
      'no-date',
      'unreadable',
    ])
    expect(kabs?.owner).toBe('Kabs')
  })
})

describe('OpenActions', () => {
  const show = (nowMs: number, done: string[] = []) =>
    render(
      <OpenActions
        open={OPEN}
        done={done}
        onDone={() => undefined}
        nowMs={nowMs}
      />
    )

  it('shows the date a due text meant, and what is past it as late', () => {
    // Thursday: "tomorrow" was yesterday, Friday is still to come.
    show(at(2026, 11, 19))
    const zach = screen.getByRole('region', { name: 'Zach' })
    expect(zach).toHaveTextContent('5 open')
    expect(zach).toHaveTextContent('1 late')

    const rows = within(zach).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent(
      /due tomorrow \(.+\) · 1 day late · Weekly/
    )
    expect(rows[1]).toHaveTextContent(/due Friday \(.+\) · Weekly/)
    expect(rows[1]).not.toHaveTextContent('late')
    // No date, and a date that cannot be read: said as they are, never late.
    expect(rows[3]).not.toHaveTextContent('due')
    expect(rows[4]).toHaveTextContent('due after CLA signs · Weekly')
    expect(rows[4]).not.toHaveTextContent('late')

    const kabs = screen.getByRole('region', { name: 'Kabs' })
    expect(kabs).not.toHaveTextContent('late')
  })

  it('says today on the day, and counts on from there', () => {
    const { unmount } = show(at(2026, 11, 20))
    expect(
      within(screen.getByRole('region', { name: 'Kabs' })).getByRole('listitem')
    ).toHaveTextContent('due Friday (today) · Weekly')
    unmount()

    show(at(2026, 11, 30))
    const zach = screen.getByRole('region', { name: 'Zach' })
    expect(zach).toHaveTextContent('3 late')
    expect(within(zach).getAllByRole('listitem')[0]).toHaveTextContent(
      '12 days late'
    )
  })

  it('does not call a ticked action late', () => {
    show(at(2026, 11, 19), ['tomorrow'])
    const zach = screen.getByRole('region', { name: 'Zach' })
    expect(zach).toHaveTextContent('4 open')
    expect(zach).not.toHaveTextContent('late')
  })
})
