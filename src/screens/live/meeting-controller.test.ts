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
import { addCard, addTopic } from '@/engine/actions'
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
    // Stop goes to the end screen; the map is one action away, and back.
    expect(now()).toMatchObject({
      rec: 'stopped',
      review: true,
      view: 'wrap',
      elapsedMs: 6_000,
    })
    running.actions.showMap()
    expect(now().view).toBe('map')
    running.actions.wrapUp()
    expect(now().view).toBe('wrap')
  })

  it('brings what is still owed from earlier meetings of the same name', async () => {
    const action = (
      id: string,
      meetingId: string,
      title: string,
      createdAt: number
    ) => ({
      card: {
        id,
        meeting_id: meetingId,
        topic_id: 't_1',
        kind: 'action' as const,
        text: id,
        owner: 'Kabs',
        due_text: null,
        segment_ids: [],
        status: 'accepted' as const,
        source: 'engine' as const,
        created_t_ms: 0,
        confirmed: true,
        done_at_ms: null,
        order_key: 0,
      },
      meeting_title: title,
      meeting_created_at_ms: createdAt,
      topic_title: 'Pricing',
    })
    const setCardDone = vi.fn<Backend['setCardDone']>(async () => undefined)
    const { backend } = core(meeting({ title: 'Weekly', created_at_ms: 100 }), {
      openActions: async () => [
        action('c_same', 'm_0', ' weekly ', 50),
        action('c_other', 'm_x', 'UDO review', 60),
        // This meeting's own actions are on its map, not in the rail.
        action('c_mine', 'm_1', 'Weekly', 100),
      ],
      setCardDone,
    })
    const running = await open(backend)
    const now = () => running.session.getState()
    expect(now().lastTime.map(row => row.card.id)).toEqual(['c_same'])

    running.actions.setDone('c_same', true)
    expect(now().lastTimeDone).toEqual(['c_same'])
    expect(setCardDone).toHaveBeenCalledWith('c_same', true)
    running.actions.setDone('c_same', false)
    expect(now().lastTimeDone).toEqual([])
    expect(setCardDone).toHaveBeenLastCalledWith('c_same', false)
  })

  it('opens the meeting even if the open actions cannot be read', async () => {
    const { backend } = core(meeting(), {
      openActions: async () => {
        throw new BackendError({ kind: 'not_found' })
      },
    })
    const running = await open(backend)
    expect(running.session.getState().lastTime).toEqual([])
    expect(running.session.getState().rec).toBe('recording')
  })

  it('says the map is behind when the local model does not answer', async () => {
    // The core that is not there refuses every request to the model.
    const { backend, say } = core(meeting())
    const running = await open(backend)
    expect(running.session.getState().notesOff).toBe(false)

    const words = Array.from({ length: 30 }, (_, n) => `word${n}`).join(' ')
    say.segment(segment('s_1', 0, words))
    // Three seconds of quiet, then more talk: a run is due.
    say.segment(segment('s_2', 5_000, 'and then'))
    await vi.waitFor(() =>
      expect(running.session.getState().notesOff).toBe(true)
    )
    // The lines are still there to read.
    expect(running.session.getState().segments).toHaveLength(2)
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
      // A past meeting opens on its map, not on the end screen.
      view: 'map',
      elapsedMs: 90_000,
      peaks: [1, 2, 3],
      modelMissing: false,
    })
    expect(running.session.getState().segments).toHaveLength(2)
    expect(running.session.getState().highlights).toHaveLength(1)
  })

  it('writes a finished meeting’s notes again, keeping what the host added', async () => {
    const asked: string[] = []
    // A model that notes every turn it is shown under one topic.
    const ollamaChat = vi.fn(async (body: string) => {
      const sent = JSON.parse(body) as {
        format: {
          properties: {
            segments: { items: { properties: { id: { enum: string[] } } } }
          }
        }
        messages: { content: string }[]
      }
      asked.push(sent.messages[1]?.content ?? '')
      const ids = sent.format.properties.segments.items.properties.id.enum
      const reply = {
        segments: ids.map(id => ({
          id,
          type: 'new',
          header: 'OFF',
          topic: 'Launch',
          cards: [
            { kind: 'note', owner: null, due_text: null, text: `From ${id}` },
          ],
        })),
      }
      return JSON.stringify({ message: { content: JSON.stringify(reply) } })
    })
    const words = (n: number) =>
      Array.from({ length: 30 }, (_, k) => `w${n}x${k}`).join(' ')
    const { backend } = core(
      meeting({
        agenda: [],
        participants: ['Matt', 'Zach'],
        loopback: true,
        started_at_ms: 1,
        ended_at_ms: 2,
        duration_ms: 90_000,
      }),
      {
        ollamaChat,
        getSegments: async () => [
          segment('s_1', 0, words(1)),
          segment('s_2', 10_000, words(2)),
          { ...segment('s_3', 20_000, words(3)), source: 'system' },
        ],
      }
    )
    const running = await open(backend, false)
    const { store, actions, session } = running
    // What the old note-taker left, and a card the host wrote.
    const header = Object.values(store.getState().topics)[0]
    const old = addTopic(store, header?.id ?? '', 'Old topic')
    const mine = addTopic(store, header?.id ?? '', 'Mine')
    store.commit('add_card', 'engine', [
      {
        entity: 'card',
        id: 'c_old',
        before: null,
        after: {
          id: 'c_old',
          meeting_id: 'm_1',
          topic_id: old?.id ?? '',
          kind: 'note',
          text: 'Garbled',
          owner: null,
          due_text: null,
          segment_ids: ['s_1'],
          status: 'accepted',
          source: 'engine',
          created_t_ms: 0,
          confirmed: false,
          done_at_ms: null,
          order_key: 0,
        },
      },
    ])
    addCard(store, mine?.id ?? '', { kind: 'action', text: 'Book the room' })

    actions.rebuild()
    expect(session.getState().rebuilding).toMatchObject({ of: 3 })
    await vi.waitFor(() => expect(session.getState().rebuilding).toBeNull())

    const cards = Object.values(store.getState().cards)
    expect(cards.find(card => card.id === 'c_old')).toBeUndefined()
    expect(cards.some(card => card.text === 'Book the room')).toBe(true)
    expect(
      cards.filter(card => card.text.startsWith('From '))
    ).not.toHaveLength(0)
    const titles = Object.values(store.getState().topics).map(t => t.title)
    expect(titles).not.toContain('Old topic')
    expect(titles).toContain('Mine')
    // Read with names, and as a live transcript.
    expect(asked.join('\n')).toContain('Matt: w1x0')
    expect(asked.join('\n')).toContain('Zach: w3x0')
    expect(asked.join('\n')).toContain('THIS IS A LIVE TRANSCRIPT')
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
