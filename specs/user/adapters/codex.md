<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CODEX: Codex Adapter

This component defines the Codex adapter using `@openai/codex-sdk` per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md).

## Adapter Identity

### CODEX-001

The adapter shall implement `AgentAdapter` with `agent: 'codex'`.

## SDK Loading

### CODEX-002

The adapter module shall be importable without the SDK installed so consumers can register the adapter unconditionally. The SDK shall only be required at call time: `isAvailable()` shall return `false` and `run()` shall throw when the SDK is absent.

## Event Normalization

### CODEX-003

The adapter shall normalize Codex events to `AgentEvent` types:

| Codex Event | AgentEvent |
| --- | --- |
| `item.completed` (text content) | `text` |
| `item.completed` (tool call) | `tool_use` |
| `item.completed` (tool result) | `tool_result` |
| File change events | `codex:file_change` (extension) |
| `turn.completed` | `done` (usage) |
| Errors | `error` |

## Permission Mapping

### CODEX-004

The adapter shall map `PermissionPolicy` to Codex controls per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm):

- `fileWrite` + `shellExecute` → `sandboxMode`: all `'allow'` → `'danger-full-access'`; `fileWrite: 'allow'` only → `'workspace-write'`; any `'deny'` → `'read-only'`
- Permission levels → `approvalPolicy`: all `'allow'` → `'never'`; any `'ask'` → `'untrusted'`; mixed → `'on-request'`
- `networkAccess` → `networkAccessEnabled`: `'allow'` → `true`; `'deny'` or `'ask'` → `false` (lossy: `'ask'` maps to `false` because the SDK has no prompt-based network control)

## Thread Resumption

### CODEX-005

When `resume` is provided in options, the adapter shall continue the previous thread identified by the token.

### CODEX-006

The adapter shall set `DonePayload.resumeToken` to the thread identifier, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md#session-continuity-via-resume-token).
