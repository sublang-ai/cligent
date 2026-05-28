<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-021: Unified Bracketed-Tag Grammar

## Goal

Collapse the tmux-play presenter's operational-line family — `[status]`, `[error: …]`, `[aborted]`, `[turn aborted: …]`, `[runtime error: …]`, plus the today-separate `tool>` / `tool<` lines — into a single grammar: every operational line shall read `<who>> [<tag> <optional glyph>] <optional body>` where the speaker prefix is the standard [TMUX-038](../user/tmux-play.md#tmux-038) `<who>> ` (no longer replaced by `tool>` / `tool<`), the bracketed tag carries the kind and an optional state glyph, and the body — when present — lives outside the brackets.

The family is incoherent today on two axes.
First, three sub-shapes coexist for body attachment: `[aborted]` carries no body, `[status] message` puts the body outside the brackets, and `[error: msg]` / `[runtime error: msg]` / `[turn aborted: reason]` put it inside the brackets after a colon.
Second, tool lifecycle lines opt out of the family entirely — they replace the `<who>> ` speaker prefix with `tool>` / `tool<` and color the prefix span by the caller's adapter accent, which is the only place in the presenter grammar where the speaker prefix is replaced rather than wrapped, and the only place where speaker identity is encoded purely as a color cue rather than literal text.

Folding tools into the family requires a glyph slot inside the bracket (tools have a 2D state space: call vs. result × ok/err/denied that color alone can't disambiguate), which then lets every member follow one rule: `[<tag> <optional glyph>] <optional body>`.
The glyph slot is optional and is only populated for kinds with multi-state semantics — tools today.
Other members (status, error, aborted, turn-aborted, runtime-error) carry no glyph; the word in the tag already names the kind and color carries the outcome.

## Status

Proposed

## Scope

In scope:

- [TMUX-038](../user/tmux-play.md#tmux-038): amend the closing paragraph that today reads "Status lines (per TMUX-039) and tool lifecycle lines (per TMUX-049) bypass `glow` — they are single-line operational text — and apply the prefix directly" to "Status lines (per [TMUX-039](../user/tmux-play.md#tmux-039)) and tool lifecycle lines (per [TMUX-049](../user/tmux-play.md#tmux-049)) bypass `glow` — they are single-line operational text — and apply the speaker prefix plus the bracketed-tag grammar directly." The speaker prefix grammar now governs tool lines as well; the `tool>` / `tool<` prefix replacement is retired.
- [TMUX-039](../user/tmux-play.md#tmux-039): replace the per-member rendering rules with one unified rule. Every operational line shall be `<who>> [<tag> <optional glyph>] <optional body>` where: (a) the `<who>> ` speaker prefix follows [TMUX-038](../user/tmux-play.md#tmux-038); (b) the bracketed tag is one of the kinds in the table below; (c) the body, when present, lives outside the brackets — not after a colon inside them; (d) colored tags (kinds whose row in the table below assigns a tag color) carry their own bold 24-bit-foreground SGR span distinct from the speaker prefix span; uncolored tags (`[status]`, `[tool ⤷]`) are emitted plain so the surrounding text style passes through; (e) the body remains unstyled by the presenter. The kind table:

  | Tag | Glyph slot | Body | Tag color | Source record / event |
  | --- | --- | --- | --- | --- |
  | `[status]` | — | message + optional structured-data tail | uncolored | `captain_status` |
  | `[error]` | — | result `error` field | `red` (`#f38ba8`) | `player_finished` / `captain_finished` with `status: 'error'` |
  | `[aborted]` | — | — | `yellow` (`#f9e2af`) | `player_finished` / `captain_finished` with `status: 'aborted'` |
  | `[turn aborted]` | — | turn-abort reason when present | `yellow` (`#f9e2af`) | `turn_aborted` |
  | `[runtime error]` | — | runtime-error message | `red` (`#f38ba8`) | `runtime_error` |
  | `[tool ⤷]` | `⤷` (call) | tool name + input summary | uncolored | `tool_use` |
  | `[tool ✓]` | `✓` (ok) | tool name + duration | `green` (`#a6e3a1`) | `tool_result` `status: 'success'` |
  | `[tool ✗]` | `✗` (err) | tool name + duration | `red` (`#f38ba8`) | `tool_result` `status: 'error'` |
  | `[tool ·]` | `·` (denied) | tool name + duration | `yellow` (`#f9e2af`) | `tool_result` `status: 'denied'` |

  The example line under TMUX-039 shall be updated to `<captain-mauve>captain> </reset><red>[runtime error]</reset> boom`, reflecting that the colored span is now just the bracketed tag and the body is plain.
- [TMUX-049](../user/tmux-play.md#tmux-049): rewrite to defer the prefix grammar to [TMUX-038](../user/tmux-play.md#tmux-038) and the bracketed tag to [TMUX-039](../user/tmux-play.md#tmux-039)'s new table. The `tool>` / `tool<` prefix replacement and its caller-accent rule are removed. A `tool_use` event shall render as `<who>> [tool ⤷] <toolName> <inputSummary>` where `<who>` is `captain` for Captain-emitted events (in the Boss/Captain pane per [TMUX-040](../user/tmux-play.md#tmux-040)) and the player id for player-emitted events (in the player pane); the bracketed tag carries no color span (the speaker prefix already carries identity). A `tool_result` event shall render a header `<who>> [tool <symbol>] <toolName>[ <duration>]` where `<symbol>` is `✓` / `✗` / `·` per the kind table, the bracketed tag span carries the outcome color, and the body — fenced and `glow`-rendered per the existing tool-output rules — follows as a continuation block with two-space indent. The input-summary priority order (`command`, `file_path`, `path`, `pattern`, `query`, `prompt`, `description`, JSON fallback), the 60-cell truncation rule, the fenced-code wrapping for the result body, the trailing-line-terminator strip, the outer-margin trim, and the `renderMarkdown` fallback rule all carry over unchanged.
- [TMUX-050](../user/tmux-play.md#tmux-050): amend the closing paragraph that today reads "Status lines (per TMUX-039) and tool lifecycle lines (per TMUX-049) bypass the buffer-then-render pipeline: each is a single line of operational text, not Markdown, and writes directly with the speaker or tool prefix grammar applied" to "…writes directly with the speaker prefix and the bracketed-tag grammar applied." No other change to the boundary list or buffering rules.
- `specs/test/tmux-play.md`: amend every test item that asserts `tool>` / `tool<` prefix grammar to assert the new `<who>> [tool …]` form, including the block-boundary clause that today enumerates "any status emission (`captain_status`, `runtime_error`, `turn_aborted`) targeting the same writer" — `tool_use` and `tool_result` on the same writer remain block boundaries and the wording of those clauses is unchanged. Add a positive test item asserting body-attachment normalization: given a `runtime_error` record with `message: 'boom'`, the rendered line shall be `<captain> [runtime error] boom`, not `<captain> [runtime error: boom]`. Add a positive test item asserting the unified prefix grammar applies to tool lines: given a Captain-emitted `tool_use` with `toolName: 'Read'` and `input: { file_path: 'a.ts' }`, the rendered line shall begin with the colored `captain> ` prefix followed by `[tool ⤷] Read a.ts`, and given a `tool_result` with `status: 'success'`, `toolName: 'Read'`, `durationMs: 200`, the header line shall be `captain> [tool ✓] Read 200ms` with the bracketed tag in the green outcome color and the body unstyled (200 ms < 1000 ms so the duration uses the `<n>ms` form per [TMUX-049](../user/tmux-play.md#tmux-049)).
- `src/app/tmux-play/presenter-tmux.ts`: implement the unified grammar. Replace the four `paintStatus(this.sgr, 'error' | 'aborted', '[…: …]')` call sites with calls that emit `<who>> ` via the standard prefix path, color only the bracketed tag, and write the body unstyled outside the brackets. Replace the `tool_use` / `tool_result` rendering paths so they reuse the speaker prefix path (no more `tool>` / `tool<` prefix), apply the new bracketed-tag SGR, and emit body / fenced result body under the standard two-space continuation indent. The render-width budget for tool result bodies, formerly `paneWidth - 2` independent of speaker prefix, becomes `paneWidth - 2` continuation budget anchored to a TMUX-038 prefixed header — the cell math is unchanged.
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
- The cell-measurement rules of [TMUX-046](../user/tmux-play.md#tmux-046) and the SGR close/reopen rule for continuation indents — unchanged.
- Localizing the bracket literals (`[status]`, `[error]`, `[tool …]`) via YAML or any other user-facing knob.
  The bracketed-tag grammar remains presenter-prescribed; if real demand emerges for configurable tag text, that is a separate IR.

## Mechanism notes (pinned by this IR)

Why one shape, not text-plus-symbol for every member:
the bracketed family's job is to encode the kind of operational line and, where applicable, its state.
Single-state members (status, error, aborted, turn-aborted, runtime-error) carry one piece of state each; the word in the tag names it, and color names the outcome dimension (uncolored for status, red for error-class, yellow for aborted-class).
Adding a glyph to those tags would duplicate what color already encodes.
Tools are the only family member with a 2D state space: phase (call vs. result) × outcome (ok / err / denied).
Color alone cannot distinguish a call from a result; the glyph slot earns its keep there.
The unified rule "glyph slot is optional, populated only for kinds with multi-state semantics" expresses this without making single-state lines pay the cost of a decorative glyph.

Why body outside the brackets, not inside:
sub-shape B (`[error: msg]`) was chosen historically so a single colored SGR span could carry the entire bracketed tag plus the explanatory message as one visual unit.
Moving the body outside trades that for two consistency wins: (a) the colored span becomes a fixed-width unit per kind, so the reader scans a column of operational lines and sees the tag light up at the same offset every time; (b) every member of the family — including `[status] msg` which already had this shape — follows the same body-attachment rule.
The body color rule simplifies too: the body is always unstyled by the presenter (matching how text bodies behave today), and only the bracketed tag carries the outcome SGR.
Lines whose body is non-empty include the explanatory text as `[tag] <body>`; lines with no body emit just `[tag]` (today: `[aborted]`).

Why the call glyph is `⤷` and not `→`:
`⤷` (U+2937, arrow pointing downwards then curving rightwards) reads as "branching into the tool" and contrasts visually with the result glyphs `✓ ✗ ·` so a column of tool lines reads as alternating call-arrow / outcome-mark.
`→` (U+2192) is more universally supported and shorter to type; if implementation reveals font-coverage issues with `⤷` in common terminals, a follow-up IR may swap it for `→` without disturbing the broader unification.
Both are 1-cell narrow per [TMUX-046](../user/tmux-play.md#tmux-046)'s cell-measurement rules.

The tool result body's render width is preserved at `max(1, paneWidth - 2)` because the body is a fenced-code continuation block following a `<who>> [tool ✓] …` header; the two-space continuation indent is the budget anchor, the same way text bodies have been since [TMUX-050](../user/tmux-play.md#tmux-050).
The header line itself wraps under [TMUX-038](../user/tmux-play.md#tmux-038)'s prefix grammar at `paneWidth - prefixWidth` where `prefixWidth` is the cell width of `<who>> ` only; the bracketed tag is part of the first-line body and contributes to soft-wrap normally.

The change is presenter-only: the runtime emits the same records before and after; observers other than the tmux presenter (visualizers, metric exporters, third-party panels that listen on `captain_telemetry`) see no change.
A test observer that asserts on record types (not on rendered bytes) needs no update.

## Deliverables

- [x] `specs/user/tmux-play.md` — amend TMUX-038's closing paragraph; rewrite TMUX-039 with the unified rule + kind table; rewrite TMUX-049 to defer the prefix grammar to TMUX-038 and the bracketed tag to TMUX-039; amend TMUX-050's closing paragraph.
- [x] `specs/test/tmux-play.md` — refresh every `tool>` / `tool<` assertion to the new form; add the body-attachment normalization test items; add the unified tool-line grammar test items.
- [x] `specs/map.md` — index IR-021.
- [ ] `src/app/tmux-play/presenter-tmux.ts` — implement the unified grammar across the five existing operational-line paths and the two tool paths; one shared helper (e.g., `writeBracketedLine(writer, who, tag, glyph?, outcomeRole?, body?)`) keeps the kind table addressable from one place.
- [ ] `src/app/tmux-play/presenter-tmux.test.ts` — update assertions for the new prefix + bracketed-tag form across status, error, aborted, turn-aborted, runtime-error, tool_use, tool_result paths.
- [ ] `src/app/tmux-play/presenter-tmux.acceptance.test.ts` (or equivalent) — refresh real-glow / real-tmux assertions that capture exact rendered bytes.
- [ ] `README.md` and `docs/tmux-play.md` — update any prose or examples that reference `tool>` / `tool<` or the inside-brackets body form.

## Tasks

1. [x] **Spec items + map.** Amend TMUX-038, TMUX-039, TMUX-049, TMUX-050 in the user spec; refresh the tool-related items in the test spec and add the new body-attachment + unified-tool-line test items; index IR-021 in `specs/map.md`. Single docs-only commit.
2. [ ] **Presenter implementation.** Implement the unified grammar in `presenter-tmux.ts` via a single bracketed-line helper that owns the SGR-on-tag rule and the body-outside-brackets rule, route all five existing operational paths and both tool paths through it, retire the `tool>` / `tool<` prefix replacement. Update unit tests in lockstep. Per-task-boundary green.
3. [ ] **Acceptance refresh.** Update the real-glow / real-tmux acceptance suite assertions to match the new rendered bytes; verify the pre-existing payload-preservation invariants (fenced code, trailing blanks, outer-margin trim) still hold under the new header form. Per-task-boundary green.
4. [ ] **Docs.** Sweep README and `docs/tmux-play.md` for stale `tool>` / `tool<` prose and example screenshots; update to the new grammar.

## Acceptance

- Every operational line in the tmux-play presenter reads `<who>> [<tag> <optional glyph>] <optional body>` with the speaker prefix from [TMUX-038](../user/tmux-play.md#tmux-038), the bracketed tag from the [TMUX-039](../user/tmux-play.md#tmux-039) kind table, and the body — when present — outside the brackets and unstyled by the presenter.
- The `tool>` / `tool<` prefix grammar is gone from both the spec and the presenter; tool lines carry the standard `<who>> ` speaker prefix.
- A `tool_use` line reads `<who>> [tool ⤷] <toolName> <inputSummary>` with the bracketed tag uncolored.
- A `tool_result` header line reads `<who>> [tool ✓|✗|·] <toolName>[ <duration>]` with the bracketed tag in the corresponding outcome color and the body (when non-empty) under the two-space continuation indent, fenced-code-wrapped and `glow`-rendered per the preserved TMUX-049 body rules.
- `[error]`, `[runtime error]`, `[turn aborted]`, and `[aborted]` render with their explanatory text outside the brackets; the bracketed tag alone carries the outcome SGR span.
- `[status]` rendering is byte-identical to today.
- The runtime emits the same records as before; no observer interface change.
- All per-task-boundary checks (build, typecheck, lint, unit, smoke, acceptance) pass at each task boundary.
