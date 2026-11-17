# Scribe — Product Requirements (v1)

Working name: Scribe. Platform: Windows 10/11 x64 desktop app plus a phone web page. Status: build from this document; the product spec in Claude is the narrative version, this is the contract.

## 1. One line
A secretary that sits in the room: it keeps the notes as a live map you can see, takes instructions by voice while the meeting runs, pins what drifts off-topic, and confirms who owes what before anything is sent.

## 2. Problem
AI meeting notes are long, flat and unread. People jump topics, action items get lost, and the summary arrives after the moment to fix it has passed. Call bots cannot see a room. Nobody combines in-person capture, a live visible structure, mid-meeting voice control and confirmed dispatch.

## 3. Users and first use cases
| Use case | Room | Must do | Done means |
| --- | --- | --- | --- |
| Custore weekly team meeting | 4–6 people in person | Agenda map, Pins, actions with owners, phones as mics | Every action leaves the room with an owner and date, and gets done |
| BNI one-to-one / FA client meeting | 2 people, laptop only | Local-only mode, fast summary, follow-up draft | Follow-up sent within 10 minutes |
| Solo dictation | One person drafting | Map becomes an outline; spoken replies; export to Markdown | Fewer rewrites than typing |

## 4. Principles (non-negotiable)
1. The map only grows during a meeting. Moves, merges, deletes are suggestions until confirmed. Everything is undoable.
2. Nothing is sent to anyone without confirmation on the end screen.
3. Recording indicator always visible; pause is one click from any screen including phones.
4. Local by default. Audio never leaves the PC unless the user turns the cloud switch on.
5. Silent in group mode: the scribe answers on screen and never interrupts a speaker. Spoken replies are opt-in and default on only in solo mode.
6. The laptop always records. Phones are an upgrade, never a requirement.

## 5. Functional requirements

Format: ID, requirement, acceptance criteria (testable). Priority: P0 = v1 blocker, P1 = v1 if time, P2 = v1.1.

### F1 Meeting lifecycle (P0)
- F1.1 Create a meeting with a title and an agenda of 0–8 headers, typed or spoken. AC: headers appear as map columns before recording starts.
- F1.2 Start, pause, resume, stop recording. AC: state changes within 300 ms; indicator reflects state; pause stops all capture including phones.
- F1.3 Meetings list with search by title, date, participant and transcript text. AC: FTS query over 50 meetings returns in < 200 ms.
- F1.4 Crash safety. AC: audio is written to disk in ≤ 10 s chunks; after a forced kill mid-meeting, reopening recovers transcript and audio up to the last chunk.

### F2 Capture (P0)
- F2.1 Capture the selected microphone. AC: device list, default device, hot-swap on unplug without crash.
- F2.2 Capture system audio (loopback) at the same time, for online calls. AC: both sides of a Zoom call appear in the transcript; echo cancellation prevents the laptop speaker output being transcribed twice.
- F2.3 Voice activity detection splits speech into utterances. AC: silences > 700 ms end an utterance; no utterance longer than 30 s.
- F2.4 Level meter for every source at ≤ 20 Hz. AC: meter moves within 100 ms of speech.

### F3 Transcript (P0)
- F3.1 Local transcription with Parakeet-TDT 0.6B v3 via sherpa-onnx; Whisper large-v3-turbo selectable for multilingual. AC: a finished utterance's text appears ≤ 2 s after it ends on the reference PC (Ryzen 5 2600 + RTX 3070) and ≤ 4 s on a 4-core laptop CPU.
- F3.2 Cloud transcription switch (Speechmatics real-time). AC: switching requires an explicit toggle plus a confirmation sentence stating audio will leave the PC; the status strip shows "cloud" while on.
- F3.3 Segments carry start/end time, speaker label (or "Speaker N"), source (laptop/system/phone id), confidence. AC: every segment links to its audio span; clicking it plays that span.
- F3.4 Model download during onboarding with progress and resume. AC: a cancelled download resumes; a corrupt file is re-downloaded; the app runs without a model (transcript off) and says so.
- F3.5 Transcript panel is searchable and scrolls with live text unless the user scrolls up. AC: "jump to live" button appears when detached.

### F4 Live map (P0)
- F4.1 Map data model: headers → topics → cards. Card kinds: note, decision, action (owner, due), research, quote. See ARCHITECTURE §Data model.
- F4.2 Structurer runs when (silence ≥ 2 s and ≥ 25 new words) or (45 s elapsed and ≥ 25 new words), both measured on the meeting clock; one run in flight; latest queued. AC: on the replay fixture at 10× speed, no run is skipped and runs do not overlap.
- F4.3 Structurer output is additive: add_card, add_topic, suggest_move, suggest_merge, suggest_pin. AC: the engine rejects any op that deletes or renames; such ops are logged and dropped.
- F4.4 New cards appear at the end of their topic with a 150 ms fade; the viewport does not jump. AC: Playwright test asserts the viewport transform is unchanged after 20 inserts.
- F4.5 Suggested moves render as dashed ghosts with Accept / Dismiss. AC: nothing moves until Accept; Dismiss removes the ghost and records the dismissal so the same suggestion is not repeated within the meeting.
- F4.6 Manual edits: drag a card to another topic, re-parent a topic, rename, change kind, set owner/due, delete (with undo). AC: all persist within 100 ms; Ctrl+Z reverts the last 50 operations.
- F4.7 Auto-layout with dagre keeps columns per header; manual drags are preserved on re-layout. AC: a dragged node keeps its position until the user runs "tidy".
- F4.8 Golden replay test passes (TEST_PLAN §Golden). AC: ≥ 80% of expected cards matched by kind + owner + segment overlap; 0 wrong owners; both off-agenda pin suggestions raised in the expected windows.

### F5 Pins (P0)
- F5.1 Off-topic detection: when new text does not fit any header or existing topic, the structurer creates an off-agenda topic and returns suggest_pin with a proposed title. There is no waiting period; it is a suggestion, and nothing is pinned until someone confirms. AC: fixture raises aircon and pop-up suggestions in their windows.
- F5.2 Pin card appears in the map header area and in the Pins rail: "New topic: X. Pin it?" with Pin / Keep here. AC: no sound; no modal.
- F5.3 Voice: "pin it", "pin this", "put a pin in it" pins the current topic. AC: works via hotkey and wake word.
- F5.4 Pins rail: list with time pinned, gist, Revisit now, Schedule. AC: Revisit makes it the active topic and marks the time; Schedule produces an .ics draft on the end screen (Google Calendar OAuth is P2).

### F6 Scribe (voice control) (P0)
- F6.1 Hold-to-talk hotkey (default Ctrl+Shift+Space, configurable; must not clash with Handy's Ctrl+Space). AC: audio captured from key-down to key-up; transcribed via the same engine; the utterance is not added to the meeting transcript.
- F6.2 Wake word "Hey Scribe" via sherpa-onnx keyword spotting with a 10 s listening window and a soft chime. AC: ≤ 1 false trigger per hour on the fixture audio replayed through speakers; P1 if training the keyword proves slow — ship hotkey-only first.
- F6.3 Intent classes: move_card, set_kind, assign_action, pin_topic, revisit_topic, schedule, summary_style, question, research, note. AC: 20 scripted commands (TEST_PLAN §Scribe script) execute correctly ≥ 18/20.
- F6.4 Questions are answered immediately, typed or spoken, in this order: from the map and transcript (with timestamps that link to the moment), then from the model's own knowledge, and the answer says which. If the question needs current facts (prices, rules, news, "is that still true"), the scribe answers what it can and offers "Research this" in one tap. AC: "what did we decide on CLA" returns the decision cards and their times; "what's the GST rate" returns a direct answer marked "from the model, not verified" with a Research button.
- F6.5 Replies render in the scribe panel; spoken replies (Kokoro TTS) are a toggle, default on in solo mode, off in group mode. AC: while the scribe speaks, its output is not transcribed (mic gated or AEC).
- F6.6 Destructive or outbound intents (send, delete, merge) ask for confirmation. AC: a card is never deleted by voice without a confirm.

### F7 Research spin-off (P1)
- F7.1 Trigger: the user says or types "research X", "check that", "look up", "verify", "find out", or taps Research on a card or on a scribe answer. The classifier may also route a question to research when it clearly needs the web. AC: all three entry points start the same job.
- F7.2 The job runs in the background: web search (Brave Search API by default; Tavily as an alternative provider behind the same interface), fetch and read the top 3–5 pages, LLM writes a 3–6 sentence answer with numbered sources. The meeting continues; transcription is never blocked. AC: a job finishes in under 30 s with a cloud LLM; a failed search produces a card that says so rather than nothing.
- F7.3 Ping-back: when done, a research card appears under the topic the request came from (or the active topic) with a "new" badge, a "done" line appears in the scribe panel with the time, and in speaking mode the scribe says "research on X is ready" once. Never a modal, never a sound in silent mode. AC: badge clears on open; the card's sources open in the browser.
- F7.4 Click any card → "Research this". AC: same pipeline, the card's text is the query.

### F8 Timeline (P0)
- F8.1 Waveform of the whole meeting with playhead; click to seek; space to play/pause; `[` and `]` seek ±10 s. AC: seek latency < 200 ms.
- F8.2 Highlights: drag on the waveform to mark a region; name it; regions become quote cards. AC: regions persist and show in the summary.
- F8.3 Clicking a card seeks to its first segment. AC: < 200 ms.
- F8.4 Speaker bands on the waveform when speakers are known. AC: colours match the participants list.

### F9 Phones as mics (P0)
- F9.1 Host shows a QR code (and short URL) for the join page. AC: QR encodes the meeting join URL with a one-time token.
- F9.2 Join page: consent screen → name → mic permission → "You're in". AC: works on iOS Safari 17+ and Android Chrome; keeps the screen awake; shows a persistent warning on iOS that locking the phone drops the mic.
- F9.3 Each phone is a separate audio track into the host. AC: 4 phones + laptop in one room; per-track level meters on the host.
- F9.4 Winning-mic arbitration: per utterance, the dominant track (audio-level based, dominant-speaker algorithm) is transcribed and labelled with that phone's name; the laptop is the fallback. AC: on a scripted 4-person read-through, ≥ 95% of utterances labelled with the right name; no duplicate transcripts of the same utterance.
- F9.5 Phone page shows the live map (read-only) and a private notes box tied to the current topic and timestamp. AC: notes sync to the host within 1 s and are visible only to their author unless shared.
- F9.6 Pause from any phone pauses the meeting. AC: F1.2.

### F10 End screen and dispatch (P0)
- F10.1 On stop, the end screen lists decisions, actions (owner, due), pinned topics, quotes. Each item editable. AC: an unchecked item is excluded from the summary.
- F10.2 Summary generator takes a layout instruction (typed or spoken: "decisions and actions only, one page") and produces Markdown. Presets: Decisions & actions, Full minutes, One-pager. AC: regenerate in < 15 s with cloud LLM, < 60 s local.
- F10.3 Per-person drafts: for each owner, a message with their actions and due dates plus the summary link/attachment. AC: drafts are editable; nothing sends until the host taps Send for that person; "Send all" needs a second confirmation.
- F10.4 Channels v1: Telegram bot (participant pairs once via /start deep link from the phone page), email via SMTP settings, .ics file for pinned-topic follow-ups. P2: Slack, Google Calendar OAuth, WhatsApp Business templates.
- F10.5 Export: Markdown summary, full transcript (txt/srt), JSON of the map. AC: files open correctly; no audio in exports unless chosen.

### F11 Consent, privacy, retention (P0)
- F11.1 Join notice: before recording starts the host sees a one-line consent reminder; the phone page requires consent before mic access; consent events are logged (who, when, how). AC: consent_log rows exist for every phone participant.
- F11.2 Data lives in the app data folder (SQLite + audio). Retention setting: keep audio forever / 90 days / 30 days / delete after summary. AC: a daily job deletes expired audio and records it.
- F11.3 No analytics, no telemetry, no training on user data. AC: network inspector during a local-mode meeting shows zero outbound calls except the relay when phones are joined.
- F11.4 Cloud switch confirmation names the vendor and what leaves the PC. AC: copy reviewed in UI_SPEC §Settings.

### F12 Settings and onboarding (P0)
- F12.1 First run: choose mic, download model, set hotkey, optional LLM key, optional Telegram bot token. AC: completable in under 5 minutes on the reference PC.
- F12.2 LLM provider: Ollama (local, default if detected), Anthropic API key, OpenAI-compatible endpoint. Any provider that is not on this PC counts as cloud: choosing it needs a confirmation that names the vendor and says transcript text will leave the PC, and the status strip shows "cloud" while it is in use. AC: a "test" button proves the provider works before saving; a non-local provider cannot be saved without the confirmation.
- F12.3 Minimum spec check: 4 cores, 8 GB RAM, AVX2; show a warning otherwise.

### F13 Solo mode (P1)
- F13.1 One-person meeting with no headers: the structurer builds topics freely; spoken replies default on; export to Markdown outline. AC: a 10-minute monologue produces an outline with ≥ 3 topics.

## 6. Non-functional
- Latency: hotkey response ≤ 300 ms; transcript segment ≤ 2 s after utterance end (reference PC); map update ≤ 5 s after a structurer trigger with cloud LLM, ≤ 20 s local; UI frame budget 16 ms with 500 cards on the map.
- Reliability: 3-hour meeting without drop or memory growth > 300 MB; recovers from forced kill (F1.4).
- Footprint: idle CPU < 5%; RAM < 1.5 GB with Parakeet loaded; installer < 150 MB without models.
- Compatibility: Windows 10 21H2+ and 11, x64; WebView2 bootstrapper embedded in the installer.
- Accessibility: keyboard reachable controls; focus rings; contrast AA in light and dark.
- Security: API keys in tauri-plugin-store for v1 (OS keychain in v1.1); the join token is single-use per phone and expires with the meeting.

## 7. Out of scope for v1
Call bots; Mac; voiceprint enrolment (v1.1); per-person analytics; shared editing of the map from phones; WhatsApp; Slack and Google OAuth; mobile app; multi-user accounts and billing.

## 8. Dogfood success metrics (two weeks, Custore + BNI)
- 100% of team meetings run with Scribe without being reminded.
- ≥ 90% of action items leave the room with an owner and a date.
- Host edits ≤ 3 cards per meeting before confirming the summary.
- Summary read rate: every recipient opens it (Telegram read receipts or ask).
- Zero incidents of audio or text leaving the PC in local mode (network log check).
