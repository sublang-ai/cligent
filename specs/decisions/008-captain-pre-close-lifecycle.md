<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-008: Captain Pre-Close Lifecycle

## Status

Accepted

## Context

[DR-004](004-tmux-play-captain-architecture.md) places `Captain.dispose()` after the runtime aborts `CaptainSession.signal`, closes session emissions, and drains accepted records.
That ordering is correct for releasing resources, but it gives a stateful Captain no lifecycle point in which to emit a final session record.
Calling `emitStatus()` or `emitTelemetry()` from `dispose()` must reject, so moving legacy disposal earlier would change its established cleanup semantics.

## Decision

### Two-Stage Captain Shutdown

The optional Captain contract gains `prepareDispose?(): Promise<void>`.
Shutdown order is:

1. Abort and unwind the active Boss turn.
2. Invoke `Captain.prepareDispose()` exactly once while `CaptainSession.signal` and session emissions remain live.
3. Abort `CaptainSession.signal`, close new session emissions, and drain already accepted emissions.
4. Invoke `Captain.dispose()` exactly once.
5. Detach observers.

`prepareDispose()` is the final-emission hook.
`dispose()` remains the post-close resource-release hook, and its attempts to emit continue to reject.
Repeated or concurrent runtime disposal shares one cleanup operation and never repeats either hook.

### Failure Cleanup

A rejected `prepareDispose()` does not skip session abort, emission drain, `Captain.dispose()`, or observer detachment.
The runtime reports a non-observer pre-close failure through `runtime_error` while emissions remain live when possible, then rejects disposal with the failure after cleanup.
An observer dispatch failure retains the existing remaining-observer `runtime_error` behavior.
When cleanup produces multiple independent failures, the runtime rejects with an `AggregateError` that preserves each failure; one failure is rethrown directly.

The same two-stage cleanup runs when `Captain.init()` rejects, because initialization may have acquired resources or emitted session state before failing.
The initialization failure remains part of the rejected result alongside any independent cleanup failures.

## Consequences

- Stateful Captains can emit a lossless terminal session record without weakening the post-close rejection boundary.
- Existing Captains need no changes because the hook is optional and `dispose()` keeps its prior semantics.
- Shutdown remains failure-safe across initialization, observer dispatch, pre-close, and final-disposal failures.
