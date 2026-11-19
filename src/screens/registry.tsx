import type { ComponentType } from 'react'
import {
  HomeActions,
  HomeEmpty,
  HomeList,
  HomeSearch,
  PreMeetingSheet,
  SettingsAppearance,
  SettingsAudio,
  SettingsSpeech,
} from './home/HomeFixtures'
import {
  Live,
  LiveGhost,
  LiveLastTime,
  LiveUnplanned,
  End,
  LiveZoomedOut,
  ModelMissing,
  NoMicError,
  NotesOff,
  Paused,
  Review,
} from './live/LiveFixtures'
import type { ScreenId } from './screens'

export const SCREENS: Record<ScreenId, ComponentType> = {
  'home-empty': HomeEmpty,
  'home-list': HomeList,
  'home-search': HomeSearch,
  'home-actions': HomeActions,
  premeeting: PreMeetingSheet,
  live: Live,
  'live-ghost': LiveGhost,
  'live-unplanned': LiveUnplanned,
  'live-zoomed-out': LiveZoomedOut,
  'live-last-time': LiveLastTime,
  paused: Paused,
  'nomic-error': NoMicError,
  'model-missing': ModelMissing,
  'notes-off': NotesOff,
  review: Review,
  end: End,
  'settings-audio': SettingsAudio,
  'settings-speech': SettingsSpeech,
  'settings-appearance': SettingsAppearance,
}
