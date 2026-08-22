<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-020: Abort Continuity and Pane Contrast

## Status

Done

## Intent

Preserve player and Captain session continuity across ESC-aborted Boss turns.
Today every adapter's `interrupted` branch omits `resumeToken` from the `done` payload even when the backend session identifier is already in scope, so the next Boss turn for that player starts a fresh adapter session and the player loses its prior context — the symptom is "after ESC, Claude/Codex come back with 'I have no prior context.'"
The fix is a three-stage rule applied uniformly at every `interrupted`-status `done` emission — prefer a known resumable session id, otherwise echo the call's `options.resume`, otherwise omit `resumeToken` — captured behind a single helper called from each of the eight interrupt-path touch points across the four adapters.
When an aborted fresh run has no trustworthy resume token, the interrupted `done` omits `resumeToken`; tmux-play exposes that through `PlayerRunResult`, and the built-in fanout Captain consumes it by retaining the aborted Boss prompt for that player and including it in that player's next prompt.

Improve the tmux-play pane-border row contrast.
The pane title and per-pane timer share the pane-border row, but the launcher's current format closes the title styling with `#[default]` and leaves the rest of the row to the terminal's default background, rendering as a hard black bar that swallows the dim `overlay1` timer text.
Carry the Catppuccin surface tone across the whole border row and lift the not-running timer text to a readable Catppuccin tone.

## Scope

In scope:

- [[claude-code-26](../packages/adapters/claude-code.md#claude-code-26)], [[codex-33](../packages/adapters/codex.md#codex-33)], [[gemini-9](../packages/adapters/gemini.md#gemini-9)], [[opencode-11](../packages/adapters/opencode.md#opencode-11)]: amend each so that on `done` with `status: 'interrupted'` the adapter shall set `DonePayload.resumeToken` per a three-stage rule: (a) if a resumable session identifier is known before the abort, use that identifier; (b) otherwise, if the call's `options.resume` was non-empty (a resumed turn aborted before the backend echoed a replacement id), echo `options.resume` back; (c) otherwise (no id ever known for this run), omit `resumeToken`. For Claude Code fresh runs, a generated SDK `sessionId` is not considered resumable until non-system SDK activity is observed, because live Claude Code rejects resume for an init-only aborted session. The success-path behavior is unchanged. The (b) branch is required because cligent's player-scoped session clears its stored continuity whenever a `done` omits `resumeToken` (`src/cligent.ts:218,312`); without (b) the common ESC-during-resumed-turn case would silently make the next turn fresh.
- [[tmux-play-99](../packages/tmux-play.md#tmux-play-99)] / [[tmux-play-41](../packages/tmux-play.md#tmux-play-41)]: when a player call finishes with interrupted `done`, `PlayerRunResult` shall expose `resumeToken` when present and omit it when absent. Captains can detect `status: 'aborted'` with no `resumeToken` as an interrupted, not-resumable player call.
- [[tmux-play-42](../packages/tmux-play.md#tmux-play-42)]: when the built-in fanout Captain observes a player result with `status: 'aborted'` and no `resumeToken`, it shall retain that player's base Boss prompt and include retained unresolved Boss prompt(s) with the latest Boss prompt on that player's next call. It shall clear retained recovery context after a non-aborted result or an aborted result with `resumeToken`.
- New [[claude-code-220](../packages/adapters/claude-code.md#claude-code-220)], [[codex-220](../packages/adapters/codex.md#codex-220)], [[gemini-220](../packages/adapters/gemini.md#gemini-220)], and [[opencode-220](../packages/adapters/opencode.md#opencode-220)]: given each adapter (Claude, Codex, Gemini, OpenCode), the adapter's `done` event with `status: 'interrupted'` shall carry `resumeToken` per the three-stage rule above. Given a mock SDK that emitted a session identifier and was then aborted, `resumeToken` shall equal that identifier. Given a mock SDK that did not emit a session identifier but the call's `options.resume` was non-empty, `resumeToken` shall equal `options.resume`. Given Claude starts a fresh run and is aborted before non-system SDK activity is observed, `resumeToken` shall be omitted; after such activity, `resumeToken` shall equal the SDK-provided or generated SDK `sessionId`. Given Codex, Gemini, or OpenCode emitted no identifier and an empty/absent `options.resume`, `resumeToken` shall be omitted.
- [[tmux-play-199](../packages/tmux-play.md#tmux-play-199)]: amend the `pane-border-format` clause to carry an explicit Catppuccin Mocha [[1]] surface background across the full pane-border row, not `#[default]`, so the post-title segment (separator, timer hourglass, timer text) renders on the same surface as the title rather than on the terminal default.
- [[tmux-play-54](../packages/tmux-play.md#tmux-play-54)]: amend to pin the not-running pane-border timer text to a Catppuccin Mocha text-level tone (e.g., `subtext1` `#bac2de`) instead of `overlay1` (`#7f849c`), for legible contrast against the pane-border surface; the running-state per-pane accent color remains unchanged.
- `src/adapters/claude-code.ts:875` and `:912`, `src/adapters/codex.ts:888` and `:929`, `src/adapters/gemini.ts:1051`, `src/adapters/opencode.ts:1103`, `:1406`, and `:1469` — eight interrupt-path `done` emissions in total (main-loop and catch-path for Claude and OpenCode; main and turn-failed for Codex; gemini and opencode `!doneYielded`-fallback). Apply the three-stage rule to every site, ideally via a single helper (e.g., `doneResumeTokenPayload(status, resumableSessionIdKnown, sessionId, options?.resume)`) so the eight call sites stay one-line.
- `src/__tests__/{claude-code,codex,gemini,opencode}-adapter.test.ts`: per-adapter abort-with-token unit tests covering the rule branches — (a) known id before abort, (b) no known id but `options.resume` set, (c) neither. Claude Code additionally covers the fresh-run generated SDK `sessionId` path.
- `src/app/tmux-play/launcher.ts`: in `paneBorderFormat`, replace the post-title `#[default]` reset with an explicit `#[bg=<surface>]` that matches the active/inactive title's background, so the whole border row is one surface tone; in `timerColorFormat`, replace the not-running `overlay1` fallback with the chosen Catppuccin text-level tone.

Out of scope:

- The runtime-level wiring from a `done.resumeToken` into the next adapter `run({ resume })` call.
  That path already exists in cligent's player-scoped session ([DR-003](../decisions/003-role-scoped-session-management.md)); the bug is purely that adapters stopped feeding it on the abort path.
- Engine-level prompt reconstruction or replay for aborted, not-resumable calls.
  Cligent only receives one prompt at a time and owns opaque session orchestration, not conversation policy. Rebuilding context belongs to the Captain/application layer that holds the conversation policy; this IR covers the built-in fanout Captain's recovery behavior.
- [[tmux-play-159](../packages/tmux-play.md#tmux-play-159)] is not amended.
  The session-level ESC test verifies abort behavior; resume-after-abort is verified at the adapter contract level by the new TADAPT item, since it depends on adapter-specific session-ID emission timing.
- Status bar (`status-style`, `status-left`, `status-right`), pane border line styling outside the title row, player color palette, and adapter color accents are not changed.

## Deliverables

- [x] `specs/packages/adapters/{claude-code,codex,gemini,opencode}.md` — amend claude-code-26 / codex-33 / gemini-9 / opencode-11 with the interrupt-token clause.
- [x] `specs/test/adapters.md` — add a new cross-adapter item verifying the interrupt-with-token contract across all four adapters.
- [x] `specs/user/tmux-play.md` — amend tmux-play-99 / tmux-play-41 (interrupted result exposure), tmux-play-42 (fanout recovery for tokenless aborts), tmux-play-199 (pane-border row surface continuity), and tmux-play-54 (timer color contrast).
- [x] `specs/map.md` — index IR-020.
- [x] `src/adapters/{claude-code,codex,gemini,opencode}.ts` — apply the three-stage `resumeToken` rule (via a shared helper) at every interrupt-path `done` emission (8 touch points).
- [x] `src/__tests__/{claude-code,codex,gemini,opencode}-adapter.test.ts` — per-adapter abort-with-token unit tests.
- [x] `src/app/tmux-play/{contract,runtime}.ts` — expose player interrupted `resumeToken` when present and omit it when absent.
- [x] `src/captains/fanout.ts` — retain tokenless aborted Boss prompts per player and include them in the next prompt for that player.
- [x] `src/app/tmux-play/launcher.ts` — `paneBorderFormat` post-title bg continuity; `timerColorFormat` not-running color bump.

## Tasks

1. [x] **Spec items + map.** Amend the four adapter user items and tmux-play-199 / tmux-play-54; add the new TADAPT item; index IR-020 in `specs/map.md`. Single docs-only commit.
2. [x] **Adapter abort-token fix.** Factor the three-stage resume-token rule into a shared helper and apply it at all eight interrupt-path `done` emissions across the four adapters; expose player interrupted `resumeToken` through tmux-play results; add per-adapter, runtime, and fanout unit tests covering the rule branches and tokenless recovery. Per-task-boundary green.
3. [x] **Pane-border row contrast.** Update `paneBorderFormat` to carry a single surface tone across the full row and `timerColorFormat`'s not-running color; update or add launcher tests asserting the new format string. Per-task-boundary green.

## Verification

- For each of the four adapters, the `done` event with `status: 'interrupted'` honors the three-stage rule: (a) known resumable id before abort → `resumeToken` equals that id; (b) no known resumable id, but `options.resume` was non-empty → `resumeToken` equals `options.resume`; (c) no known resumable id and empty/absent `options.resume` → `resumeToken` omitted.
- After an ESC-aborted Boss turn where the player has a `resumeToken`, a follow-up Boss turn for the same player results in `adapter.run` being called with the `resume` option set to the prior session's identifier, and the aborted `PlayerRunResult` exposes that token. After an ESC-aborted Boss turn where the player has no `resumeToken`, the aborted `PlayerRunResult` omits it, runtime/engine calls do not synthesize prompt content, and the built-in fanout Captain includes retained tokenless aborted Boss prompt(s) with the latest Boss prompt on that player's next call.
- The tmux pane-border row reads as a single Catppuccin surface tone from left edge to right edge of the title segment — no hard black gap between the pane title and the per-pane timer.
- The not-running pane-border timer text is legible against the pane-border surface (concrete contract: not `overlay1`; a Catppuccin text-level tone such as `subtext1`).
- All per-task-boundary checks (build, typecheck, lint, unit, smoke) pass at each task boundary.

## References

[1]: https://catppuccin.com/palette/ "Catppuccin Palette"
