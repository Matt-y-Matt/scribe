# Decisions log

One line per decision, newest first. Format: `YYYY-MM-DD — decision — why — who`.

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
| Package / crate | Licence | Added in |
| --- | --- | --- |
| dannysmith/tauri-template | MIT | M0 |
| @xyflow/react, dagre, @dnd-kit/*, zod, ulid | MIT | M0 |
| wavesurfer.js | BSD-3-Clause | M0 |
| ai, @ai-sdk/* | Apache-2.0 | M0 |
| sherpa-rs (bindings) / sherpa-onnx | MIT / Apache-2.0 | M2 |
| Anarlog crates audio-actual, aec, vad (vendored, commit: ___) | MIT | M2 |
| hound | MIT/Apache-2.0 | M2 |
| livekit (Rust SDK), livekit-client (JS) | Apache-2.0 | M4 |
| rust-dominant-speaker | MIT/Apache-2.0 | M4 |
| lettre, icalendar | MIT/Apache-2.0 | M5 |
| Parakeet-TDT 0.6B v3 (model) | CC-BY-4.0 (attribution in About) | M2 |
| Kokoro-82M (model) | Apache-2.0 | M3 |
