<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-042: OpenCode Permission Liveness

## Goal

End indefinite OpenCode headless waits on permission requests by reproducing
OpenCode's native auto response behavior and deterministically resolving any
permission request that reaches the adapter
([issue #36](https://github.com/sublang-ai/cligent/issues/36)).

## Status

Complete

## Deliverables

- [x] [OPENCODE-007](../user/adapters/opencode.md#opencode-007) specifies
      native auto replies without a session wildcard on the active v1 and v2
      SDK paths.
- [x] [OPENCODE-008](../user/adapters/opencode.md#opencode-008) and
      [OPENCODE-020](../user/adapters/opencode.md#opencode-020) specify
      session-correlated, fail-closed permission replies, bounded reply
      failure, transport-level abort cleanup, event-count-independent control
      waits, bounded SDK teardown, and `SIGTERM`-to-`SIGKILL` escalation for
      headless runs.
- [x] The adapter answers auto-mode v1 `permission.updated` and v2
      `permission.asked` requests `once`, and rejects non-auto residual
      requests through their version-correct SDK routes, with session and
      request identifiers preserved in calls and failures.
- [x] [TADAPT-037](../test/adapters.md#tadapt-037) covers both SDK paths,
      unknown permissions, concurrency, bounded failures, underlying I/O
      cancellation, ordered and bounded abort cleanup, and a real
      `mode: 'auto'` write outside the working directory.
- [x] [DR-005](../decisions/005-per-adapter-permission-configuration.md), the
      historical headless-posture record, the spec map, and the changelog
      reflect the resolved hazard.

## Tasks

The tasks below are reviewable work units delivered together in one cohesive
commit.
Build, typecheck, lint, and unit verification apply to that completed
change rather than artificial per-task commit boundaries.

1. [x] **Specify deterministic headless permission handling.**
   Correct the OpenCode auto mapping and replace the known-hazard posture with
   native auto replies plus the non-auto fail-closed contract and acceptance
   criteria.
2. [x] **Implement mapping and reply liveness.**
   Preserve OpenCode's configured rules across v1 and v2, answer auto asks
   `once`, reject non-auto requests through the matching SDK route, bound reply
   waits, and cancel both underlying SSE and permission-response I/O while
   releasing managed resources ahead of bounded SDK disposal.
3. [x] **Verify canonical and real behavior.**
   Exercise canonical v1/v2 events, request failures and correlation, pending
   abort cleanup, and a real managed-mode absolute `/tmp` write.

## Acceptance criteria

- `permissions: { mode: 'auto' }` appends no v1 or v2 wildcard rule, preserving
  native and user-configured explicit denies; explicitly present portable
  capability levels still map on their independent rule axis.
- Canonical v1 `permission.updated` and v2 `permission.asked` requests under
  auto are answered `once` without normalized interactive events; non-auto
  requests are emitted for observability and rejected exactly once through the
  applicable SDK response route.
- Residual and unknown permission names cannot wait indefinitely: missing
  request identifiers, unavailable or failed reply APIs, and reply timeouts
  terminate with an error naming the session, request, and permission.
- Foreign-session requests are ignored and concurrent requests remain
  correlated by session and request identifier.
- Streaming any number of SSE events leaves only a constant number of
  reactions on run-lifetime controls; completed events do not accumulate
  abort or server-exit reactions.
- Abort preempts a pending SSE or permission-reply wait, propagates through the
  run-owned SDK signal, closes the SSE iterator, yields one interrupted terminal
  event before managed `SIGTERM`, and closes the SDK client and managed server.
  Managed termination begins before bounded iterator/client cleanup, so a
  non-settling cleanup hook cannot block generator completion. A reply timeout
  likewise cancels the underlying response and SSE I/O before cleanup completes.
- A managed server that remains alive after the bounded `SIGTERM` grace
  receives `SIGKILL`, and the final close wait is bounded.
- A real managed-mode `mode: 'auto'` run writes and verifies an absolute `/tmp`
  file without a permission request, denial, error event, or harness-side
  timeout, and ends with one successful terminal event.
