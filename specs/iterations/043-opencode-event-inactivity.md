<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-043: OpenCode Event-Inactivity Liveness

## Goal

Give every OpenCode headless run a finite relevant-event liveness boundary,
with status-based idle recovery and deterministic cleanup for silent active
sessions ([issue #40](https://github.com/sublang-ai/cligent/issues/40)).

## Status

Complete

## Deliverables

- [x] [OPENCODE-018](../user/adapters/opencode.md#opencode-018) defines the
      configurable inactivity deadline, current-session reset rule, status
      outcomes, diagnostics, abort precedence, and cleanup contract.
- [x] The adapter races pending SSE reads against relevant-event inactivity,
      caller abort, and managed-server exit; it queries and aborts sessions
      through supported SDK surfaces and emits one terminal event.
- [x] Canned-stream coverage exercises idle, busy, retry, query failure and
      timeout, relevant and foreign traffic, cleanup, and abort races with
      short deadlines.
- [x] A credential-free real managed-server acceptance probe exercises the
      vendor status endpoint and resource-cleanup seam without a long wait.

## Tasks

1. [x] **Specify finite OpenCode liveness.**
       Add [OPENCODE-018](../user/adapters/opencode.md#opencode-018) and
       [TADAPT-035](../test/adapters.md#tadapt-035).
2. [x] **Implement inactivity recovery and cleanup.**
       Add the finite deadline, relevant-session activity tracking, bounded status
       and abort operations, deterministic terminal selection, and iterator,
       client, session, and managed-server cleanup.
3. [x] **Verify canned and real-server paths.**
       Cover every status outcome and race with injected deadlines, then exercise
       idle recovery and cleanup against a real managed OpenCode server.

## Acceptance criteria

- A permanently pending stream terminates within its configured inactivity
  deadline plus the bounded status/abort cleanup interval.
- Current-session progress restarts the deadline; explicitly foreign traffic
  does not.
- Idle recovery, busy/retry abort, and status-query failure each emit the
  diagnostics and single terminal outcome required by
  [OPENCODE-018](../user/adapters/opencode.md#opencode-018).
- Timeout diagnostics identify the session, last relevant event, elapsed
  inactivity, deadline, server mode/state, and queried state or failure.
- Pending SSE iteration, active session work, SDK client resources, and the
  managed server are cleaned up; external caller abort cannot hang on an
  iterator that ignores its signal.
- Caller abort racing inactivity produces exactly one terminal `done`.
- Unit, type, lint, build, and focused real-server acceptance checks pass.
