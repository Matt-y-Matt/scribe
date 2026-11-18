// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AudioPeaks,
  CaptureStatus,
  MeetingInfo,
  PlaybackState,
  RecordingState,
  SegmentFinal,
} from '@/ipc'
import { BackendError, type Backend } from '@/lib/backend'
import { fixtureBackend, FIXTURE_MODELS } from '@/lib/fixture-backend'
import { DEFAULT_PREFS, usePrefs } from '@/lib/prefs'
import { openMeeting } from './meeting-controller'

afterEach(() => usePrefs.setState(DEFAULT_PREFS))

const meeting = (patch: Partial<MeetingInfo> = {}): MeetingInfo => ({
  id: 'm_1',
  title: 'Bench 60',
  created_at_ms: 1,
  started_at_ms: null,
  ended_at_ms: null,
  duration_ms: 0,
  mode: 'group',
  agenda: ['A', 'B', 'C'],
  participants: ['Matt', 'Kabs'],
  loopback: false,
  ...patch,
})

const segment = (id: string, t0: number, text = 'said'): SegmentFinal => ({
  id,
  meeting_id: 'm_1',
  t0_ms: t0,
  t1_ms: t0 + 2_000,
  speaker_label: 'Room',
  source: 'laptop',
  text,
  confidence: 1,
})

/** A core the test can speak for: every event has a way in. */
function core(row: MeetingInfo, patch: Partial<Backend> = {}) {
  const quiet = () => undefined
  const say: {
    segment: (segment: SegmentFinal) => void
    state: (state: RecordingState) => void
    peaks: (peaks: AudioPeaks) => void
    capture: (status: CaptureStatus) => void
    playback: (state: PlaybackState) => void
  } = {
    segment: quiet,
    state: quiet,
    peaks: quiet,
    capture: quiet,
    playback: quiet,
  }
  const saved: unknown[] = []
  const backend: Backend = {
    ...fixtureBackend({ meetings: [row] }),
    onSegment: listener => ((say.segment = listener), () => undefined),
    onRecordingState: listener => ((say.state = listener), () => undefined),
    onPeaks: listener => ((say.peaks = listener), () => undefined),
    onCaptureStatus: listener => ((say.capture = listener), () => undefined),
    onPlayback: listener => ((say.playback = listener), () => undefined),
    mapSave: async patch => void saved.push(patch),
    ...patch,
  }
  return { backend, say, saved }
}

const open = (backend: Backend, autostart = true) =>
  openMeeting(backend, 'm_1', vi.fn(), autostart, vi.fn())

describe('openMeeting', () => {
  it('starts recording a new meeting with the saved audio choices', async () => {
    usePrefs.setState({ microphone: 'Headset', loopback: true })
    const start = vi.fn<Backend['start']>(async () => ({
      meeting_id: 'm_1',
      state: 'recording',
      elapsed_ms: 0,
      transcribing: false,
    }))
    const { backend } = core(meeting(), { start })
    const running = await open(backend)

    expect(start).toHaveBeenCalledWith('m_1', {
      microphone: 'Headset',
      loopback: true,
      model_id: DEFAULT_PREFS.modelId,
    })
    const state = running.session.getState()
    expect(state.rec).toBe('recording')
    expect(state.loopback).toBe(true)
    expect(state.noMic).toBe(false)
    // The agenda is on the map before anyone speaks (PRD F1.1).
    const headers = Object.values(running.store.getState().topics)
    expect(headers.map(header => header.title).sort()).toEqual([
      'A',
      'B',
      'C',
      'Unplanned',
    ])
  })

  it('says there is no microphone, and starts once one is there', async () => {
    let plugged = false
    const start = vi.fn<Backend['start']>(async () => {
      if (!plugged) throw new BackendError({ kind: 'no_microphone' })
      return {
        meeting_id: 'm_1',
        state: 'recording',
        elapsed_ms: 0,
        transcribing: true,
      }
    })
    const { backend } = core(meeting(), { start })
    const running = await open(backend)
    expect(running.session.getState()).toMatchObject({
      rec: 'idle',
      noMic: true,
    })

    plugged = true
    running.actions.retry()
    await vi.waitFor(() =>
      expect(running.session.getState()).toMatchObject({
        rec: 'recording',
        noMic: false,
      })
    )
  })

  it('does not start a meeting that was only opened from the list', async () => {
    const start = vi.fn<Backend['start']>()
    const { backend } = core(meeting(), { start })
    const running = await open(backend, false)
    expect(start).not.toHaveBeenCalled()
    expect(running.session.getState()).toMatchObject({
      rec: 'idle',
      notStarted: true,
    })
  })

  it('flags a missing speech model until the core says it is transcribing', async () => {
    const { backend, say } = core(meeting(), {
      listModels: async () =>
        FIXTURE_MODELS.map(model => ({ ...model, installed: false })),
    })
    const running = await open(backend)
    expect(running.session.getState().modelMissing).toBe(true)

    say.state({
      meeting_id: 'm_1',
      state: 'recording',
      elapsed_ms: 5_000,
      transcribing: true,
    })
    expect(running.session.getState().modelMissing).toBe(false)
  })

  it('keeps the session in step with the core', async () => {
    const { backend, say } = core(meeting())
    const running = await open(backend)
    const now = () => running.session.getState()

    say.state({
      meeting_id: 'm_1',
      state: 'recording',
      elapsed_ms: 4_000,
      transcribing: true,
    })
    say.segment(segment('s_2', 2_000, 'second'))
    // The other source finished later, but spoke first.
    say.segment(segment('s_1', 0, 'first'))
    say.segment({ ...segment('s_x', 0), meeting_id: 'm_other' })
    expect(now().elapsedMs).toBe(4_000)
    expect(now().segments.map(row => row.text)).toEqual(['first', 'second'])

    say.peaks({ meeting_id: 'm_1', from: 0, peaks: [10, 20] })
    say.peaks({ meeting_id: 'm_1', from: 2, peaks: [30] })
    say.peaks({ meeting_id: 'm_other', from: 0, peaks: [99] })
    expect(now().peaks).toEqual([10, 20, 30])

    say.capture({ source: 'laptop', ok: false })
    expect(now().micLost).toBe(true)
    say.capture({ source: 'laptop', ok: true })
    expect(now().micLost).toBe(false)

    say.playback({ meeting_id: 'm_1', playing: true, t_ms: 1_500 })
    expect(now().playback).toEqual({ playing: true, tMs: 1_500 })

    say.state({
      meeting_id: 'm_1',
      state: 'paused',
      elapsed_ms: 4_000,
      transcribing: true,
    })
    expect(now().rec).toBe('paused')
    say.state({
      meeting_id: 'm_1',
      state: 'stopped',
      elapsed_ms: 6_000,
      transcribing: true,
    })
    expect(now()).toMatchObject({
      rec: 'stopped',
      review: true,
      elapsedMs: 6_000,
    })
  })

  it('saves the new meeting’s headers, and every later commit', async () => {
    const { backend, saved } = core(meeting())
    const running = await open(backend)
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject({ deleted: [] })

    const [header] = Object.values(running.store.getState().topics)
    running.store.commit('rename_topic', 'user', [
      {
        entity: 'topic',
        id: header?.id ?? '',
        before: { title: header?.title },
        after: { title: 'Renamed' },
      },
    ])
    await vi.waitFor(() => expect(saved).toHaveLength(2))
    expect(saved[1]).toMatchObject({ topics: [{ title: 'Renamed' }] })
  })

  it('opens a finished meeting for review with what was saved', async () => {
    const start = vi.fn<Backend['start']>()
    const { backend } = core(
      meeting({ started_at_ms: 1, ended_at_ms: 2, duration_ms: 90_000 }),
      {
        start,
        getSegments: async () => [segment('s_1', 0), segment('s_2', 4_000)],
        getPeaks: async () => [1, 2, 3],
        listHighlights: async () => [
          { id: 'h_1', meeting_id: 'm_1', t0_ms: 0, t1_ms: 900, label: 'x' },
        ],
      }
    )
    const running = await open(backend)
    expect(start).not.toHaveBeenCalled()
    expect(running.session.getState()).toMatchObject({
      rec: 'stopped',
      review: true,
      elapsedMs: 90_000,
      peaks: [1, 2, 3],
      modelMissing: false,
    })
    expect(running.session.getState().segments).toHaveLength(2)
    expect(running.session.getState().highlights).toHaveLength(1)
  })

  it('saves a highlight and plays through the core', async () => {
    const saveHighlight = vi.fn<Backend['saveHighlight']>(async () => undefined)
    const playSpan = vi.fn<Backend['playSpan']>(async () => undefined)
    const seekPlay = vi.fn<Backend['seekPlay']>(async () => undefined)
    const { backend } = core(meeting({ started_at_ms: 1, ended_at_ms: 2 }), {
      saveHighlight,
      playSpan,
      seekPlay,
    })
    const running = await open(backend)

    running.actions.addHighlight(61_000.4, 66_500, 'The price')
    const [highlight] = running.session.getState().highlights
    expect(highlight).toMatchObject({
      meeting_id: 'm_1',
      t0_ms: 61_000,
      t1_ms: 66_500,
      label: 'The price',
    })
    expect(highlight?.id).toMatch(/^h_/)
    expect(saveHighlight).toHaveBeenCalledWith(highlight)

    running.actions.playSpan(1_000, 3_000)
    running.actions.seekPlay(9_000)
    expect(playSpan).toHaveBeenCalledWith('m_1', 1_000, 3_000)
    expect(seekPlay).toHaveBeenCalledWith('m_1', 9_000)
  })
})
