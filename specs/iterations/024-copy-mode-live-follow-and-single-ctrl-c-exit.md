<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-024: Copy-Mode Live-Follow and Single-Ctrl+C Exit

## Goal

Fix two defects that surface once any tmux-play pane is scrolled back (i.e., enters tmux copy-mode, e.g. via the mouse wheel).

1. New output to a scrolled pane is not shown.
   Player panes stream from `tail -f` and the Boss/Captain pane streams from the session process's stdout; while a pane is in copy-mode, tmux freezes the client viewport at the scroll position, so newly written content is not visible until the pane returns to its live tail.
   The user-visible symptom is "after some panes are scrolled, new output is not shown until pressing Ctrl+C" — pressing Ctrl+C only "works" because tmux's stock copy-mode `C-c` binding is `send-keys -X cancel`, which exits copy-mode and snaps the pane back to its live tail, revealing the accumulated output as a side effect.
2. Quitting takes two Ctrl+C presses.
   When the active pane is in copy-mode, `C-c` is dispatched through the `copy-mode` / `copy-mode-vi` key table (stock `cancel`), not the `root`-table session-exit binding from [TMUX-065](../user/tmux-play.md#tmux-065), so the first press only cancels copy-mode and a second press is needed to quit.
   The forwarded `send-keys -t <session>:0.0 C-c` is itself swallowed when pane 0 is the scrolled pane, so even a `root`-table dispatch fails to reach the Boss readline.

The desired behavior is: streaming output is shown instantly even when a pane has been scrolled (the pane follows its live tail when new content arrives), and a single Ctrl+C quits from any pane in any mode.

## Status

Planned

## Scope

In scope:

- New [TMUX-069](../user/tmux-play.md#tmux-069): while a tmux-play session is running, when the session writes new content to a pane (Boss/Captain or a player) that is currently in copy-mode, that pane shall return to its live tail so the new content is visible, overriding any prior scroll-back on that pane.
  A pane that is not in a mode shall be untouched; a pane in copy-mode shall be returned to its live tail without killing the session or the pane's process (a copy-mode exit primitive, i.e. `send-keys -X cancel`, not `kill-pane`), which as a side effect clears any active selection on that pane.
  The trigger is new output: it overrides the click / right-click scroll-preservation of [TMUX-062](../user/tmux-play.md#tmux-062) and [TMUX-068](../user/tmux-play.md#tmux-068) (which preserve scroll across mouse gestures with no concurrent output) only when content is written, so between Boss turns — when no output is produced — a scrolled pane keeps its position and historical review remains possible.
  The behavior shall be scoped to the launched tmux-play session.
- Amend [TMUX-065](../user/tmux-play.md#tmux-065): a single Ctrl+C shall trigger the [TMUX-026](../user/tmux-play.md#tmux-026) exit lifecycle from any pane regardless of mode.
  The launcher shall bind `C-c` in the `copy-mode` and `copy-mode-vi` key tables in addition to `root`, each session-gated via `if-shell -F #{==:#{session_name},<session>}`.
  Every table's true branch shall first exit pane 0's copy-mode when pane 0 is in a mode (`if -F -t <session>:0.0 '#{pane_in_mode}' 'send-keys -t <session>:0.0 -X cancel'`) and then deliver the byte (`send-keys -t <session>:0.0 C-c`), because a `C-c` forwarded to a pane that is itself in copy-mode is consumed by copy-mode's stock `cancel` and never reaches the Boss readline.
  Each false branch shall reproduce the per-table stock binding verbatim so other sessions on the same server are unaffected: `send-keys C-c` for `root`, `send-keys -X cancel` for `copy-mode` and `copy-mode-vi`.
- Amend [TTMUX-065](../test/tmux-play.md#ttmux-065): pin the three-table `C-c` binding shape (argv stream + real-tmux `list-keys -T root|copy-mode|copy-mode-vi C-c`), asserting the cancel-pane-0-then-forward true branch and the per-table stock false branch.
- New [TTMUX-069](../test/tmux-play.md#ttmux-069): a unit-level assertion that the live-follow observer issues a `#{pane_in_mode}`-gated copy-mode-exit for the destination pane on the records that drive a presenter pane write — the block-boundary flush and terminal writes of [TMUX-050](../user/tmux-play.md#tmux-050) (e.g. `captain_finished` / `player_finished`, `captain_status`, `turn_aborted`, `runtime_error`, tool-lifecycle lines) — and not on a buffered `text_delta` that produces no write nor on non-output control records; the assertion shall specifically pin a flush/terminal record so the "scroll after buffered deltas but before the final flush" gap is covered, plus a real-tmux acceptance probe that seeds scrollback into a pane, scrolls it back (`#{scroll_position} > 0`, `#{pane_in_mode} = 1`), drives new content to that pane through a block flush, and asserts the pane returns to its live tail (`#{pane_in_mode} = 0`) with the new content visible.
- `src/app/tmux-play/launcher.ts`: extend `configureSessionExitKey` to emit the `root` + `copy-mode` + `copy-mode-vi` `C-c` bindings with the cancel-then-forward true branch and per-table stock false branch.
- `src/app/tmux-play/follow-observer.ts` (new): a `RecordObserver` mirroring `TimingObserver` — map writer → pane via `queryPaneTargetsByTitle`, and on output-bearing records issue a debounced, `#{pane_in_mode}`-gated `send-keys -X cancel` against the destination pane; failures are display-only and swallowed.
- `src/app/tmux-play/session.ts`: construct the follow observer and register it in the runtime `observers` array alongside the presenter and timing observer.
- `src/app/tmux-play/{launcher,follow-observer}.test.ts` and `src/app/tmux-play/launcher.acceptance.test.ts`: unit + real-tmux coverage for the two behaviors above.
- `specs/map.md`: index IR-024; extend the TMUX user/test summary lines to mention copy-mode live-follow and single-Ctrl+C exit across modes.

Out of scope:

- Reverting or weakening [TMUX-062](../user/tmux-play.md#tmux-062) / [TMUX-068](../user/tmux-play.md#tmux-068) scroll-preservation on mouse gestures.
  Those remain the contract when no output is concurrently written; TMUX-069 only overrides them at the moment new content arrives.
- A "tail-follows-unless-scrolled" model (follow only when the pane is already at the bottom).
  The requested behavior is that output shows even when the pane has been scrolled, so new output unconditionally returns an in-mode pane to its tail; the gentler model is a separable future UX decision.
- Boss/Captain readline behavior, presenter rendering, and per-pane timers are unchanged; the follow observer drives only copy-mode exit and never writes pane content.

## Mechanism notes (pinned by this IR)

Empirically verified against tmux 3.6b, and consistent with the tmux manual's key-table, copy-mode, and `send-keys -X` semantics [[1]]:

- Player panes are fed by `tail -f <logfile>` (`launcher.ts` `tailCommand`) and the Boss/Captain pane is the session process's stdout; scrolling either with the mouse wheel enters copy-mode and freezes the client viewport while the underlying grid keeps growing.
- `send-keys -t <pane> -X cancel` exits copy-mode and returns the pane to its live tail (`#{pane_in_mode}` → `0`), which is the follow primitive for TMUX-069. `-X cancel` requires the pane to be in a mode, so the issue is gated on `#{pane_in_mode}` (a no-op, error-free pass for un-scrolled panes).
- Stock `copy-mode` / `copy-mode-vi` both bind `C-c` to `send-keys -X cancel`. A `C-c` delivered via `send-keys` to a pane that is itself in copy-mode is therefore consumed by that `cancel` and does not reach the pane's program (probe: no `SIGINT` received). Exiting pane 0's copy-mode first and then sending `C-c` does deliver `SIGINT` to the Boss readline. This is why the TMUX-065 true branch must cancel-then-forward in all three tables, and why the `root` binding alone is insufficient when pane 0 is the scrolled pane.

Follow-observer shape: it is a `RecordObserver` like `TimingObserver` (`timing-observer.ts`), registered in `session.ts`'s `observers` array. It resolves the destination pane for each output-bearing record — records carrying a `playerId` map to that player pane; `captain_*` / `turn_aborted` / `runtime_error` map to the Boss/Captain pane (pane 0) per [TMUX-040](../user/tmux-play.md#tmux-040) — and issues the gated `send-keys -X cancel` via `runTmux`. The presenter already buffers `text_delta` and writes at block boundaries ([TMUX-050](../user/tmux-play.md#tmux-050)) — `writer.write` fires only inside `flushBlock`, when a later non-text event, a speaker change, or turn end closes the open block — so per-pane writes are block-level, not per-token, and a `text_delta` in isolation produces no pane write to follow. The follow therefore keys on the records that drive a write (the block-boundary flush triggers plus the status / tool / abort / error / `*_finished` writes), not on raw buffered deltas, so a pane scrolled after some deltas but before the final flush is still returned to its tail when the flush lands. The observer additionally coalesces rapid records per pane (a short debounce, e.g. one issue per pane per ~250 ms) so an active turn does not spawn a `tmux` process per block. Because exiting copy-mode drops any active selection, an implementation may optionally gate the follow on "in copy-mode and no active selection" (`#{selection_present}`) so an in-progress drag-select is not disrupted; this refinement is permitted but not required by TMUX-069.

TMUX-065 binding shape (all three tables, session-gated):

```text
true  := if -F -t <s>:0.0 '#{pane_in_mode}' 'send-keys -t <s>:0.0 -X cancel' ; send-keys -t <s>:0.0 C-c
root  false := send-keys C-c
copy* false := send-keys -X cancel
```

## Deliverables

- [ ] `specs/user/tmux-play.md` — add TMUX-069 (copy-mode live-follow); amend TMUX-065 (three-table cancel-then-forward Ctrl+C).
- [ ] `specs/test/tmux-play.md` — add TTMUX-069 (live-follow unit + real-tmux probe); amend TTMUX-065 (three-table binding assertions).
- [ ] `specs/map.md` — index IR-024; extend the TMUX user/test summary lines.
- [ ] `src/app/tmux-play/launcher.ts` — three-table `C-c` bindings with cancel-then-forward true branch and per-table stock false branch.
- [ ] `src/app/tmux-play/follow-observer.ts` — new output-driven copy-mode-exit `RecordObserver`.
- [ ] `src/app/tmux-play/session.ts` — construct and register the follow observer.
- [ ] `src/app/tmux-play/launcher.test.ts` + `launcher.acceptance.test.ts` — argv + real-tmux `list-keys` assertions for the three-table `C-c` binding.
- [ ] `src/app/tmux-play/follow-observer.test.ts` + a real-tmux acceptance probe — observer dispatch unit test and the seed-scroll-output-follow probe.

## Tasks

1. [ ] **Spec items + map.** Add TMUX-069 and TTMUX-069; amend TMUX-065 and TTMUX-065; index IR-024 in `specs/map.md` and extend the TMUX user/test summary lines. Single docs-only commit.
2. [ ] **Single-Ctrl+C exit across modes.** Extend `configureSessionExitKey` to bind `C-c` in `root`, `copy-mode`, and `copy-mode-vi` with the cancel-pane-0-then-forward true branch and per-table stock false branch; update `launcher.test.ts` argv assertions and the `launcher.acceptance.test.ts` `list-keys` probe per TTMUX-065. Per-task-boundary green.
3. [ ] **Copy-mode live-follow observer.** Add `follow-observer.ts` (record → destination pane via `queryPaneTargetsByTitle`; debounced, `#{pane_in_mode}`-gated `send-keys -X cancel`), register it in `session.ts`, and add the unit test plus the real-tmux acceptance probe per TTMUX-069. Per-task-boundary green.

## Acceptance

- While a player or the Boss/Captain pane is scrolled back in copy-mode and a Boss turn streams output to it, the pane returns to its live tail and shows the new content without manual intervention; a pane that is not in a mode is untouched and a pane with no concurrent output keeps its scroll position between turns.
- The tmux command stream binds `C-c` in `root`, `copy-mode`, and `copy-mode-vi`, each session-gated; every true branch exits pane 0's copy-mode (when in a mode) before forwarding `C-c` to pane 0, and each false branch is the per-table stock binding (`send-keys C-c` for `root`; `send-keys -X cancel` for the copy-mode tables).
- A single Ctrl+C triggers the [TMUX-026](../user/tmux-play.md#tmux-026) exit lifecycle from any pane, including when the active pane and/or pane 0 is scrolled into copy-mode (no second press required).
- Other tmux sessions on the same server retain stock `Ctrl+C` and copy-mode `C-c` behavior (the `if-shell` false branches).
- All per-task-boundary checks (build, typecheck, lint, unit, smoke, acceptance) pass at each task boundary.

## References

[1]: https://man.openbsd.org/tmux.1 "tmux manual — key tables, copy-mode, send-keys -X"
