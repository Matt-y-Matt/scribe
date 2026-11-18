import type { MeetingInfo, NewMeeting } from '@/ipc'

// The meetings Home lists in its `?screen=` states and tests.

const DAY = 86_400_000
// A fixed "now", so the dates in screenshots do not change.
const NOW = Date.UTC(2026, 10, 19, 3, 0)

const meeting = (
  id: string,
  title: string,
  daysAgo: number,
  minutes: number,
  agenda: string[],
  finished = true
): MeetingInfo => ({
  id,
  title,
  created_at_ms: NOW - daysAgo * DAY,
  started_at_ms: NOW - daysAgo * DAY,
  ended_at_ms: finished ? NOW - daysAgo * DAY + minutes * 60_000 : null,
  duration_ms: minutes * 60_000,
  mode: 'group',
  agenda,
  participants: ['Matt', 'Zach', 'Ant', 'Kabs'],
  loopback: false,
})

export const FIXTURE_MEETINGS: MeetingInfo[] = [
  meeting('m_4', 'Bench 60', 0, 45, ['A', 'B', 'C'], false),
  meeting('m_3', 'Custore weekly team meeting', 2, 52, [
    'CLA quote',
    'Supplier delays',
    'Designer hire',
  ]),
  meeting('m_2', 'UDO order review', 6, 31, ['Lead times', 'Colours']),
  meeting('m_1', 'BNI one-to-one', 9, 24, []),
]

export const PREMEETING_DRAFT: Partial<NewMeeting> = {
  title: 'Custore weekly team meeting',
  agenda: ['CLA quote', 'Supplier delays', 'Designer hire'],
  participants: ['Matt', 'Zach', 'Ant', 'Kabs'],
}
