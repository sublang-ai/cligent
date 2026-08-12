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
      short deadlines, including prompt-dispatch and ready-terminal races,
      oversized host timers, and forced managed-child termination.
- [x] A credential-free real managed-server acceptance probe exercises the
      vendor status endpoint and resource-cleanup seam without a long wait.
- [x] Review follow-up measures only active SSE wait time, counts every
      explicitly tagged event from the run-owned session tree, excludes
      untagged global traffic from progress, preserves root-only output, and
      delivers interrupted continuity within the engine abort drain while
      retaining bounded cleanup ownership.

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
4. [x] **Reconcile liveness clocks and abort delivery.**
       Carry a provider-wait silence budget across non-relevant traffic, pause it
       during downstream backpressure, and initiate session cancellation before
       promptly emitting a resumable interrupted terminal.
5. [x] **Separate liveness ownership from output scope.**
       Restart the silence budget for explicitly tagged progress anywhere in
       the run-owned session tree without emitting descendant conversation, and
       pin retained bounded cancellation after interrupted terminal delivery.

## Acceptance criteria

- A permanently pending stream terminates within its configured inactivity
  deadline plus the bounded status/abort cleanup interval.
- Explicitly tagged root-session and run-owned descendant progress restarts the
  deadline without widening root-only output; explicitly foreign and untagged
  global traffic does not, and downstream backpressure consumes none of the
  provider-wait budget.
- Idle recovery, busy/retry abort, and status-query failure each emit the
  diagnostics and single terminal outcome required by
  [OPENCODE-018](../user/adapters/opencode.md#opencode-018).
- Timeout diagnostics identify the session, last relevant event, elapsed
  inactivity, deadline, server mode/state, and queried state or failure.
- Pending SSE iteration, active session work, SDK client resources, and the
  managed server are cleaned up; external caller abort cannot hang on an
  iterator that ignores its signal or leave a known prompt-dispatch session
  active, legacy control requests share the create/prompt working-directory
  scope, caller interruption starts active-session cancellation before
  resumable terminal output and bounds its completion during later cleanup,
  managed-server termination follows terminal output, and a managed child
  cannot survive by ignoring `SIGTERM`.
- Prompt-dispatch exits return any eagerly started SSE iterator and unregister
  their abort listener; a concurrently settled result transfers session and
  iterator cleanup ownership before interrupted output; rejected client cleanup
  phases do not suppress later shutdown or managed-process cleanup; instance
  disposal targets the run's working directory on both SDK paths.
- Caller abort racing inactivity or an already-ready terminal event produces
  exactly one interrupted `done`.
- Unit, type, lint, build, and focused real-server acceptance checks pass.
