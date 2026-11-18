import {
  parseFixtureJsonl,
  parseFixtureMeta,
  toSegmentFinal,
} from '@/engine/replay/fixture'
import type { SegmentFinal } from '@/ipc'
import metaText from '../../../fixtures/meeting-custore-weekly.meta.json?raw'
import transcript from '../../../fixtures/meeting-custore-weekly.jsonl?raw'
import {
  createSessionStore,
  emptySession,
  idleActions,
  type SessionActions,
  type SessionState,
  type SessionStore,
} from './session'

// The live screen's session for the `?screen=` states and the tests: the
// golden meeting's transcript, a waveform drawn from where its lines fall,
// and actions that change the page and nothing else.

export type FixtureMode =
  'recording' | 'paused' | 'no-mic' | 'model-missing' | 'review'

export interface FixtureSessionOptions {
  /** Stop after this segment. Default: the whole meeting. */
  until?: string
  mode?: FixtureMode
}

/** The fixture's segments, as the core would have announced them. */
export function fixtureSegments(until?: string): SegmentFinal[] {
  const segments: SegmentFinal[] = []
  for (const row of parseFixtureJsonl(transcript)) {
    segments.push({
      ...toSegmentFinal(row, 'm_fixture'),
      // One laptop and no diarization: every line is the room.
      speaker_label: 'Room',
    })
    if (row.id === until) break
  }
  return segments
}

/**
 * A waveform that looks like the meeting: loud where someone speaks, quiet
 * in the gaps. The same every time, so screenshots do not change.
 */
export function fixturePeaks(
  segments: readonly SegmentFinal[],
  durationMs: number
): number[] {
  const count = Math.ceil(durationMs / 50)
  const peaks = new Array<number>(count).fill(3)
  let seed = 7
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  for (const segment of segments) {
    const from = Math.floor(segment.t0_ms / 50)
    const to = Math.min(count, Math.ceil(segment.t1_ms / 50))
    for (let index = from; index < to; index++) {
      // Syllables: a slow swell with noise on top.
      const swell = 0.55 + 0.35 * Math.sin(index / 2.3)
      peaks[index] = Math.round(40 + 150 * swell * (0.5 + 0.5 * next()))
    }
  }
  return peaks
}

export function fixtureSessionState(
  options: FixtureSessionOptions = {}
): SessionState {
  const mode = options.mode ?? 'recording'
  const meta = parseFixtureMeta(metaText)
  const base = emptySession('m_fixture', meta.title)
  if (mode === 'no-mic') return { ...base, noMic: true }

  const heard = fixtureSegments(options.until)
  const elapsedMs = (heard[heard.length - 1]?.t1_ms ?? 0) + 1_200
  const peaks = fixturePeaks(heard, elapsedMs)
  return {
    ...base,
    rec:
      mode === 'paused'
        ? 'paused'
        : mode === 'review'
          ? 'stopped'
          : 'recording',
    review: mode === 'review',
    elapsedMs,
    modelMissing: mode === 'model-missing',
    // With no model the meeting is recorded and nothing is transcribed.
    segments: mode === 'model-missing' ? [] : heard,
    levels: {
      laptop: mode === 'recording' || mode === 'model-missing' ? 0.04 : 0,
      system: 0,
    },
    peaks,
    highlights:
      elapsedMs > 80_000 && mode !== 'model-missing'
        ? [
            {
              id: 'h_fixture',
              meeting_id: 'm_fixture',
              t0_ms: 72_100,
              t1_ms: 79_000,
              label: 'The price',
            },
          ]
        : [],
  }
}

/** Actions that act on the page only: there is no core behind a fixture. */
export function fixtureActions(session: SessionStore): SessionActions {
  let highlights = 0
  return {
    ...idleActions,
    pause: () => session.setState({ rec: 'paused' }),
    resume: () => session.setState({ rec: 'recording' }),
    stop: () => session.setState({ rec: 'stopped', review: true }),
    search: async query => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean)
      return session
        .getState()
        .segments.filter(segment =>
          words.every(word => segment.text.toLowerCase().includes(word))
        )
    },
    seekPlay: tMs => session.setState({ playback: { playing: true, tMs } }),
    playSpan: t0Ms =>
      session.setState({ playback: { playing: true, tMs: t0Ms } }),
    stopPlayback: () =>
      session.setState(state => ({
        playback: { ...state.playback, playing: false },
      })),
    addHighlight: (t0Ms, t1Ms, label) =>
      session.setState(state => ({
        highlights: [
          ...state.highlights,
          {
            id: `h_added_${++highlights}`,
            meeting_id: state.meetingId,
            t0_ms: t0Ms,
            t1_ms: t1Ms,
            label,
          },
        ],
      })),
    removeHighlight: highlightId =>
      session.setState(state => ({
        highlights: state.highlights.filter(row => row.id !== highlightId),
      })),
  }
}

export function fixtureSession(options: FixtureSessionOptions = {}): {
  session: SessionStore
  actions: SessionActions
} {
  const session = createSessionStore(fixtureSessionState(options))
  return { session, actions: fixtureActions(session) }
}
