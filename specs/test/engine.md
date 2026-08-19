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

Where a TypeScript consumer uses the public API, the consumer shall be able to import `PortableEffort`, `ClaudeEffort`, `CodexEffort`, `GeminiEffort`, `OpenCodeEffort`, `KimiEffort`, and `Effort`; construct and run every built-in adapter with its own vocabulary; use heterogeneous `Cligent.parallel()` and `runParallel()` tasks without cross-widening; and bind an arbitrary custom adapter vocabulary through direct and parallel calls. On those statically adapter-bound paths, cross-adapter and out-of-vocabulary values shall fail compilation.

### TENG-016
Verifies: [ENG-024](../user/engine.md#eng-024)

Where a consumer imports the effort metadata and helpers from the public package entry point, `EFFORT_SUPPORT`, each adapter entry, and each nested array shall reject runtime mutation; every values array shall match its public alias and order; orchestration arrays and all five `modelDependent` flags shall match [ENG-024](../user/engine.md#eng-024); Claude and `claude-code` lookups shall agree; predicates and assertions shall narrow and match the exposed values; notes shall name lossy, no-op, and provider-default conditions; and unknown-adapter behavior shall match the cited item.

### TENG-017
Verifies: [ENG-020](../user/engine.md#eng-020)

Where a custom adapter is registered through the legacy mutable registry, `runAgent()` shall accept `AgentOptions<string>` and forward an adapter-valid custom effort unchanged; its declarations shall not claim name-to-vocabulary narrowing.

### TENG-018
Verifies: [ENG-025](../user/engine.md#eng-025), [ENG-026](../user/engine.md#eng-026), [[package-16](../packages/package.md#package-16)]

Where an adapter's peer SDK is installed at a version below its declared floor, when the adapter loads its runtime, the load shall fail with an error naming the package, the installed version, the required version, the resolved tree, and the repair command; `isAvailable()` shall report `false`; and the readiness verdict shall report `'unsupported'` with those same versions, distinctly from the `'missing'` verdict an absent runtime produces.
Where the installed version is at or above the floor and at or below the tested version, the load shall succeed and the verdict shall report `'satisfied'`; where it is above the tested version, the load shall succeed and the verdict shall report `'untested'`; and where the version cannot be read, the load shall succeed and the verdict shall report `'unknown'`.

### TENG-019
Verifies: [ENG-013](../user/engine.md#eng-013), [ENG-027](../user/engine.md#eng-027)

_Superseded by [TENG-022](#teng-022)._

Where a TypeScript consumer constructs `DoneUsage`, the public declaration shall require `tokenAvailability` and shall reject values outside `'reported' | 'unavailable'`.
When the engine synthesizes any terminal `done`, its zero-valued token fields shall carry `'unavailable'` and its `toolUses` shall preserve the unique tool calls already observed on that stream.

### TENG-020
Verifies: [ENG-019](../user/engine.md#eng-019), [ENG-027](../user/engine.md#eng-027), [ENG-028](../user/engine.md#eng-028)

_Superseded by [TENG-022](#teng-022)._

Where an adapter publishes `DoneUsage.breakdown` on a terminal `done` observed through `Cligent.run()`, every present member shall be a finite non-negative integer, a published input side shall sum exactly to `inputTokens`, and a published output side shall sum exactly to `outputTokens`.
Where a terminal `done` carries `tokenAvailability: 'unavailable'`, including every engine-synthesized terminal, it shall carry no `breakdown`.
Where a runtime reports a component as zero and omits another, the emitted breakdown shall carry the zero and omit the other, so a consumer can distinguish a measured zero from an unreported component.

### TENG-021
Verifies: [ENG-027](../user/engine.md#eng-027), [ENG-030](../user/engine.md#eng-030)

_Superseded by [TENG-022](#teng-022)._

Where a terminal `done` observed through `Cligent.run()` carries `DoneUsage.records`, the records' components shall sum member by member to `breakdown`, no record shall carry a component `breakdown` omits, and every present `requests` count shall be a finite non-negative integer.
Where a record's model is unknown to the producer, the record shall omit `model` rather than carry a placeholder value.
Where a terminal `done` carries `tokenAvailability: 'unavailable'`, including every engine-synthesized terminal, it shall carry no `records`.

### TENG-022
Verifies: [ENG-013](../user/engine.md#eng-013), [ENG-031](../user/engine.md#eng-031)

Where a TypeScript consumer constructs `DoneUsage`, the public declaration shall require `toolUses`, shall accept optional nested `tokens` and provenance-bearing `cost`, and shall reject the removed flat token, availability, cost, and breakdown fields.
Where the engine synthesizes any terminal `done`, `usage` shall contain the unique observed tool count and no token or cost placeholder.
Where a producer publishes a token report, all numeric fields shall satisfy [ENG-031](../user/engine.md#eng-031), a complete detail side shall reconcile to its inclusive total, records shall sum exactly to report totals and published details, and measured zero shall remain distinguishable from omission.
Where request coverage is incomplete but exact counters exist, the report shall say `'partial'`; where no authentic counters exist, `tokens` shall be absent.
Where a cost is present without tokens or tokens without cost, both shapes shall remain valid, and every cost shall carry USD currency and an allowed provenance source.
