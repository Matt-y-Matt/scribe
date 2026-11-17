import { Button } from '@/components/ui/button'
import { revisitTopic, scheduleTopic } from '@/engine/actions'
import { cardsIn, pinnedTopics, type Topic } from '@/engine/model'
import { clock } from './format'
import { useLive } from './live-context'

// The Pins rail, UI_SPEC §2.3: what the meeting parked, top right, at most
// 40% of the height. "Revisit now" puts a pin back on the table; "Schedule"
// adds it to the end screen's schedule list. Nothing here sends anything.

function PinItem({ topic }: { topic: Topic }) {
  const { store, state, setActiveTopicId } = useLive()
  const cards = cardsIn(state, topic.id).length
  const scheduled = topic.scheduled_t_ms !== null
  const meta = [
    `pinned at ${clock(topic.pinned_t_ms ?? 0)}`,
    topic.revisited_t_ms !== null && `revisited ${clock(topic.revisited_t_ms)}`,
    `${cards} ${cards === 1 ? 'card' : 'cards'}`,
  ].filter(Boolean)

  return (
    <li data-pin-id={topic.id} className="rounded-md border p-2">
      <h3 className="truncate text-body font-semibold">{topic.title}</h3>
      <p className="font-mono text-meta text-text-muted">{meta.join(' · ')}</p>
      <div className="mt-2 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            revisitTopic(store, topic.id)
            setActiveTopicId(topic.id)
          }}
        >
          Revisit now
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={scheduled}
          onClick={() => scheduleTopic(store, topic.id)}
        >
          {scheduled ? 'Scheduled' : 'Schedule'}
        </Button>
      </div>
    </li>
  )
}

export function PinsRail() {
  const { state } = useLive()
  const pins = pinnedTopics(state)

  return (
    <section
      aria-labelledby="pins-title"
      className="flex max-h-[40%] min-h-0 flex-col border-b"
    >
      <h2
        id="pins-title"
        className="flex h-9 shrink-0 items-center justify-between px-3 text-meta font-semibold text-text-muted"
      >
        PINS <span className="font-mono font-normal">({pins.length})</span>
      </h2>
      {pins.length === 0 ? (
        <p className="px-3 pb-3 text-body text-text-muted">
          Nothing pinned. Say “pin it” or tap Pin on an off-topic card.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {pins.map(topic => (
            <PinItem key={topic.id} topic={topic} />
          ))}
        </ul>
      )}
    </section>
  )
}
