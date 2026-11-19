import { Menu } from '@base-ui/react/menu'
import { editCard } from '@/engine/actions'
import type { Card } from '@/engine/model'
import { cn } from '@/lib/utils'
import { initials } from './format'
import { useLive } from './live-context'
import { knownOwners } from './owners'

// The owner chip of an action on the map, as a control: one click lists the
// people in the meeting, one more gives the action to one of them. An action
// nobody owns shows a dashed "?" in the same place, so the gap is visible
// (PRD §8: actions leave the room with an owner).

const popup =
  'min-w-36 rounded-md border bg-surface p-1 text-body text-text outline-none'
const item =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1 outline-none select-none data-[highlighted]:bg-surface-2'

export function OwnerPicker({ card }: { card: Card }) {
  const { store, state, setEditingId } = useLive()
  const names = knownOwners(state)

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={
          card.owner
            ? `Owner: ${card.owner}. Change`
            : 'No owner. Give this action to someone'
        }
        title={card.owner ?? 'Nobody owns this yet'}
        className={cn(
          'nodrag nopan shrink-0 rounded-md border border-action px-1 font-mono text-meta text-action hover:bg-surface-2',
          !card.owner && 'border-dashed'
        )}
        // The card under it is draggable and plays on a click.
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
      >
        {card.owner ? initials(card.owner) : '?'}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup
            className={popup}
            onClick={event => event.stopPropagation()}
            onKeyDown={event => event.stopPropagation()}
          >
            {names.map(name => (
              <Menu.Item
                key={name}
                className={cn(item, name === card.owner && 'font-semibold')}
                onClick={() => editCard(store, card.id, { owner: name })}
              >
                {name}
              </Menu.Item>
            ))}
            {card.owner && (
              <Menu.Item
                className={cn(item, 'text-text-muted')}
                onClick={() => editCard(store, card.id, { owner: null })}
              >
                No owner
              </Menu.Item>
            )}
            <Menu.Item
              className={cn(item, 'text-text-muted')}
              onClick={() => setEditingId(card.id)}
            >
              Someone else…
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
