<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-016: tmux-play Run-Time Timers

## Goal

Add live run-time timers to a tmux-play session.
Each role pane and the Boss/Captain pane shall carry a per-pane cumulative active-time timer on its border; the tmux status bar shall carry a session-total timer with the navigation hints moved beside it.
Timers shall tick at roughly 1 Hz while work is in flight and shall exclude idle waiting.
Timing is derived from the `timestamp` already present on every record, so no record-contract change and no decision record are required — the work extends [DR-004](../decisions/004-tmux-play-captain-architecture.md)'s observer/record model and [TMUX-047](../user/tmux-play.md#tmux-047)/[TMUX-048](../user/tmux-play.md#tmux-048)'s theme and pane-border ownership.

### Timing model

| Timer | Active interval summed per occurrence | Idle excluded |
| --- | --- | --- |
| Role pane | `role_finished.timestamp − role_prompt.timestamp` | gaps between that role's runs (waiting for the Captain) |
| Boss/Captain pane | `captain_finished.timestamp − captain_prompt.timestamp` | gaps between Captain runs |
| Status-bar total | `(turn_finished \| turn_aborted).timestamp − turn_started.timestamp` | gaps between rounds (waiting for Boss input) |

Each timer shows the cumulative sum across the whole session.
While a run or turn is open, the displayed value is the accumulated sum plus (`now` − the open occurrence's start).
A timer is **running** while its occurrence is open and **frozen** otherwise.
The per-pane timers mark this with the hourglass pair — `⏳` (flowing sand) while running, `⌛` (settled) while frozen — while the status-bar total uses the clock glyph `⏰` in both states.
All three glyphs render in the terminal's emoji presentation (two cells, colored by the terminal's emoji font), so the running/frozen Catppuccin cue is carried by the duration text — the bright accent color while running, a dimmed neutral role while frozen — not by the glyph.

## Status

Done

## Scope

In scope:

- New `user/tmux-play.md` items for the timing model, the per-pane border timer, and the status-bar layout (hints on `status-left`, total on `status-right`) with Catppuccin styling.
- New `test/tmux-play.md` item verifying the timers against a real tmux server.
- A pure timing module: per-role / Captain / turn active-interval accumulation, live-value computation for a supplied `now`, and duration formatting.
- A `TimingObserver` (`RecordObserver`) registered in session mode, plus a ~1 Hz refresh loop that pushes values to tmux and is torn down on shutdown ([TMUX-019](../user/tmux-play.md#tmux-019), [TMUX-026](../user/tmux-play.md#tmux-026)).
- Launcher changes: hints → `status-left`, total → `status-right`, a per-pane timer slot in `pane-border-format`, and Catppuccin Mocha colors.

Out of scope:

- Changes to the core runtime, the record contract, or the `createTmuxPlayRuntime` programmatic API ([TMUX-029](../user/tmux-play.md#tmux-029)).
- Persisting timing across sessions, or any timing export / telemetry surface.
- Timing finer than a role or Captain run (no per-tool or per-event timing).

## Deliverables

- [x] `specs/user/tmux-play.md` — `TMUX-053`–`TMUX-055`: the timing model, the per-pane border timer, and the status-bar layout with Catppuccin styling.
- [x] `specs/test/tmux-play.md` — `TTMUX-056`: real-tmux verification of the timer surfaces.
- [x] `src/app/tmux-play/timing.ts` — pure accumulation, live-value, and duration-format module, with unit tests.
- [x] `src/app/tmux-play/` — `TimingObserver`, its session-mode registration, the ~1 Hz refresh loop, and shutdown teardown.
- [x] `src/app/tmux-play/launcher.ts` — `status-left` hints, `status-right` total, `pane-border-format` timer slot, Catppuccin colors.
- [x] `src/app/tmux-play/*.acceptance.test.ts` — real-tmux test for `TTMUX-056`.
- [x] `specs/map.md` — updated if it indexes IRs or item files.

## Tasks

1. [x] **Spec** — add `TMUX-053`–`TMUX-055` and `TTMUX-056` per the timing model and display above (IDs above the current maxima `TMUX-052` / `TTMUX-055`, each test item with a `Verifies:` line); update `map.md`.
2. [x] **Timing module** — add `src/app/tmux-play/timing.ts`: accumulate per-role / Captain / turn active intervals from records, compute live values for a supplied `now`, and format durations (`1h02m` / `3m07s` / `12s`); unit tests cover idle-gap exclusion and an open (unfinished) run.
3. [x] **Observer + session wiring** — add the `TimingObserver` backed by the timing module, register it in `session.ts` beside the presenter, and add the ~1 Hz `setInterval` that recomputes and pushes `tmux set` / `set -p` — started on `turn_started`, settled with a final push on `turn_finished` / `turn_aborted`, and cleared on session shutdown.
4. [x] **Launcher + theme** — move the navigation hints to `status-left` (with `status-left-length`), set `status-right` to the total slot, extend `pane-border-format` with the per-pane `#{@…}` timer slot, and apply the running/frozen styling: per-pane timers show `⏳` while running and `⌛` while frozen, the status-bar total shows `⏰`. The duration text carries the Catppuccin cue — the bright accent while running (each role its [TMUX-048](../user/tmux-play.md#tmux-048) adapter accent, Captain and total `mauve`), `overlay1` while frozen. The format strings shall budget two display cells for each emoji glyph; the glyphs' own colors are left to the terminal's emoji presentation.
5. [x] **Acceptance test** — add the `TTMUX-056` real-tmux test: feed the `TimingObserver` synthetic timing records against a real tmux session and assert, via `tmux show-options` / `display-message`, that the per-pane timer options and `status-right` carry the accumulated durations and the hints sit on `status-left`; self-skip when `tmux` or `glow` is unavailable.

## Acceptance criteria

- Each role pane and the Boss/Captain pane border shows a live (~1 Hz) cumulative active-time timer.
- The status bar shows the navigation hints on the left and the session total on the right.
- Per-role and Captain timers exclude time spent waiting between that participant's runs; the total excludes time spent waiting between rounds.
- Timers are styled with the Catppuccin Mocha palette.
- A running (ticking) timer and a frozen (settled) timer are distinguishable at a glance: per-pane timers by the hourglass glyph (`⏳` / `⌛`) and duration-text color, the status-bar total (clock glyph `⏰`) by duration-text color.
- The acceptance test tolerates a one-cell border-alignment variance, since emoji cell width is not uniform across terminals.
- The core runtime and `createTmuxPlayRuntime` are unchanged; no record-contract change is made.
- `npm run build`, `npm run typecheck`, `npm run lint`, and `npm test` pass at every task boundary; `npm run test:acceptance` passes after Task 5.
- All new spec items follow `meta.md`.
