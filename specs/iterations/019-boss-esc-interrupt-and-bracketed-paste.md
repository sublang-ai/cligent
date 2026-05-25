<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-019: Boss ESC Interrupt and Bracketed Paste

## Goal

Let the Boss interrupt an in-flight turn with a single ESC keypress without ending the session or losing typed input, returning to the `boss> ` prompt for the next turn.
Let the Boss paste multi-line text and have it submit as a single Boss turn under one explicit Enter, instead of one turn per embedded newline (the current behavior because plain readline treats every `\n` as line submission).
Both behaviors shall reuse Node's `readline` for editing, history, echo, EOF, and SIGINT, layering only a `keypress` listener and a bracketed-paste toggle — no raw-mode editor.

## Status

In Progress

## Scope

In scope:

- New [TMUX-057](../user/tmux-play.md#tmux-057): while the runtime has an active Boss turn, when the Boss presses ESC in the Boss/Captain pane, the session shall abort that turn without ending the session, the Boss/Captain pane shall render the existing `[turn aborted: ESC]` line per [TMUX-040](../user/tmux-play.md#tmux-040), the contents of the Boss readline's edit buffer shall be preserved across the abort, and the `boss> ` prompt shall return ready for the next Boss turn.
  Outside an active turn an ESC keypress shall have no observable effect.
  Where stdin is not a TTY the ESC keybinding shall not be installed; the SIGINT/SIGTERM/EOF lifecycle per [TMUX-026](../user/tmux-play.md#tmux-026) shall be unaffected in every mode.
- New [TMUX-058](../user/tmux-play.md#tmux-058): where both stdin and stdout of the Boss session are TTYs, when the Boss pastes multi-line text into the Boss/Captain pane and then presses Enter, the session shall submit exactly one Boss turn whose `BossTurn.prompt` preserves the pasted text's embedded newlines as `\n` characters within the single prompt string; bytes typed by the Boss after the paste and before that Enter shall be included in the same submission.
  Where either stdin or stdout is not a TTY the multi-line paste behavior shall be omitted and embedded newlines in pasted text shall behave as in the underlying readline (one Boss turn per `\n`).
  The session shall enable bracketed paste only for its own duration and shall emit the bracketed-paste-disable sequence on every shutdown path so tmux-play does not leave bracketed-paste mode enabled in the terminal after exit.
- New [TTMUX-059](../test/tmux-play.md#ttmux-059): given a `TmuxPlaySession` with an active Boss turn in flight, when the session's input delivers the byte `\x1b` and the readline escape timeout elapses, the runtime shall emit one `turn_aborted` record, the next `runBossTurn` invocation shall be accepted, and no `runtime_error` or shutdown record shall be emitted.
  Given the same session, when the input delivers the sequence `\x1b[A`, no `turn_aborted` record shall be emitted.
  Given the readline edit buffer contained user-typed bytes when the bare ESC arrived, those bytes shall remain in the edit buffer after the abort.
- New [TTMUX-060](../test/tmux-play.md#ttmux-060): given a `TmuxPlaySession` whose input and output are both TTYs, when the input delivers `\x1b[200~Alpha\nBravo\nCharlie\x1b[201~` followed by `\n`, exactly one `runBossTurn` invocation shall fire with `prompt = 'Alpha\nBravo\nCharlie'`.
  Given the input delivers `\x1b[200~Alpha\nBravo\n\x1b[201~` followed by `\n`, exactly one `runBossTurn` shall fire with `prompt = 'Alpha\nBravo'`.
  Given the input delivers `\x1b[200~Alpha\nBravo\x1b[201~` followed by `-extra\n`, exactly one `runBossTurn` shall fire with `prompt = 'Alpha\nBravo-extra'`.
- `src/app/tmux-play/session.ts`: pass `escapeCodeTimeout: 100` to `createInterface`; call `readline.emitKeypressEvents(input, this.readline)`; attach one `keypress` listener implementing both behaviors; toggle bracketed-paste mode via `stdout.write`; remove the listener and write `\x1b[?2004l` from `shutdown()` and from a `process.on('exit')` hook.
- `specs/map.md`: index IR-019; extend the TMUX user-summary line to mention Boss input keybindings.

Out of scope (deliberate non-goals):

- Typed multi-line input (no `Shift+Enter` soft-newline, no heredoc framing).
  The reported user pain is *pasted* multi-line; typed multi-line is a separable UX decision that would force a new submit convention and is not addressed here.
- A full readline replacement / raw-mode editor.
  Node's `readline` continues to own editing, history, backspace, arrow keys, prompt repaint, and `terminal: true` raw-mode entry/exit.
- ESC as a partial cancel (e.g., clearing the edit buffer or canceling a queued-but-not-yet-running turn).
  ESC is wired only to `abortActiveTurn`; the queued-turn case is handled by the existing serialization in [TMUX-018](../user/tmux-play.md#tmux-018) and an aborted active turn naturally yields to the next queued one.

## Mechanism notes (pinned by this IR)

`escapeCodeTimeout: 100` (ms): default 500 ms makes ESC feel laggy.
50–75 ms risks splitting genuine escape sequences over unusual pipes; 100 ms keeps perceived latency under the human "instant" threshold while giving margin for sluggish containers.
Setting it explicitly also makes unit tests deterministic with `vi.advanceTimersByTime(100)`.

Bare-ESC guard: `key.name === 'escape' && key.sequence === '\x1b'`.
Asserting on the byte sequence (one byte, `\x1b`) excludes Alt-ESC and other `\x1b\x1b`-encoded combos in a Node-version-insensitive way; `key.name` alone is not sufficient.

Bracketed-paste detection: `paste-start` and `paste-end` are first-class `keypress` names emitted by Node's `emitKeypressEvents` [[2]] parser when the xterm bracketed-paste markers `\x1b[200~` / `\x1b[201~` [[1]] arrive in the input stream; no byte-level marker parsing is needed inside the session.

Accumulation algorithm: Node's `readline` does **not** coalesce pasted multi-line text into a single `line` event even when paste-start/paste-end are recognized; each embedded `\n` still fires `line`.
The session must observe `inPaste` state and intercept `line` events: push to buffer while `inPaste`, flush on the next `line` after `paste-end`.
Submit shape on flush: one `runBossTurn` invocation whose prompt is `pasteBuffer.join('\n')` followed by `'\n' + line` (when `line` is non-empty) or just `pasteBuffer.join('\n')` (when `line` is empty, i.e., the paste carried a trailing newline absorbed by the explicit Enter).
Validated end-to-end with a mock TTY (three cases: paste with trailing newline, paste without trailing newline + typed continuation, normal typed line).

Cleanup: `\x1b[?2004l` must run on every exit path; otherwise the user's shell sees literal `\x1b[200~` … `\x1b[201~` wrapping subsequent pastes.

## Deliverables

- [x] `specs/user/tmux-play.md` — add TMUX-057 (ESC interrupt) and TMUX-058 (bracketed paste).
- [x] `specs/test/tmux-play.md` — add TTMUX-059 (ESC verification) and TTMUX-060 (paste verification).
- [x] `specs/map.md` — index IR-019; extend the TMUX user-summary line to mention Boss input keybindings.
- [x] `src/app/tmux-play/session.ts` — wire `escapeCodeTimeout`, install `keypress` listener for ESC, call `runtime.abortActiveTurn('ESC')` on bare ESC, remove listener in `shutdown()`.
- [ ] `src/app/tmux-play/session.ts` — write `\x1b[?2004h` on start and `\x1b[?2004l` on every shutdown path; track `inPaste` via `keypress` events; intercept `line` events to accumulate-then-flush the pasted block.
- [x] `src/app/tmux-play/session.test.ts` — session-level test covering TTMUX-059 against a programmable TTY-like input/output pair.
- [ ] `src/app/tmux-play/session.test.ts` — session-level test covering TTMUX-060 against a programmable TTY-like input/output pair.

## Tasks

1. [x] **Spec items + map.** Add TMUX-057, TMUX-058, TTMUX-059, TTMUX-060; index IR-019 in `specs/map.md`; extend the TMUX user-summary line. Single docs-only commit.
2. [x] **ESC interrupt implementation.** `session.ts` changes for ESC: `escapeCodeTimeout`, `emitKeypressEvents`, bare-ESC guard, `abortActiveTurn('ESC')`, listener cleanup in `shutdown()`. Session-level integration test verifying [TTMUX-059](../test/tmux-play.md#ttmux-059). Per-task-boundary green.
3. **Bracketed paste implementation.** `session.ts` changes for paste: bracketed-paste toggle (with all-exit-paths disable), `inPaste` state from `keypress`, `line` interception with accumulate-and-flush. Session-level integration test verifying [TTMUX-060](../test/tmux-play.md#ttmux-060). Per-task-boundary green.

## Acceptance

- Bare `\x1b` pushed to a mock TTY input during an active turn fires `runtime.abortActiveTurn('ESC')` exactly once and yields `turn_aborted`; the readline buffer's pre-existing typed bytes remain; `runBossTurn` accepts the next prompt afterward; no `shutdown` runs.
- `\x1b[A` (arrow-up) pushed to the same input does not trigger the abort.
- A multi-line bracketed-paste sequence followed by one Enter submits exactly one Boss turn whose prompt contains all pasted lines joined by `\n`, with any paste-trailing `\n` absorbed into the explicit Enter.
- Typed bytes after `paste-end` and before the next Enter ride on the last pasted line within the single submission.
- Non-TTY stdin (piped input, CI) skips ESC keypress handling; non-TTY stdout (redirected output) skips the bracketed-paste toggle; either skip is non-fatal; SIGINT/SIGTERM/EOF still trigger the full-shutdown path per [TMUX-026](../user/tmux-play.md#tmux-026).
- `\x1b[?2004l` is emitted on every shutdown path so tmux-play does not leave bracketed-paste mode enabled in the terminal after exit.
- All per-task-boundary checks (build, typecheck, lint, unit, smoke, acceptance) pass at each task boundary.

## References

[1]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Bracketed-Paste-Mode "xterm Control Sequences — Bracketed Paste Mode"
[2]: https://nodejs.org/api/readline.html#readlineemitkeypresseventsstream-interface "Node.js — readline.emitKeypressEvents()"
