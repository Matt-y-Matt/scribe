import { createContext, use } from 'react'
import {
  commands,
  events,
  type AppError,
  type AudioLevels,
  type AudioPeaks,
  type CaptureStatus,
  type Devices,
  type Highlight,
  type MapPatch,
  type MapRows,
  type MeetingInfo,
  type ModelDownload,
  type ModelInfo,
  type NewMeeting,
  type OpenAction,
  type PlaybackState,
  type RecordingState,
  type Recovered,
  type SegmentFinal,
  type StartOptions,
  type Summary,
} from '@/ipc'

// Everything the screens ask of the Rust core, behind one interface. The app
// gives them `tauriBackend`; `?screen=` fixtures and component tests give
// them a fake (fixture-backend.ts). Screens never import `@/ipc` commands
// themselves.

export type Unlisten = () => void

export interface Backend {
  listMeetings(): Promise<MeetingInfo[]>
  getMeeting(meetingId: string): Promise<MeetingInfo>
  createMeeting(meeting: NewMeeting): Promise<MeetingInfo>
  unfinishedMeetings(): Promise<MeetingInfo[]>
  recoverMeeting(meetingId: string, modelId: string): Promise<Recovered>
  /** The written summary; both fields null until one has been saved. */
  getSummary(meetingId: string): Promise<Summary>
  saveSummary(meetingId: string, summary: Summary): Promise<void>
  /** Every action not yet done, across meetings, oldest meeting first. */
  openActions(): Promise<OpenAction[]>
  /** Marks an action done, or open again, without its meeting being open. */
  setCardDone(cardId: string, done: boolean): Promise<void>

  listDevices(): Promise<Devices>
  listModels(): Promise<ModelInfo[]>
  downloadModel(modelId: string): Promise<void>
  cancelDownload(modelId: string): Promise<void>
  onModelDownload(listener: (event: ModelDownload) => void): Unlisten

  start(meetingId: string, options: StartOptions): Promise<RecordingState>
  pause(): Promise<RecordingState>
  resume(): Promise<RecordingState>
  stop(): Promise<RecordingState>
  recordingState(): Promise<RecordingState>
  onRecordingState(listener: (state: RecordingState) => void): Unlisten
  onSegment(listener: (segment: SegmentFinal) => void): Unlisten
  onLevels(listener: (levels: AudioLevels) => void): Unlisten
  onCaptureStatus(listener: (status: CaptureStatus) => void): Unlisten

  getSegments(meetingId: string): Promise<SegmentFinal[]>
  /** `meetingId` null searches every meeting. */
  searchSegments(
    meetingId: string | null,
    query: string
  ): Promise<SegmentFinal[]>

  mapLoad(meetingId: string): Promise<MapRows>
  mapSave(patch: MapPatch): Promise<void>
  /** One chat request to the Ollama on this PC; both sides are its JSON. */
  ollamaChat(body: string): Promise<string>

  getPeaks(meetingId: string): Promise<number[]>
  onPeaks(listener: (peaks: AudioPeaks) => void): Unlisten
  seekPlay(meetingId: string, tMs: number): Promise<void>
  playSpan(meetingId: string, t0Ms: number, t1Ms: number): Promise<void>
  stopPlayback(): Promise<void>
  onPlayback(listener: (state: PlaybackState) => void): Unlisten
  listHighlights(meetingId: string): Promise<Highlight[]>
  saveHighlight(highlight: Highlight): Promise<void>
  deleteHighlight(highlightId: string): Promise<void>
}

/** A command the core refused, with its reason. */
export class BackendError extends Error {
  readonly reason: AppError

  constructor(reason: AppError) {
    super('detail' in reason ? `${reason.kind}: ${reason.detail}` : reason.kind)
    this.name = 'BackendError'
    this.reason = reason
  }
}

/** The reason a backend call failed, when the core gave one. */
export function reasonOf(error: unknown): AppError['kind'] | null {
  return error instanceof BackendError ? error.reason.kind : null
}

type Outcome<T> =
  { status: 'ok'; data: T } | { status: 'error'; error: AppError }

async function ok<T>(call: Promise<Outcome<T>>): Promise<T> {
  const outcome = await call
  if (outcome.status === 'error') throw new BackendError(outcome.error)
  return outcome.data
}

async function done(call: Promise<Outcome<null>>): Promise<void> {
  await ok(call)
}

interface Listenable<T> {
  listen(handler: (event: { payload: T }) => void): Promise<() => void>
}

/** Subscribes at once and unsubscribes even if asked before that settles. */
function listen<T>(event: Listenable<T>, listener: (payload: T) => void) {
  let cancelled = false
  let unlisten: (() => void) | undefined
  void event
    .listen(message => listener(message.payload))
    .then(stop => {
      if (cancelled) stop()
      else unlisten = stop
    })
  return () => {
    cancelled = true
    unlisten?.()
  }
}

export const tauriBackend: Backend = {
  listMeetings: () => ok(commands.listMeetings()),
  getMeeting: meetingId => ok(commands.getMeeting(meetingId)),
  createMeeting: meeting => ok(commands.createMeeting(meeting)),
  unfinishedMeetings: () => ok(commands.unfinishedMeetings()),
  recoverMeeting: (meetingId, modelId) =>
    ok(commands.recoverMeeting(meetingId, modelId)),
  getSummary: meetingId => ok(commands.getSummary(meetingId)),
  saveSummary: (meetingId, summary) =>
    done(commands.saveSummary(meetingId, summary)),
  openActions: () => ok(commands.openActions()),
  setCardDone: (cardId, isDone) => done(commands.setCardDone(cardId, isDone)),

  listDevices: () => ok(commands.listDevices()),
  listModels: () => ok(commands.listModels()),
  downloadModel: modelId => done(commands.downloadModel(modelId)),
  cancelDownload: modelId => done(commands.cancelDownload(modelId)),
  onModelDownload: listener => listen(events.modelDownload, listener),

  start: (meetingId, options) => ok(commands.start(meetingId, options)),
  pause: () => ok(commands.pause()),
  resume: () => ok(commands.resume()),
  stop: () => ok(commands.stop()),
  recordingState: () => ok(commands.recordingState()),
  onRecordingState: listener => listen(events.recordingState, listener),
  onSegment: listener => listen(events.segmentFinal, listener),
  onLevels: listener => listen(events.audioLevels, listener),
  onCaptureStatus: listener => listen(events.captureStatus, listener),

  getSegments: meetingId => ok(commands.getSegments(meetingId)),
  searchSegments: (meetingId, query) =>
    ok(commands.searchSegments(meetingId, query)),

  mapLoad: meetingId => ok(commands.mapLoad(meetingId)),
  mapSave: patch => done(commands.mapSave(patch)),
  ollamaChat: body => ok(commands.ollamaChat(body)),

  getPeaks: meetingId => ok(commands.getPeaks(meetingId)),
  onPeaks: listener => listen(events.audioPeaks, listener),
  seekPlay: (meetingId, tMs) => done(commands.seekPlay(meetingId, tMs)),
  playSpan: (meetingId, t0Ms, t1Ms) =>
    done(commands.playSpan(meetingId, t0Ms, t1Ms)),
  stopPlayback: () => done(commands.stopPlayback()),
  onPlayback: listener => listen(events.playbackState, listener),
  listHighlights: meetingId => ok(commands.listHighlights(meetingId)),
  saveHighlight: highlight => done(commands.saveHighlight(highlight)),
  deleteHighlight: highlightId => done(commands.deleteHighlight(highlightId)),
}

export const BackendContext = createContext<Backend | null>(null)

export function useBackend(): Backend {
  const backend = use(BackendContext)
  if (!backend) throw new Error('useBackend outside a BackendContext')
  return backend
}
