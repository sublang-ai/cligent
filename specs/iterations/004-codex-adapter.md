<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-004: Codex Adapter

## Goal

Implement the Codex adapter using `@openai/codex-sdk`, normalizing Codex events to the Unified Event Stream and mapping UPM capabilities to Codex's sandbox and approval controls — per [DR-001](../decisions/001-unified-cli-agent-interface-architecture.md#codex-via-sdk) and [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md).

## Status

Done

## Deliverables

- [x] `src/adapters/codex.ts` — `CodexAdapter` implementing `AgentAdapter`
- [x] Sub-path export: `cligent/adapters/codex`
- [x] `@openai/codex-sdk` as optional peer dependency
- [x] Extension events: `codex:file_change`
- [x] Unit tests with mocked SDK

## Tasks

1. **Implement `CodexAdapter`** (`src/adapters/codex.ts`)
   - Implements `AgentAdapter` with `agent: 'codex'`
   - Lazy-loads `@openai/codex-sdk` via dynamic `import()` — the adapter module itself must load without the SDK installed so consumers can register it unconditionally
   - `isAvailable()` — attempts dynamic `import()` of the SDK; returns `true` if it resolves, `false` otherwise
   - `run()` — lazy-loads SDK, creates Codex instance, calls `startThread()` + `run()`, yields normalized events via `runStreamed()`; throws if SDK is not installed

2. **Codex events → AgentEvent normalization**
   - `item.completed` (text content) → `text` event
   - `item.completed` (tool call) → `tool_use` event
   - `item.completed` (tool result) → `tool_result` event
   - `turn.completed` → `done` event with usage stats
   - File change events → `codex:file_change` extension event per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#unified-event-stream) extensibility
   - Errors → `error` event

3. **UPM → Codex controls mapping**
   - Map `PermissionPolicy` to Codex `ThreadOptions` per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm):
     - `fileWrite` + `shellExecute` → `sandboxMode`: all `'allow'` → `'danger-full-access'`; `fileWrite: 'allow'` only → `'workspace-write'`; any `'deny'` → `'read-only'`
     - Permission levels → `approvalPolicy`: all `'allow'` → `'never'`; any `'ask'` → `'untrusted'`; mixed → `'on-request'`
     - `networkAccess` → `networkAccessEnabled: boolean` (`'allow'` → `true`, `'deny'`/`'ask'` → `false`; note: `'ask'` is a lossy mapping — Codex SDK has no prompt-based network control)
   - Map `allowedTools`/`disallowedTools` to Codex tool configuration

4. **Thread resumption**
   - `resume` option → `codex.resumeThread(threadId)` for session continuation

5. **Configure sub-path export**
   - Add `"./adapters/codex"` to package.json `"exports"` map
   - Ensure tree-shaking: adapter not included in main entry point

6. **Write unit tests**
   - Mock `@openai/codex-sdk` with canned event sequences
   - Verify each Codex event type maps to the correct AgentEvent type
   - Verify `codex:file_change` extension events are emitted
   - Verify UPM → sandboxMode/approvalPolicy/networkAccessEnabled mapping
   - Verify thread resumption via `resume` option
   - Verify `isAvailable()` returns `false` when SDK not installed
   - Verify AbortSignal propagation

## Acceptance criteria

- `tsc --noEmit` passes
- `vitest run` passes all unit tests
- `import('cligent/adapters/codex')` resolves the adapter
- Extension events use `codex:` namespace prefix
