<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-023: tmux-play Default Config Refresh — 1080p@18pt Grid, Equal Columns, Opus 4.8

## Goal

Refresh the shipped `tmux-play` defaults so first-run users land on a layout sized for **18pt monospace on a 1920×1080 display** and on the current generation of models:

- Shrink the default tmux cell grid from `240×67` (the legacy 16:9 grid sized for ~8pt monospace on 1080p) to `174×49`, the corresponding 16:9-ish cell grid for ~11×22 px cells (typical 18pt monospace metrics at the canonical 96 DPI baseline).
- Replace the multi-player column-weights default from `[4, 6, 6]` (content-column bias, shipped by [IR-022](022-tmux-play-layout-configuration.md)) with `[1, 1, 1]` (equal thirds), which divides `174` into `58 / 58 / 58` exactly so the rightmost column does not have to absorb a remainder.
- Bump the Captain and default `claude` player model from `claude-opus-4-7` to `claude-opus-4-8-1m` (Opus 4.8, 1M-context variant), keeping `reasoningEffort: xhigh`.
- Keep the default `codex` player at `gpt-5.5 / xhigh` (already shipped; user request matches the current value).
- Keep the single-player column-weights default at `[1, 1]` (the user request only repositions the multi-player default; the single-player 50/50 split remains unchanged).
- Keep the default `permissions: { mode: 'auto' }` on the Captain and both players unchanged.

The configurability surface introduced by [IR-022](022-tmux-play-layout-configuration.md) is unchanged; only the shipped default values move.

## Status

Planned

## Scope

In scope:

- [TMUX-011](../user/tmux-play.md#tmux-011): amend the default home YAML — Captain and `claude` player to `model: claude-opus-4-8-1m`; explicit `layout` block to `window: { columns: 174, rows: 49 }` and `columnWeights: [1, 1, 1]`. The Codex player keeps `model: gpt-5.5`. `reasoningEffort: xhigh` and `permissions: { mode: 'auto' }` remain on all three roles.
- [TMUX-028](../user/tmux-play.md#tmux-028): amend the shipped multi-player default from `[4, 6, 6]` to `[1, 1, 1]`, so each of the three visible columns receives `floor(W / 3)` cells and the rightmost column absorbs the remainder. The single-player default of `[1, 1]` is preserved.
- [TMUX-035](../user/tmux-play.md#tmux-035): amend the default `new-session -x/-y` grid from `240×67` to `174×49`. The "16:9 cell grid sized for a 1920×1080 display" framing is preserved; the cell-size assumption shifts from ~8×16 px (legacy) to ~11×22 px (typical 18pt monospace on 96 DPI screens).
- [TMUX-043](../user/tmux-play.md#tmux-043): amend the default pre-attach CSI 8 payload from `\x1b[8;67;240t` to `\x1b[8;49;174t`. The single-source-of-truth rule (the CSI 8 sequence and `new-session -x/-y` read the same `layout.window`) is unchanged.
- [TMUX-044](../user/tmux-play.md#tmux-044): amend the "shipped-defaults collapse" example so multi-player collapses to `[1, 1, 1]` → `floor(W / 3)` per column with the rightmost absorbing the remainder. The single-player `[1, 1]` collapse line is unchanged.
- [TMUX-064](../user/tmux-play.md#tmux-064): amend two default-value clauses — `layout.window` defaults to `{ columns: 174, rows: 49 }` instead of `{ columns: 240, rows: 67 }`; missing-sub-field defaults track the new full default (174 / 49); multi-player `columnWeights` defaults to `[1, 1, 1]` instead of `[4, 6, 6]`. The single-player `[1, 1]` default is preserved. The validation rules and snapshot-preservation rules are unchanged.
- [TTMUX-001](../test/tmux-play.md#ttmux-001): amend the default-config assertion — Captain and `claude` player shall use `model: claude-opus-4-8-1m`; Codex player shall continue to use `model: gpt-5.5` (unchanged). `reasoningEffort: xhigh` and `permissions: { mode: 'auto' }` remain asserted on all three roles.
- [TTMUX-014](../test/tmux-play.md#ttmux-014): amend the default-weights assertion — with no `layout.columnWeights` in YAML and two or more players, the defaults are `[1, 1, 1]` (not `[4, 6, 6]`). Single-player default `[1, 1]` is unchanged.
- [TTMUX-021](../test/tmux-play.md#ttmux-021): amend the default-window assertion — the `new-session` invocation shall request `174` columns by `49` rows (not `240×67`). The explicit-override case is unchanged.
- [TTMUX-022](../test/tmux-play.md#ttmux-022): amend the two-or-more-players column-width assertion to the new `[1, 1, 1]` default on the `174`-cell window: Boss/Captain `58`, first player column `58`, second player column `58` (174 = 3×58 exactly; no remainder absorption needed). The `60 / 90 / 90` shape is retired.
- [TTMUX-030](../test/tmux-play.md#ttmux-030): amend the real-tmux window-size probe — `tmux display-message … '#{window_width}x#{window_height}'` shall report `174x49` (not `240x67`).
- [TTMUX-031](../test/tmux-play.md#ttmux-031): amend the real-tmux pane-geometry probe to the new `[1, 1, 1]` default on the `174`-cell grid: Boss/Captain at `pane_left=0` with effective width 58 columns (less tmux's 1-cell border), first player column at `pane_left=58` with effective width 58 columns (less the 1-cell border), second player column at `pane_left=116` with effective width 58 columns.
- [TTMUX-034](../test/tmux-play.md#ttmux-034): amend the default CSI 8 byte sequence — `\x1b[8;49;174t` (not `\x1b[8;67;240t`). The explicit-override case continues to assert `\x1b[8;50;200t` against `columns: 200, rows: 50`.
- [TTMUX-035](../test/tmux-play.md#ttmux-035): amend the multi-player default formula collapse — with `[1, 1, 1]`, Boss = `floor(W * 1 / 3)`, first player = `floor(W * 1 / 3)`, second player = remainder. Sample-size sweeps (`80×24`, `160×40`, `200×50`) and the explicit `[1, 1, 1]` override line collapse to one and the same formula and continue to hold; the explicit-override probe shall pick a non-equal weights set (for example `[3, 5, 5]`) so the test still distinguishes "default" from "override" behavior.
- [TTMUX-064](../test/tmux-play.md#ttmux-064): amend the snapshot-default assertions — with no `layout` in YAML, the snapshot shall carry `layout: { window: { columns: 174, rows: 49 }, columnWeights: [1, 1] }` for one player and `layout: { window: { columns: 174, rows: 49 }, columnWeights: [1, 1, 1] }` for two or more players. The partial-`layout.window` example shall update its expected default to `{ columns: 200, rows: 49 }` (supplied `columns: 200`, missing `rows` defaults independently to the new `49`). The "wholesale fallback is forbidden" invariant is unchanged.
- [DR-004](../decisions/004-tmux-play-captain-architecture.md): amend the example YAML in the architecture record to use `model: claude-opus-4-8-1m` so the DR's illustrative snippet does not drift from the shipped default.
- `src/app/tmux-play/config.ts`: update `DEFAULT_TMUX_PLAY_CONFIG` — `layout.window: { columns: 174, rows: 49 }`, `layout.columnWeights: [1, 1, 1]`, Captain `model: claude-opus-4-8-1m`, `claude` player `model: claude-opus-4-8-1m`. The schema, default-resolution helpers (`defaultColumnWeights`, `DEFAULT_LAYOUT_WINDOW`), and validation paths shall move in lockstep so the loader's per-call defaults agree with the YAML emitted by first-run auto-create.
- `src/app/tmux-play/config.test.ts`: update the `validConfig()` fixture's layout block to the new defaults; update the `auto-creates a home default on first run` assertions (model values, layout values); update the two `defaults the layout block when YAML omits it` cases (multi-player → `[1, 1, 1]` and `{174, 49}`; single-player → `[1, 1]` and `{174, 49}`); update the partial-window default test to reflect `{ columns: 200, rows: 49 }` for the supplied `columns: 200`. The remaining tests (permissions, reasoningEffort, theme, snapshot rewriting) are value-independent of the new defaults and shall not move.
- `src/app/tmux-play/launcher.test.ts`: update the multi-player geometry assertion to the new `[1, 1, 1] × 174` layout — `new-session -x 174 -y 49`; `split-window -h -l 116` for the player area (`174 - floor(174 * 1 / 3) = 174 - 58 = 116`); `split-window -h -l 58` for the second player column (remainder of the player area); per-column expectations `bossColumns: 58, firstPlayerColumnColumns: 58, secondPlayerColumnColumns: 58`. Update the multi-player resize-hook expectation to `… resize-pane … -x $((W * 1 / 3 - 1)) && tmux resize-pane … -x $((W * 1 / 3 - 1))`. Update the `requests a … terminal resize before attach` test (and its negative twin) to assert the new `\x1b[8;49;174t` sequence. Update the `it.each` 4-player and 5-player grid cases to the new `[1, 1, 1]` splits (`-l 116` for player area, `-l 58` for the second player column). The single-player resize-hook test (`[1, 1] → $((W * 1 / 2 - 1))`) and the explicit-override case (`200×50, [3, 5, 7]`) are unchanged because they exercise non-default paths.
- `src/app/tmux-play/launcher.acceptance.test.ts`: update the `it.each` window-size parameter set to `[[174, 49], [160, 40]]` (replacing the existing `[[240, 67], [160, 40]]`), update the "creates a … session with N panes" test name and assertions to the new `174×49` grid and `58 / 58 / 58` per-column widths, and update the `captured.claude` model lookup from `claude-opus-4-7` to `claude-opus-4-8-1m`. The explicit-override case continues to exercise `160×40` with a non-default weights vector.
- `src/app/tmux-play/cli.smoke.test.ts`: update the synthesized YAML's Captain `model` from `claude-opus-4-7` to `claude-opus-4-8-1m` so the smoke fixture does not drift from the shipped default.
- `src/app/tmux-play/fanout.acceptance.test.ts`: no change required; this suite does not pin a Captain model identifier as a literal.
- `README.md`: update the `Cligent` example snippet's `model` from `'claude-opus-4-7'` to `'claude-opus-4-8-1m'`.
- `docs/tmux-play.md`: update the example YAML's Captain `model` from `claude-opus-4-7` to `claude-opus-4-8-1m`.
- `specs/map.md`: index IR-023.

Out of scope:

- The `claude-opus-4-8-1m` SDK behavior, pricing, and capability deltas vs `claude-opus-4-7`. The identifier is a literal string forwarded to `@anthropic-ai/claude-agent-sdk` per [CLAUDE-001](../user/adapters/claude-code.md#claude-001); cligent is not responsible for the upstream model availability and shall not gate the YAML loader on it.
- The single-player multi-column default. The user request explicitly targets the multi-player default; the single-player `[1, 1]` 50/50 split is retained so single-player users see no behavioral change.
- The `permissions` defaults. The user request does not move them; the existing `permissions: { mode: 'auto' }` on Captain and all default players remains, consistent with [DR-005](../decisions/005-per-adapter-permission-configuration.md) and [TMUX-011](../user/tmux-play.md#tmux-011)'s rationale.
- The `theme: auto` default. Unchanged.
- The reasoning-effort defaults (`xhigh` on all three roles). Unchanged.
- Per-adapter unit-test fixtures in `src/__tests__/{claude-code,codex}-adapter.test.ts` that reference `claude-opus-4-7` / `gpt-5.5` as opaque identifiers for adapter-behavior assertions (system-message normalization, `model_not_found` error paths, etc.). Those are not the tmux-play default surface and shall remain untouched so the adapter tests keep exercising their intended behavior independent of the tmux-play shipped default.
- The default window-size negotiation [TMUX-035](../user/tmux-play.md#tmux-035) describes for attached clients. A terminal attached at a different size still renegotiates; the YAML field only controls the launcher-requested initial grid.

## Mechanism notes (pinned by this IR)

### Cell-grid math: why `174×49` for 1080p at 18pt

On the canonical 96 DPI logical baseline used by the desktop OSes that drive `tmux-play`'s primary deployment surface (macOS Retina-doubling notwithstanding; the OS reports logical pixels), an 18pt monospace glyph computes as:

- Height: `18pt × (96 / 72) px/pt = 24 px` for the em-square. Real-world monospace line height is typically `~0.92×` em — `Menlo`, `SF Mono`, `JetBrains Mono`, and `Consolas` all land in the `21.6 – 22.5 px` range at 18pt under default line-spacing. We pick `22 px` as the representative line height; `1080 / 22 ≈ 49.09`, so `49` rows is the largest integer that fits.
- Width: monospace glyph width is `~0.6×` em for the typical 18pt face, landing in the `10.8 – 11.2 px` range. We pick `11 px` as representative; `1920 / 11 ≈ 174.55`, so `174` columns fits.

The chosen `174 × 49` grid:

- Sits inside `1920 × 1080` for the typical-metric cells (`174 × 11 = 1914`, `49 × 22 = 1078`), leaving a few-pixel margin that is consumed by terminal window chrome on every major host.
- Preserves the [TMUX-035](../user/tmux-play.md#tmux-035) "16:9 cell grid" framing: the cell ratio is `1 : 2` (`11 : 22`), and `174 × 1 : 49 × 2 = 174 : 98 ≈ 16 : 9` (within 1%).
- Divides cleanly by `3` (`174 / 3 = 58`), so the new `[1, 1, 1]` multi-player default does not require the rightmost column to absorb a remainder. Under the [TMUX-044](../user/tmux-play.md#tmux-044) formula, every column gets `floor(W * 1 / 3) = floor(174 / 3) = 58` cells, and the remainder is `0`.

The legacy `240 × 67` baseline assumed ~`8 × 16 px` cells (`240 × 8 = 1920`, `67 × ~16.1 = 1080`), which corresponds to a `12pt`-equivalent monospace face under the same 96 DPI math. That assumption is conservative for modern Retina-class displays where users routinely run 16–20pt fonts; bumping to 18pt is the explicit user direction here, and the math above is the smallest-arithmetic justification for `174 × 49` over neighboring candidates (`160 × 45`, `180 × 50`, `162 × 45`).

### Why `[1, 1, 1]` over the IR-022 `[4, 6, 6]` default

[IR-022](022-tmux-play-layout-configuration.md) shifted the multi-player default from equal thirds to `[4, 6, 6]` on the rationale that the Boss/Captain pane is the input column and the player columns are content. The user request reverses that posture: with the `174`-cell grid, `4 : 6 : 6` would give Boss `floor(174 * 4 / 16) = 43`, first player `floor(174 * 6 / 16) = 65`, second player `66` (remainder), which is asymmetric and does not match the user-requested `1 : 1 : 1`. The equal-thirds default at `174` gives `58 / 58 / 58` exactly. Users who prefer the IR-022 posture can still set `columnWeights: [4, 6, 6]` in YAML; the configurability surface is unchanged.

### Why `claude-opus-4-8-1m`

The shipped default is a literal string forwarded into the Claude Code SDK via `CligentOptions.model` per [CLAUDE-001](../user/adapters/claude-code.md#claude-001). Anthropic's model-identifier convention for the Opus tier is `claude-opus-<major>-<minor>[-<context-variant>]` (the same shape that gave us `claude-opus-4-7`). The `-1m` suffix marks the 1M-token-context variant; selecting it as the default matches the user's "Opus 4.8 1M" request directly. If the upstream SDK rejects the identifier at run time, the failure surfaces as a normal adapter error per [CLAUDE-002](../user/adapters/claude-code.md#claude-002) without affecting loader behavior — the tmux-play loader treats `model` as an opaque string per [TMUX-006](../user/tmux-play.md#tmux-006).

### Snapshot consumption

Per [TMUX-034](../user/tmux-play.md#tmux-034), the launcher writes a resolved config snapshot the session subprocess reads. The launcher resolves any missing `layout` values to their defaults before writing the snapshot, so the snapshot always carries concrete `window.columns` / `window.rows` / `columnWeights`. After this IR, the resolved-default values for the snapshot are `{ columns: 174, rows: 49 }` and (for two or more players) `[1, 1, 1]`. The "snapshot is the single point of truth for session mode" invariant is unchanged.

## Deliverables

- [ ] `specs/user/tmux-play.md` — amend TMUX-011, TMUX-028, TMUX-035, TMUX-043, TMUX-044, TMUX-064 to the new defaults.
- [ ] `specs/test/tmux-play.md` — amend TTMUX-001, TTMUX-014, TTMUX-021, TTMUX-022, TTMUX-030, TTMUX-031, TTMUX-034, TTMUX-035, TTMUX-064 to the new defaults.
- [ ] `specs/decisions/004-tmux-play-captain-architecture.md` — amend the example YAML's Captain model identifier.
- [ ] `specs/map.md` — index IR-023.
- [ ] `src/app/tmux-play/config.ts` — `DEFAULT_TMUX_PLAY_CONFIG`, `DEFAULT_LAYOUT_WINDOW`, `defaultColumnWeights` updated in lockstep.
- [ ] `src/app/tmux-play/config.test.ts` — `validConfig()` fixture, `auto-creates a home default on first run` model + layout assertions, single- and multi-player default-layout assertions, partial-window default assertion.
- [ ] `src/app/tmux-play/launcher.test.ts` — multi-player geometry assertions, resize-hook expectations, CSI 8 sequence assertions, `it.each` 4/5-player grid cases.
- [ ] `src/app/tmux-play/launcher.acceptance.test.ts` — `it.each` window-size set, multi-player real-tmux geometry, `captured.claude` model lookup.
- [ ] `src/app/tmux-play/cli.smoke.test.ts` — synthesized YAML Captain model identifier.
- [ ] `README.md` — `Cligent` example snippet model identifier.
- [ ] `docs/tmux-play.md` — example YAML Captain model identifier.

## Tasks

Each task is one commit.

1. [ ] **Spec items + map.** Amend TMUX-011 / TMUX-028 / TMUX-035 / TMUX-043 / TMUX-044 / TMUX-064 in `specs/user/tmux-play.md`; amend TTMUX-001 / TTMUX-014 / TTMUX-021 / TTMUX-022 / TTMUX-030 / TTMUX-031 / TTMUX-034 / TTMUX-035 / TTMUX-064 in `specs/test/tmux-play.md`; amend the example YAML Captain model identifier in `specs/decisions/004-tmux-play-captain-architecture.md`; add the IR-023 row to `specs/map.md` and refresh the TMUX package summary line if and only if the new defaults change the summary surface (the current summary line names the `layout` field but not its values, so no edit is required there). Docs-only commit.

2. [ ] **Config defaults + config tests.** Update `DEFAULT_TMUX_PLAY_CONFIG` in `src/app/tmux-play/config.ts` to the new defaults (`layout.window: { columns: 174, rows: 49 }`, `layout.columnWeights: [1, 1, 1]`, Captain and `claude` player `model: claude-opus-4-8-1m`). Update `DEFAULT_LAYOUT_WINDOW` to `{ columns: 174, rows: 49 }` and `defaultColumnWeights` to return `[1, 1, 1]` for `playerCount >= 2`. Update `src/app/tmux-play/config.test.ts` (`validConfig()` fixture, first-run-default assertion, single/multi default-layout cases, partial-window default case). Per-task-boundary green under `npm run build` and `npm test`.

3. [ ] **Launcher tests + acceptance + remaining doc references.** Update `src/app/tmux-play/launcher.test.ts` (multi-player geometry, resize hook, CSI 8 sequence, `it.each` 4/5-player grid cases) and `src/app/tmux-play/launcher.acceptance.test.ts` (`it.each` window-size set, real-tmux geometry, `captured.claude` model lookup). Update `src/app/tmux-play/cli.smoke.test.ts`, `README.md`, and `docs/tmux-play.md` to the new model identifier. Per-task-boundary green under `npm run build`, `npm test`, and `npm run test:smoke`; `npm run test:acceptance` shall be executed inside this commit per the IR-022 precedent for default-changing acceptance updates.

## Acceptance criteria

- `npm run build`, `npm test`, and `npm run test:smoke` pass at every task boundary.
- `npm run test:acceptance` passes locally with `tmux` available; the updated real-tmux suite verifies the new `174×49` window and the new `58 / 58 / 58` multi-player column geometry, and the `captured.claude` model lookup resolves to `claude-opus-4-8-1m`.
- With no `layout` in the YAML, two configured players yield region widths matching `floor(174 / 3) = 58`, `floor(174 / 3) = 58`, and remainder `= 58`; one configured player yields the unchanged `87 / 87` split (`174 / 2 = 87`).
- With no `layout` in the YAML, the snapshot at `<workDir>/tmux-play.config.snapshot.json` carries `layout.window = { columns: 174, rows: 49 }` and the matching default `columnWeights` for the configured player count.
- With no `model` override in YAML and no `--config` override, a freshly auto-created home YAML carries `model: claude-opus-4-8-1m` for the Captain and the `claude` player, and `model: gpt-5.5` for the `codex` player; `reasoningEffort: xhigh` and `permissions: { mode: 'auto' }` are present on all three.
- Explicit YAML overrides for `layout.window`, `layout.columnWeights`, and `model` continue to be honored verbatim — no path in launcher, session, or snapshot still references the legacy `240×67`, `[4, 6, 6]`, or `claude-opus-4-7` literals once the IR is complete.
- The single-player `[1, 1]` weights default and the per-role `permissions: { mode: 'auto' }` defaults are unchanged.
