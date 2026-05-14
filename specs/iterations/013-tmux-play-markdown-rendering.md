<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-013: tmux-play Markdown-Rendered Pane Output

## Goal

Make pane output legible by rendering each speaker's Markdown through a mature terminal renderer instead of streaming raw text.

Today the presenter writes raw model output and soft-wraps it character-by-character per [TMUX-046](../user/tmux-play.md#tmux-046).
Literal `**bold**` reaches the pane unstyled, words and URLs break mid-token at the pane edge, and fenced code is word-wrapped and corrupted even though every role pane hosts a coding agent.
Replace the hand-rolled soft-wrap and raw passthrough with a buffer-then-render pipeline: accumulate each speaker block until it is complete, render it through `glow` at the pane's display width, and append the rendered block to the pane log.
`glow` owns word-boundary wrapping, fenced-code blocks (left unwrapped, syntax-highlighted), tables, lists, and inline styles, so the presenter stops reimplementing — badly — a Markdown renderer.

Key design choices:

- Markdown is not a streamable format — a renderer cannot tell it is inside a fenced code block until the closing fence arrives — so a batch renderer needs the complete block; the presenter buffers per block and renders on completion. Intra-message token streaming is the deliberate tradeoff (see Out of scope).
- The pane mechanism is unchanged: panes still `tail -f` a per-role log file and the presenter still only ever *appends*, now appending complete rendered blocks instead of streamed fragments. No cursor-control or repaint machinery is introduced.
- `glow` is an external binary, consistent with how `tmux-play` already shells out to `tmux` and how adapters shell out to their CLIs. It is not an npm package and does not interact with [PKG-003](../dev/package.md#pkg-003)'s runtime-dependency constraint.
- The presenter stays an observer per [DR-004](../decisions/004-tmux-play-captain-architecture.md); the runtime, record set, and Captain contract are untouched, so no decision record changes.

## Status

Proposed

## Scope

In scope:

- Buffer-then-render write path in the presenter: text deltas accumulate per `(writer, block)`; a block flushes on `role_finished` / `captain_finished`, on a non-streaming `text` event, and when a `tool_use` / `tool_result` event interrupts a text run.
- `glow` integration isolated in a render module: spawn `glow` with width pinned to the pane's current display width, feed the buffered Markdown on stdin, capture rendered stdout, append it to the log.
- Speaker-prefix preservation: the renderer's output is post-indented so the [TMUX-038](../user/tmux-play.md#tmux-038) grammar still holds — the first nonblank line carries the colored `<who>> ` prefix and every following line carries the two-space hanging indent.
- Tool-result bodies routed through the same pipeline as a fenced code block so `glow` leaves their content unwrapped; `tool_use` lines are already complete on arrival and stay as-is.
- Graceful degradation: when `glow` is not on `PATH` the presenter falls back to raw passthrough (today's behavior) and prints a one-line stderr notice, so `glow` is an enhancement, not a hard launch requirement.
- New spec items TMUX-050 (render pipeline, block boundaries, prefix preservation) and TMUX-051 (`glow` external dependency, width pinning, fallback); amendments to TMUX-038 (prefix applied to a rendered block), TMUX-046 (the character-level soft-wrap, escape-carry, and SGR close/reopen machinery is superseded — wrapping is delegated to `glow`; cell measurement is retained only where [TMUX-049](../user/tmux-play.md#tmux-049) still needs it for tool-input truncation), and TMUX-049 (tool-result body rendered through the pipeline).
- Matching TTMUX test items and a real-`glow` acceptance test that self-skips when `glow` is absent.
- `docs/tmux-play.md` Requirements list gains `glow`.

Out of scope:

- Intra-message token streaming, live repaint, or any pane mechanism other than `tail -f` on a log file — each block appears when complete; deferred to a follow-up IR if liveness proves necessary.
- Configurable renderer choice (`mdcat`, `rich-cli`, …) or a `renderer:` config field — `glow` only.
- Matching `glow`'s output styling to the Catppuccin Mocha palette ([TMUX-047](../user/tmux-play.md#tmux-047)); `glow`'s built-in dark style is used as-is.
- Bundling or auto-installing `glow`.

## Deliverables

- [ ] `src/app/shared/glow.ts` — `glow` detection (`isGlowAvailable`, mirroring `shared/tmux.ts`) and `renderMarkdown(text, width)` that spawns `glow`, captures output, and degrades when the binary is absent.
- [ ] `src/app/tmux-play/presenter-tmux.ts` — buffer-then-render write path, prefix post-indent, and removal of the superseded TMUX-046 soft-wrap machinery.
- [ ] `src/app/tmux-play/presenter-tmux.test.ts` — block buffering and flush boundaries, prefix post-indent, code-fence-not-wrapped, and the fallback path with `glow` mocked absent.
- [ ] `src/app/shared/glow.acceptance.test.ts` — real-`glow` rendering check, self-skipping when `glow -v` fails.
- [ ] `specs/user/tmux-play.md` — new TMUX-050 and TMUX-051; amendments to TMUX-038, TMUX-046, TMUX-049.
- [ ] `specs/test/tmux-play.md` — new TTMUX items for the pipeline, prefix preservation, fallback, fenced code, and the real-`glow` acceptance probe.
- [ ] `docs/tmux-play.md` — `glow` added to Requirements with its install link.
- [ ] `specs/map.md` — TMUX user-row summary mentions Markdown-rendered output.

## Tasks

Each task is one commit.

1. [ ] **Render module** — `glow` detection and `renderMarkdown(text, width)` in `src/app/shared/glow.ts`, spawning `glow` with width pinned and stdin-fed, capturing stdout, and falling back to the input verbatim plus a one-line notice when `glow` is absent.
   New TMUX-051.
   Unit tests cover a rendered sample and the absent-binary fallback (binary mocked).
2. [ ] **Buffer-then-render presenter** — accumulate text deltas per block, flush on the boundaries named in Scope through the render module, and post-indent the rendered output so the TMUX-038 prefix/indent grammar holds.
   Remove the character-level soft-wrap, escape-carry, and SGR close/reopen machinery superseded by delegating wrapping to `glow`.
   New TMUX-050; amend TMUX-038 and TMUX-046.
   Presenter tests cover buffering, every flush boundary, prefix post-indent, and the fallback path.
3. [ ] **Tool-result body through the pipeline** — render `tool_result` output as a fenced code block so `glow` leaves it unwrapped; `tool_use` unchanged.
   Amend TMUX-049.
   Presenter tests cover an unwrapped code body and a long-line body that is not mid-token broken.
4. [ ] **Docs and acceptance** — `glow` in `docs/tmux-play.md` Requirements, the real-`glow` acceptance test that self-skips when `glow` is unavailable, and the `specs/map.md` TMUX summary update.

## Acceptance criteria

- `npm run build`, `npm run lint`, `npm test`, and `npm run test:smoke` pass at every task boundary.
- After Task 1, the render module returns `glow`-rendered output for a Markdown sample at a requested width, and returns the input unchanged plus a single stderr notice when the `glow` binary is absent.
- After Task 2, the presenter snapshot for a Boss → Captain → Role turn shows each block rendered — `**bold**` styled rather than literal, words wrapped at boundaries with no mid-token breaks — with the TMUX-038 colored prefix on the first line and a two-space indent on every continuation line.
- After Task 3, a `tool_result` whose output contains a fenced code block renders that body unwrapped, with no character-level line breaks inside the code.
- `npm run test:acceptance` passes with `glow` installed; the real-`glow` probe self-skips only when `glow -v` fails and never gates on adapter API keys.
- `specs/map.md` TMUX user-row summary reflects the Markdown-rendered output.
- IR-013 shall not be marked Done unless the real-`glow` acceptance test was executed end-to-end with `glow` available within the same change set.
