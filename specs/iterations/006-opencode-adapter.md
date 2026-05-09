<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-006: OpenCode Adapter

## Goal

Implement the OpenCode adapter using `@opencode-ai/sdk`, supporting both managed mode (spawn server) and external mode (connect to URL), normalizing SSE events to the Unified Event Stream and mapping UPM capabilities to OpenCode's permission system — per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md).

## Status

Done

## Deliverables

- [x] `src/adapters/opencode.ts` — `OpenCodeAdapter` implementing `AgentAdapter`
- [x] Sub-path export: `cligent/adapters/opencode`
- [x] `@opencode-ai/sdk` as optional peer dependency
- [x] Extension events: `opencode:file_part`, `opencode:image_part`
- [x] Unit tests with mocked SDK

## Tasks

1. **Implement `OpenCodeAdapter`** (`src/adapters/opencode.ts`)
   - Implements `AgentAdapter` with `agent: 'opencode'`
   - Lazy-loads `@opencode-ai/sdk` via dynamic `import()` — the adapter module itself must load without the SDK installed so consumers can register it unconditionally
   - `isAvailable()` — attempts dynamic `import()` of the SDK; in managed mode also checks `opencode` CLI on PATH via spawn-based probe; returns `true` only if all checks pass
   - `run()` — lazy-loads SDK, connects to or spawns OpenCode server, subscribes to SSE stream, yields normalized events; throws if SDK is not installed

2. **Client-server architecture**
   - **Managed mode** (default): spawn `opencode` server process, connect SDK client
   - **External mode**: connect to user-provided server URL
   - Configuration via adapter constructor options (mode, serverUrl)

3. **SSE events → AgentEvent normalization**
   - `message.part.updated` (text content, no `delta`) → `text` event; with `delta` field → `text_delta` event
   - `message.part.updated` (tool call) → `tool_use` event
   - `message.part.updated` (thinking) → `thinking` event
   - `message.part.updated` (file part) → `opencode:file_part` extension event
   - `message.part.updated` (image part) → `opencode:image_part` extension event
   - `permission.updated` → `permission_request` event (new permission request state)
   - `permission.replied` → `tool_result` with `status: 'denied'` when rejected
   - `session.idle` → `done` event with usage stats
   - Errors → `error` event

4. **Session filtering**
   - SSE stream is global (all sessions); filter events by `sessionId`
   - Emit only events matching the current session

5. **UPM → OpenCode permissions mapping**
   - Map `PermissionPolicy` per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm):
     - `fileWrite` → OpenCode `permission` map for `edit`
     - `shellExecute` → OpenCode `permission` map for `bash`
     - `networkAccess` → OpenCode `permission` map for `webfetch`
   - Map `allowedTools`/`disallowedTools` to OpenCode tool configuration

6. **Server lifecycle management**
   - Managed mode: spawn server, wait for ready, connect client
   - On abort: yield `done` event with `status: 'interrupted'`, then gracefully shut down managed server
   - On completion: gracefully shut down managed server
   - Handle server crashes with `error` event + `done` event (`status: 'error'`) and cleanup

7. **Configure sub-path export**
   - Add `"./adapters/opencode"` to package.json `"exports"` map

8. **Write unit tests**
   - Mock `@opencode-ai/sdk` client with canned SSE event sequences
   - Verify each SSE event type maps to the correct AgentEvent type
   - Verify extension events use `opencode:` namespace prefix
   - Verify session filtering (events from other sessions are dropped)
   - Verify UPM → OpenCode permission map mapping
   - Verify managed mode server lifecycle (spawn, ready, shutdown)
   - Verify external mode connection
   - Verify `isAvailable()` behavior for both modes
   - Verify AbortSignal triggers server shutdown in managed mode

## Acceptance criteria

- `tsc --noEmit` passes
- `vitest run` passes all unit tests
- `import('cligent/adapters/opencode')` resolves the adapter
- Extension events use `opencode:` namespace prefix
- Session filtering correctly isolates events
