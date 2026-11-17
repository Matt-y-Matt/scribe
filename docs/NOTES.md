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

### Verified on the reference PC (2026-11-17, Ryzen 5 2600, RTX 3070, Windows 10)
- `pnpm install`, `pnpm check`, `pnpm test` and `pnpm tauri dev` all passed. The Scribe window opens on Home.
- The window stops shrinking at the 1280 × 800 minimum, and the app follows the Windows dark-mode setting.
- `pnpm install` failed once while pnpm switched itself to the pinned 10.28.0; a retry worked with no changes.
- Commands must be run from `C:\dev\scribe`. From any other folder pnpm reports `Command "tauri" not found`.

### Not verified
- Settings persistence through `tauri-plugin-store` (`src/lib/settings.ts`) is unit-tested with a mock only. Nothing in the UI writes a setting yet, so no store file exists on the PC.

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

### Golden test
G1–G6 are answered (2026-11-17): see `docs/DECISIONS.md` and the scoring rules in `docs/TEST_PLAN.md` §2.

### Later milestones
- **L1** Answered (2026-11-17): a non-local AI provider is cloud mode. The exact confirmation copy is still to be written with the Settings AI tab.
- **L2 (M2)** PRD F3.5 and M2 require a transcript panel; the UI_SPEC §2 layout has no place for it.
- **L3** No milestone owns: Home list and search, the Pre-meeting sheet, the Settings shell, Speechmatics cloud transcription, the Ctrl+K palette, solo mode, the minimum-spec check. M2's manual test already needs the first three.
- **L4** Pause is "one click" and "within 300 ms", but the status strip uses a 300 ms hold-to-confirm.
- **L5** "No red except the indicator" against Start recording turning red on hover and the phone's red-outline Pause.
- **L6 (M3)** The wake-word chime against silent group mode.
- **L7 (M4)** "QR with a one-time token" against one code per meeting that mints per-phone tokens.
- **L8** The golden test is `tests/golden.test.ts` in BUILD_PLAN and `tests/golden.ts` in TEST_PLAN. Research is a TS file in ARCHITECTURE §3.3 but fetches through Rust.
