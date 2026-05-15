<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-013: tmux-play Markdown-Rendered Pane Output

## Goal

Make pane output legible by rendering each speaker's Markdown through a mature terminal renderer instead of streaming raw text.

Today the presenter writes raw model output and soft-wraps it character-by-character per [TMUX-046](../user/tmux-play.md#tmux-046).
Literal `**bold**` reaches the pane unstyled, words and URLs break mid-token at the pane edge, and fenced code is word-wrapped and corrupted even though every role pane hosts a coding agent.
Replace the hand-rolled soft-wrap and raw passthrough with a buffer-then-render pipeline: accumulate each speaker block until it is complete, render it through `glow` at the pane's display width minus the `<who>> ` prefix budget so the prefixed first line and the indented continuations both fit, and append the rendered block to the pane log.
`glow` owns word-boundary wrapping, fenced-code blocks (left unwrapped, syntax-highlighted), tables, lists, and inline styles, so the presenter stops reimplementing — badly — a Markdown renderer.

Key design choices:

- Markdown is not a streamable format — a renderer cannot tell it is inside a fenced code block until the closing fence arrives — so a batch renderer needs the complete block; the presenter buffers per block and renders on completion. Intra-message token streaming is the deliberate tradeoff (see Out of scope).
- The pane mechanism is unchanged: panes still `tail -f` a per-role log file and the presenter still only ever *appends*, now appending complete rendered blocks instead of streamed fragments. No cursor-control or repaint machinery is introduced.
- `glow` is an external binary and a hard launch requirement, consistent with how `tmux-play` already requires `tmux`: the launcher validates it up front and fails fast with an install pointer when it is missing. A graceful raw-passthrough fallback was rejected — Task 2 removes the [TMUX-046](../user/tmux-play.md#tmux-046) soft-wrap machinery, so a `glow`-less path would be a strict regression on today's width-aware hanging indent, and keeping that machinery alive purely as a fallback would defeat this IR's premise of not maintaining a hand-rolled renderer. `glow` is not an npm package and does not interact with [PKG-003](../dev/package.md#pkg-003)'s runtime-dependency constraint.
- The presenter stays an observer per [DR-004](../decisions/004-tmux-play-captain-architecture.md); the runtime, record set, and Captain contract are untouched, so no decision record changes.

## Status

In progress — Tasks 1 and 2 done; the acceptance-skip broadening (the `Real-tmux Acceptance` preamble in `specs/test/tmux-play.md` and TTMUX-039's standalone clause) was pulled forward from Task 4 into Task 1's review follow-up so acceptance does not break between Task 1 and Task 4 on `tmux`-available / `glow`-absent runners. Task 3 (tool-result body through the pipeline) and the remaining Task 4 work (docs/README Requirements, real-`glow` acceptance test, `specs/map.md` summary) pending.

## Scope

In scope:

- Buffer-then-render write path in the presenter: text deltas accumulate per `(writer, block)`; a block flushes on `role_finished` / `captain_finished`, on a non-streaming `text` event, and when a `tool_use` / `tool_result` event interrupts a text run.
- `glow` integration isolated in a render module: spawn `glow` with width pinned to the pane's display width *minus the visible `<who>> ` prefix budget*, feed the buffered Markdown on stdin, capture rendered stdout, append it to the log. Rendering at the full pane width and then prepending the prefix would push prose lines past the pane edge and trigger a second, terminal-level wrap — the exact indentation breakage this IR removes.
- Speaker-prefix preservation: the renderer's output is post-indented so the [TMUX-038](../user/tmux-play.md#tmux-038) grammar still holds — the first nonblank line carries the colored `<who>> ` prefix and every following line carries the two-space hanging indent. Because `glow` is invoked at `paneWidth - prefixWidth` (where `prefixWidth` is the cell width of the block's `<who>> ` prefix, ≥ the 2-cell continuation indent for every speaker), the prefixed first line and the indented continuation lines both fit within `paneWidth` without re-wrapping. `glow` still leaves over-long code and table lines unwrapped by design, so the fit guarantee covers prose rows, not those.
- Tool-result bodies routed through the same pipeline, wrapped in a fenced code block so `glow` leaves their content unwrapped. Tool output is arbitrary text and may itself contain a code fence, so the wrapper fence is a run of backticks one longer than the longest backtick run anywhere in the payload, with a minimum of three; this keeps any embedded fence inert as literal content. `tool_use` lines are already complete on arrival and stay as-is.
- `glow` is a hard launch requirement: the launcher checks for it alongside `tmux` and exits with a clear, install-pointing error when it is absent, mirroring the existing `isTmuxAvailable` gate. There is no raw-passthrough fallback — see the Goal for why.
- New spec items TMUX-050 (render pipeline, block boundaries, prefix-budgeted render width, prefix preservation) and TMUX-051 (`glow` external dependency, launcher availability gate); amendments to TMUX-038 (prefix applied to a rendered block), TMUX-046 (the character-level soft-wrap, escape-carry, and SGR close/reopen machinery is superseded — wrapping is delegated to `glow`; cell measurement is retained only where [TMUX-049](../user/tmux-play.md#tmux-049) still needs it for tool-input truncation), and TMUX-049 (tool-result body rendered through the pipeline inside a payload-safe code fence).
- Matching TTMUX test items and a real-`glow` acceptance test that self-skips when `glow` is absent; the `Real-tmux Acceptance` section preamble in [test/tmux-play.md](../test/tmux-play.md) — which today self-skips only when `tmux -V` fails — is broadened to also self-skip when `glow -v` fails, since `launchTmuxPlay` now hard-fails without `glow` and every existing TTMUX-030..036 acceptance test invokes it. The standalone self-skip clause on TTMUX-039 (under the `Theme` section, not the `Real-tmux Acceptance` section, but also driving a launched session via `launcher.acceptance.test.ts`) is amended in the same way; TTMUX-039 is the only `launchTmuxPlay`-invoking item outside the section preamble (verified by walking every `### TTMUX-` item in `specs/test/tmux-play.md`).
- `docs/tmux-play.md` and the top-level `README.md` Requirements lists both gain `glow`; the top-level list duplicates the docs list and would otherwise leave new users without the install pointer for a hard requirement.

Out of scope:

- Intra-message token streaming, live repaint, or any pane mechanism other than `tail -f` on a log file — each block appears when complete; deferred to a follow-up IR if liveness proves necessary.
- Configurable renderer choice (`mdcat`, `rich-cli`, …) or a `renderer:` config field — `glow` only.
- Matching `glow`'s output styling to the Catppuccin Mocha palette ([TMUX-047](../user/tmux-play.md#tmux-047)); `glow`'s built-in dark style is used as-is.
- Bundling or auto-installing `glow`.

## Deliverables

- [x] `src/app/shared/glow.ts` — `isGlowAvailable` (mirroring `shared/tmux.ts`'s `isTmuxAvailable`) and `renderMarkdown(text, width)` that spawns `glow` and captures rendered output.
- [x] `src/app/shared/glow.test.ts` — unit coverage for `isGlowAvailable` (true/false against a mocked binary) and `renderMarkdown` (correct argv, stdin-fed input, error mapping).
- [x] `src/app/tmux-play/launcher.ts` — fail-fast `glow` availability check alongside the existing `tmux` check, with an install-pointing error message.
- [x] `src/app/tmux-play/launcher.test.ts` — assertion that launch aborts with the install-pointing error when `glow` is reported absent.
- [x] `src/app/tmux-play/presenter-tmux.ts` — buffer-then-render write path, prefix-budgeted render width, prefix post-indent, and removal of the superseded TMUX-046 soft-wrap machinery.
- [x] `src/app/tmux-play/presenter-tmux.test.ts` — block buffering and flush boundaries, prefix post-indent, prefix-budgeted render width (prefixed prose rows fit the pane width), and code-fence-not-wrapped.
- [ ] `src/app/shared/glow.acceptance.test.ts` — real-`glow` rendering check, self-skipping when `glow -v` fails.
- [ ] `specs/user/tmux-play.md` — new TMUX-050 and TMUX-051; amendments to TMUX-038, TMUX-046, TMUX-049.
- [ ] `specs/test/tmux-play.md` — new TTMUX items for the pipeline, prefix preservation, prefix-budgeted render width, safe fenced-code wrapping, the launcher `glow` gate, and the real-`glow` acceptance probe; the `Real-tmux Acceptance` section preamble amended so existing TTMUX-030..036 also self-skip when `glow -v` fails, and TTMUX-039's standalone self-skip clause amended the same way.
- [ ] `docs/tmux-play.md` — `glow` added to Requirements with its install link.
- [ ] `README.md` — top-level Requirements list updated to include `glow` with the same install link.
- [ ] `specs/map.md` — TMUX user-row summary mentions Markdown-rendered output.

## Tasks

Each task is one commit.

1. [x] **Render module and launch gate** — `isGlowAvailable` and `renderMarkdown(text, width)` in `src/app/shared/glow.ts`, spawning `glow` with width pinned and Markdown fed on stdin, capturing stdout; plus a fail-fast `glow` check in `src/app/tmux-play/launcher.ts` alongside the existing `tmux` check.
   New TMUX-051.
   Unit tests cover a rendered sample, `isGlowAvailable` true/false against a mocked binary, and the launcher aborting with an install-pointing error when `glow` is absent.
2. [x] **Buffer-then-render presenter** — accumulate text deltas per block, flush on the boundaries named in Scope through the render module at width `paneWidth - prefixWidth`, and post-indent the rendered output so the TMUX-038 prefix/indent grammar holds.
   Remove the character-level soft-wrap, escape-carry, and SGR close/reopen machinery superseded by delegating wrapping to `glow`.
   New TMUX-050; amend TMUX-038 and TMUX-046.
   Presenter tests cover buffering, every flush boundary, prefix post-indent, and render-width budgeting (prefixed prose rows fit the pane width).
3. [ ] **Tool-result body through the pipeline** — render `tool_result` output as a fenced code block so `glow` leaves it unwrapped, selecting the fence as a backtick run one longer than the longest backtick run in the payload (minimum three) so an embedded fence cannot terminate the wrapper early; `tool_use` unchanged.
   Amend TMUX-049.
   Presenter tests cover an unwrapped code body, a long-line body that is not mid-token broken, and a payload that itself contains a ```` ``` ```` fence rendering fully inside the wrapper.
4. [ ] **Docs and acceptance** — `glow` added to the `docs/tmux-play.md` and top-level `README.md` Requirements lists; the real-`glow` acceptance test that self-skips when `glow` is unavailable; and the `specs/map.md` TMUX summary update.
   The acceptance-skip broadening (preamble + TTMUX-039 standalone clause + `launcher.acceptance.test.ts` gate) was pulled forward into Task 1's review follow-up so this sub-item is already done.

## Acceptance criteria

- `npm run build`, `npm run lint`, `npm test`, and `npm run test:smoke` pass at every task boundary.
- After Task 1, `renderMarkdown` returns `glow`-rendered output for a Markdown sample at a requested width, and `launchTmuxPlay` aborts with a clear, install-pointing error when `glow` is absent.
- After Task 2, the presenter snapshot for a Boss → Captain → Role turn shows each block rendered — `**bold**` styled rather than literal, words wrapped at boundaries with no mid-token breaks — with the TMUX-038 colored prefix on the first line and a two-space indent on every continuation line. Every prose row, measured after the prefix and indent are applied, is no wider than the pane's display width.
- After Task 3, a `tool_result` whose output itself contains a ```` ``` ```` fence renders the entire body unwrapped inside the payload-safe wrapper fence, with no part of the output escaping into Markdown rendering and no character-level line breaks inside the code.
- `npm run test:acceptance` passes with `glow` installed. On a machine with `tmux` available but `glow` absent, every TTMUX item that invokes `launchTmuxPlay` — TTMUX-030..036 via the broadened section preamble, and TTMUX-039 via its broadened standalone clause — self-skips rather than failing on the launcher's new `glow` gate; the real-`glow` probe self-skips only when `glow -v` fails; no acceptance test gates on adapter API keys.
- `specs/map.md` TMUX user-row summary reflects the Markdown-rendered output.
- IR-013 shall not be marked Done unless the real-`glow` acceptance test was executed end-to-end with `glow` available within the same change set.
