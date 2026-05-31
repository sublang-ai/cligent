<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-023: tmux-play Default Config Refresh

## Goal

Move the shipped `tmux-play` defaults for a 1920×1080 display at 18pt monospace and the current model generation.
Only default values change; the [IR-022](022-tmux-play-layout-configuration.md) configurability surface is unchanged.

- Window grid `240×67` → `174×49`. (At ~96 DPI, 18pt monospace ≈ 11×22 px cells: `1920/11 ≈ 174`, `1080/22 ≈ 49`. Keeps the 16:9-ish framing and divides by 3 exactly.)
- Multi-player (≥2 players) `columnWeights` `[4, 6, 6]` → `[1, 1, 1]`, giving `174 / 3 = 58` per column with no remainder.
- Captain and default `claude` player `model` `claude-opus-4-7` → `claude-opus-4-8-1m`.

Unchanged: `codex` player `model: gpt-5.5`; single-player `columnWeights: [1, 1]`; `reasoningEffort: xhigh`; `permissions: { mode: 'auto' }`; `theme: auto`.
The model string is an opaque literal forwarded to the SDK per [CLAUDE-001](../user/adapters/claude-code.md#claude-001); the loader does not validate it.

## Status

In progress — Task 1 (specs + map) done; Tasks 2–3 (config + tests, launcher + docs) pending.

## Scope

Spec items — swap the default values only (validation rules, override paths, and single-player defaults are unchanged):

- [TMUX-011](../user/tmux-play.md#tmux-011): default home YAML — Captain + `claude` player `model: claude-opus-4-8-1m`; `layout.window: { columns: 174, rows: 49 }`; `layout.columnWeights: [1, 1, 1]`.
- [TMUX-028](../user/tmux-play.md#tmux-028) / [TMUX-044](../user/tmux-play.md#tmux-044): multi-player default `[1, 1, 1]` → `floor(W/3)` per column, rightmost absorbs remainder (zero at `W=174`).
- [TMUX-035](../user/tmux-play.md#tmux-035): `new-session -x/-y` grid `174×49`.
- [TMUX-043](../user/tmux-play.md#tmux-043): pre-attach CSI 8 payload `\x1b[8;49;174t`.
- [TMUX-064](../user/tmux-play.md#tmux-064): `layout.window` defaults to `{ columns: 174, rows: 49 }` (sub-fields default independently); multi-player `columnWeights` defaults to `[1, 1, 1]`.
- [TMUX-055](../user/tmux-play.md#tmux-055): status-length note's initial-window reference `240` → `174` columns, tracking the [TMUX-035](../user/tmux-play.md#tmux-035) grid change. The `status-left-length` / `status-right-length` budgets themselves are unchanged.
- [TTMUX-001](../test/tmux-play.md#ttmux-001): Captain + `claude` player assert `claude-opus-4-8-1m`; `codex` still `gpt-5.5`; the created home YAML also asserts the `layout` block (`window: { columns: 174, rows: 49 }`, `columnWeights: [1, 1, 1]`) per [TMUX-011](../user/tmux-play.md#tmux-011).
- [TTMUX-014](../test/tmux-play.md#ttmux-014): multi-player default weights `[1, 1, 1]`.
- [TTMUX-021](../test/tmux-play.md#ttmux-021) / [TTMUX-030](../test/tmux-play.md#ttmux-030): window `174×49`.
- [TTMUX-022](../test/tmux-play.md#ttmux-022) / [TTMUX-031](../test/tmux-play.md#ttmux-031): three columns at `58 / 58 / 58` (`pane_left` 0 / 58 / 116; non-rightmost content width is region − 1 for the border).
- [TTMUX-034](../test/tmux-play.md#ttmux-034): CSI 8 sequence `\x1b[8;49;174t`.
- [TTMUX-035](../test/tmux-play.md#ttmux-035): multi-player formula collapses to `floor(W/3)` per column; the explicit-override probe shall use a non-equal weights set (e.g. `[3, 5, 5]`) so it still distinguishes default from override.
- [TTMUX-064](../test/tmux-play.md#ttmux-064): snapshot defaults — `{ window: { columns: 174, rows: 49 }, columnWeights: [1, 1] }` (one player) / `[1, 1, 1]` (≥2 players); partial-window case `{ columns: 200, rows: 49 }`.
- [DR-004](../decisions/004-tmux-play-captain-architecture.md): example YAML Captain model → `claude-opus-4-8-1m`.

Source + tests:

- `src/app/tmux-play/config.ts`: `DEFAULT_TMUX_PLAY_CONFIG`, `DEFAULT_LAYOUT_WINDOW`, `defaultColumnWeights` updated in lockstep so per-call defaults match the auto-created YAML.
- `src/app/tmux-play/config.test.ts`: `validConfig()` fixture, first-run-default assertions (model + layout), single/multi default-layout cases, partial-window (`{ columns: 200, rows: 49 }`) case.
- `src/app/tmux-play/launcher.test.ts`: multi-player geometry (`-x 174 -y 49`, `split-window -h -l 116` for the player area, `-l 58` for the second column), resize-hook (`-x $((W/3 - 1))`), CSI 8 sequence, and the 4/5-player `it.each` grid cases.
- `src/app/tmux-play/launcher.acceptance.test.ts`: exactly two `acceptanceIt` blocks — the resize-invariant sweep (swap `[240, 67] → [174, 49]`, update inline math to `Math.floor(width / 3)`) and the default-geometry block (rename to `174x49 / 58/58/58`, update `displayMessage` and the three pane assertions). The explicit-override block and the TTMUX-057 reasoning-effort seam stay untouched.
- `src/app/tmux-play/cli.smoke.test.ts`: synthesized YAML Captain model → `claude-opus-4-8-1m`.
- `README.md`: quick-start `Cligent` model → `claude-opus-4-8-1m`.
- `docs/tmux-play.md`: example YAML Captain model → `claude-opus-4-8-1m`, and the `## Layout` paragraph's "Sessions start on a 240x67 grid" → `174x49` (the "evenly sized 1/N" prose already matches `[1, 1, 1]`).
- `specs/map.md`: index IR-023.

Out of scope:

- Per-adapter unit-test fixtures (`src/__tests__/{claude-code,codex}-adapter.test.ts`) and the TTMUX-057 reasoning-effort seam test, which reference `claude-opus-4-7` / `gpt-5.5` as opaque per-role identifiers, not as the shipped default — left untouched.
- Single-player `[1, 1]`, `permissions`, `reasoningEffort`, `theme` defaults — unchanged.
- Upstream `claude-opus-4-8-1m` SDK behavior/availability; a rejected identifier surfaces as a normal adapter error per [CLAUDE-002](../user/adapters/claude-code.md#claude-002).

## Deliverables

- [x] `specs/user/tmux-play.md` — TMUX-011, TMUX-028, TMUX-035, TMUX-043, TMUX-044, TMUX-055, TMUX-064.
- [x] `specs/test/tmux-play.md` — TTMUX-001, TTMUX-014, TTMUX-021, TTMUX-022, TTMUX-030, TTMUX-031, TTMUX-034, TTMUX-035, TTMUX-064.
- [x] `specs/decisions/004-tmux-play-captain-architecture.md` — example YAML Captain model.
- [x] `specs/map.md` — IR-023 index row.
- [ ] `src/app/tmux-play/config.ts` — `DEFAULT_TMUX_PLAY_CONFIG`, `DEFAULT_LAYOUT_WINDOW`, `defaultColumnWeights`.
- [ ] `src/app/tmux-play/config.test.ts` — fixture, first-run, single/multi default-layout, partial-window cases.
- [ ] `src/app/tmux-play/launcher.test.ts` — geometry, resize hook, CSI 8, 4/5-player `it.each`.
- [ ] `src/app/tmux-play/launcher.acceptance.test.ts` — resize-invariant sweep + default-geometry blocks.
- [ ] `src/app/tmux-play/cli.smoke.test.ts` — Captain model identifier.
- [ ] `README.md` — quick-start `Cligent` model identifier.
- [ ] `docs/tmux-play.md` — example YAML Captain model + `## Layout` grid number.

## Tasks

Each task is one commit, green under `npm run build`, `npm test`, and `npm run test:smoke` at its boundary.

1. **Specs + map.** Amend the TMUX/TTMUX items above in `specs/user/tmux-play.md` and `specs/test/tmux-play.md`, the DR-004 example YAML, and the `specs/map.md` index row. Docs-only.
2. **Config defaults + config tests.** Update `DEFAULT_TMUX_PLAY_CONFIG`, `DEFAULT_LAYOUT_WINDOW`, `defaultColumnWeights`, and `config.test.ts`.
3. **Launcher tests + acceptance + doc references.** Update `launcher.test.ts`, the two `launcher.acceptance.test.ts` blocks, `cli.smoke.test.ts`, `README.md`, and `docs/tmux-play.md` (both the example YAML model and the `## Layout` grid number). Also run `npm run test:acceptance` (tmux required) in this commit.

## Acceptance criteria

- Every task boundary is green per the Tasks contract above; additionally `npm run test:acceptance` passes locally with `tmux` available, verifying the `174×49` window and `58 / 58 / 58` multi-player geometry.
- With no `layout` in YAML: ≥2 players yield `58 / 58 / 58`; one player yields `87 / 87`; the snapshot carries `layout.window = { columns: 174, rows: 49 }` and the matching default `columnWeights`.
- A freshly auto-created home YAML carries `model: claude-opus-4-8-1m` for the Captain and `claude` player, `gpt-5.5` for `codex`, with `reasoningEffort: xhigh` and `permissions: { mode: 'auto' }` on all three, plus an explicit `layout` block (`window: { columns: 174, rows: 49 }`, `columnWeights: [1, 1, 1]`).
- Explicit `layout.window` / `columnWeights` / `model` overrides are honored verbatim. No default-surface code path or fixture still references `240×67`, `[4, 6, 6]`, or `claude-opus-4-7`; the excluded non-default fixtures may.
