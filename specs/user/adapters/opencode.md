<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# OPENCODE: OpenCode Adapter

This component defines the OpenCode adapter using `@opencode-ai/sdk` with managed and external server modes per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md).

## Adapter Identity

### OPENCODE-001

The adapter shall implement `AgentAdapter` with `agent: 'opencode'`.

## SDK Loading

### OPENCODE-002

The adapter module shall be importable without the SDK installed so consumers can register the adapter unconditionally. The SDK shall only be required at call time: `isAvailable()` shall return `false` and `run()` shall throw when the SDK is absent.

### OPENCODE-003

`isAvailable()` shall check SDK presence and, in managed mode, also check that the `opencode` CLI is on PATH via a spawn-based probe. It shall return `true` only if all checks pass.

## Two Modes

### OPENCODE-004

The adapter shall support two modes, selectable via constructor options: managed mode (default; spawn `opencode` server process) and external mode (connect to a user-provided `serverUrl`).

## Event Normalization

### OPENCODE-005

The adapter shall normalize SSE events to `AgentEvent` types:

| SSE Event | AgentEvent |
| --- | --- |
| `message.part.updated` (text, no delta) | `text` |
| `message.part.updated` (text, with delta) | `text_delta` |
| `message.part.updated` (tool call) | `tool_use` |
| `message.part.updated` (thinking) | `thinking` |
| `message.part.updated` (file part) | `opencode:file_part` (extension) |
| `message.part.updated` (image part) | `opencode:image_part` (extension) |
| `permission.updated` | `permission_request` |
| `permission.replied` (rejected) | `tool_result` (`status: 'denied'`) |
| `session.idle` | `done` (usage) |
| Errors | `error` |

## Session Filtering

### OPENCODE-006

While the SSE stream carries events for all sessions, the adapter shall emit only events matching the current `sessionId`.

## Permission Mapping

### OPENCODE-007

The adapter shall map `PermissionPolicy` to OpenCode permission controls per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm): `fileWrite` → `edit`, `shellExecute` → `bash`, `networkAccess` → `webfetch`.

## Server Lifecycle

### OPENCODE-008

In managed mode, the adapter shall spawn the server, wait for ready, then connect the SDK client. On completion or abort, the adapter shall gracefully shut down the managed server.

### OPENCODE-009

When `AbortSignal` fires, the adapter shall yield `done` (`status: 'interrupted'`), then send `SIGTERM` to the managed server.

### OPENCODE-010

When the managed server crashes, the adapter shall yield an `error` event (`code: 'OPENCODE_SERVER_EXIT'`) followed by `done` (`status: 'error'`) and clean up resources.

## Resume Token

### OPENCODE-011

The adapter shall set `DonePayload.resumeToken` to the session identifier from the run result, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md#session-continuity-via-resume-token).
