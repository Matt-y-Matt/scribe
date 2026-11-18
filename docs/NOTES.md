# Notes

Working notes: what is known, what is not verified, and what is still open. Decisions go in `docs/DECISIONS.md`.

## M0 — Repo, tooling, fixtures (2026-11-17)

### Gate results
- `pnpm check && pnpm test`: green locally (Linux cloud session). 48 TypeScript tests, 3 Rust tests. Windows CI: green from run 3 (see "CI on Windows" below).
- `pnpm replay fixtures/meeting-custore-weekly.jsonl --speed 10`: 46 segments, 381.2 s of meeting in 38.1 s.
- `pnpm screenshot`: writes `home-empty.light.png` and `home-empty.dark.png`; reviewed against UI_SPEC §1, §3.1 and §5.

### CI on Windows
- Run 2 (`7b04e91`): `pnpm check` green, vitest green, then `cargo test` failed at load with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139). Cause: Tauri imports Common Controls v6 functions, and tauri-build links the manifest that requests them into the app binary only (`embed_resource::compile` → bins), so no test binary that links Tauri can start.
- Fix: `src-tauri/build.rs` builds with `WindowsAttributes::new_without_app_manifest()` and has the linker embed `src-tauri/windows-app-manifest.xml` into every artifact (`/MANIFEST:EMBED`). Tauri's own `build.rs` does the same for its tests. CI also builds the app executable and checks it stays up for 8 s.
- Run 3 (`4978088`): green on `windows-latest`. `pnpm check`, `pnpm test` (48 TypeScript, 3 Rust) and the start-up smoke test all passed, so the fix holds.
- Stable cargo on CI warns that `tauri-plugin-sql` and `tauri-plugin-global-shortcut` are unused dependencies. Expected until M2 and M3 register them.

### Verified on the reference PC (2026-11-17, Ryzen 5 2600, RTX 3070, Windows 10)
- `pnpm install`, `pnpm check`, `pnpm test` and `pnpm tauri dev` all passed. The Scribe window opens on Home.
- The window stops shrinking at the 1280 × 800 minimum, and the app follows the Windows dark-mode setting.
- `pnpm install` failed once while pnpm switched itself to the pinned 10.28.0; a retry worked with no changes.
- Commands must be run from `C:\dev\scribe`. From any other folder pnpm reports `Command "tauri" not found`.

### Not verified
- Settings persistence through `tauri-plugin-store` (`src/lib/settings.ts`) is unit-tested with a mock only. Nothing in the UI writes a setting yet, so no store file exists on the PC.

### First run on the Windows PC
1. `pnpm install`
2. `pnpm exec playwright install chromium` (once; `@playwright/test` is pinned to 1.63.0)
3. `pnpm check && pnpm test`, then `pnpm tauri dev`

### Things M0 left deliberately unfinished
- The **New meeting** button does nothing: the Pre-meeting sheet it opens belongs to no milestone yet (L3 below).
- There is no theme control in the UI. The app follows the OS until Settings exists; `setThemePreference()` in `src/lib/theme.ts` is ready for it.
- The app icons are the template's placeholders (`src-tauri/icons/`).
- `tauri-plugin-sql` and `tauri-plugin-global-shortcut` are dependencies but not registered; M2 and M3 wire them.
- No `playwright.config.ts` yet: M0 has screenshots but no Playwright tests. M1 adds both.

### For the next session
- **shadcn registry is unreachable from the cloud environment** (`ui.shadcn.com` is not on its network allowlist). M1 needs several components. Either allow that host for the environment, or run `pnpm dlx shadcn@latest add <component>` on the PC. `components.json` is already in place.
- eslint is on 9.x, as the template pinned it; npm now marks 9.x unsupported. Moving to 10 needs the React plugins checked first.
- Local `cargo clippy` / `cargo test` on Linux need `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev`. They are not part of the Windows build.
- The replay sink only receives `segment:final`. With finals alone the engine cannot tell a long utterance in progress from silence, so the "silence ≥ 2 s" trigger needs either the utterance start time or a VAD event (see G3).

## M1 — Map engine on replay (2026-11-17)

Built on the reference PC, in the order of the approved plan below, one commit per step.

### Gate results
- `pnpm check && pnpm test`: green on the PC. 192 TypeScript tests, 3 Rust tests.
- `pnpm e2e`: 13 Playwright tests green (Chromium, 1280 × 800).
- Windows CI: green on run 7 (`3234134`, the nine M1 commits, first run with the Playwright step) and run 8 (`f5c59d8`, the local-model work).
- **Golden replay, MockProvider** (`pnpm golden --provider mock`, and `src/engine/golden/golden.test.ts` in CI): **PASS**. Topic coverage 5/5 (CLA 14/15, suppliers 6/6, designer 6/6, aircon 3/3, pop-up 1/1). Card match 17/17 (100%). Wrong owners 0. Both pins suggested and pinned at the end. Never rules: 0 violated. 8 runs, none skipped, none overlapping. The mock's ops are written by hand against the transcript, so this score checks the engine and the scoring, not a model.
- **Golden replay, Ollama `qwen3.5:4b`** (`pnpm golden --provider ollama`, local, Ollama 0.40.16 on the RTX 3070, reasoning off): **PASS at 10×, four runs out of four.** Topic coverage 5/5 (CLA 12–13/15, suppliers 6/6, designer 6/6, aircon 3/3, pop-up 1/1). Card match 15/17 (88%). Wrong owners 0. Both pins suggested and pinned at the end. Never rules: 0 violated. No op dropped, no run failed; a run takes 2 to 6 s. The two cards it misses are the 3.50-a-name decision (it writes a note) and Matt's "message the landlord" action (it cites `s045`, not `s046`).
- **The same model, paced** (`--paced`: each run gets exactly one trigger's batch, as in a live meeting): **PASS, two runs out of two (2026-11-18).** Topic coverage 5/5 (CLA 12/15), card match 15/17 (88%), wrong owners 0, both pins, never rules 0; 8 runs, none failed. Until 2026-11-18 this failed on one wrong owner: "Matt: send the drafted options to UDO" on `s027`, where Matt says "draft the two options for UDO and I'll send it". The model was reading the transcript correctly and the answer key had only Zach's action there. Matt accepted the card, and the key now lists it under `also_accepted`: allowed, not required, so the card-match count is still out of 17 (DECISIONS, 2026-11-18). At 10× the batches fall differently and the model does not write that card.
- Which two cards the local model misses varies from run to run. Matt's "message the landlord" action is missed every time; the other is the 3.50-a-name decision or, once at 10× on 2026-11-18, Ant's "vector logo and mockups" action.
- **Anthropic Haiku: not run.** No key was set, by choice: the local model is the default and meets the gate. `pnpm golden --provider anthropic` is ready for the day it is wanted.
- Viewport: the transform is unchanged after 20 card inserts (Playwright), and after a card drag.
- `pnpm screenshot`: `live`, `live-ghost`, `live-unplanned`, `live-zoomed-out` in light and dark, reviewed against UI_SPEC §2 and §5.

### Not verified
- The Anthropic provider has not made a real call (see above). Neither has Ollama's `ops` protocol on a model large enough to follow it.
- The golden pass on the local model rests on one fixture, and its prompt's three examples come from that fixture (BUILD_PLAN asks for that). It says the engine and the model can do this meeting, not any meeting.
- The live screen has been opened in Chromium (Playwright) only, not inside the Tauri window. `pnpm tauri dev` still opens on Home, and nothing in the app navigates to the live screen yet.
- `structurer.worker.ts` has never run as a real Web Worker. Both ends of its protocol are tested through an in-memory port.

### Built differently from the spec, for Matt to confirm
- **A topic that grows pushes the topics below it down.** TEST_PLAN §2 says no topic node changes position unless the user drags or presses `T`. With topics stacked in a column and cards arriving, the only way to keep that literally is to let topics overlap. What is guaranteed and tested: the viewport never moves, a grown topic moves only the topics under it in the same column and by exactly its growth, and a dragged topic stays put until tidy (DECISIONS, 2026-11-17).
- `Esc` dismisses a ghost only while that ghost has focus. There is no global "cancel ghost" key, because a dismissal is remembered for the rest of the meeting.

### Things M1 left unfinished
- No UI to edit a card (change kind, owner, due text) or delete one. The engine has `editCard` and `deleteCard`, both undoable; PRD F4.6 needs the controls.
- A click on a card does nothing yet. It seeks the timeline in M2.
- The fixture transcript and the mock ops are bundled into the app, because the `?screen=` states are part of the app build. `vite build` warns that the main chunk is over 500 kB.
- A few "ResizeObserver loop completed with undelivered notifications" errors still reach the dev console when a column re-lays itself out. They are harmless; the Playwright tests ignore that one message.
- The right-hand column below the Pins rail is empty until the scribe panel (M3).

### What it took to get a 4B local model through (2026-11-17)
- First run: every call failed with no output. Ollama loads a model with a 4,096-token context unless told otherwise, and its OpenAI-compatible endpoint cannot be told. The provider now uses Ollama's native `/api/chat` with `num_ctx` 16,384.
- With the full op protocol the model scored 24% to 71%. Its content was right; it lost cards by leaving out the topic, inventing topic ids, and mixing up header ids that differ in one character. Three changes fixed that: the model sees short aliases (`H1`, `T3`) instead of ULIDs; a topic may be named by title; and a local model gets the card protocol (`src/engine/providers/cards.ts`, prompt `structurer-cards.md`), in which it goes through the new segments one by one, says whether each is new, a recap, the agenda or neither, picks the header from a fixed list and names the topic. The engine builds the ops from that. That took it from 71% to 88%.
- Reasoning on (`--think`) is not usable live on this PC: runs took 11 to 178 s and one ran out of context.
- A failed run used to put its segments back out of order, and a failure on the last run of a meeting was never retried. A run is now tried twice, and a batch is always in meeting order.
- `@ai-sdk/openai-compatible` is no longer used by any code. It stays for the OpenAI-compatible provider PRD F12.2 lists.

### For the next session
- Ollama is installed on the PC (winget, per-user) with `qwen3.5:4b` pulled (3.3 GB). `pnpm golden --provider ollama` checks both and says what is missing.
- `pnpm golden --trace <file>` writes each run's input and raw reply as JSON lines; that is how the protocol problems above were found.
- The structurer prompt has three examples taken from the golden fixture itself (BUILD_PLAN asks for that). A second fixture would show whether the prompt generalises.

## M1 — approved plan (2026-11-17)

Approved by Matt. Build on the reference PC in a fresh session, in this order, one commit per step, `pnpm check && pnpm test` before each. Scoring rules are in `docs/TEST_PLAN.md` §2; the answers behind them are in `docs/DECISIONS.md`.

1. **Engine model and op log** — `src/engine/model.ts`, `store.ts`. Types for topics, cards and suggestions; in-memory store with undo/redo 50 deep behind a persistence adapter (SQLite replaces it in M2). Tests first.
2. **Apply rules** — `apply.ts`, `owner.ts`. Validate ops with zod; drop anything that deletes or renames (logged, never applied); drop `add_card` with no `segment_ids`; resolve `tmp_key`; put off-agenda topics under "Unplanned" with a `suggest_pin`; match owners by Jaro-Winkler ≥ 0.8 or leave blank; dedupe by segment coverage. Tests first, including the list in TEST_PLAN §3.
3. **Structurer loop** — `trigger.ts`, `structurer.ts`, `structurer.worker.ts`, `prompts/structurer.md`. Triggers measured on the meeting clock; one run in flight; latest queued. The replay harness (`src/engine/replay/`) feeds it through `SegmentSink`.
4. **MockProvider and golden test** — `fixtures/meeting-custore-weekly.mock-ops.json`, with each canned op keyed by the segments it cites so that batching cannot change the result. Scoring in `src/engine/golden/score.ts`, test in `src/engine/golden/golden.test.ts` (tests sit next to the code; BUILD_PLAN and TEST_PLAN name other paths and should be corrected to this one).
5. **Real provider** — Ollama (OpenAI-compatible) and Anthropic behind one interface on the Vercel AI SDK. `pnpm golden --provider mock|ollama|anthropic` prints the score. Use Ollama if `http://127.0.0.1:11434` answers, otherwise ask Matt for an Anthropic key (Haiku). Only the fixture is ever sent.
6. **Map UI** — `src/screens/live/`. React Flow with header columns as group nodes, topic nodes that render their cards as rows (cards are not React Flow nodes), ghost suggestions with Accept / Dismiss, the Unplanned column, minimap, fit, tidy, zoom collapse below 0.7. dagre layout; a dragged node keeps its place until tidy. No auto-pan, no auto-zoom.
7. **Pins rail** — pin, revisit and schedule actions; the `P` key pins the active topic.
8. **Playwright tests** — `playwright.config.ts`, `e2e/`. Viewport transform unchanged after 20 inserts; ghost accept and dismiss; drag a card between topics; undo. Add them to CI (`pnpm exec playwright install chromium` first).
9. **Screenshots** — add `live`, `live-ghost`, `live-unplanned`, `live-zoomed-out` to `src/screens/screens.ts`; review light and dark against UI_SPEC §2 and §5.

Out of scope for M1: status strip, transcript panel, timeline, scribe panel, SQLite, anything audio. The live screen shows the map and the Pins rail only.

New dependency: `lucide-react` (ISC) for card-kind icons. Build the "⋯" menu on `@base-ui/react`, which is already installed; if a shadcn component is added instead, restyle it to the tokens (CLAUDE.md §Conventions).

Done means the M1 gate in BUILD_PLAN: golden replay ≥ 80% card match, 5/5 topic coverage, 0 wrong owners, both pins, with the mock in CI and with one real provider; the score for each provider recorded in this file; `live.png` and `live-ghost.png` shown to Matt.

## M2 — Live capture and transcript (2026-11-19)

Built on the reference PC in the order of the approved plan below. Everything that could be checked without a person in a room has been; the gate itself (TEST_PLAN §4) needs Matt and is described under "The gate test, for Matt".

### What works, and how it was checked
- **Capture.** The vendored Anarlog crates open the microphone and the WASAPI loopback of this PC, resample to 16 kHz and cancel echo; `capture_probe` showed both delivering audio (31 frames a second, no gaps). Our cutter turns that into utterances: 700 ms of silence ends one, 30 s is the longest, and past 10 s the next 300 ms pause ends it.
- **Speech to text.** Parakeet-TDT 0.6B v3 (int8) through the official `sherpa-onnx` crate, on the CPU. The downloader was run against Hugging Face: a download cut to 300 MB resumed with a range request and passed its SHA-256.
- **The whole pipeline in the real app** (`pnpm tauri dev`, the synthetic meeting playing as the microphone, driven through WebView2's debugging port): New meeting → Pre-meeting sheet → Start recording; transcript lines appear and the local model (`qwen3.5:4b`, through the core's relay) puts cards on the map; hold-to-pause holds, one click resumes; Stop leaves the meeting in review; Home lists it.
- **Forced kill, in the real app.** A meeting was killed with `Stop-Process` 71 s in. On relaunch Home asked "Recover meeting “Bench kill”?"; Recover brought back 71.3 s of audio, the 17 transcript lines from before the kill plus one transcribed from the unheard tail, the 5 cards, and a timeline that plays. The same was done without the window (`soak.exe`): killed at 77 s, 75.1 s of audio and 18 segments recovered, 1 added.
- **Timeline.** In the real app a click on the waveform had the playhead on screen 14 to 61 ms later; the core logged playback starting in 0 to 31 ms. A dragged region asked for a name and became a quote card.
- **Screens.** `pnpm screenshot` writes 12 states in light and dark, among them `live`, `paused`, `nomic-error` and `model-missing`; reviewed against UI_SPEC §2.
- **Tests.** 248 TypeScript tests, 66 Rust tests, 25 Playwright tests. No test needs a sound device or a model. Windows CI is green on run 16 (`037e4de`). Runs 13 to 15 failed in `pnpm test` for a reason in the runner, not the code: its cache restored the folders of the sherpa-onnx download without the libraries in them, and the build script took the folder for a finished download. CI now removes both before building.

### Numbers (reference PC: Ryzen 5 2600, 16 GB, Windows 10; all on synthetic speech)
`scripts/make_test_audio.ps1` reads the golden fixture aloud with Windows' two built-in voices: 7.4 minutes, 46 lines. It is clean, evenly paced American English with no room, so these numbers are a floor for real meetings, not a prediction.

| What | Result |
| --- | --- |
| Parakeet, real-time factor (`scripts/bench_stt.ps1`, idle PC, 352 s of speech in 113 utterances) | 0.21 at 2 threads, 0.16 at 4, 0.16 at 6 |
| Parakeet, time to transcribe one utterance at 6 threads | median 0.42 s, 95th percentile 1.09 s, longest 1.64 s (an 11.8 s utterance) |
| Parakeet, model load and peak memory of the bench | 3.1 s (kept loaded between meetings); 1,016 MB |
| Silero VAD | 3.5 s for 444 s of audio |
| Whisper large-v3-turbo, real-time factor at 6 threads | 2.12: slower than speech. Median 5.9 s an utterance. Not usable live on this CPU |
| Segment on screen after the speech ends, real app, 2.7-minute meeting, one source | median 1.17 s, 95th percentile 2.11 s, worst 4.72 s (the first utterance, which waited for the model to load) |
| **60-minute soak** (`scripts/soak.ps1 -Minutes 60 -Loopback`: both sources fed speech without a break) | 3,600.4 s on the meeting clock, 1,832 segments, 15,332 words; the transcript never more than a few seconds behind the clock; 361 ten-second files per source, 220 MB of audio |
| Soak, memory of the process | 1,316 MB private at minute 5, 1,323 MB at minute 60: 7 MB of growth (working set 1,004–1,113 MB throughout) |
| Soak, segment after the speech ends | median 1.31 s, 95th percentile 2.68 s, worst 9.0 s. Two sources were being recognised at once for the whole hour, and for the first 25 minutes the PC was also compiling and running the test suites |
| Real microphone and loopback, 91 s (`soak.exe --devices`, test speech through the speakers) | 22 segments; median 1.16 s, 95th percentile 1.80 s, worst 1.85 s |
| Seek: click to playhead | 14–61 ms |
| Recovery of a 71 s meeting | under 5 s, most of it loading the model |

The latency is the cutter's 0.7 s of closing silence plus the recognition. The gate's "≤ 2 s" holds at the median in every run and is broken at the tail: a 10 s utterance takes 1.6 to 1.9 s to recognise on this CPU, so it lands at 2.3 to 2.6 s, and with two sources talking at once a line can wait for the other source's recognition to finish. The ways to shorten that are a lower cut-off than 10 s, or a GPU build of sherpa-onnx.

### Not verified
- **A real room.** Nothing here has heard a person. Accuracy on real voices, accents and Singlish, crosstalk, a noisy room, a far microphone: all unknown.
- **Echo from speakers is reduced, not gone.** Two 90-second runs with the test speech through this PC's speakers and its real microphone open; loopback was transcribed as `system` correctly both times. In the first run (before the guard) the canceller let the first 10 seconds through, two lines doubled as `laptop`, then held but for one fragment. An echo guard was then added (`audio/echo.rs`): it drops a microphone utterance whose loudness follows the system audio (correlation ≥ 0.70) or that is 40 dB or more under it, and only while system audio is playing. In the second run it dropped the start-up leak, and six garbled fragments still came through between 35 and 76 s ("Interesting blows.", "And I offer four things."): the canceller did worse in that run, and what it half-removes (19 to 34 dB under the system audio, correlation 0.25 to 0.56) cannot be told from a quiet person talking over the speakers, by loudness pattern or band by band. So TEST_PLAN §4.3's "no doubled text" is not met on speakers. With headphones there is nothing to cancel. `stats.json` counts what the guard dropped (`echoes_dropped`). Whether this matters in practice, and whether the larger AEC models Anarlog ships (256 and 512, 57 MB, not vendored) do better, is for a real call.
- **The no-microphone path on real hardware.** The error is covered by tests with a stand-in source; nobody has unplugged a real microphone, before or during a meeting.
- **A release build.** Everything ran as `pnpm tauri dev`. The installed app's origin differs, which is why the structurer's requests go through the core; that path was used in dev, not in a built app.
- **Whisper in a meeting.** It downloads, verifies, loads and transcribes in the bench. It was not run in the app, where it would fall behind.

### Built differently from the plan or the spec, for Matt to confirm
- **The map is saved through a typed command, not SQL from the webview**, and `tauri-plugin-sql` is gone in favour of `sqlx` used from Rust. The approved plan said the webview would write through the plugin; the plugin cannot make a multi-row commit all-or-nothing (DECISIONS 2026-11-19).
- **The structurer runs on the main thread and talks to Ollama through the core**, not from a Web Worker (DECISIONS 2026-11-19).
- **Ten vendored crates, not eleven**: with `audio-utils` trimmed, `audio-mime` is not needed.
- **Utterances are cut at 10 s, not 15 s**, at the next 300 ms pause.
- **Data lives in `%LOCALAPPDATA%\co.custore.scribe`**, not the roaming profile.
- **`Start recording` does not turn red on hover** (L5).
- **A `Stop` button in the status strip, and a review screen after Stop**: UI_SPEC has no Stop control before the end screen exists.

### Things M2 left unfinished
- No level test in Settings, no search on Home, no `+` to add an agenda header mid-meeting, no way to remove a highlight, no microphone change during a meeting (DECISIONS 2026-11-19).
- A model downloaded during a meeting is used from the next meeting on; the running one stays without a transcript.
- Recovery transcribes at most the last two minutes of unheard audio per source. A meeting recorded with no model stays untranscribed: there is no "transcribe this recording" yet.
- No diarization: every line from the microphone is `Room`, every line from loopback `System audio`.
- `confidence` is always 1.0.
- The local model repeats itself on short batches: in a 2.7-minute run it wrote the same decision ("quote 42 a set…") three times, each citing different segments, so the dedupe rule did not catch it. Windows' voices pause at every sentence, which makes many short utterances and small batches; a real meeting may behave differently. Worth a look with real transcripts before M3.
- **Relaunching within a few seconds of a forced kill can fail.** The killed window's WebView2 processes take a moment to exit, and an app started before they have gone exits at once (seen once: started 23 s after the kill, exit code −1). Started again, it ran. An installed app killed from Task Manager takes its WebView2 processes with it, so this may be a dev-only effect; not investigated.
- `ort` is built without `copy-dylibs`, so the app loads Windows' own `DirectML.dll`. Fine on Windows 10 and 11; the installer (M5) should decide whether to ship a newer one.
- The vendored crates' own tests are not run: they need Anarlog's test data.

### The gate test, for Matt (TEST_PLAN §4)
Expect some doubled or garbled `Room` lines while the podcast plays through speakers (see "Echo from speakers" above); note how many and when. A second pass with headphones shows the difference.

Needs a microphone, speakers, and about 75 minutes. From `C:\dev\scribe`:
1. `pnpm tauri dev`. On Home, the gear → **Audio**: pick the microphone, tick **Also record what this PC plays**. **Speech**: Parakeet should read "Installed".
2. **New meeting**: title `Bench 60`, agenda `A`, `B`, `C`. **Start recording**.
3. Speak for 2 minutes. Play a 20-minute podcast through the speakers; talk over it twice. Check: the podcast's lines read `System audio`, yours `Room`, and nothing appears twice. With a stopwatch, time 10 of your own lines from the end of the sentence to the text appearing; the median should be 2 s or less.
4. Task Manager at 0, 30 and 60 minutes: `scribe.exe` should grow by less than 300 MB.
5. At 45 minutes, end `scribe.exe` in Task Manager. Wait ten seconds, `pnpm tauri dev` again. Home should ask to recover `Bench 60`; **Recover** should show the transcript and a timeline that plays up to the kill. (Killing at 45 minutes ends that recording; for the 60-minute memory reading, run a second meeting or skip the kill on the first.)
6. Timeline: click 5 transcript lines and 5 places on the waveform (the sound should start at once); drag across the waveform, name it, and see a quote card on the map.
7. The numbers the app measured are in `%LOCALAPPDATA%\co.custore.scribe\meetings\<id>\stats.json` after Stop (not after a kill).

### For the next session
- `powershell -File scripts/soak.ps1 -Minutes 60 -Loopback` repeats the long run without a room; `-KillAtMinute 45` adds the kill and recovery; `-Devices` uses the real microphone.
- The app's database and recordings from this session's test meetings are in `%LOCALAPPDATA%\co.custore.scribe` (`Bench 5`, `Bench kill`). Delete the folder's `meetings` directory and `scribe.db*` for a clean start; keep `models`.
- The app's own window can be driven by a script: start `pnpm tauri dev` with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` and connect Playwright with `chromium.connectOverCDP('http://127.0.0.1:9222')`. That is how the real-app checks above were made; with `SCRIBE_TEST_AUDIO` set as well, no microphone is needed.
- With Chrome and Ollama open the PC has under 2 GB free, and a full Rust build can run out of memory (rustc exits with code 1 and no message). `CARGO_BUILD_JOBS=4` gets through.
- `cargo test` rebuilds the example tools, so it fails while `soak.exe` is running; `cargo test --lib` does not.
- CI's job log needs admin rights to read. The workflow now repeats the failing lines as annotations, which anyone can read through the checks API.
- Speech-model hotwords (participants' and customers' names) would help: the bench heard "Kabs" as "Cabs" and "UDO" as "Udo" and "Uto". sherpa-onnx supports hotwords for transducers; not tried.

## M2 — plan (approved by Matt, 2026-11-19)

Approved as recommended: the nine questions below are answered yes (1–6, 9), both model downloads are approved (7), and test speech may be played through the PC's speakers a few minutes at a time (8). Seven steps in BUILD_PLAN order, one or more commits per step, `pnpm check && pnpm test` before each commit, a push after each step.

### What I checked before planning
- **Anarlog** (`fastrepl/anarlog`, MIT outside `enterprise/`): head of `main` is `9c1cbe287019e7ca199ee77bd5f6d095cf076ad8` (2026-11-17). `audio-actual`, `aec` and `vad` exist, but they do not stand alone. `audio-actual` needs `audio`, `audio-device`, `audio-interface`, `audio-sync`, `audio-utils`, `resampler` and `aec`; `aec` and `vad` need `onnx`; `audio-utils` needs `audio-mime`. That is 11 crates, not 3. None is under `enterprise/`. (Built: 10. With `audio-utils` trimmed, `audio-mime` is not needed.)
- `audio-actual` already does mic + WASAPI loopback → resample → echo cancellation in one stream (`AudioInput::from_mic_and_speaker`). `vad` is Silero v6.2 and returns a speech probability per 32 ms; cutting utterances from that is ours to write.
- `aec` and `vad` run their models through `ort` (`=2.0.0-rc.10`, MIT OR Apache-2.0), which downloads ONNX Runtime when it builds. sherpa-onnx carries its own ONNX Runtime. Two copies in one program may clash at link time.
- `audio-utils` pulls in `vorbis_rs` (a C build) and `rodio` with `symphonia-all`. Symphonia is **MPL-2.0**, which the stack line ("all MIT/Apache/BSD") does not cover. `audio-actual` uses three small functions from `audio-utils`.
- **`sherpa-rs` is deprecated.** Its repository was archived on 2026-03-08 and its README says to use the official bindings. The last release, 0.6.8 (2025-10-05), is pinned to sherpa-onnx v1.12.15. The official crate is `sherpa-onnx` 2.0.1 (Apache-2.0, 2026-10-27, from k2-fsa), with examples for Parakeet, Whisper, Silero VAD, keyword spotting and Kokoro.
- **Models** (Hugging Face, files fetched one by one, so no archive to unpack): Parakeet-TDT 0.6B v3 int8, `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` at revision `ed5d745`, 670 MB in four files, CC-BY-4.0, SHA-256 published for the three model files. Whisper turbo int8, `csukuangfj/sherpa-onnx-whisper-turbo` at `2ca6ff6`, 1,037 MB in three files, SHA-256 published.
- **This PC**: one microphone endpoint and two outputs (headphones, the monitor's speakers) are present; whether the microphone hears the room is not known. C: has 92 GB free. The RTX 3070 already has 3.7 of 8 GB in use by Ollama. `cmake`, `clang`, `ffmpeg` and `gh` are not installed; nothing below needs them. Two Windows speech voices are installed (David, Zira).

### Step 1 — Vendor the capture crates; mic + loopback → utterances
1. A half-day spike first, before any capture code of ours: copy the 11 crates into `crates/vendor/anarlog/` at the commit above with the MIT `LICENSE`, build them, and run one small program that opens the microphone and the loopback and prints levels. The same spike links `ort` and sherpa-onnx into one binary to see whether the two ONNX Runtimes coexist. If the crates do not build or capture misbehaves within the half day, switch to Meetily's cpal/WASAPI path and write down why (`prompts/milestones.md`).
2. What is changed in the vendored copy, and nothing else: each `workspace = true` dependency becomes the version Anarlog's root `Cargo.toml` pins; tests, benches and example data that need Anarlog's test crates are left out; of the AEC models only the 128 pair (7 MB) is copied, not the 256 and 512 pairs (57 MB); `audio-utils` is cut to the three functions `audio-actual` uses, which keeps Symphonia and the Vorbis C build out. Each change is listed in `crates/vendor/anarlog/VENDORED.md`. Capture, AEC and VAD code is not rewritten.
3. Ours, in `src-tauri/src/audio/`: `capture.rs` (devices, start and stop, a `Source` trait with the real capture and a file source that plays a WAV at real time for tests), `vad.rs` (utterance cutter: 700 ms of silence ends an utterance, 30 s is the longest; over 15 s it cuts at the next 300 ms pause so a long speech does not wait), `levels.rs` (`audio:levels` at 20 Hz).
4. Tests: the cutter on a synthetic 40 s signal with gaps, with a stand-in for the Silero model; the 30 s limit; levels batching. No test needs a sound device, so CI can run them.
5. Vendored crates are path dependencies outside lint and format checks (`.prettierignore`, clippy runs on our package only).

### Step 2 — Speech to text and the model downloader
1. `stt/mod.rs`: `trait Transcriber`, `LocalSherpa` running Parakeet-TDT 0.6B v3 int8 on the CPU on its own thread, one utterance at a time, `mic` and `system` in arrival order.
2. `stt/models.rs`: a catalogue (Parakeet first, Whisper turbo second) with file names, sizes, SHA-256 and the pinned revision; a downloader with HTTP range resume, a `.part` file, a hash check before the rename, and a re-download when the hash is wrong; `model:download` events; cancel. Models live in the app data folder under `models/`.
3. The app runs with no model: capture and recording still work, the transcript is off and the live screen says so (the model-missing banner).
4. Tests: SHA mismatch rejects a file; resume from a partial file against a local test server; catalogue paths. A transcription test on a short WAV runs only when the model is on disk, so CI does not download 670 MB.
5. A first run of the RTF bench here, not in step 7, because CPU or GPU is decided by that number.
6. New dependencies: `sherpa-onnx` or `sherpa-rs` (question 1), `hound`, `reqwest`, `sha2`, `ulid`.

### Step 3 — Session, audio on disk, SQLite
1. `session/mod.rs`: idle → recording → paused → stopped; the meeting clock (paused time does not count); segment ids (`s_` + ULID); `recording:state` once a second and on every change. Commands `create_meeting`, `start`, `pause`, `resume`, `stop`, `list_devices`, `set_devices`, `set_stt`, `download_model`.
2. `audio/writer.rs`: 10 s WAV files per source (16 kHz, mono, 16-bit, what the recogniser heard) under `meetings/{id}/audio/{source}/`, the header rewritten every second so a kill loses at most the last second. About 115 MB an hour per source.
3. `store/`: the schema of ARCHITECTURE §3.1 as migrations, FTS5 on segment text, WAL mode. Rust writes meetings, segments and the chunk index as they happen, so they survive a dead window. The map (topics, cards, suggestions) is written by a new `SqliteAdapter` in `src/engine/` through `@tauri-apps/plugin-sql`, one transaction per commit, undo and redo included. `MemoryAdapter` stays for tests and the `?screen=` fixtures, which run without Tauri.
4. Live segments go into the engine the replay harness already feeds, so the map builds during a real meeting; the structurer's silence trigger is ticked from the meeting clock. The webview may then call Ollama on `127.0.0.1:11434` and nothing else (CSP).
5. Tests: state machine transitions; a chunk file cut short mid-write is repaired; adapter round trip (load equals what was persisted, undo included) against an in-memory SQLite; FTS query.

### Step 4 — Status strip and transcript panel
1. Status strip (UI_SPEC §2.1): indicator with elapsed time, PAUSED in grey, 300 ms hold to pause and one click to resume; agenda chips that scroll the map to their column; a level meter for the laptop; the `silent | speaking` toggle shown but fixed to silent until M3; the privacy pill reading `local`; the gear.
2. Transcript panel: time column in mono, source label, text; follows live text until the user scrolls up, then a "Jump to live" button; a search box over the meeting (FTS). Click a segment to play its span.
3. Where it goes is question 3 (L2). My proposal: the right column under the Pins rail, as a `Transcript` tab that the scribe panel joins as a second tab in M3.
4. The screens the manual test cannot run without (L3), in their smallest form: a Pre-meeting sheet (title, agenda, consent line, Start recording), Settings with the Audio and Speech tabs only, and Home listing meetings from SQLite. `pnpm tauri dev` then reaches the live screen through New meeting.
5. Error states: no microphone (banner with "Open audio settings", recording refuses to start), model missing (banner with "Download model", recording still allowed).
6. Screenshot states added: `paused`, `nomic-error`, `model-missing`, plus `premeeting`, `settings-audio`, `settings-speech`, `home-list`. `live` now includes the strip, the transcript and the timeline. Playwright: jump-to-live appears and works; hold-to-pause.

### Step 5 — Timeline
1. Rust computes waveform peaks as chunks close (20 points a second) and sends them batched; wavesurfer draws them with the Regions plugin. A one-hour spike first to confirm wavesurfer 8 draws from peaks alone and redraws a growing recording cheaply.
2. Playback is in Rust (`seek_play`, `play_span`, as ARCHITECTURE §2 lists them), reading the chunk files; the playhead comes back as an event. Transport, `Space`, `[`, `]`, `H`.
3. While the recording plays back during a live meeting, system audio is not transcribed, or the meeting would hear and transcribe itself.
4. Highlights: drag a region, name it, it is stored in `highlights` and becomes a quote card under the active topic (undoable). A click on a card seeks to its first segment and outlines the card while it plays (left open by M1).
5. Speaker bands: one strip per source (`laptop`, `system`), labels only.
6. Tests: peak maths in Rust; Playwright on a fixture: click seeks, a dragged region makes a quote card. Seek latency is logged in-process.

### Step 6 — Recovery
1. On launch, a meeting with no end time is unfinished: Home shows "Recover meeting <title>?" with Recover and Not now. Nothing is ever deleted by declining.
2. Recover: repair the last chunk of each source, rebuild the chunk index and peaks, transcribe any audio after the last saved segment, load the map from SQLite, mark the meeting stopped at the last chunk.
3. Tests: Rust unit tests for repair and re-index. Then the real thing: record from the file source, kill the process from outside at a known time, relaunch, compare.

### Step 7 — Bench
`scripts/bench_stt.ps1` (TEST_PLAN §1) runs a small Rust binary: real-time factor, per-utterance latency (median and 95th percentile), peak memory, for Parakeet at 2, 4 and 6 threads, and for Whisper turbo if it is on disk. Results into this file.

### Questions for Matt
1. **`sherpa-rs` or the official `sherpa-onnx` crate?** CLAUDE.md and BUILD_PLAN name `sherpa-rs`, which is now archived. I recommend the official crate: same engine, maintained, Apache-2.0, and M3's wake word and Kokoro are in it. It changes one line of the stack description.
2. **Eleven vendored crates, one trimmed.** Is vendoring the whole dependency set at one commit fine, with `audio-utils` cut down to avoid MPL-2.0 Symphonia? The alternative keeps `audio-utils` whole and accepts MPL-2.0 as a dependency licence.
3. **Transcript panel place (L2):** a tab in the right column under Pins, shared with the scribe panel from M3?
4. **Minimal Pre-meeting, Settings (Audio, Speech) and Home list in M2 (L3)?** TEST_PLAN §4 starts with them. Without them the test has to be driven by a dev-only shortcut.
5. **Live map in M2?** Step 3.4 wires real segments into the structurer with local Ollama. It is not in the M2 gate, but saved topics and cards cannot be shown without it.
6. **Pause (L4):** UI_SPEC's 300 ms hold to pause, one click to resume. Keep?
7. **Downloads to approve:** Parakeet v3 int8, 670 MB from Hugging Face, needed. Whisper turbo int8, 1,037 MB, only to prove the second catalogue entry and bench it; say no and it stays an untested entry. Building also fetches ONNX Runtime and the sherpa-onnx libraries (about 100 MB, once).
8. **Sound from the PC during my tests.** To test loopback I play synthetic speech (Windows' built-in voice reading the fixture) through the default output, a few minutes at a time. Fine, or headphones-only hours?
9. **Labels without diarization:** I plan `Room` for the laptop microphone and `System audio` for loopback. Say if you want other words.

### What needs Matt at the PC
- A working microphone, and which device to use. I can see an endpoint, not whether it hears the room.
- TEST_PLAN §4 itself: the 60-minute meeting with real speech and a podcast through the speakers, the two talk-overs (echo cancellation: no doubled text), the stopwatch on ten segments, the Task Manager memory readings, the kill at 45 minutes and the relaunch, and listening to the timeline play.
- A real recording or two with the team's accents, if the default model is to be chosen from numbers (DECISIONS 2026-11-17).

### What I can verify without Matt
- Everything automated: unit tests, Playwright, the screenshots in both themes, Windows CI.
- The whole pipeline on synthetic speech: the file source for the microphone path, and real WASAPI loopback for the system path. That gives measured segment latency, a 60-minute soak with memory readings, a forced kill and recovery, seek latency, and the RTF bench. It does not prove echo cancellation or a real room, and it is not the gate.

### Risks
- Two ONNX Runtimes in one process (step 1 spike). Way out: sherpa-onnx as shared libraries, or Silero through sherpa-onnx with only AEC on `ort`.
- Parakeet on the Ryzen 5 2600's CPU may not hold ≤ 2 s on long utterances. Ways out, in order: more threads, the 15 s soft cut, a GPU build (DirectML or CUDA, with 4 GB of VRAM already Ollama's).
- Anarlog's Windows capture is the newer of its platforms (DECISIONS 2026-11-17). Way out: Meetily's path.
- The release build's webview origin (`http://tauri.localhost`) may be refused by Ollama's default CORS list; `pnpm tauri dev` is not affected. Way out: send the structurer's calls through Rust.
- CI has no sound device and gets slower with two native downloads; capture is kept behind a trait so tests never open a device.

### Out of scope for M2
Diarization and named speakers, phones, the scribe panel and hotkey, Speechmatics, the other Settings tabs, the end screen, retention, the installer.

## Open spec questions

Raised at kickoff, not yet answered. Fix them in the docs before the session that needs them.

### Golden test
G1–G6 are answered (2026-11-17): see `docs/DECISIONS.md` and the scoring rules in `docs/TEST_PLAN.md` §2.

### Later milestones
- **L1** Answered (2026-11-17): a non-local AI provider is cloud mode. The exact confirmation copy is still to be written with the Settings AI tab.
- **L2 (M2)** PRD F3.5 and M2 require a transcript panel; the UI_SPEC §2 layout has no place for it.
- **L3** No milestone owns: Home list and search, the Pre-meeting sheet, the Settings shell, Speechmatics cloud transcription, the Ctrl+K palette, solo mode, the minimum-spec check. M2's manual test already needs the first three.
- **L4** Pause is "one click" and "within 300 ms", but the status strip uses a 300 ms hold-to-confirm.
- **L5** "No red except the indicator" against Start recording turning red on hover and the phone's red-outline Pause.
- **L6 (M3)** The wake-word chime against silent group mode.
- **L7 (M4)** "QR with a one-time token" against one code per meeting that mints per-phone tokens.
- **L8** Research is a TS file in ARCHITECTURE §3.3 but fetches through Rust. (The golden test's path is settled: `src/engine/golden/`, and BUILD_PLAN and TEST_PLAN now say so.)
