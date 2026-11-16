# Notes

Working notes: what is known, what is not verified, and what is still open. Decisions go in `docs/DECISIONS.md`.

## M0 — Repo, tooling, fixtures (2026-11-17)

### Gate results
- `pnpm check && pnpm test`: green locally (Linux cloud session). 48 TypeScript tests, 3 Rust tests. Windows CI: green from run 3 (see "CI on Windows" below).
- `pnpm replay fixtures/meeting-custore-weekly.jsonl --speed 10`: 46 segments, 381.2 s of meeting in 38.1 s.
- `pnpm screenshot`: writes `home-empty.light.png` and `home-empty.dark.png`; reviewed against UI_SPEC §1, §3.1 and §5.

### CI on Windows
- Run 2 (`7b04e91`): `pnpm check` green, vitest green, then `cargo test` failed at load with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139). Cause: Tauri imports Common Controls v6 functions, and tauri-build links the manifest that requests them into the app binary only (`embed_resource::compile` → bins), so no test binary that links Tauri can start.
- Fix: `src-tauri/build.rs` builds with `WindowsAttributes::new_without_app_manifest()` and has the linker embed `src-tauri/windows-app-manifest.xml` into every artifact (`/MANIFEST:EMBED`). Tauri's own `build.rs` does the same for its tests. CI also builds the app executable and checks it stays up for 8 s.
- Run 3 (`4978088`): green on `windows-latest`. `pnpm check`, `pnpm test` (48 TypeScript, 3 Rust) and the start-up smoke test all passed, so the fix holds.
- Stable cargo on CI warns that `tauri-plugin-sql` and `tauri-plugin-global-shortcut` are unused dependencies. Expected until M2 and M3 register them.

### Not verified
- **The app has not been launched.** M0 was built in a Linux container, which can compile, lint and test the Rust core but cannot open the Windows app. Run `pnpm tauri dev` once on the PC and confirm the window opens on Home.
- Settings persistence through `tauri-plugin-store` (`src/lib/settings.ts`) is unit-tested with a mock only; it first runs for real under `pnpm tauri dev`.

### First run on the Windows PC
1. `pnpm install`
2. `pnpm exec playwright install chromium` (once; `@playwright/test` is pinned to 1.63.0)
3. `pnpm check && pnpm test`, then `pnpm tauri dev`

### Things M0 left deliberately unfinished
- The **New meeting** button does nothing: the Pre-meeting sheet it opens belongs to no milestone yet (L3 below).
- There is no theme control in the UI. The app follows the OS until Settings exists; `setThemePreference()` in `src/lib/theme.ts` is ready for it.
- The app icons are the template's placeholders (`src-tauri/icons/`).
- `tauri-plugin-sql` and `tauri-plugin-global-shortcut` are dependencies but not registered; M2 and M3 wire them.
- No `playwright.config.ts` yet: M0 has screenshots but no Playwright tests. M1 adds both.

### For the next session
- **shadcn registry is unreachable from the cloud environment** (`ui.shadcn.com` is not on its network allowlist). M1 needs several components. Either allow that host for the environment, or run `pnpm dlx shadcn@latest add <component>` on the PC. `components.json` is already in place.
- eslint is on 9.x, as the template pinned it; npm now marks 9.x unsupported. Moving to 10 needs the React plugins checked first.
- Local `cargo clippy` / `cargo test` on Linux need `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev`. They are not part of the Windows build.
- The replay sink only receives `segment:final`. With finals alone the engine cannot tell a long utterance in progress from silence, so the "silence ≥ 2 s" trigger needs either the utterance start time or a VAD event (see G3).

## Open spec questions

Raised at kickoff, not yet answered. Fix them in the docs before the session that needs them.

### Golden test — before M1
- **G1** The answer key cannot pass its own scoring. Counting exactly the expected cards, topic coverage is CLA 9/15, suppliers 4/6, designer 2/6, aircon 0/3, pop-up 0/1, all under the 80% in TEST_PLAN §2.
- **G2** "≥ 80% under one engine topic": the wireframe and the scribe script assume CLA splits into Pricing and Artwork, and then no single topic reaches 80% of CLA's segments.
- **G3** Pin timing. PRD F5.1 waits 60 s off-topic; ARCHITECTURE §3.2 suggests a pin immediately; the fixture windows are 36.7 s (aircon) and 21.9 s (pop-up). The fixture has no silence of 2 s or more (longest gap 0.8 s), so only the 45 s rule fires. Does "between s023 and s026" refer to the suggestion's segments? Is the 45 s meeting time or wall time (at 10× the whole fixture is 38 s)?
- **G4** `pins_at_end`: nobody confirms a pin during a replay. Does Matt saying "put a pin in it" in the meeting count, does the test auto-accept, or is this unscored?
- **G5** Card matching: is it one-to-one, and what counts as a wrong owner where s010 carries both a Kabs action and a Matt action?
- **G6** Owner fuzzy match ≥ 0.8: the metric is not named. "Kabir" → Kabs is 0.85 by Jaro-Winkler and 0.6 by Levenshtein ratio.

### Later milestones
- **L1 (M1)** Rule 4 forbids transcript text leaving without the cloud switch, but the switch is defined only for Speechmatics. A cloud LLM provider sends transcript text regardless, and the M1 gate allows Anthropic.
- **L2 (M2)** PRD F3.5 and M2 require a transcript panel; the UI_SPEC §2 layout has no place for it.
- **L3** No milestone owns: Home list and search, the Pre-meeting sheet, the Settings shell, Speechmatics cloud transcription, the Ctrl+K palette, solo mode, the minimum-spec check. M2's manual test already needs the first three.
- **L4** Pause is "one click" and "within 300 ms", but the status strip uses a 300 ms hold-to-confirm.
- **L5** "No red except the indicator" against Start recording turning red on hover and the phone's red-outline Pause.
- **L6 (M3)** The wake-word chime against silent group mode.
- **L7 (M4)** "QR with a one-time token" against one code per meeting that mints per-phone tokens.
- **L8** The golden test is `tests/golden.test.ts` in BUILD_PLAN and `tests/golden.ts` in TEST_PLAN. Research is a TS file in ARCHITECTURE §3.3 but fetches through Rust.
