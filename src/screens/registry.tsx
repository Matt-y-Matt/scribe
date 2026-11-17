import type { ComponentType } from 'react'
import { Home } from './home/Home'
import {
  Live,
  LiveGhost,
  LiveUnplanned,
  LiveZoomedOut,
} from './live/LiveFixtures'
import type { ScreenId } from './screens'

export const SCREENS: Record<ScreenId, ComponentType> = {
  'home-empty': Home,
  live: Live,
  'live-ghost': LiveGhost,
  'live-unplanned': LiveUnplanned,
  'live-zoomed-out': LiveZoomedOut,
}
