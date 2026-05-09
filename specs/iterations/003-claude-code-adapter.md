<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-003: Claude Code Adapter

## Goal

Implement the Claude Code adapter using `@anthropic-ai/claude-agent-sdk`, normalizing SDK messages to the Unified Event Stream and mapping UPM capabilities to Claude Code's permission system — per [DR-001](../decisions/001-unified-cli-agent-interface-architecture.md#claude-code-via-agent-sdk) and [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md).

## Status

Done

## Deliverables

- [x] `src/adapters/claude-code.ts` — `ClaudeCodeAdapter` implementing `AgentAdapter`
- [x] Sub-path export: `cligent/adapters/claude-code`
- [x] `@anthropic-ai/claude-agent-sdk` as optional peer dependency
- [x] Unit tests with mocked SDK

## Tasks

1. **Implement `ClaudeCodeAdapter`** (`src/adapters/claude-code.ts`)
   - Implements `AgentAdapter` with `agent: 'claude-code'`
   - Lazy-loads `@anthropic-ai/claude-agent-sdk` via dynamic `import()` — the adapter module itself must load without the SDK installed so consumers can register it unconditionally
   - `isAvailable()` — attempts dynamic `import()` of the SDK; returns `true` if it resolves, `false` otherwise
   - `run()` — lazy-loads SDK, calls `query()`, and yields normalized events; throws if SDK is not installed

2. **SDKMessage → AgentEvent normalization**
   - `system` message → `init` event (extract model, cwd, tools)
   - `assistant` message with text content → `text` event
   - `assistant` message with tool_use content → `tool_use` event
   - Stream events (text deltas) → `text_delta` events
   - `result` message → `done` event with usage stats and status mapping
   - Errors → `error` event with `recoverable` flag

3. **UPM → Claude Code permissions mapping**
   - Map `PermissionPolicy` per-capability to SDK controls per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm):
     - All three capabilities `'allow'` → `permissionMode: 'bypassPermissions'` (with `allowDangerouslySkipPermissions: true`)
     - Only `fileWrite: 'allow'` (others `'ask'`) → `permissionMode: 'acceptEdits'`
     - Any capability `'ask'` (none `'deny'`) → `permissionMode: 'default'` with `canUseTool` callback that auto-approves tool categories corresponding to `'allow'` capabilities
     - Any capability `'deny'` → `permissionMode: 'default'` with `canUseTool` callback that auto-approves `'allow'` categories and denies `'deny'` categories (`Write`/`Bash`/`WebFetch`)
   - Map `allowedTools`/`disallowedTools` to SDK options

4. **AgentOptions → SDK options mapping**
   - `cwd` → SDK `cwd`
   - `model` → SDK `model`
   - `maxTurns` → SDK `maxTurns`
   - `maxBudgetUsd` → SDK `maxBudgetUsd`
   - `resume` → SDK `resume` (session ID)
   - `abortSignal` → SDK `abortController` / signal propagation

5. **Configure sub-path export**
   - Add `"./adapters/claude-code"` to package.json `"exports"` map
   - Ensure tree-shaking: adapter not included in main entry point

6. **Write unit tests**
   - Mock `@anthropic-ai/claude-agent-sdk` `query()` returning canned `SDKMessage` sequences
   - Verify each SDKMessage type maps to the correct AgentEvent type
   - Verify UPM → permissions mapping for all PermissionLevel combinations
   - Verify AgentOptions pass-through to SDK options
   - Verify `isAvailable()` returns `false` when SDK not installed
   - Verify AbortSignal propagation

## Acceptance criteria

- `tsc --noEmit` passes
- `vitest run` passes all unit tests
- `import('cligent/adapters/claude-code')` resolves the adapter
- Main entry point (`import('cligent')`) does not bundle the adapter
