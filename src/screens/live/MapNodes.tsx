import type { NodeProps } from '@xyflow/react'
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
  return (
    <div
      data-header-id={header.id}
      className={cn(
        'h-full w-full rounded-md',
        // Unplanned is the dashed column at the far right (UI_SPEC §2.2).
        header.off_agenda && 'border border-dashed border-pin'
      )}
    >
      <h2
        className={cn(
          'flex h-9 items-center px-2 text-header font-semibold',
          header.off_agenda && 'text-text-muted'
        )}
      >
        {header.title}
      </h2>
    </div>
  )
}

export function TopicNodeView({ data }: NodeProps<TopicNode>) {
  return <TopicCard topicId={data.topicId} />
}
