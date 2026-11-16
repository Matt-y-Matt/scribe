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
- Map: @xyflow/react + @dagrejs/dagre. Reorder: dnd-kit (pointer-based). Timeline: wavesurfer.js + Regions
- LLM calls: Vercel AI SDK (`ai`), provider switchable (Ollama local / Anthropic / OpenAI-compatible)
- Speech: sherpa-onnx via `sherpa-rs` (Parakeet-TDT 0.6B v3 default; Whisper turbo multilingual option); cloud switch = Speechmatics
- Audio capture: vendored WASAPI crates (see ARCHITECTURE §Vendored) — do not rewrite capture
- Store: SQLite via `tauri-plugin-sql` (sqlx) + FTS5; settings via `tauri-plugin-store`
- Phones: LiveKit (Rust SDK on host, JS SDK on the join page)

## Commands
- `pnpm install` · `pnpm tauri dev` · `pnpm tauri build`
- `pnpm check` = `tsc --noEmit && eslint . && prettier --check . && cargo clippy --all-targets -- -D warnings && cargo fmt --check` (cargo runs against `src-tauri/Cargo.toml`)
- `pnpm test` = `vitest run` · `cargo test`
- `pnpm format` — prettier and `cargo fmt` · `pnpm ipc` — regenerate `src/ipc.ts` from `src-tauri/src/ipc.rs`
- `pnpm replay fixtures/meeting-custore-weekly.jsonl --speed 10` — plays a transcript into the engine without audio
- `pnpm screenshot` — Playwright screenshots of every screen state into `.screenshots/<state>.<light|dark>.png` (git-ignored)

## Layout
- `src/` React app · `src/engine/` map engine, structurer, scribe intents (pure TS, no DOM, unit-tested)
- `src/screens/` one folder per screen; `screens.ts` lists every `?screen=` state, `registry.tsx` maps it to a component
- `src/styles/tokens.css` the only place colours live · `src/components/ui/` shadcn/ui (Base UI) components · `src/ipc.ts` generated, never edited
- `scripts/` the `replay` and `screenshot` commands (run with tsx)
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

## Conventions
From `dannysmith/tauri-template`, kept where they do not conflict with the rules above (decision log, 2026-11-17).
- State: `useState` for a component, Zustand for global UI state, TanStack Query for persisted data. Read Zustand with selectors (`useStore(s => s.value)`), never by destructuring the whole store; use `getState()` inside callbacks.
- The React Compiler memoises; do not add `useMemo` or `useCallback` by hand.
- Call Rust through the generated `commands` and `events` in `src/ipc.ts`, never a string `invoke`. After changing `ipc.rs`, run `pnpm ipc` and commit the result; `cargo test` fails if it is stale.
- Rust: inline format arguments (`format!("{name}")`); Tauri v2 APIs only.
- Tailwind is narrowed to the UI_SPEC tokens (`src/styles/app.css`): `bg-surface`, `text-text-muted`, `border-border`, `text-body`, `rounded-md`. shadcn's own colour names (`bg-primary`, `text-muted-foreground`, …) do not exist here, so restyle every component after `shadcn add`. `src/styles/design-rules.test.ts` fails on shadows, gradients, blur, colour literals outside `tokens.css` and non-fade motion.
- A new screen state: add its id to `src/screens/screens.ts` and its component to `registry.tsx`; `pnpm screenshot` then covers it in both themes.
- Tests sit next to the code as `*.test.ts(x)`. Engine tests start with `// @vitest-environment node` so they cannot touch the DOM.
- All files are LF (`.gitattributes`), on Windows too.
