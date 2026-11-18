import type { ComponentType } from 'react'
import {
  HomeEmpty,
  HomeList,
  HomeSearch,
  PreMeetingSheet,
  SettingsAudio,
  SettingsSpeech,
} from './home/HomeFixtures'
import {
  Live,
  LiveGhost,
  LiveUnplanned,
  LiveZoomedOut,
  ModelMissing,
  NoMicError,
  Paused,
} from './live/LiveFixtures'
import type { ScreenId } from './screens'

export const SCREENS: Record<ScreenId, ComponentType> = {
  'home-empty': HomeEmpty,
  'home-list': HomeList,
  'home-search': HomeSearch,
  premeeting: PreMeetingSheet,
  live: Live,
  'live-ghost': LiveGhost,
  'live-unplanned': LiveUnplanned,
  'live-zoomed-out': LiveZoomedOut,
  paused: Paused,
  'nomic-error': NoMicError,
  'model-missing': ModelMissing,
  'settings-audio': SettingsAudio,
  'settings-speech': SettingsSpeech,
}
