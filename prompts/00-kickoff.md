# Kickoff prompt — paste into Claude Code in the empty `scribe` folder

You are building Scribe, a Windows desktop meeting secretary. Read, in this order, and do not start coding until you have: `CLAUDE.md`, `docs/PRD.md`, `docs/UI_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/BUILD_PLAN.md`, `docs/TEST_PLAN.md`, `fixtures/meeting-custore-weekly.jsonl` and its `.expected.json`.

Then:
1. Tell me, in under 200 words, what the product is and what the first milestone's gate is, so I know you read it.
2. List any contradiction or gap you found between the documents. Do not resolve them yourself; ask me.
3. Produce a plan for M0 (Repo, tooling, fixtures) only: the exact steps, the files you will create, the commands you will run, and the licence of every dependency you add. Wait for my approval before running anything.

Constraints for this and every session:
- One milestone per session. Nothing from a later milestone, even if it looks easy.
- Follow the rules in CLAUDE.md §"Rules that never bend" and the design brief literally.
- Run `pnpm check && pnpm test` before claiming anything is done. For UI work, run `pnpm screenshot` and look at the images against UI_SPEC §2 and §5.
- Record each decision and every new dependency's licence in `docs/DECISIONS.md`.
- If something fails twice, stop, write what you know in `docs/NOTES.md`, and ask me.
