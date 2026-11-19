import { ulid } from 'ulid'
import { clearNotes } from '@/engine/actions'
import { RowAdapter } from '@/engine/persist'
import cardsPrompt from '@/engine/prompts/structurer-cards.md?raw'
import { createOllamaProvider } from '@/engine/providers/ollama'
import { named, speakerNames } from '@/engine/speakers'
import { MapStore } from '@/engine/store'
import { Structurer } from '@/engine/structurer'
import type { SegmentFinal } from '@/ipc'
import { reasonOf, type Backend } from '@/lib/backend'
import { logger } from '@/lib/logger'
import { currentPrefs } from '@/lib/prefs'
import {
  createSessionStore,
  emptySession,
  withPeaks,
  withSegment,
  type SessionActions,
  type SessionStore,
} from './session'

// A meeting, live or in review, on the real core: loads what is saved, starts
// recording when the host pressed Start, and from then on keeps the screen's
// session and the map engine fed from the core's events.

/** "Custore weekly" this week is "custore weekly " last week. */
const sameTitle = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

export interface RunningMeeting {
  store: MapStore
  session: SessionStore
  actions: SessionActions
  dispose: () => void
}

export async function openMeeting(
  backend: Backend,
  meetingId: string,
  leave: () => void,
  autostart: boolean,
  openSettings: (tab: 'audio' | 'speech') => void
): Promise<RunningMeeting> {
  const prefs = currentPrefs()
  const [meeting, rows, segments, peaks, highlights, models, recording, open] =
    await Promise.all([
      backend.getMeeting(meetingId),
      backend.mapLoad(meetingId),
      backend.getSegments(meetingId),
      backend.getPeaks(meetingId),
      backend.listHighlights(meetingId),
      backend.listModels(),
      backend.recordingState(),
      // Not worth failing to open a meeting over.
      backend.openActions().catch(() => []),
    ])

  const store = new MapStore({
    meeting: {
      id: meeting.id,
      title: meeting.title,
      mode: meeting.mode,
      participants: meeting.participants,
    },
    agenda: meeting.agenda,
    adapter: new RowAdapter({
      meeting: {
        id: meeting.id,
        title: meeting.title,
        mode: meeting.mode,
        participants: meeting.participants,
      },
      rows,
      backend: { save: patch => backend.mapSave(patch) },
      // The map on screen is still right; say so in the log, without text.
      onError: () => logger.error('the map could not be saved'),
    }),
  })

  const here = recording.meeting_id === meetingId
  const fresh = meeting.started_at_ms === null
  const modelMissing = !models.some(
    model => model.id === prefs.modelId && model.installed
  )
  const session = createSessionStore({
    ...emptySession(meeting.id, meeting.title),
    rec: here ? recording.state : fresh ? 'idle' : 'stopped',
    review: !here && !fresh,
    notStarted: fresh && !here && !autostart,
    elapsedMs: here ? recording.elapsed_ms : meeting.duration_ms,
    modelMissing: (here || fresh) && modelMissing,
    loopback: fresh ? prefs.loopback : meeting.loopback,
    segments,
    peaks,
    highlights,
    cleanupModel: models.some(model => !model.live && model.installed),
    cleaned: meeting.cleaned,
    // A meeting being held, not one being read: what is still owed from
    // the earlier meetings of the same name.
    lastTime:
      here || fresh
        ? open.filter(
            row =>
              row.card.meeting_id !== meetingId &&
              row.meeting_created_at_ms <= meeting.created_at_ms &&
              sameTitle(row.meeting_title, meeting.title)
          )
        : [],
  })
  store.tick(session.getState().elapsedMs)

  // The structurer builds the map from what is said, on the Ollama of this
  // PC. Its requests go through the core (backend.ollamaChat).
  const noteTaker = () =>
    new Structurer({
      store,
      provider: createOllamaProvider(
        { kind: 'ollama', prompt: cardsPrompt },
        body => backend.ollamaChat(body)
      ),
      // What it reads is speech recognition, not a written transcript.
      liveSpeech: true,
      log: (message, context) => logger.info(message, context),
      // A run that failed keeps its lines for the next one, so the map
      // catches up by itself; until then the host is told it is behind.
      onRun: run => session.setState({ notesOff: run.error !== undefined }),
    })
  const structurer = noteTaker()

  // The note-taker reads a name where the meeting's own facts give one
  // ("Room" cannot own an action); the transcript keeps the core's label.
  const withName = (segment: SegmentFinal) =>
    named(
      segment,
      speakerNames(meeting.participants, session.getState().loopback)
    )

  const mine = (id: string | null) => id === meetingId
  const heard = (segment: SegmentFinal) => {
    session.setState(state => ({
      segments: withSegment(state.segments, segment),
    }))
    structurer.segmentFinal(withName(segment))
  }

  // A finished meeting's notes, written again by the note-taker as it is
  // now. The transcript is played in at the pace a live meeting would give
  // it: each run gets one trigger's lines and the next waits for it.
  const rebuild = async () => {
    const now = session.getState()
    if (now.rebuilding || !now.review || now.segments.length === 0) return
    const lines = [...now.segments]
    clearNotes(store)
    const fresh = noteTaker()
    session.setState({ rebuilding: { done: 0, of: lines.length } })
    try {
      for (const [index, segment] of lines.entries()) {
        fresh.segmentFinal(withName(segment))
        await fresh.idle()
        session.setState({ rebuilding: { done: index + 1, of: lines.length } })
      }
      fresh.end()
      await fresh.idle()
    } finally {
      session.setState({ rebuilding: null })
    }
  }

  // The transcript heard again by the clean-up model (session/cleanup.rs in
  // the core), then read back so the screen, the summary and a rebuild of
  // the notes all use it.
  const cleanTranscript = async () => {
    const now = session.getState()
    if (now.cleaning || now.cleaned || !now.cleanupModel) return
    if (now.segments.length === 0) return
    session.setState({ cleaning: { done: 0, of: now.segments.length } })
    const unlisten = backend.onTranscriptCleanup(event => {
      if (mine(event.meeting_id)) {
        session.setState({ cleaning: { done: event.done, of: event.total } })
      }
    })
    try {
      await backend.cleanTranscript(meetingId)
      session.setState({
        segments: await backend.getSegments(meetingId),
        cleaned: true,
      })
    } finally {
      unlisten()
      session.setState({ cleaning: null })
    }
  }
  const cleanQuietly = () => {
    cleanTranscript().catch((error: unknown) =>
      logger.error('the transcript could not be cleaned up', {
        reason: reasonOf(error),
      })
    )
  }

  const stops = [
    backend.onSegment(segment => {
      if (mine(segment.meeting_id)) heard(segment)
    }),
    backend.onRecordingState(next => {
      if (!mine(next.meeting_id)) return
      const stopped = next.state === 'stopped'
      const justStopped = stopped && session.getState().rec !== 'stopped'
      session.setState(state => ({
        rec: next.state,
        elapsedMs: next.elapsed_ms,
        review: stopped,
        // Stop goes to the end screen: who owes what, while it is fresh.
        view: stopped && state.rec !== 'stopped' ? 'wrap' : state.view,
        // The core says so once the model has loaded.
        modelMissing: next.transcribing || stopped ? false : state.modelMissing,
        micLost: stopped ? false : state.micLost,
      }))
      if (stopped) structurer.end()
      else structurer.clock(next.elapsed_ms)
      // The meeting is over: clean its transcript up while the host reads
      // the end screen. The summary waits for it.
      if (justStopped) cleanQuietly()
    }),
    backend.onLevels(levels => {
      const rms = (id: string) =>
        levels.sources.find(source => source.id === id)?.rms ?? 0
      session.setState({
        levels: { laptop: rms('laptop'), system: rms('system') },
      })
    }),
    backend.onPeaks(batch => {
      if (!mine(batch.meeting_id)) return
      session.setState(state => ({
        peaks: withPeaks(state.peaks, batch.from, batch.peaks),
      }))
    }),
    backend.onCaptureStatus(status => {
      if (status.source === 'laptop') session.setState({ micLost: !status.ok })
    }),
    backend.onPlayback(playback => {
      if (!mine(playback.meeting_id)) return
      session.setState({
        playback: { playing: playback.playing, tMs: playback.t_ms },
      })
    }),
  ]

  const start = async () => {
    const now = currentPrefs()
    try {
      const state = await backend.start(meetingId, {
        microphone: now.microphone,
        loopback: now.loopback,
        model_id: now.modelId,
      })
      session.setState({
        rec: state.state,
        elapsedMs: state.elapsed_ms,
        noMic: false,
        notStarted: false,
        loopback: now.loopback,
      })
    } catch (error) {
      const reason = reasonOf(error)
      // No microphone, or one that would not open: say so and offer to try
      // again. Anything else (the core is busy, the meeting already has a
      // recording) is not the microphone's doing.
      if (reason === 'no_microphone' || reason === 'capture') {
        session.setState({ noMic: true })
      } else {
        logger.error('recording could not start', { reason })
        session.setState({ notStarted: true })
      }
    }
  }

  const quietly = (call: Promise<unknown>, what: string) => {
    call.catch((error: unknown) =>
      logger.error(what, { reason: reasonOf(error) })
    )
  }

  const actions: SessionActions = {
    pause: () => quietly(backend.pause(), 'pause failed'),
    resume: () => quietly(backend.resume(), 'resume failed'),
    stop: () => quietly(backend.stop(), 'stop failed'),
    retry: () => void start(),
    search: query => backend.searchSegments(meetingId, query),
    seekPlay: tMs => quietly(backend.seekPlay(meetingId, tMs), 'seek failed'),
    playSpan: (t0Ms, t1Ms) =>
      quietly(backend.playSpan(meetingId, t0Ms, t1Ms), 'play failed'),
    stopPlayback: () => quietly(backend.stopPlayback(), 'stop failed'),
    addHighlight: (t0Ms, t1Ms, label) => {
      const highlight = {
        id: `h_${ulid()}`,
        meeting_id: meetingId,
        t0_ms: Math.round(t0Ms),
        t1_ms: Math.round(t1Ms),
        label,
      }
      session.setState(state => ({
        highlights: [...state.highlights, highlight],
      }))
      quietly(backend.saveHighlight(highlight), 'highlight not saved')
    },
    removeHighlight: highlightId => {
      session.setState(state => ({
        highlights: state.highlights.filter(row => row.id !== highlightId),
      }))
      quietly(backend.deleteHighlight(highlightId), 'highlight not removed')
    },
    openSettings,
    setDone: (cardId, isDone) => {
      session.setState(state => ({
        lastTimeDone: isDone
          ? [...state.lastTimeDone.filter(id => id !== cardId), cardId]
          : state.lastTimeDone.filter(id => id !== cardId),
      }))
      quietly(backend.setCardDone(cardId, isDone), 'done not saved')
    },
    wrapUp: () => {
      quietly(backend.stopPlayback(), 'stop failed')
      session.setState({ view: 'wrap' })
    },
    showMap: () => session.setState({ view: 'map' }),
    cleanTranscript: cleanQuietly,
    rebuild: () => {
      rebuild().catch((error: unknown) =>
        logger.error('the notes could not be rebuilt', {
          reason: reasonOf(error),
        })
      )
    },
    leave: () => {
      quietly(backend.stopPlayback(), 'stop failed')
      leave()
    },
  }

  // The host pressed Start recording to get here: start now.
  if (fresh && !here && autostart) await start()

  return {
    store,
    session,
    actions,
    dispose: () => {
      for (const stop of stops) stop()
    },
  }
}
