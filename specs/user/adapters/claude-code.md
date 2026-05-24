<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CLAUDE: Claude Code Adapter

## Intent

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
- No capability set to `'allow'` or `'deny'` — every capability `'ask'`, which includes a missing `permissions` field — → `permissionMode: 'default'` with **no** `canUseTool` callback. Per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) a missing policy is no override, so the SDK's own `default`-mode handling governs and the adapter synthesizes nothing.
- Any capability `'allow'` or `'deny'` present (mixed with `'ask'`) → `permissionMode: 'default'` with a `canUseTool` callback that enforces the explicit categories

### CLAUDE-005

The `canUseTool` callback shall conform to the Claude Agent SDK `CanUseTool` contract: the SDK invokes it as `(toolName, input, options)` and validates the resolved value against `PermissionResult`, so the callback shall resolve to `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }` — a bare boolean or `undefined` fails the SDK's schema validation and raises a `ZodError` on every tool call. It shall match tool categories to UPM capabilities — `Write`/`Edit` → `fileWrite`, `Bash` → `shellExecute`, `WebFetch` → `networkAccess` — and resolve each call as: capability `'allow'` → `allow`; capability `'deny'` → `deny`; capability `'ask'` → `deny` (interactive approval is unavailable to a headless adapter run; the deny `message` shall name the capability); a tool matching no category → `allow`, since it is not a permission-gated capability.

## Options Mapping

### CLAUDE-006

The adapter shall map `AgentOptions` fields to SDK query options: `cwd` → SDK `cwd`, `model` → SDK `model`, `maxTurns` → SDK `maxTurns`, `maxBudgetUsd` → SDK `maxBudgetUsd`, `resume` → SDK `resume`.

### CLAUDE-008

The adapter shall map `AgentOptions.reasoningEffort` (per [ENG-020](../engine.md#eng-020)) to the Claude Agent SDK `effort` query option per [[1]]:

| `reasoningEffort` | SDK `effort` |
| --- | --- |
| `minimal` | `low` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

The pinned Claude Agent SDK declares `effort` as the closed set `'low' | 'medium' | 'high' | 'xhigh' | 'max'`.
`minimal` collapses to `low` (the SDK's lowest tier).
When `reasoningEffort` is omitted, the adapter shall not set `effort` and shall defer to the SDK default.

## Resume Token

### CLAUDE-007

The adapter shall set `DonePayload.resumeToken` to the session identifier from the SDK result, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md#session-continuity-via-resume-token).

## References

[1]: https://platform.claude.com/docs/en/build-with-claude/effort "Claude effort parameter"
