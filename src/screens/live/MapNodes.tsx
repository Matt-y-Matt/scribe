import type { NodeProps } from '@xyflow/react'
import { hasAgenda } from '@/engine/model'
import { cn } from '@/lib/utils'
import { useLive } from './live-context'
import type { HeaderNode, TopicNode } from './nodes'
import { TopicCard } from './TopicCard'

// The two React Flow node types of the map. A header is a column: a group
// node sized by the layout, with its title at the top. A topic is a child of
// its column and draws itself (TopicCard).

export function HeaderColumn({ data }: NodeProps<HeaderNode>) {
  const { state } = useLive()
  const header = state.topics[data.headerId]
  if (!header) return null
  // With no agenda nothing is off it: the area is just the meeting's topics.
  const aside = header.off_agenda && hasAgenda(state)
  return (
    <div
      data-header-id={header.id}
      data-aside={aside || undefined}
      className={cn(
        'h-full w-full rounded-md',
        // Off the agenda: its own colour, at the far right (UI_SPEC §2.2).
        aside && 'border border-dashed border-aside bg-aside-soft'
      )}
    >
      <h2
        className={cn(
          'flex h-9 items-center px-2 text-header font-semibold',
          aside && 'text-aside'
        )}
      >
        {header.off_agenda
          ? aside
            ? 'Off the agenda'
            : 'Topics'
          : header.title}
      </h2>
    </div>
  )
}

export function TopicNodeView({ data }: NodeProps<TopicNode>) {
  return <TopicCard topicId={data.topicId} />
}
