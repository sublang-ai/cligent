<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CODEX: Codex Adapter

## Intent

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
| `turn.failed` | `error` followed by `done` (`status: 'error'`) |
| Errors | `error` |

When Codex emits `turn.failed`, the adapter shall yield a structured `error` event carrying the failure's `message` and `code`, then yield a terminal `done` event with `status: 'error'`, and stop iterating the SDK stream. This ensures the actual failure reason (e.g., model rejection, server-side error) reaches the caller before the SDK's exec wrapper otherwise raises a generic non-zero-exit exception.

When Codex supplies an error message as a JSON-encoded object string, the adapter shall present the human-readable `detail`, `message`, or `error_description` content as the `error.message` while preserving a structured `code` when available. The adapter may further unwrap nested `error` envelopes to reach those human-readable fields.

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

## Working Directory

### CODEX-009

The adapter shall set `skipGitRepoCheck: true` on the Codex SDK `ThreadOptions` so the CLI's interactive-user git-repo gate does not refuse programmatic invocations. The `workingDirectory` is selected deliberately by the caller (per [TMUX-034](../tmux-play.md#tmux-034) the tmux-play launcher targets a snapshotted work dir, and library consumers pass `AgentOptions.cwd` explicitly); the gate was designed to catch surprise CLI use, not these paths.

## Options Mapping

### CODEX-007

The adapter shall map `AgentOptions.reasoningEffort` (per [ENG-020](../engine.md#eng-020)) to the Codex SDK `modelReasoningEffort` thread option per [[1]]:

| `reasoningEffort` | SDK `modelReasoningEffort` |
| --- | --- |
| `minimal` | `minimal` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `xhigh` |

When `reasoningEffort` is omitted, the adapter shall not set `modelReasoningEffort` and shall defer to the Codex default.

## References

[1]: https://github.com/openai/codex/blob/main/sdk/typescript/README.md "Codex TypeScript SDK"
