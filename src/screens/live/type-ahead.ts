// N, A or D opens a box to write a card in, and people start typing at once.
// The box takes a moment to exist (a topic may have to be made and laid out
// first), and whatever is typed in that moment used to go to the map: the
// first letters were lost, and an "n" among them opened another box. So from
// the key until the box is ready, the keys are kept here, and the box takes
// them when it has the focus.

/** If no box ever claims them, the keys are let go after this long. */
const GIVE_UP_MS = 2_000

let held: string | null = null
let timer: ReturnType<typeof setTimeout> | undefined

function onKeyDown(event: KeyboardEvent) {
  if (held === null) return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key.length === 1) held += event.key
  else if (event.key === 'Backspace') held = held.slice(0, -1)
  else if (event.key === 'Escape') stop()
  else return
  // Kept: it must not reach the map, or type itself anywhere else.
  event.preventDefault()
  event.stopImmediatePropagation()
}

function stop() {
  held = null
  clearTimeout(timer)
  window.removeEventListener('keydown', onKeyDown, true)
}

/** Start keeping what is typed, for the box that is about to open. */
export function holdTyping(): void {
  stop()
  held = ''
  window.addEventListener('keydown', onKeyDown, true)
  timer = setTimeout(stop, GIVE_UP_MS)
}

/** The box is ready: hand over what was typed meanwhile, and stop keeping. */
export function claimTyping(take: (typed: string) => void): void {
  const typed = held
  stop()
  if (typed) take(typed)
}
