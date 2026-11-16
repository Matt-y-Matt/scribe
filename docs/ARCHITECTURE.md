# Scribe — Architecture (v1)

## 1. Shape
One Tauri v2 app: a Rust core owns audio, speech, phones, storage and the meeting session; a React webview owns the UI and the map engine (pure TypeScript, unit-tested, no DOM). A separate static web app is the phone join page. Our cloud is a LiveKit room per meeting (LiveKit Cloud at first) plus one serverless token endpoint on Vercel. Optional third-party services are off until the user switches them on.

```
Phones (join page) ──LiveKit──▶ Rust core ──events──▶ React UI + map engine ──AI SDK──▶ Ollama (local) | Anthropic | OpenAI-compatible
Laptop mic + system audio ──▶ Rust core (capture → AEC → VAD → STT) ──▶ SQLite (segments, audio chunks)
End screen ──▶ Rust dispatch (Telegram, SMTP, .ics)
```

## 2. Rust core (`src-tauri/src/`)

| Module | Responsibility | Key crates |
| --- | --- | --- |
| `audio/capture.rs` | Enumerate devices; capture mic + WASAPI loopback; resample to 16 kHz mono f32; ring buffers | vendored `audio-actual` (Anarlog) or Meetily's cpal/WASAPI path; `cpal`, `wasapi` (MIT) |
| `audio/aec.rs` | Echo cancellation so speaker output is not transcribed twice | vendored `aec` (Anarlog, ONNX) or WebRTC AEC3 via Talky's approach |
| `audio/vad.rs` | Silero VAD; utterance boundaries (700 ms silence, 30 s max) | sherpa-onnx VAD via `sherpa-rs` |
| `audio/writer.rs` | Write 10 s WAV/FLAC chunks per source; crash-safe | `hound` (MIT) |
| `stt/mod.rs` | `trait Transcriber { fn feed(&mut self, utt: Utterance) -> Segment }`; impls `LocalSherpa` (Parakeet, Whisper), `CloudSpeechmatics` | `sherpa-rs` (MIT bindings to sherpa-onnx, Apache-2.0); `tokio-tungstenite` for Speechmatics |
| `stt/models.rs` | Model catalogue, download with resume + SHA-256, paths | `reqwest`, `sha2` |
| `session/mod.rs` | Meeting state machine (idle → recording → paused → stopped); clock; assigns segment ids; fans out events | — |
| `phones/mod.rs` | Join LiveKit room as the host; subscribe to audio tracks; per-track level; dominant-speaker arbitration; route the winning track into VAD/STT with the participant label; data channel for map snapshots and private notes | `livekit` (Rust SDK, Apache-2.0), `rust-dominant-speaker` (MIT/Apache-2.0) |
| `scribe/hotkey.rs` | Global hold-to-talk; captures mic during hold into a separate buffer; emits `scribe:utterance` | `tauri-plugin-global-shortcut` |
| `scribe/kws.rs` | Wake word via sherpa-onnx keyword spotting; 10 s window; chime | `sherpa-rs` |
| `scribe/tts.rs` | Kokoro via sherpa-onnx TTS; gates the mic while speaking | `sherpa-rs` |
| `store/` | SQLite schema + migrations; FTS5 on segments; retention job | `tauri-plugin-sql` (sqlx) |
| `dispatch/` | Telegram Bot API, SMTP, .ics generation | `reqwest`, `lettre` (MIT/Apache-2.0), `icalendar` (MIT/Apache-2.0) |
| `ipc.rs` | All commands and events, typed once; tauri-specta generates `src/ipc.ts` | `tauri-specta` |

### Events (Rust → UI), batched where frequent
- `recording:state {state, elapsed_ms}`
- `audio:levels {sources: [{id, rms}]}` at ≤ 20 Hz
- `segment:final {id, meeting_id, t0_ms, t1_ms, speaker_label, source, text, confidence}`
- `segment:partial {source, text}` (only when the engine supports streaming; optional)
- `phone:joined/left {participant_id, name}` · `phone:note {participant_id, topic_id, text, t_ms}`
- `scribe:utterance {text, t_ms}` (hotkey/wake word result; not a meeting segment)
- `job:update {job_id, kind, status, result?}`
- `model:download {model_id, bytes, total, done}`

### Commands (UI → Rust)
`create_meeting`, `start`, `pause`, `resume`, `stop`, `seek_play {t_ms}`, `play_span {t0,t1}`, `list_devices`, `set_devices`, `set_stt {engine, model}`, `download_model`, `set_hotkey`, `set_wake_word`, `speak {text}` / `stop_speaking`, `start_phone_room` → `{join_url, qr_png}`, `end_phone_room`, `run_research {card_id, query}`, `send_telegram {participant_id, text}`, `send_email {to, subject, body}`, `write_ics {…}`, `export {kind}`, `set_retention`.

## 3. Map engine (`src/engine/`, pure TS)

### 3.1 Data model (also the SQLite schema)
```
meetings(id, title, started_at, ended_at, mode: group|solo, privacy: local|cloud, agenda_json, summary_md, layout_instruction)
participants(id, meeting_id, name, source: host|phone|guest, telegram_chat_id?, email?)
segments(id, meeting_id, t0_ms, t1_ms, speaker_participant_id?, speaker_label, source, text, confidence)   -- FTS5 on text
topics(id, meeting_id, parent_id?, title, kind: header|topic, order_key, status: active|pinned|done, off_agenda bool, created_t_ms, pinned_t_ms?, revisited_t_ms?)
cards(id, meeting_id, topic_id, kind: note|decision|action|research|quote, text, owner_participant_id?, due_text?, due_date?, segment_ids_json, status: proposed|accepted|dismissed, source: engine|user|scribe, created_t_ms, confirmed bool)
suggestions(id, meeting_id, kind: move|merge|pin, payload_json, status: open|accepted|dismissed, created_t_ms)
highlights(id, meeting_id, t0_ms, t1_ms, label)
notes(id, meeting_id, participant_id, topic_id?, t_ms, text, shared bool)
scribe_log(id, meeting_id, t_ms, query, intent, answer, ok bool)
jobs(id, meeting_id, kind: research, query, status, result_json, card_id?)
consent_log(id, meeting_id, participant_id?, event, t_ms, detail)
settings(key, value_json)
```
Ids: ULIDs generated client-side (`c_…`, `t_…`); the LLM never mints ids. It refers to existing topics by id and proposes new topics with a `tmp_key` that the engine resolves.

### 3.2 Structurer loop
Trigger: `(silence ≥ 2000 ms && newWords ≥ 25) || (elapsedSinceRun ≥ 45 s && newWords ≥ 25)`. One run in flight; if a trigger fires during a run, run again immediately after with everything new. Runs in a Web Worker.

Input (JSON) to the LLM:
```
{ agenda: [{id, title}],
  outline: [{id, title, parent_id, off_agenda, last_cards: [{id, kind, text}]}],   // all topics, last 2 cards each
  recent_structured: "…",      // last 90 s of transcript already processed, for continuity
  new_segments: [{id, t0, speaker, text}],
  participants: ["Matt","Zach","Ant","Kabs"],
  now_ms }
```
Output schema (JSON Schema enforced; Ollama `format`, Anthropic tool use, or AI SDK `Output.array`):
```
ops: Array<
 | {op:"add_card", topic_id?: string, tmp_topic?: string, kind, text, owner?: string, due_text?: string, segment_ids: string[]}
 | {op:"add_topic", tmp_key: string, title: string, parent_id?: string, off_agenda: boolean, segment_ids: string[]}
 | {op:"suggest_move", card_id: string, to_topic_id: string, reason: string}
 | {op:"suggest_merge", topic_id: string, into_topic_id: string, reason: string}
 | {op:"suggest_pin", tmp_key_or_topic_id: string, title: string, reason: string}
>
```
Engine rules on apply: drop any op not in the schema; drop add_card with empty segment_ids; `off_agenda` topics are created under the "Unplanned" column with a `suggest_pin`; owners must match a participant name (fuzzy ≥ 0.8) or are left blank; a card whose segment_ids are all already covered by an accepted card of the same kind is dropped (dedupe); never delete, never rename.

System prompt skeleton (keep in `src/engine/prompts/structurer.md`): role; rules (additive only, prefer attaching to existing topics, decisions must be explicit statements of what was agreed, actions need a person and a verb, do not create cards from agenda statements or recaps, off-agenda = does not fit any header or topic after reading the new text); output format; 3 short examples from the fixture.

### 3.3 Scribe intents
Hotkey/wake word text → `classifyIntent()` (small LLM call with a fixed schema; ≤ 1 s with cloud, ≤ 4 s local): `{intent, args}` where intent ∈ move_card | set_kind | assign_action | pin_topic | revisit_topic | schedule | summary_style | question | research | note | unknown. Resolution of "that"/"this": the most recent card added, or the card under the mouse/selected. Execute through the same engine API as the UI (so undo works). `question` → retrieval: FTS5 top-20 segments + outline → LLM answer with `[00:01:06]` links; if retrieval finds nothing relevant the model answers from its own knowledge and the answer is labelled "from the model, not verified" with a Research button. `research` → job (below). `unknown` → ask once in the panel, never aloud.

Research job (`src/engine/research.ts`, runs in Rust or a worker, never on the UI thread): `SearchProvider` interface with `brave` (default; free 2,000 queries/month, then about $3 per 1,000) and `tavily` implementations → top 3–5 URLs → fetch and extract readable text (Rust `reqwest` + a readability crate, 2 MB cap, 10 s timeout each) → LLM summary with numbered citations → `add_card {kind: research}` under the originating topic, `job:update done` event, panel line, optional single spoken notice in speaking mode. Queries and results are stored in `jobs`; the raw pages are not kept.

### 3.4 Summary
Input: full outline with all accepted cards, pins, highlights, participants, layout_instruction (free text) or preset. Output Markdown with fixed section ids so the end screen can map edits back. Per-person drafts are generated from accepted action cards grouped by owner: "Hi {name}, from today's {title}: … (due …). Full notes: {link or attached}".

## 4. Phones (`join-page/` + `src-tauri/src/phones/`)
- Host calls Vercel function `POST /api/room` → creates LiveKit room `scribe-{meeting_id}`, returns host token and a join URL `https://join.<domain>/m/{code}` (single-use per phone; the function mints participant tokens on `POST /api/join {code, name}`).
- Join page (Vite + React, livekit-client JS): consent → name → `getUserMedia` (HTTPS required) → publish audio track; subscribe to the host's data channel for `map:snapshot` and `map:patch`; send `note` and `pause` as data messages; `navigator.wakeLock.request('screen')`.
- Host (Rust `livekit` SDK): subscribe to all remote audio tracks; compute RMS per 20 ms; `rust-dominant-speaker` picks the dominant track; per VAD utterance the dominant track is fed to STT with `source = phone:{participant_id}`; if no phone is dominant, the laptop mic is used. Overlap: if two tracks are both above threshold for > 1 s, transcribe both and label both (rare; accept duplicates, dedupe by text similarity + overlap).
- LAN: LiveKit Cloud handles signalling and TURN; media takes the direct ICE path when the network allows. Self-host later via Tauri sidecar.
- Telegram pairing: the join page's "Get your action items on Telegram" button opens `t.me/{bot}?start={participant_code}`; the bot's webhook (same Vercel function) maps `chat_id → participant`.

## 5. Vendored code (`crates/vendor/`)
Copy by commit with LICENSE files; record commit SHAs in `docs/DECISIONS.md`.
- `fastrepl/anarlog` crates: `audio-actual`, `aec`, `vad` (MIT; do not copy anything under `enterprise/`)
- `Zackriya-Solutions/meetily` cpal/WASAPI loopback (MIT) as the second reference when Anarlog's capture misbehaves
- `thewh1teagle/vibe` crates `vad-rs`, `nemotron-diarize-rs` (MIT) — v1.1 diarization
- Engines/bindings via crates.io: `sherpa-rs`, `livekit`, `rust-dominant-speaker`, `hound`, `lettre`, `icalendar`
- Do not vendor: tldraw, Screenpipe, Amurex, Peaks.js, Piper, Porcupine, ELK, react-beautiful-dnd.

## 6. Secrets, privacy, retention
- Keys in `tauri-plugin-store` (plaintext) for v1; migrate to OS keychain in v1.1.
- Local mode: the only outbound connections are LiveKit (if phones joined) and the token function. The network test in TEST_PLAN enforces this.
- Retention job on app start and daily: delete audio chunks past the setting; log to `consent_log` as `retention_delete`.
- Logs: `tauri-plugin-log`, info level never includes transcript text, audio paths or keys.

## 7. Build and packaging
- Windows installer via Tauri NSIS bundler; `webviewInstallMode: embedBootstrapper`; `dragDropEnabled: false` in `tauri.conf.json` (so HTML drag events reach the webview; dnd-kit is pointer-based anyway).
- Updater: `tauri-plugin-updater` with a static JSON on GitHub Releases (sign with minisign; keep the private key out of the repo).
- CI: GitHub Actions `windows-latest`: `pnpm check`, `pnpm test`, `cargo test`, `pnpm tauri build` on tags.
- Models are not bundled; downloaded on first run from Hugging Face mirrors; SHA-256 verified.
