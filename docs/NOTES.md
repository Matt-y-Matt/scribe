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
- `pnpm check && pnpm test`: green on the PC. 171 TypeScript tests, 3 Rust tests.
- `pnpm e2e`: 13 Playwright tests green (Chromium, 1280 × 800).
- **Golden replay, MockProvider** (`pnpm golden --provider mock`, and `src/engine/golden/golden.test.ts` in CI): **PASS**. Topic coverage 5/5 (CLA 14/15, suppliers 6/6, designer 6/6, aircon 3/3, pop-up 1/1). Card match 17/17 (100%). Wrong owners 0. Both pins suggested and pinned at the end. Never rules: 0 violated. 8 runs, none skipped, none overlapping. The mock's ops are written by hand against the transcript, so this score checks the engine and the scoring, not a model.
- **Golden replay, Ollama `qwen3.5:4b`** (`pnpm golden --provider ollama`, local, Ollama 0.40.16 on the RTX 3070, reasoning off): **PASS at 10×, four runs out of four.** Topic coverage 5/5 (CLA 12–13/15, suppliers 6/6, designer 6/6, aircon 3/3, pop-up 1/1). Card match 15/17 (88%). Wrong owners 0. Both pins suggested and pinned at the end. Never rules: 0 violated. No op dropped, no run failed; a run takes 2 to 6 s. The two cards it misses are the 3.50-a-name decision (it writes a note) and Matt's "message the landlord" action (it cites `s045`, not `s046`).
- **The same model, paced** (`--paced`: each run gets exactly one trigger's batch, as in a live meeting): 5/5, 15/17, both pins, never rules 0, but **1 wrong owner, so a fail.** The card is "Matt: send the drafted options to UDO" on `s027`, where Matt says "draft the two options for UDO and I'll send it". The answer key has only Zach's action there. The model is reading the transcript correctly; whether the key should allow Matt on `s027`, as it allows two owners on `s010`, is Matt's call. At 10× the batches fall differently and the model does not write that card.
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
