# Scribe — Proposals for flow and features (2026-11-19)

Written after building M2 and the screens around it, from using the app end to end on the test meeting. Nothing here is built unless it says so. Each item says what it is, why, and roughly what it costs. Matt picks; what is picked moves into BUILD_PLAN.

The test for every item: does it get an action out of the room with an owner and a date, and done by the next meeting? That is the product (PRD §3). Anything that does not help that, or help the host keep their eyes on the people, is lower.

## 1. The flow today, and where it catches

1. **Home → New meeting → title, agenda, people → Start.** Fine the first time. For the weekly meeting the host types the same title, three headers and four names every week.
2. **Live.** Cards arrive by themselves. The host can now fix a card in place, add one, search (`Ctrl+K`). If the local model is not running the map stays empty; the screen now says so, and it did not before today.
3. **Stop → end screen.** Lists, ticks, owners, dates, a summary, a draft per person. Built today. Nothing is sent; drafts are copied by hand.
4. **Afterwards.** Home shows the meeting's decisions and actions. Then nothing: an action is never seen again unless someone opens that meeting. This is the biggest hole. The PRD's "done means" for the team meeting is that actions get done, and nothing in the app follows one past the end screen.

## 2. Recommended, in this order

### A. Actions that carry over (the follow-through loop)
- **What.** An action can be ticked done. Home gets an "Open actions" view: every action not yet done, across meetings, grouped by person, oldest first, each with its meeting and time link. Starting a meeting with the same title as an earlier one shows "From last time" in the Pins rail: its open actions and its pinned topics, each with `Done`, `Still open`, `Add to agenda`.
- **Why.** It closes the loop the product exists for. It also makes the first two minutes of the weekly meeting write themselves: read out last week's open actions.
- **Cost.** One column on cards (`done_at`), one query, one Home view, one rail section. About two sessions. No model, no audio.

### B. Start again
- **What.** On a past meeting in Home: `New meeting like this`. It opens the Pre-meeting sheet with that title, agenda and people filled in. Home also gets `Start now`: one click, no sheet, titled with the date, for a one-to-one that was not planned.
- **Why.** The weekly meeting should take one click and a glance to start, not twenty seconds of typing while the room waits.
- **Cost.** Half a session. Screens only.

### C. Read-back before people leave
- **What.** On the end screen, `Read back`: the ticked actions in large type, one person at a time, with owner and date, and `Next`. The host reads it to the room; anyone can object while they are still there. A wrong owner is fixed with one click on a name.
- **Why.** PRD §2: the summary arrives after the moment to fix it has passed. This is that moment, and it takes thirty seconds. It is also the first thing a new team sees the product do for them.
- **Cost.** Half a session. It reads the same data as the drafts.

### D. One key to keep a moment
- **What.** `M` (and a `Mark` button on the timeline) keeps the last 20 seconds as a highlight, at once, with no naming step; the name can be typed afterwards. Today a highlight is a drag on the waveform or `H` twice, both of which need the host to know in advance that something worth keeping is about to be said.
- **Why.** People notice a good line after it is said.
- **Cost.** An hour or two. Uses the highlight code that exists.

### E. Type a card without leaving the keyboard
- **What.** `N` note, `A` action, `D` decision: opens the new-card editor (built today) on the active topic with that kind chosen. In the editor, typing `@` offers the people in the meeting as owner.
- **Why.** The model misses things. The host adding one line should cost three seconds and no mouse.
- **Cost.** Two hours.

### F. An owner in one click on the map
- **What.** An action with no owner shows a dashed `?` chip. Clicking it lists the people in the meeting; one click assigns. The same list appears on a click of an existing chip.
- **Why.** "Who owes it" is the most common fix, and today it is pencil → field → type → save.
- **Cost.** Two hours.

### G. Rename and delete a meeting
- **What.** From Home: rename a meeting; delete one, with its audio, after a confirmation that names what goes.
- **Why.** Test meetings pile up (there are two on this PC now), and a meeting started with the wrong title keeps it for ever. Also a privacy matter: a person asks for a recording to be removed.
- **Cost.** Half a session; one new command in the core. Deletion is permanent, so it gets the confirmation.

### H. First-run check
- **What.** One screen before the first meeting: microphone (with a moving level meter), speech model (download), the model that writes the map (is Ollama running, is `qwen3.5:4b` pulled, with the one command to fix each), and a ten-second "say something" test that shows the words appear.
- **Why.** Each of the three can be silently missing today, and each shows up as a different empty panel mid-meeting.
- **Cost.** One session. PRD F12.1 asks for it anyway.

## 3. Smaller things, cheap, worth doing with the above
- **Save the summary as a file** (`.md`), next to Copy. Needs the save dialog; an hour.
- **"+" on the agenda chips** to add a header mid-meeting (in UI_SPEC §2.1, not built).
- **Remove a highlight** from the timeline (the code path exists, there is no control).
- **Theme switch in Settings** (light, dark, as Windows). Both themes are complete; only the OS setting chooses today.
- **A due date that is a date.** "Friday" is kept as text. Showing "Fri 21 Nov" next to it, worked out from the meeting's day, would let Open actions sort by date and show what is late. Text stays the truth; the date is a reading of it.
- **Speaker name on a transcript line**: click `Room` on a line to say who it was; later lines stay `Room`. Useful only until phones do it properly (M4), so low.

## 4. Looks
- The live screen is dense and quiet, as the spec asks. Two things read as unfinished: the `silent | speaking` control in the status strip does nothing until the scribe exists (M3), and the React Flow credit sits in the map's top-right corner. I would hide the first until M3. The second I would leave until someone has read React Flow's terms: the library is MIT, and its makers ask projects that do not subscribe to keep the credit on the canvas, so moving it to Settings → About is a question for them, not a styling choice.
- The end screen's action rows are the tallest thing in the app. If eleven actions is a normal meeting, a compact mode (one line each: tick, text, owner, date) would fit them on one screen.
- Home's right side is plain. Once A is built it should lead with what is open, not with the last meeting.

## 5. Not recommended now
- **Drag to reorder agenda columns, colour themes, custom card kinds.** Decoration; none of them moves an action.
- **Automatic sending.** The principle is that nothing is sent without confirmation, and copy-paste proves the drafts are right before any channel is wired (M5).
- **Anything that listens differently** (voice commands, wake word, phones, echo and cut-off tuning) until the real meeting of 2026-11-20 says how capture behaves in a room.
