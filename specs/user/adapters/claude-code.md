<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CLAUDE: Claude Code Adapter

This component defines the Claude Code adapter using `@anthropic-ai/claude-agent-sdk` per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md).

## Adapter Identity

### CLAUDE-001

The adapter shall implement `AgentAdapter` with `agent: 'claude-code'`.

## SDK Loading

### CLAUDE-002

The adapter module shall be importable without the SDK installed so consumers can register the adapter unconditionally. The SDK shall only be required at call time: `isAvailable()` shall return `false` and `run()` shall throw when the SDK is absent.

## Event Normalization

### CLAUDE-003

The adapter shall normalize SDK messages to `AgentEvent` types:

| SDK Message | AgentEvent |
| --- | --- |
| `system` | `init` (model, cwd, tools) |
| `assistant` with text content | `text` |
| `assistant` with tool_use content | `tool_use` |
| Stream events (text deltas) | `text_delta` |
| `result` | `done` (usage, status) |
| Errors | `error` (recoverable flag) |

## Permission Mapping

### CLAUDE-004

The adapter shall map `PermissionPolicy` to Claude Code permission modes per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm):

- All three capabilities `'allow'` → `permissionMode: 'bypassPermissions'`
- Only `fileWrite: 'allow'` (others `'ask'`) → `permissionMode: 'acceptEdits'`
- Any capability `'ask'` (none `'deny'`) → `permissionMode: 'default'` with `canUseTool` callback
- Any capability `'deny'` → `permissionMode: 'default'` with `canUseTool` callback that denies matching categories

### CLAUDE-005

The `canUseTool` callback shall match tool categories to UPM capabilities: `Write`/`Edit` → `fileWrite`, `Bash` → `shellExecute`, `WebFetch` → `networkAccess`.

## Options Mapping

### CLAUDE-006

The adapter shall map `AgentOptions` fields to SDK query options: `cwd` → SDK `cwd`, `model` → SDK `model`, `maxTurns` → SDK `maxTurns`, `maxBudgetUsd` → SDK `maxBudgetUsd`, `resume` → SDK `resume`.

## Resume Token

### CLAUDE-007

The adapter shall set `DonePayload.resumeToken` to the session identifier from the SDK result, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md#session-continuity-via-resume-token).
