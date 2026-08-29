<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-021: Unified Bracketed-Tag Grammar

## Status

Done — all four tasks closed at per-task-boundary green (typecheck, lint, unit 473/473 including the no-reason `turn_aborted` regression guard, smoke 7/7); the real-glow acceptance probe pins the unified `<who>> [tool ✓] <toolName>` header alongside the preserved tmux-play-49 payload-preservation invariants, and the full acceptance suite reports 18/18 passing.

## Intent

Collapse the tmux-play presenter's operational-line family — `[status]`, `[error: …]`, `[aborted]`, `[turn aborted: …]`, `[runtime error: …]`, plus the today-separate `tool>` / `tool<` lines — into a single grammar: every operational line shall read `<who>> [<tag> <optional glyph>] <optional body>` where the speaker prefix is the standard [[tmux-play-38](../packages/tmux-play.md#tmux-play-38)] `<who>> ` (no longer replaced by `tool>` / `tool<`), the bracketed tag carries the kind and an optional state glyph, and the body — when present — lives outside the brackets.

The family is incoherent today on two axes.
First, three sub-shapes coexist for body attachment: `[aborted]` carries no body, `[status] message` puts the body outside the brackets, and `[error: msg]` / `[runtime error: msg]` / `[turn aborted: reason]` put it inside the brackets after a colon.
Second, tool lifecycle lines opt out of the family entirely — they replace the `<who>> ` speaker prefix with `tool>` / `tool<` and color the prefix span by the caller's adapter accent, which is the only place in the presenter grammar where the speaker prefix is replaced rather than wrapped, and the only place where speaker identity is encoded purely as a color cue rather than literal text.

Folding tools into the family requires a glyph slot inside the bracket (tools have a 2D state space: call vs. result × ok/err/denied that color alone can't disambiguate), which then lets every member follow one rule: `[<tag> <optional glyph>] <optional body>`.
The glyph slot is optional and is only populated for kinds with multi-state semantics — tools today.
Other members (status, error, aborted, turn-aborted, runtime-error) carry no glyph; the word in the tag already names the kind and color carries the outcome.

## Scope

In scope:

- [[tmux-play-38](../packages/tmux-play.md#tmux-play-38)]: amend the closing paragraph that today reads "Status lines (per tmux-play-39) and tool lifecycle lines (per tmux-play-49) bypass `glow` — they are single-line operational text — and apply the prefix directly" to "Status lines (per [[tmux-play-39](../packages/tmux-play.md#tmux-play-39)]) and tool lifecycle lines (per [[tmux-play-49](../packages/tmux-play.md#tmux-play-49)]) bypass `glow` — they are single-line operational text — and apply the speaker prefix plus the bracketed-tag grammar directly." The speaker prefix grammar now governs tool lines as well; the `tool>` / `tool<` prefix replacement is retired.
- [[tmux-play-39](../packages/tmux-play.md#tmux-play-39)]: replace the per-member rendering rules with one unified rule. Every operational line shall be `<who>> [<tag> <optional glyph>] <optional body>` where: (a) the `<who>> ` speaker prefix follows [[tmux-play-38](../packages/tmux-play.md#tmux-play-38)]; (b) the bracketed tag is one of the kinds in the table below; (c) the body, when present, lives outside the brackets — not after a colon inside them; (d) colored tags (kinds whose row in the table below assigns a tag color) carry their own bold 24-bit-foreground SGR span distinct from the speaker prefix span; uncolored tags (`[status]`, `[tool ↪]`) are emitted plain so the surrounding text style passes through; (e) the body remains unstyled by the presenter. The kind table:

  | Tag | Glyph slot | Body | Tag color | Source record / event |
  | --- | --- | --- | --- | --- |
  | `[status]` | — | message + optional structured-data tail | uncolored | `captain_status` |
  | `[error]` | — | result `error` field | `red` (`#f38ba8`) | `player_finished` / `captain_finished` with `status: 'error'` |
  | `[aborted]` | — | — | `yellow` (`#f9e2af`) | `player_finished` / `captain_finished` with `status: 'aborted'` |
  | `[turn aborted]` | — | turn-abort reason when present | `yellow` (`#f9e2af`) | `turn_aborted` |
  | `[runtime error]` | — | runtime-error message | `red` (`#f38ba8`) | `runtime_error` |
  | `[tool ↪]` | `↪` (call) | tool name + input summary | uncolored | `tool_use` |
  | `[tool ✓]` | `✓` (ok) | tool name + duration | `green` (`#a6e3a1`) | `tool_result` `status: 'success'` |
  | `[tool ✗]` | `✗` (err) | tool name + duration | `red` (`#f38ba8`) | `tool_result` `status: 'error'` |
  | `[tool ·]` | `·` (denied) | tool name + duration | `yellow` (`#f9e2af`) | `tool_result` `status: 'denied'` |

  The example line under tmux-play-39 shall be updated to `<captain-mauve>captain> </reset><red>[runtime error]</reset> boom`, reflecting that the colored span is now just the bracketed tag and the body is plain.
- [[tmux-play-49](../packages/tmux-play.md#tmux-play-49)]: rewrite to defer the prefix grammar to [[tmux-play-38](../packages/tmux-play.md#tmux-play-38)] and the bracketed tag to [[tmux-play-39](../packages/tmux-play.md#tmux-play-39)]'s new table. The `tool>` / `tool<` prefix replacement and its caller-accent rule are removed. A `tool_use` event shall render as `<who>> [tool ↪] <toolName> <inputSummary>` where `<who>` is `captain` for Captain-emitted events (in the Boss/Captain pane per [[tmux-play-40](../packages/tmux-play.md#tmux-play-40)]) and the player id for player-emitted events (in the player pane); the bracketed tag carries no color span (the speaker prefix already carries identity). A `tool_result` event shall render a header `<who>> [tool <symbol>] <toolName>[ <duration>]` where `<symbol>` is `✓` / `✗` / `·` per the kind table, the bracketed tag span carries the outcome color, and the body — fenced and `glow`-rendered per the existing tool-output rules — follows as a continuation block with two-space indent. The input-summary priority order (`command`, `file_path`, `path`, `pattern`, `query`, `prompt`, `description`, JSON fallback), the 60-cell truncation rule, the fenced-code wrapping for the result body, the trailing-line-terminator strip, the outer-margin trim, and the `renderMarkdown` fallback rule all carry over unchanged.
- [[tmux-play-50](../packages/tmux-play.md#tmux-play-50)]: amend the closing paragraph that today reads "Status lines (per tmux-play-39) and tool lifecycle lines (per tmux-play-49) bypass the buffer-then-render pipeline: each is a single line of operational text, not Markdown, and writes directly with the speaker or tool prefix grammar applied" to "…writes directly with the speaker prefix and the bracketed-tag grammar applied." No other change to the boundary list or buffering rules.
- `specs/test/tmux-play.md`: amend every test item that asserts `tool>` / `tool<` prefix grammar to assert the new `<who>> [tool …]` form, including the block-boundary clause that today enumerates "any status emission (`captain_status`, `runtime_error`, `turn_aborted`) targeting the same writer" — `tool_use` and `tool_result` on the same writer remain block boundaries and the wording of those clauses is unchanged. Add a positive test item asserting body-attachment normalization: given a `runtime_error` record with `message: 'boom'`, the rendered line shall be `<captain> [runtime error] boom`, not `<captain> [runtime error: boom]`. Add a positive test item asserting the unified prefix grammar applies to tool lines: given a Captain-emitted `tool_use` with `toolName: 'Read'` and `input: { file_path: 'a.ts' }`, the rendered line shall begin with the colored `captain> ` prefix followed by `[tool ↪] Read a.ts`, and given a `tool_result` with `status: 'success'`, `toolName: 'Read'`, `durationMs: 200`, the header line shall be `captain> [tool ✓] Read 200ms` with the bracketed tag in the green outcome color and the body unstyled (200 ms < 1000 ms so the duration uses the `<n>ms` form per [[tmux-play-49](../packages/tmux-play.md#tmux-play-49)]).
- `src/app/tmux-play/presenter-tmux.ts`: implement the unified grammar. Replace the four `paintStatus(this.sgr, 'error' | 'aborted', '[…: …]')` call sites with calls that emit `<who>> ` via the standard prefix path, color only the bracketed tag, and write the body unstyled outside the brackets. Replace the `tool_use` / `tool_result` rendering paths so they reuse the speaker prefix path (no more `tool>` / `tool<` prefix), apply the new bracketed-tag SGR, and emit body / fenced result body under the standard two-space continuation indent. The render-width budget for tool result bodies, formerly `paneWidth - 2` independent of speaker prefix, becomes `paneWidth - 2` continuation budget anchored to a tmux-play-38 prefixed header — the cell math is unchanged.
- `src/app/tmux-play/presenter-tmux.test.ts`: update every assertion that matches `tool> ` / `tool< ` to match `<who>> [tool …]`; update assertions that match `[error: msg]` / `[runtime error: msg]` / `[turn aborted: reason]` to match `[error] msg` / `[runtime error] msg` / `[turn aborted] reason` and the new SGR-span-on-tag rule.
- `src/app/tmux-play/presenter-tmux.acceptance.test.ts` (or the equivalent real-glow acceptance file) and any real-tmux acceptance assertions that capture exact prefix bytes from a session: refresh to match the new grammar.
- README and `docs/tmux-play.md` examples that show `tool>` / `tool<` (if any): update to the new form.

Out of scope:

- The runtime record types (`tool_use`, `tool_result`, `captain_status`, `runtime_error`, `turn_aborted`, `player_finished`, `captain_finished`) and their payloads.
  Only the presenter rendering changes; the records on the wire are unchanged.
- The Captain extension contract ([DR-004](../decisions/004-tmux-play-captain-architecture.md)) — `emitStatus`, `emitTelemetry`, and the run-result types stay as they are.
  A third-party Captain that already emits `captain_status` continues to work; only the rendered bytes in the tmux pane change.
- Body content rules for the tool input summary (priority order, 60-cell truncation, JSON fallback) and the tool result body (fenced code, trailing-terminator strip, outer-margin trim, `renderMarkdown` fallback) — all preserved verbatim under the new grammar.
- The `[status]` data-tail rendering (`formatStatusData(record.data)`) for structured `captain_status` data — preserved verbatim as the trailing portion of the body outside the brackets.
- The cell-measurement rules of [[tmux-play-46](../packages/tmux-play.md#tmux-play-46)] — unchanged.
  The then-current SGR close/reopen rule was later retired with the hand-written wrapping path by
  [DR-019](../decisions/019-superseded-item-retirements.md).
- Localizing the bracket literals (`[status]`, `[error]`, `[tool …]`) via YAML or any other user-facing knob.
  The bracketed-tag grammar remains presenter-prescribed; if real demand emerges for configurable tag text, that is a separate IR.

## Deliverables

- [x] `specs/user/tmux-play.md` — amend tmux-play-38's closing paragraph; rewrite tmux-play-39 with the unified rule + kind table; rewrite tmux-play-49 to defer the prefix grammar to tmux-play-38 and the bracketed tag to tmux-play-39; amend tmux-play-50's closing paragraph.
- [x] `specs/test/tmux-play.md` — refresh every `tool>` / `tool<` assertion to the new form; add the body-attachment normalization test items; add the unified tool-line grammar test items.
- [x] `specs/map.md` — index IR-021.
- [x] `src/app/tmux-play/presenter-tmux.ts` — implement the unified grammar across the five existing operational-line paths and the two tool paths; one shared helper (e.g., `writeBracketedLine(writer, who, tag, glyph?, outcomeRole?, body?)`) keeps the kind table addressable from one place.
- [x] `src/app/tmux-play/presenter-tmux.test.ts` — update assertions for the new prefix + bracketed-tag form across status, error, aborted, turn-aborted, runtime-error, tool_use, tool_result paths.
- [x] `src/app/tmux-play/presenter-tmux.acceptance.test.ts` (or equivalent) — refresh real-glow / real-tmux assertions that capture exact rendered bytes.
- [x] `README.md` and `docs/tmux-play.md` — update any prose or examples that reference `tool>` / `tool<` or the inside-brackets body form. (Sweep found no stale references in either file; only `CHANGELOG.md`'s Unreleased section gains a new entry describing the grammar unification.)

## Tasks

1. [x] **Spec items + map.** Amend tmux-play-38, tmux-play-39, tmux-play-49, tmux-play-50 in the user spec; refresh the tool-related items in the test spec and add the new body-attachment + unified-tool-line test items; index IR-021 in `specs/map.md`. Single docs-only commit.
2. [x] **Presenter implementation.** Implement the unified grammar in `presenter-tmux.ts` via a single bracketed-line helper that owns the SGR-on-tag rule and the body-outside-brackets rule, route all five existing operational paths and both tool paths through it, retire the `tool>` / `tool<` prefix replacement. Update unit tests in lockstep. Per-task-boundary green.
3. [x] **Acceptance refresh.** Update the real-glow / real-tmux acceptance suite assertions to match the new rendered bytes; verify the pre-existing payload-preservation invariants (fenced code, trailing blanks, outer-margin trim) still hold under the new header form. Per-task-boundary green.
4. [x] **Docs.** Sweep README and `docs/tmux-play.md` for stale `tool>` / `tool<` prose and example screenshots; update to the new grammar. (Sweep found no stale references in either file; `CHANGELOG.md` Unreleased gains an IR-021 entry per project convention.)

## Verification

- Every operational line in the tmux-play presenter reads `<who>> [<tag> <optional glyph>] <optional body>` with the speaker prefix from [[tmux-play-38](../packages/tmux-play.md#tmux-play-38)], the bracketed tag from the [[tmux-play-39](../packages/tmux-play.md#tmux-play-39)] kind table, and the body — when present — outside the brackets and unstyled by the presenter.
- The `tool>` / `tool<` prefix grammar is gone from both the spec and the presenter; tool lines carry the standard `<who>> ` speaker prefix.
- A `tool_use` line reads `<who>> [tool ↪] <toolName> <inputSummary>` with the bracketed tag uncolored.
- A `tool_result` header line reads `<who>> [tool ✓|✗|·] <toolName>[ <duration>]` with the bracketed tag in the corresponding outcome color and the body (when non-empty) under the two-space continuation indent, fenced-code-wrapped and `glow`-rendered per the preserved tmux-play-49 body rules.
- `[error]`, `[runtime error]`, `[turn aborted]`, and `[aborted]` render with their explanatory text outside the brackets; the bracketed tag alone carries the outcome SGR span.
- `[status]` rendering is byte-identical to today.
- The runtime emits the same records as before; no observer interface change.
- All per-task-boundary checks (build, typecheck, lint, unit, smoke, acceptance) pass at each task boundary.
