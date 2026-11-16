# Scribe — CLAUDE.md

Scribe is a Windows desktop meeting secretary: it records the room, transcribes on the PC, builds a live topic map while people talk, takes voice instructions mid-meeting, pins off-topic items, and confirms action items before sending drafts. Working name; rename later.

## Read first
- `docs/PRD.md` — what we are building and the acceptance criteria
- `docs/UI_SPEC.md` — screens, layout, tokens, interaction rules
- `docs/ARCHITECTURE.md` — modules, data model, events, LLM patch protocol
- `docs/BUILD_PLAN.md` — milestones; one milestone per session
- `docs/TEST_PLAN.md` — what "done" requires

## Stack
- Tauri v2 (Rust core) + React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui (Base UI)
- Map: @xyflow/react + dagre. Reorder: dnd-kit (pointer-based). Timeline: wavesurfer.js + Regions
- LLM calls: Vercel AI SDK (`ai`), provider switchable (Ollama local / Anthropic / OpenAI-compatible)
- Speech: sherpa-onnx via `sherpa-rs` (Parakeet-TDT 0.6B v3 default; Whisper turbo multilingual option); cloud switch = Speechmatics
- Audio capture: vendored WASAPI crates (see ARCHITECTURE §Vendored) — do not rewrite capture
- Store: SQLite via `tauri-plugin-sql` (sqlx) + FTS5; settings via `tauri-plugin-store`
- Phones: LiveKit (Rust SDK on host, JS SDK on the join page)

## Commands
- `pnpm install` · `pnpm tauri dev` · `pnpm tauri build`
- `pnpm check` = `tsc --noEmit && eslint . && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
- `pnpm test` = `vitest run` · `cargo test`
- `pnpm replay fixtures/meeting-custore-weekly.jsonl --speed 10` — plays a transcript into the engine without audio
- `pnpm screenshot` — Playwright screenshots of every screen state into `.screenshots/`

## Layout
- `src/` React app · `src/engine/` map engine, structurer, scribe intents (pure TS, no DOM, unit-tested)
- `src-tauri/src/` Rust: `audio/`, `stt/`, `session/`, `phones/`, `store/`
- `crates/vendor/` third-party crates copied by commit, each with its LICENSE
- `join-page/` the phone web app (separate Vite project)
- `fixtures/` replay transcripts + golden expectations · `docs/` · `prompts/`

## Rules that never bend
1. The map only grows during a meeting. Moves, merges and deletes are suggestions until a person confirms. Undo for everything.
2. Nothing is sent to anyone without the host confirming on the end screen.
3. The recording indicator is always visible; pause is one click from every screen, including phones.
4. Local by default: no network call carries audio or transcript text unless the user turned the cloud switch on. Research and dispatch are the only exceptions, and they are user-triggered.
5. The scribe never speaks unprompted in group mode and never interrupts a speaker.
6. Never log transcript text, audio paths or API keys at info level.
7. New dependency = note its licence in `docs/DECISIONS.md`. No GPL/AGPL/LGPL/custom-licence code in the app.

## UI brief (details in UI_SPEC)
Dense desktop tool, not a marketing site. Two type families (Inter, JetBrains Mono). One accent (#2D5BFF). 13 px body. 1 px borders, 6 px radius, no shadows, no gradients, no hero sections, no stat tiles. Motion ≤ 150 ms, fades only. Light and dark from day one. Every screen has an empty state and an error state.

## How to work
- Plan first (plan mode), then build. One milestone per session; paste its "done means" from BUILD_PLAN.
- Write the test or the fixture before the feature when the engine is involved.
- Run `pnpm check && pnpm test` before saying done; for UI work also run `pnpm screenshot` and look at the images.
- Keep the Rust ↔ TS boundary typed: events and commands are declared once in `src-tauri/src/ipc.rs` and generated into `src/ipc.ts` (tauri-specta). Batch high-frequency events (audio levels at ≤ 20 Hz).
- Small commits with clear messages. Record decisions in `docs/DECISIONS.md` (one line, dated).
- If a fix fails twice, stop and write down what you know in `docs/NOTES.md` before trying again.
