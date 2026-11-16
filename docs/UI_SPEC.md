# Scribe — UI Spec (v1)

Dense desktop tool. The host glances at it between looking at people; nothing on screen may demand attention it has not earned. Everything here is implementable with shadcn/ui (Base UI), Tailwind v4, React Flow, dnd-kit and wavesurfer.js. Claude Code: follow this literally; where it is silent, choose the quieter option.

## 1. Design tokens

Define as CSS variables in `src/styles/tokens.css`, light and dark via `[data-theme]` and `prefers-color-scheme`.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| --bg | #FAFAF9 | #141416 | window background |
| --surface | #FFFFFF | #1C1C1F | panels, cards |
| --surface-2 | #F3F3F1 | #232327 | hover, inset areas, timeline track |
| --border | #E4E4E1 | #2C2C31 | all 1 px borders |
| --text | #1A1A1A | #ECECEA | body |
| --text-muted | #6B6B68 | #9A9A96 | meta, timestamps |
| --accent | #2D5BFF | #6B8CFF | selection, primary buttons, decision cards |
| --accent-soft | #E8EDFF | #1E2A4A | accent backgrounds |
| --record | #DC2626 | #EF4444 | recording indicator only |
| --action | #B45309 | #F59E0B | action-item owner chip |
| --research | #0F766E | #2DD4BF | research card badge |
| --quote | #FDE68A | #78350F | highlight regions, quote cards |
| --pin | #6B6B68 | #9A9A96 | pinned topic dashed outline |

Type: `Inter` for UI, `JetBrains Mono` for timestamps, ids and transcripts' time column. Sizes: 18 page title, 15 section/header, 13 body, 12 secondary, 11 meta. Weights 400/600 only. Line height 1.4.
Spacing on a 4 px grid: 4, 8, 12, 16, 24, 32. Radius 6 px. Borders 1 px. No shadows, no gradients, no blur. Focus ring: 2 px accent, 2 px offset. Motion: 150 ms ease-out fades and opacity only; no slides, no bounces; respect `prefers-reduced-motion`.

## 2. Window layout (Live meeting screen)

Minimum window 1280 × 800. Panels resizable; sizes remembered.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● REC 00:23:41 │ CLA quote · Supplier delays · Designer hire │ 👤4 ▂▅▃▁ │ silent │ local ▾ │  ← Status strip, 48 px
├───────────────────────────────────────────────────────┬──────────────────────┤
│                                                       │ PINS           (2)   │
│   CLA quote        Supplier delays     Designer hire  │ ┌──────────────────┐ │
│   ┌───────────┐    ┌───────────┐       ┌───────────┐  │ │ Office aircon    │ │
│   │ Pricing   │    │ Guangzhou │       │ FT junior │  │ │ 00:03:16 · 3 cards│ │
│   │ ─────────  │    │ lead times│       │ vs freelance│ │ │ Revisit  Schedule│ │
│   │ ◆ decision │    │ ▪ note    │       │ ◆ decision │  │ └──────────────────┘ │
│   │ ▪ note     │    │ ▪ note    │       │ ▶ action   │  │ ┌──────────────────┐ │
│   │ ▶ action   │    │ ▶ action  │       │ ▶ action   │  │ │ Christmas pop-up │ │
│   └───────────┘    └───────────┘       └───────────┘  │ └──────────────────┘ │
│   ┌───────────┐    ┌ ─ ─ ─ ─ ─ ┐                      ├──────────────────────┤
│   │ Artwork   │    ┆ suggested ┆  ← ghost move        │ SCRIBE               │
│   │ ▪ note    │    ┆ Accept ✕  ┆                      │ You: "what did we    │
│   │ ▶ action  │    └ ─ ─ ─ ─ ─ ┘                      │  decide on CLA?"     │
│   └───────────┘                                       │ Scribe: 42/set, 40 w/ │
│                                      [minimap]        │  2nd batch · 00:01:06 │
│                                                       │ ⟲ researching MAS…   │
│                                                       │ [hold Ctrl+Shift+Spc]│
├───────────────────────────────────────────────────────┴──────────────────────┤
│ ▶ ‖  ◀10 10▶   ▁▂▃▅▆▅▃▂▁▂▃▅▇▅▃▁▂▃▅▃▂▁▂▃▅▆▅▃▂▁   ▌quote▐        00:23:41 / live │  ← Timeline, 120 px
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Status strip (48 px, top)
Left to right: recording indicator (red dot + "REC" + elapsed, mono; grey "PAUSED" when paused; clicking it pauses/resumes with a 300 ms hold-to-confirm when live); agenda chips (click = scroll map to that header; "+" adds a header); participants (count + a 16 px level meter per joined phone; hover shows names); mode toggle `silent | speaking`; privacy pill `local` or `cloud` (cloud is accent-soft with a cloud icon; never hidden); settings gear.

### 2.2 Map (centre, flexible)
React Flow canvas. Header columns are React Flow group nodes laid out left to right by dagre (`rankdir=TB` inside a column, columns ordered by agenda order). Topics are nodes inside their header column; cards are rows inside a topic node (a topic node is a custom node rendering its cards as a list — cards are not separate React Flow nodes; this keeps 500 cards cheap).

Topic node (min 240 px, max 320 px wide):
- Title row: 15/600, kind icon none; card count at right in 11 muted; "⋯" menu (rename, pin, merge into…, tidy, delete with undo).
- Card rows: 13 body, 11 meta line (time · owner); left 3 px kind bar: note = border colour, decision = accent, action = action colour, research = research colour, quote = quote colour. Action rows show an owner chip (initials, action colour outline) and due text.
- New card: fade in 150 ms at the end of the list; the viewport never auto-pans (a "new cards ↓" pill appears bottom-right if they are offscreen).
- Ghost (suggested move/merge/pin): dashed 1 px pin colour outline, 60% opacity, with `Accept` (accent text button) and `✕`. Ghosts stack at most 3 per topic; older ones collapse into "+2 suggestions".
- Drag: dnd-kit for card rows within/between topics; React Flow drag for topic nodes. Dropping a card on another topic moves it (confirmed by the act); dropping a topic on a header re-parents.
- Zoom: 0.4–1.5. Below 0.7, cards collapse to kind icons with counts; titles stay. Minimap bottom-right, 160 × 100.
- Controls: `tidy` (re-run dagre), `fit`, zoom ±. Keyboard: `F` fit, `T` tidy.
- Off-agenda suggestion: appears as a ghost topic in a dashed "Unplanned" column at the far right: "New topic: Office aircon — Pin it?" with `Pin` and `Keep here`. Pin moves it to the rail and leaves a small pin marker in the column.

### 2.3 Pins rail (right top, 320 px wide, max 40% height, scroll)
Header "PINS (n)". Each pin: title (13/600), "pinned at 00:03:16 · 3 cards" (11 mono), buttons `Revisit now` (sets as active topic; shows in map with accent outline) and `Schedule` (adds to end-screen schedule list). Empty state: "Nothing pinned. Say "pin it" or tap Pin on an off-topic card."

### 2.4 Scribe panel (right bottom, remaining height)
Conversation list, newest at bottom. Entries: `You:` (hold-to-talk transcript, mono 12) · `Scribe:` (13, answers include time links as `00:01:06` chips that seek) · job rows (`⟲ researching …` with a spinner, becomes `✓ done` with a `View` link that scrolls the map to the card). Bottom: a one-line text input (type instead of talk) and a hint "hold Ctrl+Shift+Space to talk". While the hotkey is held: a 24 px live level bar replaces the hint and the panel border turns accent. Speaking mode on: a speaker icon in the panel header; a stop button appears while TTS plays.

### 2.5 Timeline (bottom, 120 px)
wavesurfer.js: track in --surface-2, wave in --text-muted, progress in --accent. Regions plugin for highlights in --quote at 40% opacity with a label. Speaker bands: 4 px strips under the wave per known speaker in categorical colours (participants list order). Transport: play/pause, ◀10, 10▶; time readout mono right "00:23:41 / live". Keyboard when the timeline or map has focus: `Space` play/pause, `[` `]` ±10 s, `H` start/stop a highlight at the playhead. Clicking a card seeks; the card gets a 1 px accent outline while its span plays.

## 3. Other screens

### 3.1 Home
Left: "New meeting" (primary), meetings list (title, date, duration, participants, 3 chips of top topics), search box (title/participants/transcript). Right: the selected meeting's summary preview. Empty state: one sentence and the New meeting button. Error state (no model installed): banner with "Download model".

### 3.2 Pre-meeting (sheet over Home)
Title; agenda editor (chips, add by typing or "🎤 say the agenda"); participants (expected names, optional); mode (group/solo); privacy pill; QR code (240 px) + short URL + "copy"; consent reminder line: "Tell the room you're recording. Phones ask for consent before joining."; `Start recording` (primary, accent) — becomes red on hover to signal it is live.

### 3.3 End screen (full window, replaces live view on Stop)
Three columns: Decisions · Actions (owner chip, due date picker) · Pinned (each with `Schedule` producing an .ics row). Every row has a checkbox (checked = in summary) and inline edit. Below: Quotes (highlights). Right rail: Summary — layout input ("decisions and actions only, one page" / presets dropdown) → `Generate` → Markdown preview (editable). Bottom: Drafts — one card per owner: channel icon (Telegram/email), recipient, editable text, `Send` per card; `Send all` with a confirm dialog listing recipients. `Finish` returns to Home. Nothing sends on Finish.

### 3.4 Meeting review (opening a past meeting)
Same as Live layout but the status strip shows "REVIEW" and the timeline plays the recording; map is editable; summary and drafts are reachable via a `Summary` tab.

### 3.5 Settings
Tabs: Audio (devices, loopback on/off, level test) · Speech (model picker with size/language/speed, download status, cloud switch with the exact confirmation copy below) · AI (provider: Ollama/Anthropic/OpenAI-compatible; key; `Test`) · Scribe (hotkey recorder, wake word on/off, spoken replies default, voice) · Sending (Telegram bot token + pairing status; SMTP) · Privacy (retention, data folder, export all, delete all) · About.

Cloud switch confirmation copy (exact): "Turn on cloud transcription? Audio from this meeting will be sent to Speechmatics (real-time, not stored by them) for transcription. Local mode keeps audio on this PC. [Keep local] [Send to cloud]".

### 3.6 Phone join page (`join-page/`, mobile first, 375 px)
1. Consent: meeting title, host name, "This meeting is being recorded and transcribed by the host. Your phone will act as a microphone and show the live notes." `I agree` (primary) / `No thanks` (shows "You can still listen; nothing is recorded from this phone").
2. Name: single field, prefilled from last time (localStorage), `Join`.
3. Live: top bar with your name + mic level + `Pause meeting` (red outline); live map as a simple outline list (headers → topics → cards, read-only, auto-updating); bottom sheet `My notes` (textarea bound to the current topic; "saved" tick). Persistent banner on iOS: "Keep this page open. Locking the phone stops the mic." Wake Lock requested on join.
4. Disconnected state: "Reconnecting…" then "Lost connection — tap to rejoin".

## 4. Interaction rules (enforced in code, tested)
1. Map only grows; ghost until confirmed; `Ctrl+Z` undo 50 deep; `Ctrl+Shift+Z` redo.
2. No auto-pan, no auto-zoom while live. Fit/tidy only on user action.
3. No modal dialogs during a live meeting except the cloud switch and Send all. Everything else is inline or a toast (bottom-left, 4 s, never stacked more than 2).
4. The scribe never plays audio in group mode unless the user toggled speaking; TTS is interruptible by pressing the hotkey.
5. Every card, pin and scribe answer carries a time link; clicking seeks.
6. Keyboard map: `Ctrl+Shift+Space` hold-to-talk · `Space` play/pause · `[` `]` seek · `H` highlight · `P` pin active topic · `F` fit · `T` tidy · `Ctrl+K` command palette (search topics/cards/transcript) · `Esc` cancel ghost/close sheet.
7. Light/dark both complete; no screen may rely on colour alone (icons + text for card kinds).
8. Empty and error states exist for every panel (listed in TEST_PLAN §Screenshots).

## 5. What "looks right" means
- A 60-minute meeting with 3 headers, 10 topics and 60 cards fits on a 1440 px wide screen at zoom 0.8 with titles readable.
- At a glance the host can see: are we on agenda (column), what was decided (accent bars), who owes what (owner chips), what is parked (rail).
- The screen is quiet: no red except the indicator, no accent except selection, decisions and primary buttons.
