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
| First observed lifecycle event of a `command_execution` or `mcp_tool_call` item | `tool_use` |
| `item.completed` of a `command_execution` or `mcp_tool_call` item | `tool_result` |
| File change events | `codex:file_change` (extension) |
| `turn.completed` | `done` (usage) |
| `turn.failed` | `error` followed by `done` (`status: 'error'`) |
| Errors | `error` |

The SDK represents shell commands and MCP tool invocations as `command_execution` and `mcp_tool_call` thread items that evolve across `item.started`, `item.updated`, and `item.completed` events and correlate by item `id` [[1]].
For each such item `id`, the adapter shall emit exactly one `tool_use`, on the first lifecycle event observed for the `id`, and at most one terminal `tool_result`, on the item's `item.completed` event, whether the item completed or failed.
When `item.completed` arrives for an `id` whose earlier lifecycle events were not observed, the adapter shall synthesize the missing `tool_use` immediately before the `tool_result`.
An `item.updated` event for an already-announced `id` shall produce no additional unified lifecycle event.
Both unified events shall carry the native item `id` as `toolUseId` so concurrent items remain correlated.

The `tool_use` payload shall name the tool `command_execution` with the native command string as input for command items, and the MCP server-qualified tool name (`<server>.<tool>`) with the native arguments as input for MCP items.
The `tool_result` payload shall map native status `failed` to `status: 'error'` and any other terminal status to `status: 'success'`, and shall preserve the native `aggregated_output` and, when present, `exit_code` for command items, and the native result or error details for MCP items.

Where an `item.completed` item instead carries legacy alias tool shapes — `tool_call`, `function_call`, or `tool_use` calls and `tool_result`, `function_call_result`, or `tool_output` results, at item top level or among content blocks — the adapter shall normalize them to the same `tool_use` and `tool_result` events as a compatibility fallback, preserving their native status (including `denied`) and duration detail, with their identifiers counted through the same unique-`toolUseId` rule below.

Because the SDK usage object carries token counts but no tool-count metric, the adapter shall report `DonePayload.usage.toolUses` on every terminal `done` event as the number of unique `toolUseId` values observed during the run — for canonical SDK streams, the unique `command_execution` and `mcp_tool_call` item `id`s — independent of token-usage fields.
Where the SDK supplies canonical `Usage`, the adapter shall preserve cache-inclusive `input_tokens` as `DonePayload.usage.inputTokens`, shall recognize and validate `cached_input_tokens`, `cache_write_input_tokens`, and `reasoning_output_tokens`, and shall not add those detail counters to the inclusive input or output total a second time [[6]][[7]].

When Codex emits `turn.failed`, the adapter shall yield a structured `error` event carrying the failure's `message` and `code`, then yield a terminal `done` event with `status: 'error'`, and stop iterating the SDK stream. This ensures the actual failure reason (e.g., model rejection, server-side error) reaches the caller before the SDK's exec wrapper otherwise raises a generic non-zero-exit exception.

When Codex supplies an error message as a JSON-encoded object string, the adapter shall present the human-readable `detail`, `message`, or `error_description` content as the `error.message` while preserving a structured `code` when available. The adapter may further unwrap nested `error` envelopes to reach those human-readable fields.

## Permission Mapping

### CODEX-004

The adapter shall map `PermissionPolicy` to Codex controls per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm) and [ENG-021](../engine.md#eng-021), using Codex's modern permission-profile model [[3]][[4]]. The adapter shall express the local-access surface through the `CodexOptions.config` override `default_permissions` and shall not set `ThreadOptions.sandboxMode` or `ThreadOptions.networkAccessEnabled`, because a present legacy `sandbox_mode` makes Codex ignore `default_permissions` [[4]].

When the resolved `AgentOptions` carries no `permissions` policy, the adapter shall set none of `default_permissions`, `approvals_reviewer`, or `ThreadOptions.approvalPolicy`, leaving Codex's own default posture in effect per [DR-005](../../decisions/005-per-adapter-permission-configuration.md)'s no-project-wide-default rule. The mappings below apply only to a provided `PermissionPolicy`; within a provided policy an omitted capability field is treated as unset, which is distinct from an absent policy.

When the resolved `AgentOptions` carries a `permissions` policy, the adapter shall invoke Codex `exec` with `--ignore-user-config` while preserving the normal `CODEX_HOME` auth and session state. This prevents a user-level legacy `sandbox_mode` or stale `default_permissions` entry from overriding the adapter-selected permission profile for the run. Runs with no `permissions` policy shall continue to inherit Codex's own config.

The `default_permissions` profile shall be selected as follows:

- `PermissionPolicy.mode: 'bypass'` → `:danger-full-access`.
- Otherwise, derived from the per-capability levels: all of `fileWrite` / `shellExecute` / `networkAccess` set to `'allow'` → `:danger-full-access`; `fileWrite` or `shellExecute` set to `'deny'` → `:read-only`; otherwise, including all unset → `:workspace`. `networkAccess` alone shall never select `:read-only`: both `:workspace` and `:read-only` grant no network, so denying network shall not remove workspace write access. This is lossy for network: a `networkAccess: 'allow'` not accompanied by `fileWrite` and `shellExecute` both `'allow'` rounds to `:workspace`, which grants no network, because no built-in profile expresses workspace-write with network.

`ThreadOptions.approvalPolicy` and the reviewer shall be selected as follows:

- `PermissionPolicy.mode: 'auto'` → `approvalPolicy: 'on-request'` and the `CodexOptions.config` override `approvals_reviewer: 'auto_review'` per Codex auto-review semantics [[2]].
- `PermissionPolicy.mode: 'bypass'` → `approvalPolicy: 'never'` and no `approvals_reviewer`.
- `PermissionPolicy.mode` unset → `approvalPolicy` from the per-capability levels (all `'allow'` → `'never'`; any `'ask'` → `'untrusted'`; otherwise → `'on-request'`) and no `approvals_reviewer`.

When `PermissionPolicy.writablePaths` is non-empty per [ENG-022](../engine.md#eng-022) and the resolved `default_permissions` profile would otherwise be `:workspace`, the adapter shall select a generated `cligent-workspace-extra-writes` permission profile whose definition extends `:workspace` and grants `write` for each canonicalized path under `:workspace_roots`. The adapter shall expose `WritablePathsPermissionMapping` per [ENG-023](../engine.md#eng-023) with `enforcement: 'profile'` and the canonical `paths`. The generated profile may be delivered through any Codex route that satisfies [DR-006](../../decisions/006-workspace-writable-paths.md)'s config-delivery constraints. When non-empty `writablePaths` resolves alongside `:read-only`, the adapter shall reject the policy before starting a Codex thread. When the resolved `default_permissions` profile is `:danger-full-access`, `writablePaths` shall not narrow that broader posture, no extra-writes profile shall be generated, and the adapter shall report the canonical paths with `enforcement: 'ambient'` per [ENG-023](../engine.md#eng-023).

## Thread Resumption

### CODEX-005

When `resume` is provided in options, the adapter shall continue the previous thread identified by the token.

### CODEX-006

When Codex provides a thread identifier before terminal `done`, the adapter shall set `DonePayload.resumeToken` to that identifier, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md#session-continuity-via-resume-token).
When an abort causes terminal `done` with `status: 'interrupted'`, the adapter shall preserve continuity by setting `DonePayload.resumeToken` to the first available value in this order: the Codex-provided thread identifier observed before the abort; otherwise the non-empty `AgentOptions.resume` value passed into the run; otherwise no `resumeToken`.

## Working Directory

### CODEX-009

The adapter shall set `skipGitRepoCheck: true` on the Codex SDK `ThreadOptions` so the CLI's interactive-user git-repo gate does not refuse programmatic invocations. The `workingDirectory` is selected deliberately by the caller (per [TMUX-034](../tmux-play.md#tmux-034) the tmux-play launcher targets a snapshotted work dir, and library consumers pass `AgentOptions.cwd` explicitly); the gate was designed to catch surprise CLI use, not these paths.

## Options Mapping

### CODEX-007

Per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), the adapter shall accept the Codex-specific `AgentOptions.effort` vocabulary from [ENG-020](../engine.md#eng-020) and preserve the following native values through the documented effort and configuration surfaces per [[1]], [[3]], and [[5]]:

| `AgentOptions.effort` | Transport | Native value |
| --- | --- | --- |
| `minimal` | SDK `ThreadOptions.modelReasoningEffort` | `minimal` |
| `low` | SDK `ThreadOptions.modelReasoningEffort` | `low` |
| `medium` | SDK `ThreadOptions.modelReasoningEffort` | `medium` |
| `high` | SDK `ThreadOptions.modelReasoningEffort` | `high` |
| `xhigh` | SDK `ThreadOptions.modelReasoningEffort` | `xhigh` |
| `max` | Codex constructor `config.model_reasoning_effort` | `max` |
| `ultra` | Codex constructor `config.model_reasoning_effort` | `ultra` |

The minimum compatible Codex SDK thread option supports `minimal` through `xhigh`; for `max` and `ultra`, the adapter shall use the constructor configuration pass-through so the installed SDK spawns Codex with `--config model_reasoning_effort="<value>"`, and shall leave the thread `modelReasoningEffort` field unset per [[3]] and [[5]].
When effort is omitted, the adapter shall set neither effort transport and shall leave [CODEX-004](#codex-004)'s independently selected configuration-isolation behavior unchanged, preserving only defaults applicable to that run.
Where effort is outside the Codex-specific accepted vocabulary, including the Claude-specific value `ultracode`, the adapter shall reject it before starting a thread with an error naming the Codex adapter and allowed values.
Mapping `ultra` shall leave independently mapped permission-profile, approval, sandbox, writable-path, and network controls unchanged, although provider delegation may increase token use, latency, cost, concurrency, and tool activity per [[5]].

### CODEX-011

Where `AgentOptions.allowedTools` or `AgentOptions.disallowedTools` is provided, including an empty array, the adapter shall reject before loading or invoking the Codex SDK with an error that states the installed Codex integration cannot enforce explicit tool restrictions.
Where both fields are omitted, the adapter shall preserve Codex's native available-tool set.

## References

[1]: https://github.com/openai/codex/blob/main/sdk/typescript/README.md "Codex TypeScript SDK"
[2]: https://developers.openai.com/codex/concepts/sandboxing/auto-review "Codex: Auto-review"
[3]: https://developers.openai.com/codex/config-reference "Codex: Configuration Reference"
[4]: https://developers.openai.com/codex/permissions "Codex: Permission profiles and sandbox settings"
[5]: https://openai.com/index/gpt-5-6/ "Introducing GPT-5.6"
[6]: https://github.com/openai/codex/blob/rust-v0.146.0/sdk/typescript/src/events.ts#L20-L36 "Codex SDK 0.146.0 turn usage"
[7]: https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/protocol/src/protocol.rs#L2215-L2230 "Codex 0.146.0 token-usage protocol"
