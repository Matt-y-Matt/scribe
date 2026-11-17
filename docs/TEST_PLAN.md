# Scribe — Test Plan (v1)

"Done" for any milestone = its automated checks green in CI + its manual script passed on the reference PC (Ryzen 5 2600, RTX 3070, 16 GB, Windows) + screenshots reviewed.

## 1. Layers
| Layer | Tool | Runs | Covers |
| --- | --- | --- | --- |
| Unit (TS) | vitest | every commit, CI | engine model, op log/undo, structurer apply rules, dedupe, owner matching, intent classifier parsing, summary mapping |
| Unit (Rust) | cargo test | every commit, CI | VAD utterance splitting, chunk writer + recovery, arbitration, model catalogue/SHA, .ics and Telegram payloads |
| Golden replay | vitest + MockProvider (CI) and real provider (local) | M1 on; nightly local | end-to-end engine on `fixtures/*.jsonl` vs `*.expected.json` |
| UI behaviour | Playwright against `vite dev` with `?screen=` fixtures | every UI commit | viewport stability, ghosts, drag, undo, keyboard map, empty/error states |
| Screenshots | `pnpm screenshot` | every UI task | every screen state, light + dark; reviewed by a human (or Claude Code with Playwright MCP) against UI_SPEC |
| Audio bench | `scripts/bench_stt.ps1` | M2, then when models change | real-time factor, segment latency, memory |
| Manual scripts | this document §4–§7 | milestone gates | live meeting, scribe commands, room test with phones, dispatch |
| Network self-test | `scripts/nettest.ps1` (Windows `pktmon` or `netsh trace`) | M5, dogfood daily | zero outbound in local mode except LiveKit/token endpoint |

## 2. Golden test (M1 gate)
Input: `fixtures/meeting-custore-weekly.jsonl` replayed at 10× with simulated silences. Output: the engine's topics, cards, suggestions.
Scoring (implement in `tests/golden.ts`):
- Topic coverage: for each expected topic, ≥ 80% of its `must_cover_segments` are cited (in `segment_ids`) by the cards or topics the engine placed under the matching header. Coverage is per agenda header, so the engine may split a header into several topics (CLA into Pricing and Artwork). For aircon and pop-up, the citing cards and topic must sit under one off-agenda topic. Score per expected topic 0/1.
- Card match: an expected card matches an engine card when kind is equal, owner is equal (or both blank), and segment overlap ≥ 1. Matching is one-to-one: each engine card can satisfy at most one expected card (best assignment). Score = matched / expected.
- Wrong owner: an engine action card is a wrong owner when it overlaps at least one expected action card by segment and its owner equals none of the owners of the expected action cards it overlaps. (s010 carries a Kabs action and a Matt action; either owner is right there.)
- Pins: a `suggest_pin` exists for an off-agenda topic that cites at least one segment in s023–s026 (aircon), and another that cites at least one in s041–s042 (pop-up). The window is about which segments the suggestion cites, not when it was raised.
- Pins at end: the test accepts every pin suggestion, standing in for the host tapping Pin, then checks `pins_at_end`. Speech in the meeting ("put a pin in it") never pins by itself.
- Never rules: any violation fails the test outright.
Pass: topic coverage 5/5, card match ≥ 0.80, both pins, `pins_at_end` met, 0 wrong owners, 0 never-violations, and no op of type delete/rename accepted (assert on the op log). Record the score in `docs/NOTES.md` per provider (mock, Ollama Qwen3.5 4B, Anthropic Haiku).
Stability assertions (Playwright, same fixture): viewport transform unchanged after 20 card inserts; no topic node changes position unless the user drags or presses `T`.

## 3. Unit test list (minimum)
TS: `applyOps` drops unknown/deleting ops · dedupe by segment coverage · owner fuzzy match by Jaro-Winkler ≥ 0.8 ("Kabs"→Kabs, "Kabir"→Kabs, "Ross"→blank) · trigger logic (silence/word/elapsed cases, no overlap) · undo/redo depth 50 · intent parse for 10 classes · summary section ids round-trip after edit · ULID monotonicity.
Rust: VAD splits a synthetic 40 s tone-with-gaps into expected utterances · 30 s max utterance · chunk writer recovers after truncation · dominant-speaker picks the loudest sustained track and ignores 100 ms spikes · SHA-256 mismatch rejects a model · `.ics` validates (RFC 5545 lines, CRLF) · Telegram message escaping.

## 4. Manual: live meeting (M2 gate)
1. Fresh launch; Settings → Audio: pick mic and enable loopback; Speech: Parakeet downloaded.
2. New meeting "Bench 60", agenda "A, B, C". Start. Speak for 2 minutes; play a 20-minute podcast through the speakers; talk over it twice.
3. Check: podcast text appears with source `system`; your speech with `laptop`; no doubled text from AEC failure; segments appear ≤ 2 s after you stop speaking (stopwatch, 10 samples, report median).
4. Run to 60 minutes (any audio). Memory via Task Manager at 0/30/60 min; growth < 300 MB.
5. At 45 min, kill the process from Task Manager. Relaunch. Expect: "Recover meeting Bench 60?" → transcript and audio up to the last chunk; timeline plays.
6. Timeline: click 5 segments, measure seek latency (< 200 ms); drag a highlight; it appears as a quote card.
Pass: all of the above; screenshots `live.png`, `paused.png`, `nomic.png`, `model-missing.png` in light and dark match UI_SPEC.

## 5. Manual: scribe script (M3 gate) — 20 commands, 18 must pass
Run on the replayed fixture (paused at the end) with the real provider. Hold the hotkey and say each line.
1. "put that under pricing" (last card → topic Pricing) 2. "that's a decision" (last note → decision) 3. "Ant owns the mockups by Wednesday" (action with owner+due) 4. "pin this" (active topic pinned) 5. "revisit the aircon" (pinned topic active) 6. "schedule the pop-up for next week" (schedule entry) 7. "what did we decide on CLA?" (3 decisions with time links) 8. "who owns the lead times?" (Zach, link) 9. "check whether the MAS outsourcing guidelines apply to recording client calls" (research job → card with sources) 10. "note: Ross prefers email over calls" (note card under active topic) 11. "move the Pantone action to artwork" 12. "make that a quote" 13. "summarise decisions and actions only" (summary style set) 14. "what's still pinned?" 15. "undo" 16. "when did Zach mention Dongguan?" (time link) 17. "assign the job description to Ant, due Friday" 18. "merge artwork into pricing" (asks for confirmation; does not merge until yes) 19. "delete that" (asks for confirmation) 20. "hey scribe, pin it" (wake word path, if shipped; else hotkey).
Pass: ≥ 18 correct; no modal; no spoken output in group mode; items 18–19 ask first.

## 6. Manual: room test (M4 gate)
Setup: reference PC + 4 phones (at least 1 iPhone, 1 Android), same Wi-Fi, then repeat on guest Wi-Fi with client isolation if available.
1. Pre-meeting shows QR; each phone: consent → name → live page; status strip shows 4 meters.
2. Read the fixture aloud, each person reading their own speaker's lines, phones face-up, screens on. 46 utterances.
3. Check: each segment's speaker label; count correct; count duplicates (same text twice).
4. Lock one iPhone for 60 s: its meter drops; the banner was shown; the laptop fallback labels that speaker "Speaker ?" or the laptop; unlock → recovers.
5. One phone taps Pause: all capture stops; indicator shows PAUSED on PC and phones.
6. Type a private note on a phone: appears in the host's notes list within 1 s; not visible to other phones.
Pass: ≥ 95% correct labels (44/46), ≤ 1 duplicate, pause and notes work, guest-Wi-Fi run still connects (via relay).

## 7. Manual: dispatch and privacy (M5 gate)
1. End screen: untick one action; generate "decisions and actions only, one page"; the unticked action is absent.
2. Drafts: edit Kabs's text; tap Send → Telegram message arrives at the paired chat; nothing else sent. "Send all" → confirm dialog lists recipients → all arrive.
3. `.ics` for a pinned topic opens in Outlook/Google Calendar with the right title and a next-week date.
4. Privacy: set retention 30 days; backdate a meeting's audio files 31 days (change mtime); relaunch; audio gone, `consent_log` has `retention_delete`.
5. Network self-test during a 10-minute local-mode meeting without phones: 0 outbound connections from the app process; with phones: only LiveKit and the token endpoint.
6. Installer: fresh Windows 11 VM without WebView2 → install → onboarding → 5-minute meeting → one Telegram draft. Then publish a new version; the app updates itself.

## 8. Screenshot inventory (`pnpm screenshot`, light and dark)
Each state is written as `.screenshots/<state>.light.png` and `.screenshots/<state>.dark.png` (git-ignored). A state exists once it is listed in `src/screens/screens.ts`.

home-empty · home-list · premeeting · live · live-ghost · live-unplanned · live-zoomed-out · paused · nomic-error · model-missing · cloud-confirm · end-screen · end-drafts · review · settings-audio · settings-speech · settings-ai · settings-scribe · settings-sending · settings-privacy · join-consent · join-name · join-live · join-ios-banner · join-disconnected.

## 9. Bug triage during dogfood
P0 = data loss, crash, audio/text leaving the PC in local mode, wrong recipient. Fix same day. P1 = wrong owner, missed decision, map jump. Fix within the week. P2 = everything else; list and batch.
