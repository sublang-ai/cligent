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

When `PermissionPolicy.writablePaths` is non-empty per [ENG-022](../engine.md#eng-022) and Claude Code sandboxing is not independently active through a supported adapter surface, the adapter shall accept valid entries, expose `WritablePathsPermissionMapping` per [ENG-023](../engine.md#eng-023) with `enforcement: 'ambient'` and canonical `paths`, and keep the existing permission-mode / `canUseTool` mapping unchanged.

### CLAUDE-005

The `canUseTool` callback shall conform to the Claude Agent SDK `CanUseTool` contract: the SDK invokes it as `(toolName, input, options)` and validates the resolved value against `PermissionResult`, so the callback shall resolve to `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }` — a bare boolean or `undefined` fails the SDK's schema validation and raises a `ZodError` on every tool call. It shall match tool categories to UPM capabilities — `Write`/`Edit` → `fileWrite`, `Bash` → `shellExecute`, `WebFetch` → `networkAccess` — and resolve each call as: capability `'allow'` → `allow`; capability `'deny'` → `deny`; capability `'ask'` → `deny` (interactive approval is unavailable to a headless adapter run; the deny `message` shall name the capability); a tool matching no category → `allow`, since it is not a permission-gated capability.

## Options Mapping

### CLAUDE-006

The adapter shall map `AgentOptions` fields to SDK query options: `cwd` → SDK `cwd`, `model` → SDK `model`, `maxTurns` → SDK `maxTurns`, `maxBudgetUsd` → SDK `maxBudgetUsd`, non-empty `resume` → SDK `resume`.

### CLAUDE-008

Per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), the adapter shall accept the Claude-specific `AgentOptions.effort` vocabulary from [ENG-020](../engine.md#eng-020) and map each value to the Claude Agent SDK query options per [[1]] and [[2]]:

| `AgentOptions.effort` | SDK `effort` | SDK `settings.ultracode` |
| --- | --- | --- |
| `minimal` | `low` | `false` |
| `low` | `low` | `false` |
| `medium` | `medium` | `false` |
| `high` | `high` | `false` |
| `xhigh` | `xhigh` | `false` |
| `max` | `max` | `false` |
| `ultracode` | `xhigh` | `true` |

The minimum compatible Claude Agent SDK declares model effort as `'low' | 'medium' | 'high' | 'xhigh' | 'max'`, so `minimal` shall collapse to its lowest tier and `ultracode` shall use `xhigh` plus the provider's orchestration setting.
Every explicit portable effort shall set `settings.ultracode: false` so a per-run downgrade overrides inherited ultracode configuration.
When effort is omitted, the adapter shall set neither SDK field and shall preserve SDK and user-configuration defaults.
Where effort is outside the Claude-specific accepted vocabulary, including the Codex-specific value `ultra`, the adapter shall reject it before invoking the SDK with an error naming the Claude adapter and allowed values.
Mapping `ultracode` shall leave independently mapped permission controls unchanged, although the provider's delegated workflow may increase token use, latency, cost, concurrency, and tool activity per [[2]].

## Resume Token

### CLAUDE-007

When a Claude Code run starts without `AgentOptions.resume`, the adapter shall pass a generated UUID as SDK `sessionId` so the run has a stable session identifier once Claude persists the conversation.
When the Claude Code SDK provides a session identifier before terminal `done`, the adapter shall set `DonePayload.resumeToken` to that identifier, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md#session-continuity-via-resume-token).
When an abort causes terminal `done` with `status: 'interrupted'`, the adapter shall preserve continuity by setting `DonePayload.resumeToken` to the first available value in this order: a session identifier observed on SDK activity beyond the initial `system` message, or the adapter-assigned session identifier after such activity; otherwise the non-empty `AgentOptions.resume` value passed into the run; otherwise no `resumeToken`.

## References

[1]: https://platform.claude.com/docs/en/build-with-claude/effort "Claude effort parameter"
[2]: https://code.claude.com/docs/en/workflows#let-claude-decide-with-ultracode "Claude Code workflows: let Claude decide with ultracode"
