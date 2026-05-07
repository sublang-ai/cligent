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
- Read-only role panes (input disabled).
- Real-tmux acceptance test that verifies geometry, layout, titles, and read-only role panes against an actual tmux server.

Out of scope: non-tmux UIs.

## Deliverables

- [x] `src/app/tmux-play/launcher.ts`.
- [x] `src/app/tmux-play/presenter-tmux.ts`.
- [x] `src/captains/fanout.ts`.
- [x] Tests for TTMUX-021..029; update TTMUX-014.
- [x] Read-only role panes in `src/app/tmux-play/launcher.ts` and matching unit-test assertions.
- [x] `src/app/tmux-play/launcher.acceptance.test.ts` covering TTMUX-030..033.
- [x] TTMUX-030..033 in `specs/test/tmux-play.md`.

## Tasks

Each task is one commit.

1. [x] Layout and geometry — TMUX-027/028, TMUX-035, TMUX-036.
2. [x] Presenter rewrite — TMUX-037..040.
3. [x] Fanout role prompt — TMUX-042.
4. [x] Role continuity verification — TMUX-041.
5. [x] Read-only role panes — TMUX-027 (`select-pane -d`) and unit-test coverage.
6. [x] Real-tmux acceptance gate — TTMUX-030..033 against an actual tmux server.

## Verification

- `npm run build`, `npm test`, and `npm run test:smoke` pass.
- `npm run test:acceptance` passes locally with `tmux` available; the new real-tmux acceptance suite verifies actual session geometry (`240x67`), pane layout (60/90/90 column placement), pane titles read back via `#{pane_title}`, and `pane_input_off=on` plus `send-keys` rejection on every role pane.
- IR shall not be marked Done unless the acceptance suite was executed end-to-end against a real tmux server within the same change set.
