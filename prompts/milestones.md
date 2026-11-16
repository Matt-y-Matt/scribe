# Milestone session prompts — paste one per session, after `00-kickoff.md` has been run once

Each prompt assumes `docs/BUILD_PLAN.md` is in the repo. Replace nothing; Claude Code reads the milestone section itself.

## M0
Read `docs/BUILD_PLAN.md` §M0 and `docs/TEST_PLAN.md` §1. Plan M0 as a checklist with the commands you will run and the files you will create. Wait for my approval. Then execute. Done means: CI green on `windows-latest`, `pnpm replay fixtures/meeting-custore-weekly.jsonl --speed 10` streams 46 segments, `pnpm screenshot` writes `home-empty.png` in light and dark. Show me the screenshots.

## M1
Read `docs/BUILD_PLAN.md` §M1, `docs/ARCHITECTURE.md` §3, `docs/UI_SPEC.md` §2.2–2.3, `docs/TEST_PLAN.md` §2–3. Plan first; wait. Build in this order: engine model + op log + tests → structurer with MockProvider + golden test → real provider (Ollama if `http://127.0.0.1:11434` answers, else ask me for an Anthropic key) → map UI → Pins rail → Playwright stability tests. Done means the M1 gate in BUILD_PLAN with the golden score recorded in `docs/NOTES.md` for mock and real provider. Show me `live.png` and `live-ghost.png`.

## M2
Read §M2, ARCHITECTURE §2 and §5, UI_SPEC §2.1 and §2.5, TEST_PLAN §4. Plan first; wait. Vendor the Anarlog crates by commit with their LICENSE files before writing any capture code; if they do not build on this machine within half a day, switch to Meetily's cpal/WASAPI path and record why. Done means TEST_PLAN §4 passed on this PC with the numbers written into `docs/NOTES.md`.

## M3
Read §M3, ARCHITECTURE §3.3, UI_SPEC §2.4, TEST_PLAN §5. Plan first; wait. Hotkey and intents first, Q&A second, research third, wake word fourth, TTS last. If wake-word training exceeds two days, ship hotkey-only and log it. Done means 18/20 on the scribe script with the real provider.

## M4
Read §M4, ARCHITECTURE §4, UI_SPEC §3.6, TEST_PLAN §6. Day 1 is the spike: prove the Rust LiveKit SDK receives one phone's audio and prints RMS. Report the result before building anything else. Done means the room test passed with 4 phones; report the label accuracy and duplicate count.

## M5
Read §M5, UI_SPEC §3.3 and §3.5, ARCHITECTURE §6–7, TEST_PLAN §7–8. Plan first; wait. Done means TEST_PLAN §7 passed including the fresh-VM install and the self-update, and every screenshot in §8 exists in light and dark.

## Bug session (dogfood)
Here is today's list from dogfood, in priority order: [paste]. For each P0: reproduce with a test first, fix, run `pnpm check && pnpm test`, commit. Do not refactor anything unrelated. Report what you could not reproduce.
