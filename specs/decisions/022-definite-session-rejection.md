<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-022: Definite Session Rejection

## Status

Accepted (2026-09-05); implementation awaits the owner's storage-contract review.
Amends [DR-002](002-unified-event-stream-and-adapter-interface.md) and [DR-003](003-role-scoped-session-management.md) for typed pre-execution resume rejection.

## Context

Provider conversation stores may be absent on another device or after cleanup.
A caller needs to distinguish a rejected resume selection from an execution failure whose effects are uncertain.

## Decision

- Reserve `SESSION_RESUME_REJECTED` only for authoritative proof that the selected conversation was rejected before prompt execution [[engine-84](../packages/engine.md#engine-84)].
- Preserve that classification through programmatic Captain/player results [[tmux-play-33](../packages/tmux-play.md#tmux-play-33)].
- Adapters and the engine never retry automatically; the host owns recovery context, effect authority and any fresh attempt.
- Unknown provider failures retain ordinary error handling; messages alone never prove safe retry.

## Consequences

- Hosts can recover missing provider sessions without treating every failure as retryable.
- Backends unable to prove pre-execution rejection remain conservative; no new capability or session store is introduced.
