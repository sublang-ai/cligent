<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-020: Abort Continuity and Pane Contrast

## Goal

Preserve role and Captain session continuity across ESC-aborted Boss turns.
Today every adapter's `interrupted` branch omits `resumeToken` from the `done` payload even when the backend session identifier is already in scope, so the next Boss turn for that role starts a fresh adapter session and the role loses its prior context — the symptom is "after ESC, Claude/Codex come back with 'I have no prior context.'"
The fix is a three-stage rule applied uniformly at every `interrupted`-status `done` emission — prefer a backend-emitted session id, otherwise echo the call's `options.resume`, otherwise omit `resumeToken` — captured behind a single helper called from each of the eight interrupt-path touch points across the four adapters.

Improve the tmux-play pane-border row contrast.
The pane title and per-pane timer share the pane-border row, but the launcher's current format closes the title styling with `#[default]` and leaves the rest of the row to the terminal's default background, rendering as a hard black bar that swallows the dim `overlay1` timer text.
Carry the Catppuccin surface tone across the whole border row and lift the not-running timer text to a readable Catppuccin tone.

## Status

Done

## Scope

In scope:

- [CLAUDE-007](../user/adapters/claude-code.md#claude-007), [CODEX-006](../user/adapters/codex.md#codex-006), [GEMINI-009](../user/adapters/gemini.md#gemini-009), [OPENCODE-011](../user/adapters/opencode.md#opencode-011): amend each so that on `done` with `status: 'interrupted'` the adapter shall set `DonePayload.resumeToken` per a three-stage rule: (a) if the backend emitted a session identifier before the abort, use that identifier; (b) otherwise, if the call's `options.resume` was non-empty (a resumed turn aborted before the backend echoed a replacement id), echo `options.resume` back; (c) otherwise (no id ever known for this run), omit `resumeToken`. The success-path behavior is unchanged. The (b) branch is required because cligent's role-scoped session clears its stored continuity whenever a `done` omits `resumeToken` (`src/cligent.ts:218,312`); without (b) the common ESC-during-resumed-turn case would silently make the next turn fresh.
- New [TADAPT-020](../test/adapters.md#tadapt-020): given each adapter (Claude, Codex, Gemini, OpenCode), the adapter's `done` event with `status: 'interrupted'` shall carry `resumeToken` per the three-stage rule above. Given a mock SDK that emitted a session identifier and was then aborted, `resumeToken` shall equal that identifier. Given a mock SDK that did not emit a session identifier but the call's `options.resume` was non-empty, `resumeToken` shall equal `options.resume`. Given a mock SDK that emitted no identifier and an empty/absent `options.resume`, `resumeToken` shall be omitted.
- [TMUX-048](../user/tmux-play.md#tmux-048): amend the `pane-border-format` clause to carry an explicit Catppuccin Mocha [[1]] surface background across the full pane-border row, not `#[default]`, so the post-title segment (separator, timer hourglass, timer text) renders on the same surface as the title rather than on the terminal default.
- [TMUX-054](../user/tmux-play.md#tmux-054): amend to pin the not-running pane-border timer text to a Catppuccin Mocha text-level tone (e.g., `subtext1` `#bac2de`) instead of `overlay1` (`#7f849c`), for legible contrast against the pane-border surface; the running-state per-pane accent color remains unchanged.
- `src/adapters/claude-code.ts:875` and `:912`, `src/adapters/codex.ts:888` and `:929`, `src/adapters/gemini.ts:1051`, `src/adapters/opencode.ts:1103`, `:1406`, and `:1469` — eight interrupt-path `done` emissions in total (main-loop and catch-path for Claude and OpenCode; main and turn-failed for Codex; gemini and opencode `!doneYielded`-fallback). Apply the three-stage rule to every site, ideally via a single helper (e.g., `resolveInterruptedResumeToken(backendProvidedSessionId, sessionId, options?.resume)`) so the eight call sites stay one-line.
- `src/__tests__/{claude-code,codex,gemini,opencode}-adapter.test.ts`: per-adapter abort-with-token unit tests covering all three branches of the rule — (a) backend id emitted before abort, (b) no backend id but `options.resume` set, (c) neither.
- `src/app/tmux-play/launcher.ts`: in `paneBorderFormat`, replace the post-title `#[default]` reset with an explicit `#[bg=<surface>]` that matches the active/inactive title's background, so the whole border row is one surface tone; in `timerColorFormat`, replace the not-running `overlay1` fallback with the chosen Catppuccin text-level tone.

Out of scope:

- The runtime-level wiring from a `done.resumeToken` into the next adapter `run({ resume })` call.
  That path already exists in cligent's role-scoped session ([DR-003](../decisions/003-role-scoped-session-management.md)); the bug is purely that adapters stopped feeding it on the abort path.
- [TTMUX-059](../test/tmux-play.md#ttmux-059) is not amended.
  The session-level ESC test verifies abort behavior; resume-after-abort is verified at the adapter contract level by the new TADAPT item, since it depends on adapter-specific session-ID emission timing.
- Status bar (`status-style`, `status-left`, `status-right`), pane border line styling outside the title row, role color palette, and adapter color accents are not changed.

## Mechanism notes (pinned by this IR)

Adapter abort path: each adapter already captures the SDK-provided session identifier into a local `sessionId` and tracks whether the backend emitted it via `backendProvidedSessionId`.
The success-path `done` emissions spread `...(backendProvidedSessionId ? { resumeToken: sessionId } : {})`; the interrupt-path emissions in the same files do not, and they also fail to fall back to `options.resume` when present — which is the abort-during-resumed-turn case where the backend hasn't yet echoed a replacement id but the call already had a known prior session to resume.
The three-stage rule (Scope) captures both cases: prefer the freshly-emitted id when present, otherwise echo the inbound `options.resume`, otherwise omit.
Factoring the rule into one helper keeps the eight touch points uniform and makes the new TADAPT item's three Given clauses map one-to-one onto helper branches.
The success path's existing TADAPT-010 / TADAPT-011 / TADAPT-012 / TADAPT-013 coverage stays valid; only the interrupt path needs new verification.

Pane-border row continuity: the current `paneBorderFormat` opens with either `#[fg=base,bg=blue,bold]` (active) or `#[fg=text,bg=mantle]` (inactive), writes the title, then emits `#[default]`.
`#[default]` returns to the terminal's default style, which in most modern terminals is a near-black background — visually a hard cut between the colored title and the dim timer text that follows.
Replacing `#[default]` with `#[bg=<surface>]` (matching the chosen surface for the row) keeps the whole pane-border row at one tone.

Timer color: `timerColorFormat`'s not-running branch currently uses `overlay1` (`#7f849c`), close in luminance to the chosen surface tones; against `mantle` or any darker surface it reads as low-contrast grey-on-grey.
Bumping to `subtext1` (`#bac2de`) keeps the timer subdued relative to the active title accent (`blue`) but legible at a glance.

## Deliverables

- [x] `specs/user/adapters/{claude-code,codex,gemini,opencode}.md` — amend CLAUDE-007 / CODEX-006 / GEMINI-009 / OPENCODE-011 with the interrupt-token clause.
- [x] `specs/test/adapters.md` — add a new TADAPT item verifying the interrupt-with-token contract across all four adapters.
- [x] `specs/user/tmux-play.md` — amend TMUX-048 (pane-border row surface continuity) and TMUX-054 (timer color contrast).
- [x] `specs/map.md` — index IR-020.
- [x] `src/adapters/{claude-code,codex,gemini,opencode}.ts` — apply the three-stage `resumeToken` rule (via a shared helper) at every interrupt-path `done` emission (8 touch points).
- [x] `src/__tests__/{claude-code,codex,gemini,opencode}-adapter.test.ts` — per-adapter abort-with-token unit tests.
- [x] `src/app/tmux-play/launcher.ts` — `paneBorderFormat` post-title bg continuity; `timerColorFormat` not-running color bump.

## Tasks

1. [x] **Spec items + map.** Amend the four adapter user items and TMUX-048 / TMUX-054; add the new TADAPT item; index IR-020 in `specs/map.md`. Single docs-only commit.
2. [x] **Adapter abort-token fix.** Factor the three-stage resume-token rule into a shared helper and apply it at all eight interrupt-path `done` emissions across the four adapters; add per-adapter unit tests covering all three branches of the rule. Per-task-boundary green.
3. [x] **Pane-border row contrast.** Update `paneBorderFormat` to carry a single surface tone across the full row and `timerColorFormat`'s not-running color; update or add launcher tests asserting the new format string. Per-task-boundary green.

## Acceptance

- For each of the four adapters, the `done` event with `status: 'interrupted'` honors the three-stage rule: (a) backend emitted id before abort → `resumeToken` equals that id; (b) no emitted id, but `options.resume` was non-empty → `resumeToken` equals `options.resume`; (c) no emitted id and empty/absent `options.resume` → `resumeToken` omitted.
- After an ESC-aborted Boss turn, a follow-up Boss turn for the same role results in `adapter.run` being called with the `resume` option set to the prior session's identifier (no fresh adapter session is started).
- The tmux pane-border row reads as a single Catppuccin surface tone from left edge to right edge of the title segment — no hard black gap between the pane title and the per-pane timer.
- The not-running pane-border timer text is legible against the pane-border surface (concrete contract: not `overlay1`; a Catppuccin text-level tone such as `subtext1`).
- All per-task-boundary checks (build, typecheck, lint, unit, smoke) pass at each task boundary.

## References

[1]: https://catppuccin.com/palette/ "Catppuccin Palette"
