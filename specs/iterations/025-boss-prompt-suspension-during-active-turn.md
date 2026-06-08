<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-025: Boss Prompt Suspension During an Active Turn

## Goal

Stop the live Boss readline from painting `boss> ` prompt chrome into the Boss/Captain pane while a Boss turn is in flight, so streaming presenter output for the turn is never interleaved with — or followed by — a fresh `boss> ` prompt that a turn-completion consumer reading the pane would misread as an implicit turn-over signal.
The session shall suspend or clear the readline prompt when the runtime starts a turn and restore `boss> ` exactly once after the turn completes normally or aborts on ESC.
Type-ahead the Boss enters during the turn shall stay preserved per [TMUX-057](../user/tmux-play.md#tmux-057) and surface on the restored prompt; ESC abort per [TMUX-057](../user/tmux-play.md#tmux-057) and bracketed paste per [TMUX-058](../user/tmux-play.md#tmux-058) shall keep working.
This is an implementation refinement within the existing session-mode / presenter architecture of [DR-004](../decisions/004-tmux-play-captain-architecture.md); no new DR is required.

## Status

In Progress.
Task 1 (spec items + map) is complete: [TMUX-075](../user/tmux-play.md#tmux-075) added; [TMUX-037](../user/tmux-play.md#tmux-037) and [TMUX-057](../user/tmux-play.md#tmux-057) amended with the reconciling cross-references; [TTMUX-074](../test/tmux-play.md#ttmux-074) added; the `specs/map.md` TMUX user/test summary lines extended.
Task 2 (implementation + session test) is complete: `session.ts` suspends the prompt at turn start and restores it once on every turn-end path; two `session.test.ts` regression tests over a real `createInterface` cover the typed and pasted [TTMUX-074](../test/tmux-play.md#ttmux-074) session clauses.
Task 3 (real-tmux acceptance probe) is not started.

## Context

Session mode (`src/app/tmux-play/session.ts`) runs the Boss readline and registers the tmux presenter as an observer; both write to the same Boss/Captain pane stdout per [DR-004](../decisions/004-tmux-play-captain-architecture.md).
The session does not call `readline.prompt()` mid-turn — it re-prompts only in the `finally` after `runBossTurn` resolves — so a non-interacting Boss sees no mid-turn `boss> `.
The defect surfaces because the readline is intentionally kept live and echoing during a turn (raw mode, `escapeCodeTimeout`) so a bare ESC aborts the turn and the edit buffer is preserved per [TMUX-057](../user/tmux-play.md#tmux-057) / [IR-019](019-boss-esc-interrupt-and-bracketed-paste.md).
Any Boss keystroke during the turn triggers readline's line refresh, repainting `boss> <buffer>` chrome amid the presenter's streaming output; a consumer keying on `boss> ` as the turn-over marker is then misled.
The fix therefore cannot simply stop the session from prompting (it already does not); it must keep the readline capturing ESC and type-ahead while preventing the `boss> ` chrome from rendering until the turn ends.

## Design decision (adopted by this IR)

Adopt the prescribed direction: while a Boss turn is active the readline prompt is **suspended** (no fresh `boss> ` prompt line painted), and it is **restored once** at turn completion / ESC abort.
Reconcile the released items rather than contradict them:

- [TMUX-037](../user/tmux-play.md#tmux-037) "echo the user's input line as the user types it" is scoped to the ready (between-turns) prompt; during an active turn the prompt is suspended per the new [TMUX-075](../user/tmux-play.md#tmux-075).
- [TMUX-057](../user/tmux-play.md#tmux-057) edit-buffer preservation is unchanged; the preserved buffer is surfaced when [TMUX-075](../user/tmux-play.md#tmux-075) restores the prompt.

Accepted tradeoff: the Boss does not see live echo of type-ahead bytes while a turn is active; the typed text appears when the prompt is restored.
Alternative considered and left out of scope: keep echoing type-ahead on a distinct input affordance that does not carry the `boss> ` token — more invasive, defers a separate UX convention, and is not needed to remove the false turn-over signal.

## Mechanism notes (pinned by this IR)

`readline.pause()` is **not** viable: it pauses the input stream, which also stops `keypress` delivery, breaking the [TMUX-057](../user/tmux-play.md#tmux-057) ESC handler and type-ahead capture.
Keep the readline live; suppress the prompt-chrome render instead.
Viable mechanisms (implementer's choice, observable contract pinned by [TMUX-075](../user/tmux-play.md#tmux-075) / [TTMUX-074](../test/tmux-play.md#ttmux-074)):

- On turn start, clear the current input line from the pane (`readline.clearLine(output, 0)` + `readline.cursorTo`, or write `\r\x1b[2K`) and set the readline prompt to the empty string so subsequent line refreshes paint no `boss> ` token; restore the colored `boss> ` prompt string at turn end before re-prompting.
- Or intercept keystrokes during the turn (the session already owns a `keypress` listener), hold typed bytes in a buffer with no echo, and feed them back into the readline line when the prompt is restored.

The turn-active window is already tracked by `this.activeBossTurn` (set true before `await runBossTurn`, false in the `finally`); the suspend/restore hooks attach to the same boundary so they cover normal completion, ESC abort, and the runtime-error / observer-dispatch failure paths.
Bracketed-paste type-ahead during a turn must be preserved on the same path as typed type-ahead.

## Scope

In scope:

- New **[TMUX-075](../user/tmux-play.md#tmux-075)** (user): While session mode is running a Boss turn — between the runtime's `turn_started` and the matching `turn_finished` or `turn_aborted` — the Boss/Captain pane shall paint no fresh `boss> ` readline prompt line (the already-echoed submitted-prompt input line per [TMUX-037](../user/tmux-play.md#tmux-037) aside), so the turn's streaming output is never interleaved with or followed by a fresh `boss> ` prompt a turn-completion consumer would read as an implicit turn-over signal.
  When the runtime starts a Boss turn, the session shall suspend or clear the live readline prompt before the turn's first presenter output reaches the pane.
  When the turn ends — normal completion or ESC abort per [TMUX-057](../user/tmux-play.md#tmux-057) — the session shall restore the `boss> ` prompt exactly once, ready for the next turn.
  Edit-buffer bytes the Boss types (or pastes per [TMUX-058](../user/tmux-play.md#tmux-058)) during the active turn shall be preserved per [TMUX-057](../user/tmux-play.md#tmux-057) and surfaced on the restored prompt; they shall not render as a `boss> `-prefixed line while the turn is active.
  Where stdin is not a TTY, no keypress handling is installed per [TMUX-057](../user/tmux-play.md#tmux-057) and there is no live editing prompt whose `boss> ` chrome a keystroke could repaint mid-turn, so this item's active-turn suspension is a no-op; any static `boss> ` string the underlying readline writes between turns is unchanged.
- Amend **[TMUX-037](../user/tmux-play.md#tmux-037)**: add a clause scoping its as-typed echo to the ready (between-turns) prompt and cross-referencing [TMUX-075](../user/tmux-play.md#tmux-075) for the active-turn suspension, so the two items do not contradict.
- Amend **[TMUX-057](../user/tmux-play.md#tmux-057)**: add a clause noting the preserved edit-buffer contents are surfaced when the `boss> ` prompt is restored per [TMUX-075](../user/tmux-play.md#tmux-075).
- New **[TTMUX-074](../test/tmux-play.md#ttmux-074)** (test), `Verifies:` [TMUX-075](../user/tmux-play.md#tmux-075), [TMUX-037](../user/tmux-play.md#tmux-037), [TMUX-057](../user/tmux-play.md#tmux-057), [TMUX-058](../user/tmux-play.md#tmux-058):
  Given a `TmuxPlaySession` running a Boss turn whose player/Captain call is blocked (the `runBossTurn` promise is pending), when the presenter streams the Captain's `captain> ` reply to the Boss/Captain pane (player output stays in its player pane per [TMUX-040](../user/tmux-play.md#tmux-040)), the captured Boss/Captain-pane content shall contain no fresh `boss> ` prompt line after that streamed output until the matching `turn_finished` or `turn_aborted` — the already-submitted input line that opened the turn (the `boss> <prompt>` echo per [TMUX-037](../user/tmux-play.md#tmux-037)) is unaffected; after the turn resolves, exactly one fresh `boss> ` prompt shall be restored.
  Given the Boss types type-ahead bytes during the active turn, those bytes shall not render a fresh `boss> `-prefixed line while the turn is active, and the next Enter after the turn ends shall fire exactly one `runBossTurn` whose prompt is the preserved bytes ([TMUX-057](../user/tmux-play.md#tmux-057)); given the Boss pastes multi-line text during the active turn, the same suppression holds and the next Enter fires exactly one `runBossTurn` whose prompt preserves the pasted embedded newlines ([TMUX-058](../user/tmux-play.md#tmux-058)).
  The session-level probe shall use a real `createInterface` over a TTY-like input/output pair (as the [TTMUX-059](../test/tmux-play.md#ttmux-059) ESC probe does), because a stubbed readline does not echo prompt chrome and would pass vacuously.
  A real-tmux attached-client acceptance clause shall assert that, with a turn in flight, pane 0 shows no fresh `boss> ` prompt line after the streamed Captain output between `turn_started` and the turn's terminal record (the submitted-prompt input line aside); it shall run under `*.acceptance.test.ts` and self-skip when `tmux -V`, `glow -v`, or an attached-client driver is unavailable.
- `src/app/tmux-play/session.ts`: suspend/clear the prompt on turn start and restore it once on turn end / ESC abort / runtime-error paths, preserving typed and pasted type-ahead and keeping the ESC keypress handler intact.
- `src/app/tmux-play/session.test.ts`: session-level regression coverage for [TTMUX-074](../test/tmux-play.md#ttmux-074) over a real-readline TTY pair.
- `specs/map.md`: extend the TMUX user and test package summary lines to mention active-turn prompt suspension (the IR-025 index row is added when this record is authored).

Out of scope (deliberate non-goals):

- Live echo of type-ahead during a turn on a separate, non-`boss> ` input affordance (the considered alternative above).
- Any change to ESC-abort semantics, bracketed-paste accumulation, or the SIGINT/SIGTERM/EOF lifecycle beyond keeping them working across the suspend/restore boundary.
- A readline replacement / raw-mode editor; Node's `readline` keeps owning editing, history, echo at the ready prompt, and raw-mode entry/exit.

## Deliverables

- [x] `specs/user/tmux-play.md` — add [TMUX-075](../user/tmux-play.md#tmux-075); amend [TMUX-037](../user/tmux-play.md#tmux-037) and [TMUX-057](../user/tmux-play.md#tmux-057) with the reconciling cross-references.
- [x] `specs/test/tmux-play.md` — add [TTMUX-074](../test/tmux-play.md#ttmux-074) with the `Verifies:` line.
- [x] `specs/map.md` — confirm IR-025 is indexed; extend the TMUX user and test summary lines for active-turn prompt suspension.
- [x] `src/app/tmux-play/session.ts` — suspend/clear prompt on turn start, restore once on every turn-end path, preserve type-ahead, keep ESC handling.
- [x] `src/app/tmux-play/session.test.ts` — session-level regression test over a real-readline TTY pair.
- [ ] `src/app/tmux-play/*.acceptance.test.ts` — real-tmux attached-client probe asserting no fresh `boss> ` prompt line on pane 0 during an active turn.

## Tasks

1. [x] **Spec items + map.** Add [TMUX-075](../user/tmux-play.md#tmux-075); amend [TMUX-037](../user/tmux-play.md#tmux-037) and [TMUX-057](../user/tmux-play.md#tmux-057); add [TTMUX-074](../test/tmux-play.md#ttmux-074); confirm IR-025 indexed in `specs/map.md` and extend the TMUX user/test summary lines. Single docs-only commit.
2. [x] **Prompt-suspension implementation + session test.** `session.ts` changes to suspend/clear the prompt on turn start and restore once on completion / ESC abort / runtime-error paths while preserving typed and pasted type-ahead and the ESC keypress handler. Session-level regression test over a real-readline TTY pair verifying the [TTMUX-074](../test/tmux-play.md#ttmux-074) session clauses. Per-task-boundary green.
3. [ ] **Real-tmux acceptance probe.** Attached-client `*.acceptance.test.ts` probe verifying [TTMUX-074](../test/tmux-play.md#ttmux-074)'s real-tmux clause — pane 0 shows no fresh `boss> ` prompt line between `turn_started` and the turn's terminal record — self-skipping without `tmux` / `glow` / an attached-client driver. Per-task-boundary green.

## Acceptance

- During an active turn whose player/Captain call is blocked, the Boss/Captain pane contains no fresh `boss> ` prompt line beyond the submitted-prompt input line; exactly one fresh `boss> ` prompt is restored after `turn_finished` / `turn_aborted`.
- Type-ahead typed or pasted during a turn does not render a fresh `boss> ` line while the turn is active and is submitted verbatim as one `runBossTurn` on the next Enter after the turn ends, preserving [TMUX-057](../user/tmux-play.md#tmux-057) / [TMUX-058](../user/tmux-play.md#tmux-058).
- Bare ESC during a turn still aborts via `abortActiveTurn('ESC')` and yields `turn_aborted`; `\x1b[A` does not; non-TTY stdin skips ESC and prompt suspension non-fatally.
- The bracketed-paste-disable sequence is still emitted on every shutdown path per [TMUX-058](../user/tmux-play.md#tmux-058).
- Real-tmux probe confirms no fresh `boss> ` prompt line on pane 0 mid-turn; existing [TTMUX-059](../test/tmux-play.md#ttmux-059) / [TTMUX-060](../test/tmux-play.md#ttmux-060) ESC and paste coverage stays green.
- All per-task-boundary checks (build, typecheck, lint, unit, smoke, acceptance) pass at each task boundary.
