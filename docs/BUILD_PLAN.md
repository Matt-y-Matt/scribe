# Scribe — Build Plan (v1)

Order of work: the map engine first on a replayed transcript, then live audio, then the scribe, then phones, then the end screen and dogfood. Weeks are estimates for one builder with Claude Code most days; gates are not estimates. One milestone per Claude Code session; paste the milestone's "Session prompt" from `prompts/`.

| # | Milestone | Weeks | Gate (done means) |
| --- | --- | --- | --- |
| M0 | Repo, tooling, fixtures | days 1–3 | `pnpm check && pnpm test` green in CI; replay harness prints the fixture at 10× |
| M1 | Map engine on replay | 1–2 | Golden replay test ≥ 80% match, 0 wrong owners, both pins suggested; viewport never jumps |
| M2 | Live capture and transcript | 3–5 | 60-minute live meeting, segments ≤ 2 s, survives a forced kill, timeline seeks |
| M3 | Scribe | 6–8 | 18/20 scripted commands correct; Q&A returns time links; research job attaches sources |
| M4 | Phones as mics | 9–11 | 4 phones + laptop in one room, ≥ 95% utterances named right, no duplicate text |
| M5 | End screen, dispatch, consent, installer | 12–13 | Drafts send via Telegram and email only on confirm; retention job works; installer updates itself |
| M6 | Dogfood | 14–15 | Two weeks at Custore + BNI: the metrics in PRD §8 |
| M7 | Launch prep (v1.1) | 16 on | Voiceprints, OS keychain, billing, Mac, 10 outside users |

If M3 runs long, drop spoken replies and research to v1.1 before touching M4. The map and the phones are the product.

## M0 — Repo, tooling, fixtures (days 1–3)
Tasks
1. `pnpm create tauri-app` is not used; clone `dannysmith/tauri-template` (MIT), rename to `scribe`, update identifiers, keep its CLAUDE.md conventions merged into ours.
2. Add deps: `@xyflow/react`, `@dagrejs/dagre`, `@dnd-kit/core` + `@dnd-kit/sortable`, `wavesurfer.js`, `ai` (+ `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`), `zod`, `ulid`. Rust: `sqlx` via `tauri-plugin-sql`, `tauri-plugin-store`, `tauri-plugin-global-shortcut`, `tauri-plugin-log`, `tauri-plugin-single-instance`, `tauri-plugin-window-state`, `tauri-specta`. (`sherpa-rs` and `hound` are added in M2, when they are first used.)
3. Design tokens, fonts (self-hosted Inter and JetBrains Mono), light/dark switch, shadcn init with Base UI.
4. Scripts: `pnpm check`, `pnpm test`, `pnpm replay`, `pnpm screenshot` (Playwright against `vite dev` with a `?screen=` query to render any screen state from fixtures).
5. `docs/DECISIONS.md` seeded; `.github/workflows/ci.yml` on `windows-latest`.
6. Replay harness: reads `fixtures/*.jsonl`, emits `segment:final` events into the engine at N× speed with simulated silences from the `t0/t1` gaps.
Done: CI green; `pnpm replay fixtures/meeting-custore-weekly.jsonl --speed 10` streams 46 segments to the console; `pnpm screenshot` writes `home-empty.light.png` and `home-empty.dark.png`.

## M1 — Map engine on replay (weeks 1–2)
Tasks
1. `src/engine/model.ts`: types and an in-memory store with an op log (undo/redo 50), persistence adapter to SQLite later (M2).
2. `src/engine/structurer.ts`: trigger logic, worker, provider abstraction (Ollama via OpenAI-compatible; Anthropic), JSON schema, apply rules (ARCHITECTURE §3.2), dedupe, owner fuzzy match.
3. `src/engine/prompts/structurer.md` with 3 fixture examples; a `MockProvider` that returns canned ops from `fixtures/*.mock-ops.json` for CI.
4. Map UI: React Flow + dagre layout, header columns, topic nodes rendering card rows, ghost suggestions, Unplanned column, minimap, fit/tidy, zoom collapse at 0.7.
5. Pins rail; pin/revisit/schedule actions; `P` key.
6. Golden test: `tests/golden.test.ts` scores engine output against `fixtures/meeting-custore-weekly.expected.json` (rules in TEST_PLAN).
7. Playwright: viewport-stability test (20 inserts, transform unchanged), ghost accept/dismiss, drag card between topics, undo.
Done: gate above with a real provider (Ollama Qwen3.5 4B or Anthropic Haiku) and with the mock in CI.

## M2 — Live capture and transcript (weeks 3–5)
Tasks
1. Vendor Anarlog `audio-actual`, `aec`, `vad` by commit; wire mic + loopback → resample → AEC → VAD → utterances.
2. Add `sherpa-rs` and `hound`. `stt::LocalSherpa` with Parakeet-TDT 0.6B v3; model catalogue and downloader with resume and SHA-256; Whisper turbo as the second entry.
3. Session state machine; chunked WAV writer; SQLite persistence for segments, topics, cards (replace the in-memory adapter); FTS5.
4. Status strip (indicator, elapsed, agenda chips, mode, privacy pill), transcript panel with "jump to live".
5. Timeline: wavesurfer with Regions; seek, play span, highlights → quote cards; speaker bands (labels only, no diarization yet).
6. Recovery: on launch, detect an unfinished meeting and rebuild from chunks.
7. Bench: `cargo bench`-style script printing RTF for Parakeet on this PC; record in `docs/NOTES.md`.
Done: a real 60-minute meeting recorded on the reference PC with the gate metrics; forced-kill recovery demonstrated; `pnpm screenshot` covers live, paused, no-mic error, model-missing banner.

## M3 — Scribe (weeks 6–8)
Tasks
1. Global hold-to-talk (Ctrl+Shift+Space default; hotkey recorder in Settings; clash check against Handy's Ctrl+Space).
2. `scribe:utterance` path: separate buffer → STT → `classifyIntent` → engine API; panel UI with time-link chips; text input fallback.
3. Q&A: FTS5 retrieval + outline → answer with links.
4. Research job: `SearchProvider` interface, Brave Search API first (Tavily as the second implementation) → fetch top pages → LLM summary with citations → research card + badge + panel "done" line; spoken notice only in speaking mode; job list in panel.
5. Wake word via sherpa-onnx KWS: train "Hey Scribe" (follow sherpa-onnx KWS docs); chime; 10 s window. If training takes > 2 days, ship hotkey-only and log the decision.
6. TTS via Kokoro (sherpa-onnx); mic gating while speaking; speaking/silent toggle; solo-mode default.
7. Scribe script test (TEST_PLAN §Scribe script) automated with the mock provider; manual run with the real provider.
Done: gate above; no modal appears during any scripted command.

## M4 — Phones as mics (weeks 9–11)
Tasks
1. Vercel project `scribe-join`: static join page + `/api/room`, `/api/join`, `/api/telegram` functions; LiveKit Cloud project (free tier); env vars.
2. Join page screens (UI_SPEC §3.6): consent → name → live; Wake Lock; iOS banner; reconnect.
3. Host: `livekit` Rust SDK joins as host; subscribes to tracks; per-track RMS at 50 Hz; `rust-dominant-speaker`; route the winning track into VAD/STT with participant label; laptop fallback; overlap rule.
4. Data channel: host publishes `map:snapshot` on join and `map:patch` on change; phones send `note` and `pause`.
5. QR code in Pre-meeting; participants with level meters in the status strip; consent_log rows on join.
6. Spike first (day 1): prove the Rust SDK receives a phone's audio and prints RMS. If the Rust SDK blocks, fall back to the host webview joining with livekit-client and streaming PCM to Rust over a Tauri channel (slower; acceptable).
7. Room test with 4 phones (TEST_PLAN §Room test).
Done: gate above; the laptop-only path still works when no phone joins.

## M5 — End screen, dispatch, consent, installer (weeks 12–13)
Tasks
1. End screen (UI_SPEC §3.3): three lists with checkboxes and inline edit; quotes; summary generator with presets and free-text layout; per-person drafts.
2. Telegram bot: token in Settings; pairing via `/start {code}` from the join page; `send_telegram` on confirm only. SMTP email. `.ics` for scheduled pins.
3. Consent: pre-meeting reminder line; join-page consent; log; export; delete all.
4. Retention setting and daily job; privacy tab; network self-test ("local mode made 0 outbound calls in the last meeting").
5. Installer: NSIS bundle with embedded WebView2 bootstrapper; updater with signed `latest.json` on GitHub Releases; first-run onboarding (F12.1).
6. Meeting review screen; exports (Markdown, txt, srt, JSON).
Done: gate above; a fresh Windows 11 VM installs, onboards, records a 5-minute meeting and sends one Telegram draft.

## M6 — Dogfood (weeks 14–15)
Run every Custore team meeting and Matt's BNI one-to-ones with Scribe. Daily: export the network self-test, note every edit the host made before confirming, every mislabelled speaker, every crash. Weekly: fix the top 5 issues. Exit on the PRD §8 metrics.

## Session discipline (every milestone)
1. Start the session with the milestone's prompt from `prompts/`. Ask Claude Code for a plan; read it; cut anything not in the milestone.
2. Build in the order listed; commit after each task; `pnpm check && pnpm test` before each commit.
3. UI tasks end with `pnpm screenshot`; look at the PNGs; compare against UI_SPEC §2 and §5.
4. Record decisions and licences in `docs/DECISIONS.md`; unknowns in `docs/NOTES.md`.
5. Demo the gate at the end of the milestone (the test plan says how); if it fails, the next session starts with the failure, not the next milestone.
