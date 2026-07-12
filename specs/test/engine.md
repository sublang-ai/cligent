<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TENG: Engine Tests

## Intent

Verification criteria for the `Cligent` class and protocol hardening.

## Cligent Lifecycle

### TENG-001
Verifies: [ENG-004](../user/engine.md#eng-004)

Given a mock adapter and `CligentOptions` with `role`, when calling `run()`, every yielded event shall include the `role` field. When `role` is omitted, events shall not include a `role` field.

### TENG-002
Verifies: [ENG-002](../user/engine.md#eng-002)

When `run()` is called while a previous `run()` generator is still active on the same `Cligent` instance, the second call shall throw.

### TENG-003
Verifies: [ENG-003](../user/engine.md#eng-003)

Given instance defaults and per-call overrides, `run()` shall deep-merge `permissions` (per-call fields override; unset fields inherit), replace `allowedTools`/`disallowedTools` arrays entirely, and use per-call values for other scalars when set.
When both instance defaults and per-call overrides contain `permissions.writablePaths`, the per-call array shall replace the instance default array rather than merging element-wise.

## Session Continuity

### TENG-004
Verifies: [ENG-005](../user/engine.md#eng-005)

When the adapter emits `done` with `resumeToken`, the next `run()` call shall pass `resume: resumeToken` to the adapter. When the caller explicitly sets `resume` in overrides, the explicit value shall take precedence.

### TENG-005
Verifies: [ENG-006](../user/engine.md#eng-006)

When the adapter emits `done` without `resumeToken`, the next `run()` call shall not pass `resume` to the adapter.

## Protocol Hardening (run)

### TENG-006
Verifies: [ENG-001](../user/engine.md#eng-001)

Given a mock adapter that yields canned events, when calling `run()`, the consumer shall receive all expected `CligentEvent` values in order.

### TENG-007
Verifies: [ENG-005](../user/engine.md#eng-005), [ENG-009](../user/engine.md#eng-009), [ENG-010](../user/engine.md#eng-010), [ENG-013](../user/engine.md#eng-013)

When `AbortSignal` fires during `run()`, the engine shall yield `done` (`status: 'interrupted'`) and no further events.
When the adapter responds to that abort by yielding non-terminal flush events followed by its own terminal `done` with `status: 'interrupted'` and `resumeToken` during the bounded abort drain, the engine shall suppress the non-terminal events, yield that adapter `done` rather than a synthesized one, capture the token, and pass it as `resume` on the next `Cligent.run()` call. When the adapter does not settle to terminal `done` during the abort drain, the engine shall synthesize `done` (`status: 'interrupted'`) without clearing the previously stored resume token.

### TENG-008
Verifies: [ENG-008](../user/engine.md#eng-008)

When the adapter's generator throws before `done`, the engine shall yield `error` (`code: 'ADAPTER_ERROR'`) then `done` (`status: 'error'`). When the throw occurs after `done`, the engine shall suppress the exception and yield no additional events.

### TENG-009
Verifies: [ENG-012](../user/engine.md#eng-012)

When the adapter's generator exhausts without yielding `done`, the engine shall yield `error` (`code: 'MISSING_DONE'`) then `done` (`status: 'error'`).

### TENG-010
Verifies: [ENG-009](../user/engine.md#eng-009), [ENG-011](../user/engine.md#eng-011)

When `AbortSignal` fires concurrently with the adapter emitting its own `done`, the engine shall yield exactly one `done` event per session (done-cardinality race).

## Cligent.parallel()

### TENG-011
Verifies: [ENG-014](../user/engine.md#eng-014)

Given multiple `Cligent` instances with mock adapters, when calling `Cligent.parallel()`, the consumer shall receive interleaved events with per-instance `done` events, each carrying the correct `role`.

### TENG-012
Verifies: [ENG-015](../user/engine.md#eng-015)

When one instance's adapter throws in `parallel()`, the engine shall yield `error` + `done` for that instance; remaining instances shall continue unaffected.

### TENG-013
Verifies: [ENG-012](../user/engine.md#eng-012), [ENG-015](../user/engine.md#eng-015)

When an adapter's generator exhausts without yielding `done` inside `parallel()`, the engine shall yield `error` (`code: 'MISSING_DONE'`) then `done` (`status: 'error'`) for that instance; remaining instances shall continue unaffected.

### TENG-014
Verifies: [ENG-016](../user/engine.md#eng-016)

When one task's `AbortSignal` fires in `parallel()`, only that task shall yield `done` (`status: 'interrupted'`); remaining tasks shall continue. When all active tasks share one `AbortController` and it fires, all active tasks (those that have not yet emitted `done`) shall yield `done` (`status: 'interrupted'`).

## Effort API

### TENG-015
Verifies: [ENG-020](../user/engine.md#eng-020)

Where a TypeScript consumer uses the public API, the consumer shall be able to import `PortableEffort`, `ClaudeEffort`, `CodexEffort`, `GeminiEffort`, `OpenCodeEffort`, and `Effort`; construct and run every built-in adapter with its own vocabulary; use heterogeneous `Cligent.parallel()` and `runParallel()` tasks without cross-widening; and bind an arbitrary custom adapter vocabulary through direct and parallel calls. On those statically adapter-bound paths, cross-adapter and out-of-vocabulary values shall fail compilation.

### TENG-016
Verifies: [ENG-024](../user/engine.md#eng-024)

Where a consumer imports the effort metadata and helpers from the public package entry point, `EFFORT_SUPPORT`, each adapter entry, and each nested array shall reject runtime mutation; every values array shall match its public alias and order; orchestration arrays and all four `modelDependent` flags shall match [ENG-024](../user/engine.md#eng-024); Claude and `claude-code` lookups shall agree; predicates and assertions shall narrow and match the exposed values; notes shall name lossy and no-op conditions; and unknown-adapter behavior shall match the cited item.

### TENG-017
Verifies: [ENG-020](../user/engine.md#eng-020)

Where a custom adapter is registered through the legacy mutable registry, `runAgent()` shall accept `AgentOptions<string>` and forward an adapter-valid custom effort unchanged; its declarations shall not claim name-to-vocabulary narrowing.
