<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-024: Boss Input Wrap-Correct Rendering

## Goal

Stop the Boss/Captain pane from accumulating duplicated input rows in its scrollback when the Boss types or edits a long line in a narrow pane.
The reported symptom is that scrolling far up the Captain pane shows the same `boss> …` row repeated many times.
Eliminate the duplication at its source while preserving the single-occurrence echo of [TMUX-037](../user/tmux-play.md#tmux-037), the ESC interrupt of [TMUX-057](../user/tmux-play.md#tmux-057), and the bracketed-paste submission of [TMUX-058](../user/tmux-play.md#tmux-058).

## Status

In progress.
Tasks 1–2 complete (spec items + map; wrap-correct input renderer module with boundary-byte unit tests).
Tasks 3–4 (session integration, real-tmux acceptance) not started.

## Root cause (confirmed)

The Boss/Captain pane is a Node `readline` interface in `terminal: true` mode; the player panes are `tail -f` and are unaffected (their scrollback was captured clean).
The duplication is a `readline` redraw artifact triggered when a rendered input row is exactly the pane width — the terminal "magic margin" / deferred-wrap (DECAWM [[2]]) case.

Evidence from a live session at pane width 38 (`boss> On some pane (at least Captain),` is exactly 38 cells):

- The 38-cell row repeated ~40× in the Captain pane scrollback, all during typing/editing and before any captain output.
- The Coder pane (`tail -f`, no readline) showed no duplication.

Mechanism, from Node v25 `readline` internals [[1]]:

- `Interface[kGetDisplayPos]` returns `{ cols: 0, rows: N }` for content whose width is an exact multiple of `columns`, asserting the cursor advanced to a fresh row; the terminal's deferred wrap actually leaves the cursor on the same row in the last cell.
- `Interface[kRefreshLine]` compensates with `if (lineCols === 0) write(' ')` to force a new row, then repositions using the mismatched row count.
- When the prompt sits near the bottom of a pane already filled with prior captain output, each boundary-crossing keystroke forces an extra row that scrolls a stranded copy of the full-width row into history.

Rejected quick fixes (each verified or reasoned to be unacceptable):

| Candidate | Result |
| --- | --- |
| Report `output.columns - 1` to readline | Garbles output: readline wraps at `W-1` while the terminal wraps at `W`, so cursor math and terminal disagree and rows overlap (reproduced). |
| `terminal: false` | Disables readline's redraw but also its echo; canonical mode would break the raw-mode `keypress` path that [TMUX-057](../user/tmux-play.md#tmux-057) ESC interrupt and [TMUX-058](../user/tmux-play.md#tmux-058) bracketed paste depend on. |
| Monkey-patch `Symbol(_getDisplayPos)` / `Symbol(_refreshLine)` [[1]] | Reaches into undocumented Node private symbols; version-fragile; fails review on best-practice grounds. |

A robust fix must own the Boss input redraw so it never drives the terminal into the deferred-wrap state, while leaving readline to own the edit buffer, history, key handling, `line` events, and raw-mode entry/exit. That is multiple commit-sized steps, hence this IR rather than a single commit.

## Scope

In scope:

- New [TMUX-067](../user/tmux-play.md#tmux-067): Where session mode renders the Boss readline to a TTY of width `W`, when the Boss types or edits an input line whose prompt-plus-content visible width reaches or exceeds `W`, the Boss/Captain pane scrollback shall not accumulate duplicated copies of any input row, and the cursor shall track the edit position across wrap boundaries.
  The rendered input shall reserve the rightmost column so no input row is written into the terminal's last cell, removing the deferred-wrap ambiguity.
  The single-occurrence echo of [TMUX-037](../user/tmux-play.md#tmux-037), the ESC interrupt of [TMUX-057](../user/tmux-play.md#tmux-057), and the bracketed-paste submission of [TMUX-058](../user/tmux-play.md#tmux-058) shall continue to hold.
  Where stdout is not a TTY, input rendering shall fall back to the underlying readline echo and the row-duplication guarantee shall not apply.
- New [TTMUX-067](../test/tmux-play.md#ttmux-067): real-tmux acceptance that first fills the pane so the `boss> ` prompt sits on the bottom row, then types and edits a line of visible width ≥ `2·W` (with distinct per-row content) across the `W`-column boundary, then asserts that no input row repeats in captured scrollback, that no captured input row is `W` cells wide, and that the prompt-stripped visible input rows concatenate to the typed text; it submits no Boss turn (needs no API key), and delegates the ESC-during-turn and bracketed multi-line paste regressions to the session-level [TTMUX-059](../test/tmux-play.md#ttmux-059) / [TTMUX-060](../test/tmux-play.md#ttmux-060).
- `src/app/tmux-play/`: a Boss input renderer that drives off readline's `line`/`cursor`, reserves the last column, emits explicit breaks at wrap boundaries, and clears/repaints the input region; readline is given a discarding sink output so its magic-margin redraw never reaches the pane.
- `src/app/tmux-play/session.ts`: wire the renderer into the turn lifecycle (clear the input region before captain output streams, repaint after `runBossTurn` and at every `prompt()` point), keeping TMUX-037/057/058 intact.
- `specs/map.md`: index IR-024; extend the TMUX user-summary line to mention wrap-correct Boss input rendering.

Out of scope (deliberate non-goals):

- Changing the player (`tail -f`) panes; they do not exhibit the bug.
- Adjusting tmux `history-limit`, pane geometry, or copy-mode; the fix is in how input is rendered, not how history is stored.
- Typed multi-line input UX (still governed by [TMUX-058](../user/tmux-play.md#tmux-058) paste semantics only).

## Mechanism notes (pinned by this IR)

Renderer ownership: create the readline interface with `terminal: true` so it still raw-modes stdin (required by [TMUX-057](../user/tmux-play.md#tmux-057)/[TMUX-058](../user/tmux-play.md#tmux-058)) and maintains `line`/`cursor`/history/`line` events, but give it a discarding sink as `output` so its own redraw is suppressed.
The session renders the prompt-plus-`line` to the real pane on each `keypress`, wrapping at `W-1` cells with an explicit `\r\n` at each wrap point so the terminal never enters deferred wrap, and positions the cursor from `rl.cursor`.
Width is measured in display cells via the shared `displayCells` model (the same one the presenter soft-wraps with, [TMUX-046](../user/tmux-play.md#tmux-046)), not UTF-16 code units, and the buffer is packed a code point at a time: a wide (CJK / emoji) character is never split across a wrap boundary and never overflows the reserved rightmost column, so the no-`W`-th-column guarantee holds for non-ASCII Boss input; the `rl.cursor` code-unit index is mapped back to a column through each code point's code-unit length.

Lifecycle coordination: the presenter writes captain output to the same pane during a turn.
The renderer must clear its input region before captain output streams and repaint after the turn finishes and at every point that previously called `readline.prompt()`, so input still appears exactly once per [TMUX-037](../user/tmux-play.md#tmux-037).

Fallback: if coordinating a wrap-correct multi-row repaint with async captain output proves to interleave poorly, narrow the renderer to a single-row horizontal-scroll input (also reserves the last column, so multi-row drift cannot occur); record the choice in a follow-up note on TMUX-067.

## Deliverables

- [x] `specs/user/tmux-play.md` — add TMUX-067 (wrap-correct Boss input rendering, no scrollback duplication).
- [x] `specs/test/tmux-play.md` — add TTMUX-067 (real-tmux no-duplication + no-rightmost-column acceptance that submits no Boss turn; ESC/paste continuity delegated to TTMUX-059/060).
- [x] `specs/map.md` — index IR-024; extend the TMUX user-summary line.
- [x] `src/app/tmux-play/boss-input-renderer.ts` — Boss input renderer module (reserve last column, explicit wrap breaks, region clear/repaint) with `boss-input-renderer.test.ts` unit tests for byte output at boundary widths.
- [ ] `src/app/tmux-play/session.ts` — sink output for readline; repaint-on-keypress; clear-before / repaint-after turn lifecycle; TMUX-037/057/058 preserved.
- [ ] `src/app/tmux-play/session.test.ts` — session-level tests that the input region repaints exactly once around a turn and that ESC/paste still behave per TMUX-057/058.
- [ ] `src/app/tmux-play/*.acceptance` (real-tmux gate) — TTMUX-067 scrollback no-duplication acceptance.

## Tasks

1. [x] **Spec items + map.** Add TMUX-067 and TTMUX-067; index IR-024 in `specs/map.md`; extend the TMUX user-summary line. Docs-only commit.
2. [x] **Input renderer module.** Implement the wrap-correct renderer (reserve last column, explicit breaks at wrap points, region clear/repaint) driven off `line`/`cursor`. Unit tests pin the emitted bytes at widths where the prompt-plus-content hits exact `W` and `2·W` boundaries. Per-task-boundary green.
3. [ ] **Session integration.** Give readline a discarding sink output; repaint on `keypress`; clear the input region before captain output and repaint after `runBossTurn` and at prior `prompt()` points; preserve TMUX-037/057/058. Session-level integration tests. Per-task-boundary green.
4. [ ] **Real-tmux acceptance.** Add TTMUX-067 under the existing real-tmux acceptance gate: fill the pane so `boss> ` sits on the bottom row, type/edit ≥ `2·W` across the boundary with distinct per-row content, assert no input row repeats in captured scrollback, assert no captured input row is `W` cells wide, and assert the prompt-stripped rows concatenate to the typed text; submit no Boss turn (ESC + bracketed paste continuity stays covered by TTMUX-059/060). Per-task-boundary green.

## Acceptance

- In a real tmux pane of width `W` whose prompt sits on the bottom row, typing and editing an input line of visible width ≥ `2·W` across the `W`-column boundary leaves no duplicated input row in the captured scrollback and no captured input row of width `W`.
- The prompt-stripped visible Boss input rows concatenate to the typed text byte-for-byte.
- The Boss input still appears exactly once in the pane per [TMUX-037](../user/tmux-play.md#tmux-037); captain output during a turn does not double-print the input region.
- ESC during an active turn still aborts per [TMUX-057](../user/tmux-play.md#tmux-057); a bracketed multi-line paste still submits one turn per [TMUX-058](../user/tmux-play.md#tmux-058).
- Where stdout is not a TTY, the session falls back to readline echo and remains functional; the SIGINT/SIGTERM/EOF lifecycle per [TMUX-026](../user/tmux-play.md#tmux-026) is unchanged in every mode.
- All per-task-boundary checks (build, typecheck, lint, unit, smoke, acceptance) pass at each task boundary.

## References

[1]: https://github.com/nodejs/node/blob/v25.8.0/lib/internal/readline/interface.js "Node.js — readline Interface (kGetDisplayPos / kRefreshLine), v25.8.0"
[2]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html "xterm Control Sequences — DEC Private Mode (DECSET/DECRST), Ps = 7 Auto-Wrap Mode (DECAWM)"
