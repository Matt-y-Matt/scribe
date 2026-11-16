# Scribe — start here

This folder is everything Claude Code needs to build v1. Do these steps on the Windows PC (Tauri builds for Windows must run on Windows).

## 1. Install once (about 30 minutes)
1. Git for Windows, Node 22 LTS, pnpm (`npm i -g pnpm`), Rust via rustup (stable, MSVC toolchain), Visual Studio Build Tools 2022 with "Desktop development with C++".
2. Claude Code (`npm i -g @anthropic-ai/claude-code`), then `claude` once to log in.
3. Ollama is already installed from the Karakeep setup; pull the structuring model: `ollama pull qwen3.5:4b`. (Or keep an Anthropic API key ready; Claude Code will ask.)
4. Optional but recommended for UI quality, run inside the repo after step 2 below:
   - `pnpm dlx shadcn@latest mcp init --client claude` (shadcn MCP)
   - `claude mcp add playwright npx @playwright/mcp@latest` (Claude can screenshot its own UI)
   - `npx ctx7 setup --claude` (Context7: current library docs)
   - `/plugin install superpowers@claude-plugins-official` and the `frontend-design` skill from `anthropics/skills`

## 2. Create the repo (5 minutes)
1. On GitHub create a private repo `scribe`. Clone it to `C:\dev\scribe`.
2. Copy this whole folder's contents into it: `CLAUDE.md`, `docs/`, `prompts/`, `fixtures/`, `START-HERE.md`.
3. Commit: `git add -A && git commit -m "Scribe spec and handover"`.

## 3. First Claude Code session
1. `cd C:\dev\scribe` then `claude`.
2. Paste `prompts/00-kickoff.md`. Read its three answers. Fix any gap it finds by editing the docs, not by letting it guess.
3. Approve the M0 plan. Let it run. Check the gate at the end of `docs/BUILD_PLAN.md` §M0.

## 4. Every milestone after that
Open a fresh session, paste the matching block from `prompts/milestones.md`, approve the plan, let it build, check the gate in `docs/TEST_PLAN.md`. Send the screenshots to the Claude chat where the product spec lives for review.

## 5. Accounts you will need by M4–M5
- LiveKit Cloud (free Build tier) — phones as mics
- Vercel — the join page and the token function (already connected to your Claude)
- A Telegram bot token from @BotFather — action-item drafts
- Brave Search API key (free plan, 2,000 queries a month) — research spin-offs; optional Tavily key as the alternative
- Optional: Speechmatics key — cloud transcription switch

## What is in this folder
- `CLAUDE.md` — the rules Claude Code reads first
- `docs/PRD.md` — requirements with acceptance criteria
- `docs/UI_SPEC.md` — screens, tokens, interaction rules
- `docs/ARCHITECTURE.md` — modules, data model, events, LLM patch protocol, what to vendor
- `docs/BUILD_PLAN.md` — milestones and gates
- `docs/TEST_PLAN.md` — automated and manual checks per milestone
- `docs/DECISIONS.md` — decision and licence log
- `prompts/` — the kickoff prompt and one prompt per milestone
- `fixtures/` — a replayable fake Custore meeting and its expected map, used by the golden test
