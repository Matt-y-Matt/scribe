# Decisions log

One line per decision, newest first. Format: `YYYY-MM-DD — decision — why — who`.

- 2026-11-17 — Golden test scoring (G1, G2): a segment is covered when any card or topic cites it, and coverage is measured per agenda header, not per topic — the answer key's own cards cover only 60/67/33/0/0% of the must-cover segments, and the wireframe splits CLA into Pricing and Artwork, so "80% under one topic" could not pass — Matt, on Claude's recommendation
- 2026-11-17 — Pin suggestions (G3, G4): the structurer suggests a pin as soon as it finds off-agenda talk (the 60 s wait in PRD F5.1 is dropped); the test checks which segments the suggestion cites; trigger timers run on the meeting clock; the golden test accepts pin suggestions in place of the host, and speech in the meeting never pins by itself — the fixture's off-agenda windows are 37 s and 22 s, a replay at 10× lasts 38 s of wall time, and rule 1 needs a person to confirm — Matt, on Claude's recommendation
- 2026-11-17 — Card matching (G5, G6): one engine card matches at most one expected card; a wrong owner is an action whose owner matches none of the expected actions on the segments it overlaps; names match by Jaro-Winkler ≥ 0.8 — s010 legitimately carries two owners; "Kabir" → Kabs is 0.85 by Jaro-Winkler and 0.6 by Levenshtein ratio — Matt, on Claude's recommendation
- 2026-11-17 — A non-local AI provider is cloud mode (L1): it needs a confirmation naming the vendor and shows the cloud pill; Ollama stays the default — rule 4 covers transcript text, and the cloud switch was only defined for Speechmatics — Matt, on Claude's recommendation
- 2026-11-17 — M0 was built in a Linux cloud session, not on the Windows PC; `windows-latest` CI is the Windows check, and `pnpm tauri dev` still has to be run once on the PC — the handover arrived as a zip in a cloud session; everything in the M0 gate except launching the app can be verified there — Matt, on Claude's recommendation
- 2026-11-17 — Template: `dannysmith/tauri-template` imported as files at commit `8e0db1e`; where it conflicts with our CLAUDE.md, ours wins (pnpm not npm; commits and the dev server are allowed). Left out: its demo UI (sidebars, custom title bar, preferences, command palette, quick pane), i18n, macOS/Linux config and `tauri-nspanel`, the updater and release workflow (back in M5), plugins the spec never names (clipboard-manager, dialog, fs, notification, opener, os, persisted-scope, process) and ast-grep/knip/jscpd. Kept: tauri-specta, log, single-instance, window-state, Zustand, TanStack Query, React Compiler, its eslint/prettier/vitest setup — Scribe's screens share nothing with the demo UI, and every kept dependency is one more licence and capability to own — Matt, on Claude's recommendation
- 2026-11-17 — `sherpa-rs` and `hound` are added in M2, not M0 — BUILD_PLAN and this log disagreed; nothing uses them before M2 and `sherpa-rs` puts a native build in every CI run. Its latest release (0.6.8) is from 2025-10-05: check it supports Parakeet-TDT v3 on day 1 of M2 — Matt, on Claude's recommendation
- 2026-11-17 — Layout library is `@dagrejs/dagre`, not `dagre` — `dagre` 0.8.5 has had no registry activity since 2022; the fork is maintained, MIT, and ships its own types — Matt, on Claude's recommendation
- 2026-11-17 — Licence rule 7: OFL-1.1 is accepted for the two font families; direct dependencies are logged by hand in the table below; transitive dependencies are not audited — the stack line above said "all MIT/Apache/BSD", which fonts are not; an automated transitive check can be added on request — Matt, on Claude's recommendation
- 2026-11-17 — Replay fixtures map to `segment:final` as: seconds → whole ms, fixture ids kept (`s001`…), `speaker` → `speaker_label`, `source: "laptop"`, `confidence: 1`, `meeting_id: "m_replay"`; each fixture has a `.meta.json` with title, mode, agenda and participants — the golden file refers to fixture ids, and the engine must not read its own answer key for the agenda — Matt, on Claude's recommendation
- 2026-11-17 — `pnpm replay` plays into a `SegmentSink` interface; M0 ships a console sink and the map engine becomes the sink in M1; a segment is emitted when its utterance ends (`t1 / speed`), scheduled against the start of the replay — the engine does not exist in M0; finals arrive at utterance end in a live meeting too — Matt, on Claude's recommendation
- 2026-11-17 — Screenshots are `.screenshots/<state>.light.png` and `<state>.dark.png`, 1280 × 800 at 2×, git-ignored — the docs named one file per state but asked for both themes; images are reviewed, not versioned — Matt, on Claude's recommendation
- 2026-11-17 — Home empty-state copy is "No meetings yet. Start one and Scribe keeps the notes."; the New meeting button is rendered but does nothing until the Pre-meeting sheet exists — UI_SPEC gave no sentence, and no milestone owns the sheet yet (docs/NOTES.md, open question L3) — Matt, on Claude's recommendation
- 2026-11-17 — App identifier is `co.custore.scribe` — it names the app-data folder (SQLite + audio), so changing it later moves user data — Matt, on Claude's recommendation
- 2026-11-17 — New token `--on-accent` (`#FFFFFF` light, `#141416` dark) for text on accent fills — white on the dark accent `#6B8CFF` is 3.08:1 and fails AA (PRD §6); `#141416` on it is 5.98:1 — Matt, on Claude's recommendation
- 2026-11-17 — `pnpm check` is CLAUDE.md's four commands plus `prettier --check .`; cargo is pointed at `src-tauri/Cargo.toml` with `--manifest-path` — the template's formatting convention is kept; a root Cargo workspace can wait until `crates/vendor/` exists (M2) — Claude
- 2026-11-17 — IPC: `src-tauri/src/ipc.rs` is the one declaration; `pnpm ipc` generates `src/ipc.ts`; the Rust test `ipc_ts_is_up_to_date` fails when they drift. Events keep the `domain:name` names from ARCHITECTURE §2 by implementing `tauri_specta::Event` by hand (the derive would produce `segment-final`). Millisecond fields are `u32` — specta refuses to export `u64` to TypeScript (it would need BigInt); `u32` ms covers 49 days — Claude
- 2026-11-17 — shadcn/ui: `components.json` is written to the CLI's schema by hand (`style: base-nova`) and the button is built directly on `@base-ui/react`, because the registry host `ui.shadcn.com` is blocked in the cloud session. Tailwind's theme is narrowed to the UI_SPEC tokens and shadcn's semantic colour names are not used: its `accent` means "hover fill" while ours is the brand blue. Every component added with `shadcn add` is restyled to tokens; `src/styles/design-rules.test.ts` enforces it — Claude
- 2026-11-17 — `pnpm screenshot` starts `vite dev` as its own process — loading Vite inside the tsx process breaks the React Compiler preset (`import.meta.resolve is not a function`) — Claude
- 2026-11-17 — All text files are LF on every platform (`.gitattributes`) — prettier, the fixtures and the generated `src/ipc.ts` are compared byte for byte on Windows CI — Claude
- 2026-11-17 — Tauri config: NSIS is the only bundle target, the CSP has no remote image source, and the webview's capability is `core:default` + `store:default` only — ARCHITECTURE §7 names NSIS; local by default means the webview gets no network or file permission it does not use — Claude
- 2026-11-17 — Template dependencies not needed yet are dropped rather than kept idle: sonner, react-resizable-panels, lucide-react, cmdk, react-day-picker, tw-animate-css, all `@radix-ui/*` — each returns with the shadcn component that needs it — Claude
- 2026-11-17 — Audio capture: vendor Anarlog's crates first, Meetily's cpal/WASAPI path as the fallback — Anarlog splits capture, echo cancellation and VAD into separate crates we can lift one at a time and adds diarization/voiceprint crates for v1.1; Meetily's audio is inside its app and does ducking rather than true echo cancellation; Anarlog's Windows build is newer, so M2 day 1 tests it and switches if it misbehaves — Claude proposal
- 2026-11-17 — Research spin-off: Brave Search API as the default provider (documented pricing, 2,000 free queries a month, about $3 per 1,000 after), Tavily behind the same interface; we fetch and read pages ourselves — Claude proposal
- 2026-11-17 — Scribe answers questions immediately (meeting first, then model knowledge, labelled); research is a background job with a ping-back; both can be typed or spoken — Matt
- 2026-11-17 — Build order: map engine on a replayed transcript (M1) before live audio (M2) — the map logic is the product; capture is vendored plumbing — Matt
- 2026-11-17 — Singlish accuracy is not a gate; test with real recordings in M2 and pick the default model from the numbers — Matt
- 2026-11-17 — v1 dispatch channels: Telegram bot, SMTP email, .ics file; Slack and Google OAuth move to v1.1 — fewer OAuth reviews before dogfood — Claude proposal, pending Matt
- 2026-11-17 — Phones-as-mics in v1, voiceprints in v1.1 — deterministic plumbing beats probabilistic labels; the phone page doubles as the participant view — Matt
- 2026-11-17 — Local transcription by default (Parakeet via sherpa-onnx), Speechmatics as the cloud switch — cost and privacy — Matt
- 2026-11-17 — Hold-to-talk default Ctrl+Shift+Space — avoids Handy's Ctrl+Space — Claude proposal
- 2026-11-17 — Stack: Tauri v2 + React 19 + TS, shadcn (Base UI), React Flow + dagre, dnd-kit, wavesurfer.js, Vercel AI SDK, sherpa-rs, LiveKit — all MIT/Apache/BSD; tldraw, Screenpipe, Peaks.js, Piper, Porcupine, ELK excluded for licence reasons — Claude research 2026-11-16
- 2026-11-17 — "Pinned"/"Pins" is the term for parked topics; never "parking lot" — Matt

## Licences of dependencies (append as added)

Licence as declared in the npm or crates.io registry on the day the dependency was added. Direct dependencies only (see the 2026-11-17 licence decision above).

| Package / crate | Licence | Added in |
| --- | --- | --- |
| dannysmith/tauri-template @ `8e0db1e` (source files; notice kept in `docs/licences/`) | MIT | M0 |
| tauri, tauri-build, @tauri-apps/api, @tauri-apps/cli | Apache-2.0 OR MIT | M0 (template) |
| tauri-plugin-log, tauri-plugin-single-instance, tauri-plugin-window-state | Apache-2.0 OR MIT | M0 (template) |
| tauri-plugin-store, tauri-plugin-sql, tauri-plugin-global-shortcut (+ @tauri-apps/plugin-store, @tauri-apps/plugin-sql) | Apache-2.0 OR MIT | M0 |
| specta, tauri-specta, specta-typescript | MIT | M0 (template) |
| serde, serde_json, log | MIT OR Apache-2.0 | M0 (template) |
| react, react-dom, vite, @vitejs/plugin-react, @rolldown/plugin-babel, babel-plugin-react-compiler, tailwindcss, @tailwindcss/vite | MIT | M0 (template) |
| zustand, @tanstack/react-query | MIT | M0 (template) |
| @base-ui/react, clsx, tailwind-merge | MIT | M0 |
| class-variance-authority | Apache-2.0 | M0 |
| @xyflow/react, @dagrejs/dagre, @dnd-kit/core, @dnd-kit/sortable, zod, ulid | MIT | M0 |
| wavesurfer.js | BSD-3-Clause | M0 |
| ai, @ai-sdk/anthropic, @ai-sdk/openai-compatible | Apache-2.0 | M0 |
| @fontsource-variable/inter, @fontsource-variable/jetbrains-mono (Inter, JetBrains Mono font files) | OFL-1.1 | M0 |
| Dev only: typescript, @playwright/test | Apache-2.0 | M0 |
| Dev only: tsx, vitest, jsdom, @testing-library/react, @testing-library/jest-dom, eslint, @eslint/js, typescript-eslint, eslint-plugin-react, eslint-plugin-react-hooks, eslint-plugin-react-compiler, eslint-plugin-react-refresh, eslint-config-prettier, prettier, @types/node, @types/react, @types/react-dom | MIT | M0 |
| sherpa-rs (bindings) / sherpa-onnx | MIT / Apache-2.0 | M2 |
| Anarlog crates audio-actual, aec, vad (vendored, commit: ___) | MIT | M2 |
| hound | Apache-2.0 | M2 |
| livekit (Rust SDK), livekit-client (JS) | Apache-2.0 | M4 |
| rust-dominant-speaker | MIT/Apache-2.0 | M4 |
| lettre, icalendar | MIT/Apache-2.0 | M5 |
| Parakeet-TDT 0.6B v3 (model) | CC-BY-4.0 (attribution in About) | M2 |
| Kokoro-82M (model) | Apache-2.0 | M3 |
