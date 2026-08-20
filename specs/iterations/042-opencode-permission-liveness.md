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

- [x] [[opencode-7](../packages/adapters/opencode.md#opencode-7)] specifies
      native auto replies without a session wildcard on the active v1 and v2
      SDK paths.
- [x] [[opencode-8](../packages/adapters/opencode.md#opencode-8)] and
      [[opencode-20](../packages/adapters/opencode.md#opencode-20)] specify
      session-correlated, fail-closed permission replies, bounded reply
      failure, transport-level abort cleanup, event-count-independent control
      waits, bounded SDK teardown, and `SIGTERM`-to-`SIGKILL` escalation for
      headless runs, with a namespaced audit record after successful auto
      replies.
- [x] The adapter answers auto-mode v1 `permission.updated` and v2
      `permission.asked` requests `once`, and rejects non-auto residual
      requests through their version-correct SDK routes, with session and
      request identifiers preserved in calls and failures.
- [x] [[opencode-237](../packages/adapters/opencode.md#opencode-237)] covers both SDK paths,
      unknown permissions, concurrency, bounded failures, underlying I/O
      cancellation, ordered and bounded abort cleanup, and a real
      `mode: 'auto'` write outside the working directory that proves an
      explicit `bash` ask was answered `once`.
- [x] [DR-005](../decisions/005-per-adapter-permission-configuration.md), the
      historical headless-posture record, the spec map, and the changelog
      reflect the resolved hazard.
- [x] Review follow-up closes the adjacent prompt-tool hazard: OpenCode 1.18.13
      rewrites prompt `tools` into persistent permission rules, so
      [[opencode-15](../packages/adapters/opencode.md#opencode-15)] rejects every
      explicitly present tool-list option before SDK loading instead of
      letting an enabled tool override a native or portable deny.
- [x] Review follow-up separates root-only output from run-owned descendant
      permission control, including resumed child discovery and child-scoped
      replies.
- [x] Review follow-up keeps a caller-supplied resume identifier unconfirmed
      when OpenCode rejects its lineage before prompt dispatch, allowing
      `Cligent` to clear stale continuity.

## Tasks

Each task below is one-commit size.
Tasks 1–3 describe the original cohesive implementation; Tasks 4–6 are
separate review follow-ups.
Build, typecheck, lint, and unit verification apply at each completed change
boundary.

1. [x] **Specify deterministic headless permission handling.**
   Correct the OpenCode auto mapping and replace the known-hazard posture with
   native auto replies plus the non-auto fail-closed contract and acceptance
   criteria.
2. [x] **Implement mapping and reply liveness.**
   Preserve OpenCode's configured rules across v1 and v2, answer auto asks
   `once`, reject non-auto requests through the matching SDK route, bound reply
   waits, audit successful auto decisions, and cancel both underlying SSE and
   permission-response I/O while releasing managed resources ahead of bounded
   SDK disposal.
3. [x] **Verify canonical and real behavior.**
   Exercise canonical v1/v2 events, request failures and correlation, pending
   abort cleanup, and a real managed-mode absolute `/tmp` write.
4. [x] **Fail closed on unsafe prompt tool filters.**
   Remove the public adapter and compatibility-wrapper paths that emitted
   prompt `tools`, reject explicit tool-list presence before SDK loading, and
   cover empty, non-empty, combined, and permission-policy interactions.
5. [x] **Resolve descendant permission control.**
   Preserve root-only output filtering while tracking the root's owned session
   lineage, discover descendants before resumed prompts, and correlate replies
   with the native descendant session identifier.
6. [x] **Reject stale resumed continuity.**
   Treat only a freshly created or otherwise observed backend session as
   provider-confirmed, so a failed pre-dispatch resume omits its stale token
   and the next `Cligent` run can create a new session.

## Acceptance criteria

- `permissions: { mode: 'auto' }` appends no v1 or v2 wildcard rule, preserving
  native and user-configured explicit denies; explicitly present portable
  capability levels still map on their independent rule axis.
- Canonical v1 `permission.updated` and v2 `permission.asked` requests under
  auto are answered `once` without normalized interactive events; non-auto
  requests are emitted for observability and rejected exactly once through the
  applicable SDK response route. Each successful auto reply emits one
  namespaced automated-decision audit event with native and tool correlation.
- Residual and unknown permission names cannot wait indefinitely: missing
  request identifiers, unavailable or failed reply APIs, and reply timeouts
  terminate with an error naming the session, request, and permission.
- Root and run-owned descendant requests are handled while unrelated session
  trees are ignored; concurrent requests remain correlated by native session
  and request identifier, and descendant content remains filtered.
- A caller-supplied resume identifier rejected during pre-prompt lineage
  discovery is not returned by the non-interrupted error terminal unless
  OpenCode independently confirmed it during that run.
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
  file by requesting an exact shell command with `shellExecute: 'ask'`, emits
  a `bash` tool invocation plus its successful `once` audit record, produces no
  interactive permission request, denial, error event, or harness-side
  timeout, and ends with one successful terminal event.
- Any explicitly present `allowedTools` or `disallowedTools`, including empty
  arrays and a combination such as `shellExecute: 'deny'` with
  `allowedTools: ['bash']`, fails before the SDK loader, session, subscription,
  or prompt. Direct permission-mapper and low-level compatibility-wrapper
  calls cannot reintroduce OpenCode's persistent prompt-tool permission
  rewrite.
