<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-023: tmux-play Default Config Refresh

## Goal

Move the shipped `tmux-play` defaults for a 1920×1080 display at 18pt monospace and the current model generation.
Only default values change; the [IR-022](022-tmux-play-layout-configuration.md) configurability surface is unchanged.

- Window grid `240×67` → `174×49`. (At ~96 DPI, 18pt monospace ≈ 11×22 px cells: `1920/11 ≈ 174`, `1080/22 ≈ 49`. Keeps the 16:9-ish framing and divides by 3 exactly.)
- Multi-player (≥2 players) `columnWeights` `[4, 6, 6]` → `[1, 1, 1]`, giving `174 / 3 = 58` per column with no remainder.
- Captain and default `claude` player `model` `claude-opus-4-7` → `claude-opus-4-8`.

Unchanged: `codex` player `model: gpt-5.5`; single-player `columnWeights: [1, 1]`; `reasoningEffort: xhigh`; `permissions: { mode: 'auto' }`; `theme: auto`.
The model string is an opaque literal forwarded to the SDK per [[claude-code-1](../packages/adapters/claude-code.md#claude-code-1)]; the loader does not validate it.

## Status

Done — Tasks 1 (specs + map), 2 (config + config tests), and 3 (launcher tests + acceptance + doc references) complete; build, unit, smoke, and acceptance suites green.

## Scope

Spec items — swap the default values only (validation rules, override paths, and single-player defaults are unchanged):

- [[tmux-play-11](../packages/tmux-play.md#tmux-play-11)]: default home YAML — Captain + `claude` player `model: claude-opus-4-8`; `layout.window: { columns: 174, rows: 49 }`; `layout.columnWeights: [1, 1, 1]`.
- [[tmux-play-28](../packages/tmux-play.md#tmux-play-28)] / [[tmux-play-44](../packages/tmux-play.md#tmux-play-44)]: multi-player default `[1, 1, 1]` → `floor(W/3)` per column, rightmost absorbs remainder (zero at `W=174`).
- [[tmux-play-35](../packages/tmux-play.md#tmux-play-35)]: `new-session -x/-y` grid `174×49`.
- [[tmux-play-43](../packages/tmux-play.md#tmux-play-43)]: pre-attach CSI 8 payload `\x1b[8;49;174t`.
- [[tmux-play-64](../packages/tmux-play.md#tmux-play-64)]: `layout.window` defaults to `{ columns: 174, rows: 49 }` (sub-fields default independently); multi-player `columnWeights` defaults to `[1, 1, 1]`.
- [[tmux-play-55](../packages/tmux-play.md#tmux-play-55)]: status-length note's initial-window reference `240` → `174` columns, tracking the [[tmux-play-35](../packages/tmux-play.md#tmux-play-35)] grid change. The `status-left-length` / `status-right-length` budgets themselves are unchanged.
- [[tmux-play-101](../packages/tmux-play.md#tmux-play-101)]: Captain + `claude` player assert `claude-opus-4-8`; `codex` still `gpt-5.5`; the created home YAML also asserts the `layout` block (`window: { columns: 174, rows: 49 }`, `columnWeights: [1, 1, 1]`) per [[tmux-play-11](../packages/tmux-play.md#tmux-play-11)].
- [[tmux-play-114](../packages/tmux-play.md#tmux-play-114)]: multi-player default weights `[1, 1, 1]`.
- [[tmux-play-121](../packages/tmux-play.md#tmux-play-121)] / [[tmux-play-130](../packages/tmux-play.md#tmux-play-130)]: window `174×49`.
- [[tmux-play-122](../packages/tmux-play.md#tmux-play-122)] / [[tmux-play-131](../packages/tmux-play.md#tmux-play-131)]: three columns at `58 / 58 / 58` (`pane_left` 0 / 58 / 116; non-rightmost content width is region − 1 for the border).
- [[tmux-play-134](../packages/tmux-play.md#tmux-play-134)]: CSI 8 sequence `\x1b[8;49;174t`.
- [[tmux-play-135](../packages/tmux-play.md#tmux-play-135)]: multi-player formula collapses to `floor(W/3)` per column; the explicit-override probe shall use a non-equal weights set (e.g. `[3, 5, 5]`) so it still distinguishes default from override.
- [[tmux-play-164](../packages/tmux-play.md#tmux-play-164)]: snapshot defaults — `{ window: { columns: 174, rows: 49 }, columnWeights: [1, 1] }` (one player) / `[1, 1, 1]` (≥2 players); partial-window case `{ columns: 200, rows: 49 }`.
- [DR-004](../decisions/004-tmux-play-captain-architecture.md): example YAML Captain model → `claude-opus-4-8`.

Source + tests:

- `src/app/tmux-play/config.ts`: `DEFAULT_TMUX_PLAY_CONFIG`, `DEFAULT_LAYOUT_WINDOW`, `defaultColumnWeights` updated in lockstep so per-call defaults match the auto-created YAML.
- `src/app/tmux-play/config.test.ts`: `validConfig()` fixture, first-run-default assertions (model + layout), single/multi default-layout cases, partial-window (`{ columns: 200, rows: 49 }`) case.
- `src/app/tmux-play/launcher.test.ts`: multi-player geometry (`-x 174 -y 49`, `split-window -h -l 116` for the player area, `-l 58` for the second column), resize-hook (`-x $((W/3 - 1))`), CSI 8 sequence, and the 4/5-player `it.each` grid cases.
- `src/app/tmux-play/launcher.acceptance.test.ts`: exactly two `acceptanceIt` blocks — the resize-invariant sweep (swap `[240, 67] → [174, 49]`, update inline math to `Math.floor(width / 3)`) and the default-geometry block (rename to `174x49 / 58/58/58`, update `displayMessage` and the three pane assertions). The explicit-override block and the tmux-play-157 reasoning-effort seam stay untouched.
- `src/app/tmux-play/cli.smoke.test.ts`: synthesized YAML Captain model → `claude-opus-4-8`.
- `README.md`: quick-start `Cligent` model → `claude-opus-4-8`.
- `docs/tmux-play.md`: example YAML Captain model → `claude-opus-4-8`, and the `## Layout` paragraph's "Sessions start on a 240x67 grid" → `174x49` (the "evenly sized 1/N" prose already matches `[1, 1, 1]`).
- `specs/map.md`: index IR-023.

Out of scope:

- Per-adapter unit-test fixtures (`src/__tests__/{claude-code,codex}-adapter.test.ts`) and the tmux-play-157 reasoning-effort seam test, which reference `claude-opus-4-7` / `gpt-5.5` as opaque per-role identifiers, not as the shipped default — left untouched.
- Single-player `[1, 1]`, `permissions`, `reasoningEffort`, `theme` defaults — unchanged.
- Upstream `claude-opus-4-8` SDK behavior/availability; a rejected identifier surfaces as a normal adapter error per [[claude-code-2](../packages/adapters/claude-code.md#claude-code-2)].

## Deliverables

- [x] `specs/user/tmux-play.md` — tmux-play-11, tmux-play-28, tmux-play-35, tmux-play-43, tmux-play-44, tmux-play-55, tmux-play-64.
- [x] `specs/test/tmux-play.md` — tmux-play-101, tmux-play-114, tmux-play-121, tmux-play-122, tmux-play-130, tmux-play-131, tmux-play-134, tmux-play-135, tmux-play-164.
- [x] `specs/decisions/004-tmux-play-captain-architecture.md` — example YAML Captain model.
- [x] `specs/map.md` — IR-023 index row.
- [x] `src/app/tmux-play/config.ts` — `DEFAULT_TMUX_PLAY_CONFIG`, `DEFAULT_LAYOUT_WINDOW`, `defaultColumnWeights`.
- [x] `src/app/tmux-play/config.test.ts` — fixture, first-run, single/multi default-layout, partial-window cases.
- [x] `src/app/tmux-play/launcher.test.ts` — geometry, resize hook, CSI 8, 4/5-player `it.each`.
- [x] `src/app/tmux-play/launcher.acceptance.test.ts` — resize-invariant sweep + default-geometry blocks.
- [x] `src/app/tmux-play/cli.smoke.test.ts` — Captain model identifier.
- [x] `README.md` — quick-start `Cligent` model identifier.
- [x] `docs/tmux-play.md` — example YAML Captain model + `## Layout` grid number.

## Tasks

Each task is one commit, green under `npm run build`, `npm test`, and `npm run test:smoke` at its boundary.

1. **Specs + map.** Amend the TMUX/TTMUX items above in `specs/user/tmux-play.md` and `specs/test/tmux-play.md`, the DR-004 example YAML, and the `specs/map.md` index row. Docs-only.
2. **Config defaults + config tests.** Update `DEFAULT_TMUX_PLAY_CONFIG`, `DEFAULT_LAYOUT_WINDOW`, `defaultColumnWeights`, and `config.test.ts`.
3. **Launcher tests + acceptance + doc references.** Update `launcher.test.ts`, the two `launcher.acceptance.test.ts` blocks, `cli.smoke.test.ts`, `README.md`, and `docs/tmux-play.md` (both the example YAML model and the `## Layout` grid number). Also run `npm run test:acceptance` (tmux required) in this commit.

## Acceptance criteria

- Every task boundary is green per the Tasks contract above; additionally `npm run test:acceptance` passes locally with `tmux` available, verifying the `174×49` window and `58 / 58 / 58` multi-player geometry.
- With no `layout` in YAML: ≥2 players yield `58 / 58 / 58`; one player yields `87 / 87`; the snapshot carries `layout.window = { columns: 174, rows: 49 }` and the matching default `columnWeights`.
- A freshly auto-created home YAML carries `model: claude-opus-4-8` for the Captain and `claude` player, `gpt-5.5` for `codex`, with `reasoningEffort: xhigh` and `permissions: { mode: 'auto' }` on all three, plus an explicit `layout` block (`window: { columns: 174, rows: 49 }`, `columnWeights: [1, 1, 1]`).
- Explicit `layout.window` / `columnWeights` / `model` overrides are honored verbatim. No default-surface code path or fixture still references `240×67`, `[4, 6, 6]`, or `claude-opus-4-7`; the excluded non-default fixtures may.
