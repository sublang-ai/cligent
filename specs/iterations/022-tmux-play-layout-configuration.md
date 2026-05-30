<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-022: tmux-play Layout Configuration

## Goal

Expose tmux-play's window geometry and pane-column ratios as YAML config so users can pick their initial resolution and per-column weights instead of inheriting the hardcoded `240×67` / equal-thirds layout baked into the launcher.
Shift the shipped default for the multi-player (≥2 players) case from `1 : 1 : 1` to `4 : 6 : 6` so the two content-bearing player columns each get more cells than the Boss/Captain input column.
The single-player case keeps its existing `1 : 1` default; only the multi-player default and the configurability surface are new.

## Status

Proposed

## Scope

In scope:

- [TMUX-005](../user/tmux-play.md#tmux-005): list the new optional top-level `layout` field alongside `theme`.
- New [TMUX-064](../user/tmux-play.md#tmux-064): define the `layout` schema — `layout.window.columns`, `layout.window.rows`, `layout.columnWeights` — its validation, and its defaults (window `240×67`; weights `[1, 1]` when one player, `[4, 6, 6]` when two or more players).
- [TMUX-028](../user/tmux-play.md#tmux-028): amend so the visible-column ratio derives from `layout.columnWeights` instead of being hardcoded to `1/3` (multi) or `1/2` (single). The number of visible columns still follows the player count — 2 columns with one player, 3 columns with two or more players — and the loader shall reject a `columnWeights` length that does not match.
- [TMUX-035](../user/tmux-play.md#tmux-035): amend so the initial `new-session -x/-y` dimensions come from `layout.window.columns` / `layout.window.rows`, defaulting to `240` / `67` when the YAML omits them. The 16:9 framing reasoning is retained as the rationale for the default.
- [TMUX-043](../user/tmux-play.md#tmux-043): amend so the pre-attach xterm window-manipulation request is `CSI 8 ; <rows> ; <columns> t` where `<rows>` and `<columns>` come from the resolved `layout.window.rows` / `layout.window.columns`. The default values remain `67` / `240`. Without this amendment, a user-configured `200×50` window would still ask the attached terminal to grow to `240×67`, and tmux's default `window-size` negotiation would then renegotiate the session up to `240×67` on attach — silently overriding the configured resolution at the exact moment it matters.
- [TMUX-044](../user/tmux-play.md#tmux-044): amend so the resize-invariant hook computes per-column region width as `floor(W * weight_i / sum(weights))` for non-rightmost columns, with the rightmost column absorbing the remainder, using the configured `layout.columnWeights`. The pane-content-width-vs-region-width invariant (each non-rightmost pane's content is one less cell than its region) is unchanged.
- [TMUX-011](../user/tmux-play.md#tmux-011): amend the default home YAML to include an explicit `layout` block (`window: { columns: 240, rows: 67 }`, `columnWeights: [4, 6, 6]`) so first-run users see the new knobs and the shipped default surfaces in the file rather than the code.
- New [TTMUX-064](../test/tmux-play.md#ttmux-064): given a YAML config whose `layout` is malformed (non-integer/non-positive `columns`/`rows`; `columnWeights` not an array; weight not a positive number; `columnWeights` length mismatched against player count), the loader shall reject with an error that names the offending path per [TMUX-008](../user/tmux-play.md#tmux-008). Given a valid `layout`, the loaded config shall preserve the values verbatim and the snapshot JSON shall carry the same values.
- [TTMUX-014](../test/tmux-play.md#ttmux-014): amend to reflect the new ratio derivation: with no `layout.columnWeights` in YAML, the defaults are `1 : 1` (one player) and `4 : 6 : 6` (two or more players); with an explicit `columnWeights`, the resolved region widths follow that ratio.
- [TTMUX-021](../test/tmux-play.md#ttmux-021): amend to assert the `new-session` invocation uses the resolved `layout.window.columns` / `layout.window.rows` — `240×67` by default — and that an explicit override (e.g., `200×50`) is honored.
- [TTMUX-034](../test/tmux-play.md#ttmux-034): amend so the asserted pre-attach byte sequence is parameterized by the resolved `layout.window` — `\x1b[8;67;240t` by default and `\x1b[8;<rows>;<columns>t` for an explicit override — so the test verifies the same source of truth as `new-session -x/-y`.
- [TTMUX-022](../test/tmux-play.md#ttmux-022): amend so the multi-player column expectation is the default `4 : 6 : 6` ratio of a 240-column window — `Boss 60`, `Col1 90`, `Col2 90` (within tmux nearest-cell rounding) — not 80/80/80.
- [TTMUX-031](../test/tmux-play.md#ttmux-031): amend the real-tmux geometry check to use the default `4 : 6 : 6` ratio: `pane_left=0` Boss with effective region width 60, first player column at `pane_left=60` with effective width 90, second player column at `pane_left=150` with effective width 90. The 1-cell border accounting from the prior text is preserved.
- [TTMUX-035](../test/tmux-play.md#ttmux-035): amend the resize-invariant assertion so the per-column region width formula is `floor(W * weight_i / sum(weights))` with the rightmost column absorbing the remainder, holding at the sample sizes already enumerated. With the shipped multi-player default (`4 : 6 : 6`), Boss = `floor(W*4/16)`, Col1 = `floor(W*6/16)`, Col2 = remainder.
- `src/app/tmux-play/config.ts`: extend `TmuxPlayConfig` with an optional `layout` field; normalize/validate per the new TMUX-064; default the field server-side so the snapshot always carries concrete values for session mode to consume.
- `src/app/tmux-play/launcher.ts`: read `loaded.config.layout` (after defaulting) and thread its `window` dimensions into the `new-session -x/-y` call, the `requestTerminalResize` `\x1b[8;<rows>;<columns>t` payload, and any other launcher path that previously assumed `240×67`; thread its `columnWeights` into the initial `split-window -l` sizing and the `configureLayoutHooks` shell expression. Retire the `INITIAL_TMUX_COLUMNS`, `INITIAL_TMUX_ROWS`, `PLAYER_AREA_SIZE_SINGLE`, `PLAYER_AREA_SIZE_MULTI`, and `SECOND_PLAYER_COLUMN_SIZE` module constants.
- `src/app/tmux-play/config.test.ts`: cover the new TMUX-064 validation cases (accepted defaults; rejected malformed `window` values; rejected non-positive weights; rejected length-mismatched weights) plus the snapshot-preserves-`layout` path.
- `src/app/tmux-play/launcher.test.ts`: update the geometry / split-window / hook-command assertions to the new `4 : 6 : 6` default and to a coverage case with an explicit `columnWeights` override.
- `src/app/tmux-play/launcher.acceptance.test.ts`: update the real-tmux geometry assertion to the new `4 : 6 : 6` default and add a case that exercises an override.
- `specs/map.md`: index IR-022.

Out of scope:

- Per-pane priority or row-weight configurability inside the first / second player columns.
  Multiple players in one column still split evenly via tmux's default vertical split sizing.
- Removing tmux's terminal size negotiation: a client attached at a different size still negotiates per [TMUX-035](../user/tmux-play.md#tmux-035); the YAML field only controls the launcher-requested initial grid.
- Status-bar `status-left-length` / `status-right-length` tuning: those budgets are sized for the 240-column default and remain unchanged. A future IR can revisit them if very narrow `layout.window.columns` is observed in the wild.

## Mechanism notes (pinned by this IR)

Region widths from weights: with weights `[w_0, w_1, …, w_{N-1}]` and window width `W`, non-rightmost column `i < N-1` gets region width `floor(W * w_i / sum(w))`; the rightmost column absorbs the remainder, so `region_{N-1} = W - sum_{i<N-1} floor(W * w_i / sum(w))`.
This generalizes the existing `floor(W / 3)` / `floor(W / 2)` formulas of [TMUX-044](../user/tmux-play.md#tmux-044) — set every weight to 1 and the new formula collapses to the old one.

Initial `split-window` sizing: the launcher currently passes literal `-l` values (`120`, `160`, `50%`) derived from the 240-column window. After this IR, those values are computed from the resolved `window.columns` and `columnWeights` so the initial layout matches the resize-hook formula at session creation rather than relying on tmux to converge after the first hook fires.

Default rationale: keep `1 : 1` for the single-player layout — only one player column exists, and the 50/50 split is what one-shot users have today.
Adopt `4 : 6 : 6` for the multi-player layout because the Boss/Captain pane is the input column and player columns are the content columns, so giving each content column 50% more cells than the input column is the user-reported preference.
Both defaults sum to integers that divide the canonical 240-cell window cleanly enough that tmux's nearest-cell rounding lands on round multiples (`240 * 4/16 = 60`, `240 * 6/16 = 90`).

Snapshot consumption: per [TMUX-034](../user/tmux-play.md#tmux-034) the launcher writes a resolved config snapshot the session subprocess reads.
The launcher resolves any missing `layout` values to their defaults before writing the snapshot, so the snapshot always carries concrete `window.columns` / `window.rows` / `columnWeights`.
The launcher does not consult the YAML again after session creation, so reading `layout` from `loaded.config` (post-normalization) is the single point of truth.

## Deliverables

- [ ] `specs/user/tmux-play.md` — amend TMUX-005, TMUX-011, TMUX-028, TMUX-035, TMUX-043, TMUX-044; add TMUX-064 defining `layout`.
- [ ] `specs/test/tmux-play.md` — amend TTMUX-014, TTMUX-021, TTMUX-022, TTMUX-031, TTMUX-034, TTMUX-035; add TTMUX-064 covering `layout` validation and snapshot preservation.
- [ ] `specs/map.md` — index IR-022.
- [ ] `src/app/tmux-play/config.ts` — `TmuxPlayConfig.layout` field, normalization, validation, defaults, snapshot inclusion.
- [ ] `src/app/tmux-play/config.test.ts` — TTMUX-064 cases.
- [ ] `src/app/tmux-play/launcher.ts` — thread `layout` into `new-session -x/-y`, `split-window -l`, `configureLayoutHooks`; retire the hardcoded layout constants.
- [ ] `src/app/tmux-play/launcher.test.ts` — geometry / split / hook assertions updated to the new defaults; explicit-override case added.
- [ ] `src/app/tmux-play/launcher.acceptance.test.ts` — real-tmux geometry assertion updated; explicit-override case added.

## Tasks

Each task is one commit.

1. [ ] **Spec items + map.** Amend TMUX-005 / TMUX-011 / TMUX-028 / TMUX-035 / TMUX-043 / TMUX-044 and add TMUX-064 in `specs/user/tmux-play.md`; amend TTMUX-014 / TTMUX-021 / TTMUX-022 / TTMUX-031 / TTMUX-034 / TTMUX-035 and add TTMUX-064 in `specs/test/tmux-play.md`; update the `specs/map.md` TMUX package summary to mention the new top-level `layout` field. Docs-only commit.

2. [ ] **Config schema for `layout`.** Add `TmuxPlayConfig.layout` (`window: { columns, rows }`, `columnWeights: number[]`) to `src/app/tmux-play/config.ts`; normalize/validate per TMUX-064 (reject non-positive integer dimensions, non-array or non-positive-number weights, weights-length not matching `players.length === 1 ? 2 : 3`); default the field at load time so the snapshot always carries concrete values. Update `DEFAULT_TMUX_PLAY_CONFIG` to include explicit `layout`. Add unit tests in `src/app/tmux-play/config.test.ts` covering the accepted defaults, each rejection path, and snapshot preservation. Per-task-boundary green.

3. [ ] **Launcher wiring + tests.** Thread `loaded.config.layout` into `buildTmuxSession` so `new-session -x/-y` uses `layout.window`, `requestTerminalResize` emits `\x1b[8;<rows>;<columns>t` from the same `layout.window`, each `split-window -l` value is computed from `layout.columnWeights` and `layout.window.columns`, and `configureLayoutHooks` builds its `resize-pane` chain from the weights and the runtime `#{window_width}`. Retire the now-unused `INITIAL_TMUX_COLUMNS`, `INITIAL_TMUX_ROWS`, `PLAYER_AREA_SIZE_*`, and `SECOND_PLAYER_COLUMN_SIZE` constants. Update `src/app/tmux-play/launcher.test.ts` to assert the new default geometry (`60 / 90 / 90` for two players, `120 / 120` for one player, `240×67` window) and the unchanged-default `\x1b[8;67;240t` resize sequence, and add an explicit-override case that exercises a non-default `layout.window` end-to-end (new-session args, terminal CSI bytes, column weights). Update `src/app/tmux-play/launcher.acceptance.test.ts` similarly against a real tmux server. Per-task-boundary green; the acceptance suite shall be executed end-to-end inside this commit per the IR-011 precedent.

## Acceptance criteria

- `npm run build`, `npm test`, and `npm run test:smoke` pass at every task boundary.
- `npm run test:acceptance` passes locally with `tmux` available; the updated real-tmux suite verifies the `4 : 6 : 6` default geometry and the explicit-override case.
- With no `layout` in the YAML, two configured players yield region widths matching `floor(240 * 4/16) = 60`, `floor(240 * 6/16) = 90`, and remainder `= 90`; one configured player yields the unchanged `120 / 120` split.
- With an explicit `layout.columnWeights` in the YAML, the resolved region widths follow that ratio at the resolved `layout.window.columns`; with an explicit `layout.window` in the YAML, both the `new-session -x/-y` arguments and the pre-attach `\x1b[8;<rows>;<columns>t` bytes match — no path still asserts `240×67` against a configured override.
- Malformed `layout` values are rejected with an error naming the offending path (e.g., `layout.window.columns`, `layout.columnWeights[2]`) per [TMUX-008](../user/tmux-play.md#tmux-008).
- The session snapshot JSON at `<workDir>/tmux-play.config.snapshot.json` carries the resolved `layout` block; mutating the YAML after launch does not change the running session.
