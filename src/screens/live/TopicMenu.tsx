import { Menu } from '@base-ui/react/menu'
import { ChevronRight, Ellipsis } from 'lucide-react'
import { deleteTopic, mergeTopic, pinTopic } from '@/engine/actions'
import type { Topic } from '@/engine/model'
import { useLive } from './live-context'

// The "⋯" menu on a topic (UI_SPEC §2.2): rename, pin, merge into…, tidy,
// delete. Each is one undoable operation; delete says so in a toast.

const popup =
  'min-w-40 rounded-md border bg-surface p-1 text-body text-text outline-none'
const item =
  'flex cursor-default items-center justify-between gap-4 rounded-md px-2 py-1 outline-none select-none data-[highlighted]:bg-surface-2'

export function TopicMenu({
  topic,
  onRename,
}: {
  topic: Topic
  onRename: () => void
}) {
  const { store, state, tidy, notify } = useLive()
  const others = Object.values(state.topics)
    .filter(
      other =>
        other.kind === 'topic' &&
        other.id !== topic.id &&
        other.status !== 'pinned'
    )
    .sort((a, b) => a.title.localeCompare(b.title))

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Menu for ${topic.title}`}
        className="nodrag nopan flex size-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-opacity duration-150 ease-out hover:bg-surface-2"
      >
        <Ellipsis size={14} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={popup}>
            <Menu.Item className={item} onClick={onRename}>
              Rename
            </Menu.Item>
            {topic.status !== 'pinned' && (
              <Menu.Item
                className={item}
                onClick={() => pinTopic(store, topic.id)}
              >
                Pin
              </Menu.Item>
            )}
            {others.length > 0 && (
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger className={item}>
                  Merge into…
                  <ChevronRight size={12} aria-hidden />
                </Menu.SubmenuTrigger>
                <Menu.Portal>
                  <Menu.Positioner sideOffset={4} className="z-50">
                    <Menu.Popup className={popup}>
                      {others.map(other => (
                        <Menu.Item
                          key={other.id}
                          className={item}
                          onClick={() => {
                            mergeTopic(store, topic.id, other.id)
                            notify(
                              `Merged “${topic.title}” into “${other.title}”.`
                            )
                          }}
                        >
                          {other.title}
                        </Menu.Item>
                      ))}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.SubmenuRoot>
            )}
            <Menu.Item className={item} onClick={tidy}>
              Tidy
            </Menu.Item>
            <Menu.Item
              className={item}
              onClick={() => {
                deleteTopic(store, topic.id)
                notify(`Deleted “${topic.title}”.`)
              }}
            >
              Delete
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
