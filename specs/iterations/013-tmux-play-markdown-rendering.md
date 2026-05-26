<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-013: tmux-play Markdown-Rendered Pane Output

## Goal

Render each speaker's Markdown through `glow` instead of streaming raw text through a hand-rolled char-by-char soft-wrap, so prose wraps at word boundaries, inline styles render, and fenced code survives intact for the coding-agent player panes.

The presenter buffers each block until complete, renders it through `glow` at `paneWidth - prefixWidth`, and appends the result to the pane log.
`glow` owns wrapping, fenced code, tables, lists, and inline styles.

Key design choices:

- Markdown is not streamable; blocks buffer and render on completion. Token-by-token streaming is the deliberate tradeoff.
- Panes still `tail -f` the per-player log; only complete rendered blocks are appended, no repaint machinery.
- `glow` is a hard launch requirement, mirroring `tmux`. No fallback path — Task 2 removes the [TMUX-046](../user/tmux-play.md#tmux-046) machinery that would otherwise serve as one. Not an npm package; [PKG-003](../dev/package.md#pkg-003) is not implicated.
- The presenter stays an observer per [DR-004](../decisions/004-tmux-play-captain-architecture.md); runtime, record set, and Captain contract are unchanged.

## Status

Done — Task 4's real-`glow` acceptance gate closed: `npm run test:acceptance` reported 7/7 passing against `glow 2.1.2`.

## Scope

In scope:

- Buffer-then-render write path; blocks flush on `player_finished` / `captain_finished`, on a non-streaming `text` event, and on `tool_use` / `tool_result` interrupting a text run.
- Render module in `src/app/shared/glow.ts`: spawn `glow` at width `paneWidth - prefixWidth`, stdin-fed, stdout captured.
- Speaker-prefix post-indent so [TMUX-038](../user/tmux-play.md#tmux-038) grammar holds; the prefix budget keeps prose rows within pane width.
- Tool-result bodies routed through the same pipeline, wrapped in a fenced code block. Wrapper fence is `max(3, longest_backtick_run + 1)` so an embedded fence cannot terminate it.
- `glow` launcher gate alongside the existing `tmux` check; install-pointing error on absence.
- New TMUX-050 (pipeline, prefix-budgeted width, prefix preservation) and TMUX-051 (`glow` launch gate). Amendments to TMUX-038 (prefix on rendered block), TMUX-046 (soft-wrap superseded; cell measurement retained for [TMUX-049](../user/tmux-play.md#tmux-049)), and TMUX-049 (tool body through the pipeline).
- Matching TTMUX items and a real-`glow` acceptance probe. The `Real-tmux Acceptance` preamble and TTMUX-039's standalone clause both broadened to self-skip when `glow -v` fails, since the launcher hard-fails otherwise.
- `glow` added to `docs/tmux-play.md` and top-level `README.md` Requirements lists.

Out of scope:

- Intra-message token streaming or pane repaint.
- Configurable renderer (`mdcat`, `rich-cli`, …); `glow` only.
- Theming `glow`'s output to Catppuccin Mocha ([TMUX-047](../user/tmux-play.md#tmux-047)).
- Bundling or auto-installing `glow`.

## Deliverables

- [x] `src/app/shared/glow.ts` — `isGlowAvailable` and `renderMarkdown(text, width)`.
- [x] `src/app/shared/glow.test.ts` — unit coverage.
- [x] `src/app/tmux-play/launcher.ts` — `glow` availability gate alongside the `tmux` gate.
- [x] `src/app/tmux-play/launcher.test.ts` — aborts with install-pointing error when `glow` is absent.
- [x] `src/app/tmux-play/presenter-tmux.ts` — buffer-then-render path; removal of TMUX-046 soft-wrap machinery.
- [x] `src/app/tmux-play/presenter-tmux.test.ts` — buffering and flush boundaries, prefix post-indent, render-width budgeting, fenced-code-not-wrapped.
- [x] `src/app/shared/glow.acceptance.test.ts` — real-`glow` rendering, self-skipping when `glow -v` fails.
- [x] `specs/user/tmux-play.md` — new TMUX-050 and TMUX-051; amendments to TMUX-038, TMUX-046, TMUX-049.
- [x] `specs/test/tmux-play.md` — new TTMUX items; `Real-tmux Acceptance` preamble and TTMUX-039 broadened to self-skip on missing `glow`.
- [x] `docs/tmux-play.md` — `glow` added to Requirements.
- [x] `README.md` — top-level Requirements list updated.
- [x] `specs/map.md` — TMUX summary mentions Markdown-rendered output.

## Tasks

Each task is one commit.

1. [x] **Render module and launch gate** — `isGlowAvailable` + `renderMarkdown(text, width)` in `shared/glow.ts`; launcher `glow` gate. New TMUX-051.
2. [x] **Buffer-then-render presenter** — buffer text deltas, flush on the boundaries in Scope, render at `paneWidth - prefixWidth`, post-indent. Remove TMUX-046 soft-wrap machinery. New TMUX-050; amend TMUX-038 and TMUX-046.
3. [x] **Tool-result body through the pipeline** — fence the body with `max(3, longest_backtick_run + 1)` backticks, render, indent. Amend TMUX-049.
4. [x] **Docs and acceptance** — `glow` in `docs/tmux-play.md` and top-level `README.md`; real-`glow` acceptance test; `specs/map.md` summary update. Acceptance-skip broadening was pulled forward into Task 1's review follow-up.

## Acceptance criteria

- `npm run build`, `npm run lint`, `npm test`, and `npm run test:smoke` pass at every task boundary.
- After Task 1: `renderMarkdown` returns `glow`-rendered output at a requested width; `launchTmuxPlay` aborts with an install-pointing error when `glow` is absent.
- After Task 2: presenter snapshot for a Boss → Captain → Player turn shows rendered blocks (bold styled, no mid-token wraps, prefix + two-space indent intact); every prose row fits pane width after prefixing.
- After Task 3: a `tool_result` whose payload contains a triple-backtick fence renders the entire body unwrapped inside the wrapper.
- `npm run test:acceptance` passes with `glow` installed. On a `tmux`-available / `glow`-absent runner, every `launchTmuxPlay`-driving TTMUX item self-skips per the broadened skip clauses.
- IR-013 shall not be marked Done unless the real-`glow` acceptance test was executed end-to-end with `glow` available within the same change set.
