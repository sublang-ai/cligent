<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-029: Captain Pre-Close Lifecycle

## Goal

Let stateful tmux-play Captains emit final session telemetry before the runtime closes `CaptainSession`, while preserving the existing post-close `dispose()` boundary and completing cleanup after failures.

## Status

Complete

## Deliverables

- [x] Add [DR-008](../decisions/008-captain-pre-close-lifecycle.md), [TMUX-085](../user/tmux-play.md#tmux-085), and [TTMUX-086](../test/tmux-play.md#ttmux-086).
- [x] Add optional `Captain.prepareDispose()` to the public tmux-play contract.
- [x] Invoke pre-close and final-disposal hooks exactly once in their respective emission phases during normal and initialization-failure cleanup.
- [x] Surface pre-close and final-disposal failures without skipping later cleanup, including observer failures caused by pre-close emissions, while preserving legacy handling of earlier dispatcher failures.
- [x] Cover ordering, emission acceptance/rejection, idempotence, and failure cleanup with focused runtime and contract tests.
- [x] Update public documentation and the changelog.

## Tasks

1. [x] **Specify, implement, and verify two-stage Captain cleanup.**
       Extend the public lifecycle, serialize idempotent disposal, preserve legacy post-close behavior, aggregate independent failures, and verify normal and failed initialization paths.

## Acceptance criteria

- A session emission awaited from `prepareDispose()` reaches observers before `CaptainSession.signal` aborts.
- The same emission attempted from `dispose()` rejects because session emissions are closed.
- Repeated or concurrent runtime disposal invokes `prepareDispose()` and `dispose()` once each.
- A rejected pre-close hook or its emission observer does not prevent session abort, final disposal, or observer detachment.
- A partially initialized Captain receives the same pre-close and final cleanup sequence.
- Build, focused tests, typecheck, and lint pass.
