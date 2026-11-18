import type {
  Devices,
  Highlight,
  MeetingInfo,
  ModelDownload,
  ModelInfo,
  RecordingState,
  SegmentFinal,
} from '@/ipc'
import { BackendError, type Backend, type Unlisten } from './backend'

// A Rust core that is not there: the `?screen=` fixtures, the component tests
// and a plain `vite dev` in a browser all run on this. It remembers what it
// is told for the life of the page and records nothing.

export const FIXTURE_MODELS: ModelInfo[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    title: 'Parakeet-TDT 0.6B v3',
    languages: 'English and 24 other European languages',
    licence: 'CC-BY-4.0',
    bytes: 670_576_784,
    installed: true,
    downloading: false,
  },
  {
    id: 'whisper-large-v3-turbo-int8',
    title: 'Whisper large-v3-turbo',
    languages: 'Multilingual (99 languages)',
    licence: 'MIT',
    bytes: 1_036_613_791,
    installed: false,
    downloading: false,
  },
]

export const FIXTURE_DEVICES: Devices = {
  microphones: ['Microphone (USB Audio Device)', 'Headset (Jabra Evolve2)'],
  default_microphone: 'Microphone (USB Audio Device)',
}

export interface FixtureData {
  meetings: MeetingInfo[]
  models: ModelInfo[]
  devices: Devices
  segments: Record<string, SegmentFinal[]>
  highlights: Record<string, Highlight[]>
  /** A download in progress, replayed to every listener. */
  download: ModelDownload | null
}

const IDLE: RecordingState = {
  meeting_id: null,
  state: 'idle',
  elapsed_ms: 0,
  transcribing: false,
}

const nothing: Unlisten = () => undefined

export function fixtureBackend(overrides: Partial<FixtureData> = {}): Backend {
  const data: FixtureData = {
    meetings: [],
    models: FIXTURE_MODELS,
    devices: FIXTURE_DEVICES,
    segments: {},
    highlights: {},
    download: null,
    ...overrides,
  }
  let recording = IDLE
  let created = 0

  const meeting = (meetingId: string) => {
    const found = data.meetings.find(row => row.id === meetingId)
    if (!found) throw new BackendError({ kind: 'not_found' })
    return found
  }

  return {
    listMeetings: async () => data.meetings,
    getMeeting: async meetingId => meeting(meetingId),
    createMeeting: async request => {
      const row: MeetingInfo = {
        id: `m_fixture_${++created}`,
        title: request.title,
        created_at_ms: Date.now(),
        started_at_ms: null,
        ended_at_ms: null,
        duration_ms: 0,
        mode: request.mode,
        agenda: request.agenda,
        participants: request.participants,
        loopback: false,
      }
      data.meetings = [row, ...data.meetings]
      return row
    },
    unfinishedMeetings: async () =>
      data.meetings.filter(
        row => row.started_at_ms !== null && row.ended_at_ms === null
      ),
    recoverMeeting: async meetingId => {
      const row = meeting(meetingId)
      data.meetings = data.meetings.map(other =>
        other.id === meetingId ? { ...other, ended_at_ms: Date.now() } : other
      )
      return {
        meeting_id: meetingId,
        duration_ms: row.duration_ms,
        segments_added: 0,
      }
    },

    listDevices: async () => data.devices,
    listModels: async () => data.models,
    downloadModel: async () => undefined,
    cancelDownload: async () => undefined,
    onModelDownload: listener => {
      if (data.download) listener(data.download)
      return nothing
    },

    start: async meetingId => {
      meeting(meetingId)
      if (data.devices.microphones.length === 0) {
        throw new BackendError({ kind: 'no_microphone' })
      }
      recording = {
        meeting_id: meetingId,
        state: 'recording',
        elapsed_ms: 0,
        transcribing: data.models.some(model => model.installed),
      }
      return recording
    },
    pause: async () => (recording = { ...recording, state: 'paused' }),
    resume: async () => (recording = { ...recording, state: 'recording' }),
    stop: async () => {
      const stopped = { ...recording, state: 'stopped' as const }
      recording = IDLE
      return stopped
    },
    recordingState: async () => recording,
    onRecordingState: () => nothing,
    onSegment: () => nothing,
    onLevels: () => nothing,
    onCaptureStatus: () => nothing,

    getSegments: async meetingId => data.segments[meetingId] ?? [],
    searchSegments: async (meetingId, query) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean)
      if (words.length === 0) return []
      const pool =
        meetingId === null
          ? Object.values(data.segments).flat()
          : (data.segments[meetingId] ?? [])
      return pool.filter(segment =>
        words.every(word => segment.text.toLowerCase().includes(word))
      )
    },

    mapLoad: async () => ({ topics: [], cards: [], suggestions: [] }),
    mapSave: async () => undefined,
    ollamaChat: async () => {
      throw new BackendError({ kind: 'local_ai', detail: 'no core' })
    },

    getPeaks: async () => [],
    onPeaks: () => nothing,
    seekPlay: async () => undefined,
    playSpan: async () => undefined,
    stopPlayback: async () => undefined,
    onPlayback: () => nothing,
    listHighlights: async meetingId => data.highlights[meetingId] ?? [],
    saveHighlight: async highlight => {
      const others = (data.highlights[highlight.meeting_id] ?? []).filter(
        row => row.id !== highlight.id
      )
      data.highlights[highlight.meeting_id] = [...others, highlight]
    },
    deleteHighlight: async highlightId => {
      for (const [meetingId, rows] of Object.entries(data.highlights)) {
        data.highlights[meetingId] = rows.filter(row => row.id !== highlightId)
      }
    },
  }
}
