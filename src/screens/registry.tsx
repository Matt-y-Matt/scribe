import type { ComponentType } from 'react'
import { Home } from './home/Home'
import type { ScreenId } from './screens'

export const SCREENS: Record<ScreenId, ComponentType> = {
  'home-empty': Home,
}
