<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# OPENCODE: OpenCode Adapter

## Intent

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
| `permission.updated` / `permission.asked` | `permission_request` |
| `permission.replied` (rejected) | `tool_result` (`status: 'denied'`) |
| `session.idle` | `done` (usage) |
| Errors | `error` |

## Session Filtering

### OPENCODE-006

While the SSE stream carries events for all sessions, the adapter shall emit only events matching the current `sessionId`. Events that carry no session or thread identifier shall pass through unfiltered, since many event types in a multiplexed stream lack explicit session tags.

## Permission Mapping

### OPENCODE-007

The adapter shall map `PermissionPolicy` to OpenCode permission controls per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm): `fileWrite` → `edit`, `shellExecute` → `bash`, `networkAccess` → `webfetch`.
On the OpenCode v2 SDK path, the adapter shall apply the equivalent `PermissionRuleset` at `session.create` for fresh sessions and at `session.update` before prompting resumed sessions, because the v2 prompt body no longer accepts the legacy `permission` map.

## Server Lifecycle

### OPENCODE-008

In managed mode, the adapter shall spawn the server, wait for ready, then connect the SDK client. On completion or abort, the adapter shall gracefully shut down the managed server.

### OPENCODE-009

When `AbortSignal` fires, the adapter shall yield `done` (`status: 'interrupted'`), then send `SIGTERM` to the managed server.

### OPENCODE-010

When the managed server crashes, the adapter shall yield an `error` event (`code: 'OPENCODE_SERVER_EXIT'`) followed by `done` (`status: 'error'`) and clean up resources.

## Resume Token

### OPENCODE-011

When OpenCode provides a session identifier before terminal `done`, the adapter shall set `DonePayload.resumeToken` to that identifier, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md#session-continuity-via-resume-token).
When an abort causes terminal `done` with `status: 'interrupted'`, the adapter shall preserve continuity by setting `DonePayload.resumeToken` to the first available value in this order: the OpenCode-provided session identifier observed before the abort; otherwise the non-empty `AgentOptions.resume` value passed into the run; otherwise no `resumeToken`.

## Options Mapping

### OPENCODE-012

The adapter shall map `AgentOptions.reasoningEffort` (per [ENG-020](../engine.md#eng-020)) to the top-level `variant` field on the OpenCode v2 session prompt body per [[1]].
The prompt-body surface, rather than session creation, shall be used so the value applies to both fresh and resumed sessions.
Provider dispatch shall use the `provider/model` prefix in `AgentOptions.model`.
When the provider has no documented built-in variant set, the adapter shall leave `variant` unset and defer to the user's `opencode.jsonc`.
When `reasoningEffort` is omitted, the adapter shall not set `variant`.

| `reasoningEffort` | Anthropic | OpenAI | Google | Other |
| --- | --- | --- | --- | --- |
| `minimal` | `high` | `minimal` | `low` | unset |
| `low` | `high` | `low` | `low` | unset |
| `medium` | `high` | `medium` | `low` | unset |
| `high` | `high` | `high` | `high` | unset |
| `xhigh` | `max` | `xhigh` | `high` | unset |
| `max` | `max` | `xhigh` | `high` | unset |

Where a provider lacks a 1:1 variant for the requested effort, the adapter shall use the nearest documented variant for that provider per [ENG-020](../engine.md#eng-020).

## References

[1]: https://opencode.ai/docs/models/ "OpenCode model configuration"
