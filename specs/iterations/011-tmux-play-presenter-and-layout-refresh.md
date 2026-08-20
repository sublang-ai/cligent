<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-011: tmux-play Presenter and Layout Refresh

## Goal

Implement [[tmux-play-27](../packages/tmux-play.md#tmux-play-27)], [[tmux-play-28](../packages/tmux-play.md#tmux-play-28)], [[tmux-play-35](../packages/tmux-play.md#tmux-play-35)], [[tmux-play-36](../packages/tmux-play.md#tmux-play-36)], [[tmux-play-37](../packages/tmux-play.md#tmux-play-37)], [[tmux-play-38](../packages/tmux-play.md#tmux-play-38)], [[tmux-play-39](../packages/tmux-play.md#tmux-play-39)], [[tmux-play-40](../packages/tmux-play.md#tmux-play-40)], [[tmux-play-41](../packages/tmux-play.md#tmux-play-41)], [[tmux-play-42](../packages/tmux-play.md#tmux-play-42)].

## Status

Done

## Scope

In scope:

- 240x67 tmux session at start.
- 4/6/6 column split; Boss/Captain on the left.
- Pane titles `Captain` plus title-cased player ids.
- Single Boss-input echo.
- `<who>> ` first-nonblank-line prefix with two-space hanging continuation indent.
- Failure as `<who>> [error: <message>]` or `<who>> [aborted]`.
- Boss pane omits per-player outputs and Captain prompt body.
- Persistent player Cligents with auto-resume.
- Fanout player prompts without identity preamble.
- Read-only player panes (input disabled).
- Real-tmux acceptance test that verifies geometry, layout, titles, and read-only player panes against an actual tmux server.
- Pre-attach terminal resize request (xterm CSI 8 t) so honoring terminals expand to 240×67 to match tmux-play-35.
- Resize-invariant 4/6/6 layout via session-scoped tmux hooks, so the spec's region split holds at any window size, not only at creation.

Out of scope: non-tmux UIs.

## Deliverables

- [x] `src/app/tmux-play/launcher.ts`.
- [x] `src/app/tmux-play/presenter-tmux.ts`.
- [x] `src/captains/fanout.ts`.
- [x] Tests for tmux-play-121..tmux-play-129; update tmux-play-114.
- [x] Read-only player panes in `src/app/tmux-play/launcher.ts` and matching unit-test assertions.
- [x] `src/app/tmux-play/launcher.acceptance.test.ts` covering tmux-play-130..tmux-play-133.
- [x] tmux-play-130..tmux-play-133 in `specs/test/tmux-play.md`.
- [x] Pre-attach `CSI 8 t` resize request in `src/app/tmux-play/launcher.ts`, tmux-play-43 in `specs/user/tmux-play.md`, and tmux-play-134 in `specs/test/tmux-play.md`.
- [x] Session-scoped `client-resized` / `after-resize-window` hooks in `src/app/tmux-play/launcher.ts` (tmux-play-44), unit-test coverage of the `set-hook` calls, and tmux-play-135 acceptance verification of the invariant at multiple window sizes.

## Tasks

Each task is one commit.

1. [x] Layout and geometry — tmux-play-27, tmux-play-28, tmux-play-35, tmux-play-36.
2. [x] Presenter rewrite — tmux-play-37..tmux-play-40.
3. [x] Fanout player prompt — tmux-play-42.
4. [x] Player continuity verification — tmux-play-41.
5. [x] Read-only player panes — tmux-play-27 (`select-pane -d`) and unit-test coverage.
6. [x] Real-tmux acceptance gate — tmux-play-130..tmux-play-133 against an actual tmux server.
7. [x] Pre-attach terminal resize request — tmux-play-43 (`CSI 8 ; 67 ; 240 t`) and tmux-play-134 unit-test coverage.
8. [x] Resize-invariant 4/6/6 layout — tmux-play-44 (session-scoped `client-resized` and `after-resize-window` hooks), unit-test of `set-hook` invocations, and tmux-play-135 real-tmux verification at multiple window sizes.

## Acceptance criteria

- `npm run build`, `npm test`, and `npm run test:smoke` pass.
- `npm run test:acceptance` passes locally with `tmux` available; the new real-tmux acceptance suite verifies actual session geometry (`240x67`), pane layout (60/90/90 column placement), pane titles read back via `#{pane_title}`, and `pane_input_off=on` plus `send-keys` rejection on every player pane.
- IR shall not be marked Done unless the acceptance suite was executed end-to-end against a real tmux server within the same change set.
