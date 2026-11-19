import { useStore } from 'zustand'
import { EndScreen } from '../end/EndScreen'
import { LiveScreen, type LiveScreenProps } from './LiveScreen'

/**
 * A meeting on screen: the live screen while it runs and in review, the end
 * screen once it has been stopped or the host asks for the summary.
 */
export function MeetingScreen(props: LiveScreenProps) {
  const wrap = useStore(
    props.session,
    state => state.review && state.view === 'wrap'
  )
  return wrap ? (
    <EndScreen
      store={props.store}
      session={props.session}
      actions={props.actions}
    />
  ) : (
    <LiveScreen {...props} />
  )
}
