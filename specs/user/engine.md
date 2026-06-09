<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# ENG: Core Engine

## Intent

This component defines the `Cligent` class, `Cligent.parallel()`, and event helpers per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md) and [DR-003](../decisions/003-role-scoped-session-management.md).

## Cligent Class

### ENG-001

The `Cligent` constructor shall accept an `AgentAdapter` and optional `CligentOptions` per [DR-003](../decisions/003-role-scoped-session-management.md). `CligentOptions` contains instance-level defaults (`role`, `cwd`, `model`, `permissions`, `maxTurns`, `maxBudgetUsd`, `reasoningEffort`, `allowedTools`, `disallowedTools`). Call-scoped fields (`abortSignal`, `resume`) exist only in `RunOptions`.

### ENG-002

`Cligent.run()` shall throw when called while a previous `run()` generator on the same instance is still active (single-flight enforcement per [DR-003](../decisions/003-role-scoped-session-management.md#single-flight-enforcement)).

### ENG-003

`Cligent.run()` shall merge `CligentOptions` instance defaults with per-call `RunOptions` overrides per [DR-003](../decisions/003-role-scoped-session-management.md#option-merge-semantics): deep merge for `permissions`, replace for `allowedTools`/`disallowedTools` arrays, per-call wins for other scalars. `abortSignal` and `resume` exist only in `RunOptions` (per-call), not in instance defaults.
Within `permissions`, `writablePaths` is an array grant field: when a per-call `permissions.writablePaths` array is provided, it shall replace the instance default array rather than merging element-wise.

### ENG-004

When `CligentOptions.role` is set, every event yielded by `run()` shall carry a `role` field matching that value. When `role` is not set, events shall not include a `role` field.

## Session Continuity

### ENG-005

When the adapter emits a `done` event with a `resumeToken`, `Cligent` shall store it. On subsequent `run()` calls, `Cligent` shall inject `resume: resumeToken` into adapter options — unless the caller explicitly sets `resume` in per-call overrides.

### ENG-006

When the adapter emits a `done` event without a `resumeToken`, `Cligent` shall not inject `resume` on subsequent calls. Auto-resume is a no-op for adapters that do not support resumption.

## Event Helpers

### ENG-007

The engine shall export `createEvent()`, `generateSessionId()`, and `isAgentEvent()` helpers for constructing events, generating unique session IDs, and runtime type-guarding `AgentEvent` values.

## Protocol Hardening (run)

### ENG-008

When the adapter's generator throws and no `done` event has been yielded, `run()` shall yield an `error` event (`code: 'ADAPTER_ERROR'`, `recoverable: false`) followed by a `done` event (`status: 'error'`). When the throw occurs after `done`, the exception shall be swallowed.

### ENG-009

When the `AbortSignal` fires and no `done` event has been yielded, `run()` shall call `.return()` on the adapter generator and yield a `done` event (`status: 'interrupted'`). When the signal is already aborted before `.run()` is called, `run()` shall yield `done` (`status: 'interrupted'`) without calling the adapter.
When the signal fires while an adapter `.next()` read is already pending, `run()` shall give the adapter a short bounded drain window before synthesis. During that drain, post-abort non-terminal events shall be suppressed; if the drain reaches an adapter-emitted `done`, that adapter event shall be yielded and processed normally before generator cleanup. For stateful `Cligent.run()`, processing that adapter `done` includes [ENG-005](#eng-005) resume-token capture. If the drain does not reach `done`, the synthesized interrupted `done` may include the inbound `resume` token when one was passed into the run, but shall not fabricate a token from a non-terminal event `sessionId`.

### ENG-010

Once a `done` event is yielded (whether from the adapter or synthesized), the engine shall call `.return()` on the generator and suppress all subsequent events. No event of any type shall follow `done`.

### ENG-011

Exactly one `done` event shall be yielded per `run()` call.

### ENG-012

When the adapter's generator exhausts without yielding a `done` event, `run()` shall yield an `error` event (`code: 'MISSING_DONE'`, `recoverable: false`) followed by a `done` event (`status: 'error'`).

### ENG-013

Synthesized `done` payloads shall use zeroed usage (`inputTokens: 0`, `outputTokens: 0`, `toolUses: 0`) and `durationMs` measured from when the adapter's `.run()` was called. An adapter-emitted `done` shall take precedence over synthesis.
This precedence includes an adapter-emitted interrupted `done` observed during the abort-drain path of [ENG-009](#eng-009).

## Cligent.parallel()

### ENG-014

`Cligent.parallel()` shall merge multiple `Cligent` streams, yielding `CligentEvent` values from each instance as they become available. Each event carries both `agent` (backend identity) and `role` (task identity).

### ENG-015

When one instance's adapter throws and no `done` has been yielded for that instance, `parallel()` shall yield an `error` event and `done` event for that instance and remove it from the pool. Remaining instances shall continue.

### ENG-016

Each task's `overrides.abortSignal` controls only that task. When a task's signal fires, `parallel()` shall yield `done` (`status: 'interrupted'`) for that task and remove it from the pool; remaining tasks continue. To abort all tasks, the caller shall share one `AbortController` across all task overrides.

## Tool Filtering

### ENG-017

When `allowedTools` is set, adapters shall restrict available tools to that list. When `disallowedTools` is also set, adapters shall further exclude those tools from the allowed set. Tool names shall be matched as exact identifiers unless the adapter explicitly documents pattern support per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#adapter-interface).

## Adapter Thread Safety

### ENG-018

`AgentAdapter.run()` shall be safe for concurrent calls on the same adapter instance unless the adapter explicitly documents an environmental constraint. Each call shall create fresh local state and `run()` shall not mutate adapter instance state per [DR-003](../decisions/003-role-scoped-session-management.md#adapter-thread-safety).

## Usage Reporting

### ENG-019

Adapter-reported `inputTokens` shall include all input tokens consumed by the request, regardless of caching tier (base, cache-read, and cache-creation). Adapters shall sum provider-specific cache fields (e.g. `cacheReadInputTokens`, `cacheCreationInputTokens`) into the single `inputTokens` value.

## Reasoning Effort

### ENG-020

`AgentOptions.reasoningEffort` shall accept the closed set `'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`, ordered from least to greatest reasoning depth, with `undefined` reserved to defer to the adapter or model default.
The unified set is a strict superset of the per-adapter SDK enums; adapters that lack a 1:1 value shall map to the nearest supported neighbour per their own item.
Adapters whose backend exposes no per-call reasoning surface shall ignore this field and document the rationale.

## Permission Policy Mode

### ENG-021

`PermissionPolicy.mode` shall accept the closed set `'auto' | 'bypass' | undefined` per [DR-005](../decisions/005-per-adapter-permission-configuration.md).
When `mode` is set, adapters shall use it as the session-wide automation posture at their SDK-knob selection step: `'auto'` shall map to the classifier-, sandbox-, or reviewer-protected auto-mode each SDK exposes, and `'bypass'` shall map to the unchecked-bypass mode where the SDK supports one.
Where an SDK models the automation posture and the local-access surface (filesystem, command, network) as independent axes, the adapter's mapping item may additionally derive the local-access surface from `fileWrite` / `shellExecute` / `networkAccess` while `mode` governs the automation posture; where it does not, `mode` shall take precedence over those per-capability levels.
Where an SDK exposes an automatic reviewer for otherwise interactive approval prompts, the `'auto'` mapping shall select it when that reviewer is part of the SDK's protected auto posture; this shall not expand filesystem, network, or sandbox permissions.
Adapters whose architecture cannot reach a given mode shall reject it at mapping time with an error naming the constraint; the rejection surfaces per [DR-005](../decisions/005-per-adapter-permission-configuration.md)'s failure-surfacing rule.
When `mode` is `undefined`, adapters shall continue to derive their SDK options from `fileWrite` / `shellExecute` / `networkAccess` as before.

## Workspace Writable Paths

### ENG-022

`PermissionPolicy.writablePaths` shall accept an optional array of workspace-relative path strings per [DR-006](../decisions/006-workspace-writable-paths.md). Adapters shall emit only canonical workspace-relative entries: separators use `/`, leading `./` components and trailing slashes are absent, and `.` components do not appear. Adapters shall reject empty entries, root-equivalent entries such as `.` or `./`, absolute paths, paths containing `..`, empty path segments, glob metacharacters, shell expansion characters, or control characters.

### ENG-023

`WritablePathsEnforcement` shall accept the closed set `'profile' | 'sandbox' | 'ambient'` per [DR-006](../decisions/006-workspace-writable-paths.md). `WritablePathsPermissionMapping` shall report canonical `paths` and the field-local `enforcement` class for accepted non-empty `writablePaths` policies. When `writablePaths` is absent or empty, permission mapping shall not emit a `WritablePathsPermissionMapping` payload.
