<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-011: tmux-play Presenter and Layout Refresh

## Goal

Implement [TMUX-027/028](../user/tmux-play.md#tmux-027) and [TMUX-035..042](../user/tmux-play.md#tmux-035).

## Status

In progress

## Scope

In scope:

- 240x67 tmux session at start.
- 4/6/6 column split; Boss/Captain on the left.
- Pane titles `Captain` plus title-cased role ids.
- Single Boss-input echo.
- `<who>> ` line prefix.
- Failure as `<who>> [error: <message>]` or `<who>> [aborted]`.
- Boss pane omits per-role outputs and Captain prompt body.
- Persistent role Cligents with auto-resume.
- Fanout role prompts without identity preamble.

Out of scope: non-tmux UIs.

## Deliverables

- [x] `src/app/tmux-play/launcher.ts`.
- [x] `src/app/tmux-play/presenter-tmux.ts`.
- [x] `src/captains/fanout.ts`.
- [ ] Tests for TTMUX-021..029; update TTMUX-014.

## Tasks

Each task is one commit.

1. [x] Layout and geometry — TMUX-027/028, TMUX-035, TMUX-036.
2. [x] Presenter rewrite — TMUX-037..040.
3. [x] Fanout role prompt — TMUX-042.
4. Role continuity verification — TMUX-041.

## Verification

`npm run build` and `npm test` pass.
A tmux launch shows new geometry and prefix-style output.
Runtime test pins Cligent reuse and resume-token round-trip.
