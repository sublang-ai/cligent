<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-002: Core Engine and Adapter Registry

> **Note:** The `AdapterRegistry` and `runAgent()` API from this iteration are replaced by the `Cligent` class in [DR-003](../decisions/003-role-scoped-session-management.md). Protocol hardening logic (done-terminal, done-cardinality, abort, error synthesis) carries forward into `Cligent.run()`.

## Goal

Implement the core engine: an adapter registry for managing agent adapters, the `runAgent()` entry point that looks up an adapter and yields events, and `runParallel()` for merging multiple agent streams — per the driver-adapter architecture in [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#driver-adapter-architecture).

## Deliverables

- [x] `src/registry.ts` — `AdapterRegistry` class
- [x] `src/engine.ts` — `runAgent()` and `runParallel()` functions
- [x] `src/events.ts` — event factory helpers (`createEvent`, `generateSessionId`, `isAgentEvent`)
- [x] Unit tests with mock adapters
- [x] Updated `src/index.ts` exports

## Tasks

1. **Implement `AdapterRegistry`** (`src/registry.ts`)
   - `register(adapter: AgentAdapter): void` — registers by `adapter.agent`; throws on duplicate
   - `get(agent: AgentType): AgentAdapter | undefined` — lookup by agent name
   - `list(): AgentType[]` — return registered agent names
   - `unregister(agent: AgentType): boolean` — remove an adapter; return `true` if found

2. **Implement `runAgent()`** (`src/engine.ts`)
   - Accepts `agent: AgentType`, `prompt: string`, `options?: AgentOptions`, and a registry
   - Looks up adapter via registry; throws if not found
   - Calls `adapter.run(prompt, options)` and yields each `AgentEvent`
   - If the adapter's generator throws **and no `done` has been yielded yet**, catch and yield a normalized `error` event (with `recoverable: false`, `code: 'ADAPTER_ERROR'`) followed by a `done` event (with `status: 'error'`); throws after `done` (e.g., during `.return()` cleanup) are swallowed; never propagate adapter exceptions to the consumer
   - Synthesized `done` payloads use zeroed usage (`inputTokens: 0`, `outputTokens: 0`, `toolUses: 0`) and `durationMs` measured from when the adapter's `.run()` was called (per-adapter start, not global engine entry); adapters have richer data so their `done` always takes precedence per the cardinality rule
   - On `AbortSignal`, call `.return()` on the adapter generator and yield a `done` event with `status: 'interrupted'` per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#session-control)
   - **Done is terminal:** once a `done` event is yielded (whether from the adapter or synthesized), the engine must stop consuming from that adapter — call `.return()` on the generator and suppress all subsequent events; no event of any type may follow `done`
   - **Done cardinality:** exactly one `done` event per session — the engine only synthesizes `done` when the adapter terminates without emitting one:
     - Throw (no prior `done`): `error` event (`code: 'ADAPTER_ERROR'`, `recoverable: false`) then `done` event (`status: 'error'`)
     - Abort (no prior `done`): `done` event (`status: 'interrupted'`)
     - Generator exhaustion (no prior `done`): `error` event (`code: 'MISSING_DONE'`, `recoverable: false`, protocol violation: adapter completed without terminal event) then `done` event (`status: 'error'`)

3. **Implement `runParallel()`** (`src/engine.ts`)
   - Accepts array of `{ adapter, prompt, options }` tasks per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#parallel-execution)
   - Merges streams using `Promise.race` on pending `next()` calls
   - Tags events with `adapter.agent` (already in `BaseEvent`)
   - Isolates errors: when an adapter's generator throws **and no `done` has been yielded for that adapter**, yield a normalized `error` event + `done` event (`status: 'error'`) for that adapter and remove it from the race pool; throws after `done` are swallowed; remaining adapters continue
   - On `AbortSignal`, call `.return()` on all active generators and yield a `done` event with `status: 'interrupted'` for each active adapter
   - Same terminal/cardinality/synthetic-payload rules as `runAgent()`: per-adapter `done` tracking, zeroed usage defaults, `durationMs` from per-adapter `.run()` start

4. **Implement event factory helpers** (`src/events.ts`)
   - `createEvent(type, agent, payload, sessionId?)` — returns a fully populated `AgentEvent` with timestamp and sessionId
   - `generateSessionId()` — returns a unique session identifier
   - `isAgentEvent(value: unknown): value is AgentEvent` — type guard for runtime validation

5. **Update `src/index.ts`**
   - Re-export `AdapterRegistry`, `runAgent`, `runParallel`, and event helpers

6. **Write unit tests**
   - Mock adapter implementing `AgentAdapter` that yields canned events
   - Test registry CRUD operations (register, get, list, unregister, duplicate rejection)
   - Test `runAgent()` end-to-end with mock adapter
   - Test `runParallel()` with multiple mock adapters, verifying interleaved events
   - Test `AbortSignal` cancellation for both `runAgent()` and `runParallel()`
   - Test error isolation in `runParallel()` (one failing adapter, others continue)
   - Test done-terminal: adapter emits `done` then throws — verify engine suppresses all post-done events (both the `error` and the duplicate `done`)
   - Test done-cardinality: abort fires concurrently with adapter's own `done` — verify exactly one `done` yielded
   - Test MISSING_DONE for both `runAgent()` and `runParallel()`: adapter generator exhausts without emitting `done` — verify engine emits `error` event with `code: 'MISSING_DONE'` followed by `done` with `status: 'error'`; in parallel, verify other adapters continue unaffected

## Verification

- `tsc --noEmit` passes
- `vitest run` passes all unit tests
- Mock adapter tests cover registry CRUD, single-agent streaming, parallel streaming, abort, error isolation, done-terminal suppression, done-cardinality dedup, and MISSING_DONE synthesis
