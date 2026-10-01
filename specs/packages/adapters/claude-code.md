<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# claude-code: Claude Code Adapter

## Intent

This package lets a consumer of the agent-adapter contract run Claude Code through the `@anthropic-ai/claude-agent-sdk`, per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md).
It owns whether the SDK and the native binary it spawns are ready to run and how a portable request becomes an SDK query, including native fast-mode, subagent-model, and subagent-effort selection, and how that query's stream becomes unified events, permission decisions, authentic fast-mode observation, resume continuity, and token accounting, not what a caller does with them and not the SDK's own behavior.
Its requirements are stated in this project's `AgentAdapter`, `AgentEvent`, `AgentOptions`, `PermissionPolicy`, `DonePayload`, and `Cligent` vocabulary, which the engine defines and without which this adapter's behavior cannot be stated.

## External Behavior

### Adapter Identity

### claude-code-1

The adapter shall implement `AgentAdapter` with `agent: 'claude-code'`.

### SDK Loading

### claude-code-2

Where the Claude Agent SDK is not installed, the adapter module shall remain importable so consumers can register it unconditionally.

### claude-code-13

When `isAvailable()` is called, the adapter shall return the result of the first matching row of this matrix:

| SDK and native binary | Result |
| --- | --- |
| the Claude Agent SDK cannot be loaded, as when it is missing under [[engine-26](../engine.md#engine-26)] runtime readiness | `false` |
| the SDK loads, but [[claude-code-57](#claude-code-57)]'s lookup finds no native binary | `false` |
| the SDK loads and that lookup finds the native binary | `true` |

### claude-code-14

Where the Claude Agent SDK is not installed, when `run()` is called, the adapter shall throw `ClaudeCodeAdapter requires @anthropic-ai/claude-agent-sdk. Install it to use this adapter.`.

### claude-code-56

Where the Claude Agent SDK loads but [[claude-code-57](#claude-code-57)]'s lookup finds no native binary, when `run()` is called, the adapter shall throw before any SDK call with the message of the first matching row of this matrix:

| Lookup outcome | Message names |
| --- | --- |
| the SDK publishes no native binary for the host [[claude-code-57](#claude-code-57)] | that the SDK publishes no native binary for the host as `<platform>-<arch>`, with no reinstall advice |
| any other | the lookup's first candidate package, the host as `<platform>-<arch>`, and the repair of reinstalling so npm installs that optional package: `npm ci` in a checkout, or reinstalling the SDK where `@sublang/cligent` resolves it without omitting optional dependencies |

### Event Normalization

### claude-code-3

When the adapter normalizes a non-terminal, non-system SDK message, it shall yield `AgentEvent` values according to this dispatch matrix:

| SDK Message | AgentEvent |
| --- | --- |
| `assistant` | each event selected by the ordered assistant mapping below |
| `user` without `isReplay: true` | emit only `tool_result` blocks from `message.content`, preserving their order and the mapping below; ignore ordinary user text and attached media |
| `user` with `isReplay: true` | no event |
| `stream`, `stream_event`, or `delta` | `text_delta` from the first non-empty `delta`, then `text`, or no event |
| `error` | `error` with the payload selected by [[claude-code-32](#claude-code-32)] |
| missing or any other `type` | no event |

- An assistant message emits its non-empty top-level `text` as `text`, then its non-empty top-level `delta` as `text_delta`, then the events selected below from top-level `content` when that member is not nullish or otherwise from `message.content`, preserving block order.

| Assistant content block | Event payload or outcome |
| --- | --- |
| `text` with a string `text`, including empty | `text.content` is that string |
| `thinking` with a non-empty string `summary` | `thinking.summary` is that string |
| `thinking` without a non-empty summary | no event |
| `tool_use` | `tool_use.toolUseId` is the first non-empty `id`, then `toolUseId`, or an identifier generated through [[engine-7](../engine.md#engine-7)]; `toolName` is the first non-empty `name`, then `toolName`, or `unknown_tool`; `input` is the supplied object or `{}` |
| `tool_result` | the tool-result mapping below |
| any other block | no event |

- A `tool_result` selects `toolUseId` from the first non-empty `toolUseId`, `tool_use_id`, and `id`, or generates one through [[engine-7](../engine.md#engine-7)]; selects `toolName` from the matching tool-use identifier observed in this run, then non-empty `name`, then `toolName`, or `unknown_tool`; selects output from the first non-nullish `output`, `result`, and `content`, or `null`; and selects numeric duration from `durationMs`, then `duration_ms`, or omits it.
- Its status is `denied` for case-insensitive source status `denied`, otherwise `error` for `isError: true`, `is_error: true`, or case-insensitive source status `error`, and otherwise `success`.
- Each tool result is followed by normalized media payloads [[media-1](../media.md#media-1)] for its explicit image, audio, document, or resource content [[media-2](../media.md#media-2)], preserving content order and the tool-use identifier without reading paths or interpreting ordinary text as media [[media-3](../media.md#media-3)].

### claude-code-32

When the adapter normalizes an SDK `error` message, it shall select its payload according to this field-priority matrix:

| Payload member | First available value |
| --- | --- |
| `code` | non-empty top-level `code`, nested `error.code`, nested `error.type`, otherwise omitted; replace upstream `SESSION_RESUME_REJECTED` with `SDK_STREAM_ERROR` because provider codes do not establish pre-execution rejection [[engine-84](../engine.md#engine-84)] |
| `message` | non-empty top-level `message`, nested `error.message`, otherwise `Claude Code SDK error` |
| `recoverable` | boolean top-level `recoverable`, boolean top-level `retryable`, otherwise `false` |

### claude-code-15

When the adapter normalizes a sequence of SDK `system` messages, it shall select and emit the `init` handshake according to this sequence matrix:

| State and message | Outcome |
| --- | --- |
| no `init` emitted; `subtype: 'init'` | emit `init` with model, cwd, and tools |
| no `init` emitted; subtype absent, empty, or non-string | emit `init`, because runtime notices carry non-empty string labels |
| no `init` emitted; any other subtype | emit nothing |
| `init` already emitted; any `system` message | emit nothing, preserving the first handshake's capabilities |

- An emitted `init` selects model from non-empty message `model`, requested model, then `unknown`; sets `reportedModel` [[engine-27](../engine.md#engine-27)] only from non-empty message `model`; selects cwd from non-empty message `cwd`, requested cwd, then the process cwd; and retains each non-empty string tool or object tool name.

### claude-code-10

When the SDK stream yields a success-classified `result` carrying no non-empty result or error text and a valid complete zero main-loop signature per [[claude-code-28](#claude-code-28)], the adapter shall classify it according to this continuation-repair matrix:

| Run state | Outcome |
| --- | --- |
| non-empty inbound `resume`; no prior `text`, `text_delta`, `thinking`, `tool_use`, or `tool_result` | emit no terminal event and continue consuming, for every matching result while those conditions hold |
| no inbound `resume` | emit terminal `done` with `status: 'success'`, no result value, and usage derived normally from the terminal accounting per [[claude-code-12](#claude-code-12)] and [[claude-code-31](#claude-code-31)], then stop consuming |
| non-empty inbound `resume`; prior `text`, `text_delta`, `thinking`, or `tool_result` but no observed `tool_use` | emit terminal `done` with `status: 'success'`, no result value, and usage derived normally from the terminal accounting per [[claude-code-12](#claude-code-12)] and [[claude-code-31](#claude-code-31)], then stop consuming |

### claude-code-18

While a run is not aborted and has emitted no terminal `done`, when its SDK stream ends, the adapter shall yield a non-recoverable `error` with code `MISSING_RESULT` and message `Protocol violation: Claude Code SDK stream ended without a result message`, followed by terminal `done` with `status: 'error'`, elapsed duration, usage containing only the tool-use count in [[claude-code-50](#claude-code-50)], and no result or resume token.

### claude-code-42

While a run is not aborted, when the SDK query fails before terminal `done`, the adapter shall yield a non-recoverable `error` with code `SDK_STREAM_ERROR` and the thrown `Error` message or `Claude Code adapter failed during stream`, followed by terminal `done` with `status: 'error'`, elapsed duration, usage containing only the tool-use count in [[claude-code-50](#claude-code-50)], and no result or resume token, whether failure occurs during query invocation or iterator consumption.

### claude-code-48

While the mapped SDK abort controller is aborted and no terminal `done` has been emitted, when the SDK query exits, the adapter shall yield for the bounded abort drain in [[engine-35](../engine.md#engine-35)] only terminal `done` with [[engine-73](../engine.md#engine-73)] status `'interrupted'`, the resume token selected by [[claude-code-26](#claude-code-26)], elapsed duration, usage containing only the tool-use count in [[claude-code-50](#claude-code-50)], and no result, whether the iterator ends or query invocation or iterator consumption throws.

### Permission Mapping

### claude-code-4

When the adapter maps the closed `PermissionPolicy.mode` set in [[engine-21](../engine.md#engine-21)] and its capability levels to Claude Code controls under [[engine-52](../engine.md#engine-52)] per [DR-005](../../decisions/005-per-adapter-permission-configuration.md), it shall produce exactly this matrix, with an explicit mode taking precedence over every capability level:

| Policy input | `permissionMode` | `allowDangerouslySkipPermissions` | `canUseTool` |
| --- | --- | --- | --- |
| policy absent | `default` | omitted | omitted |
| `mode: 'auto'`, with any capability levels | `auto` | omitted | omitted; native classifier handling receives no cligent-selected capability grant |
| `mode: 'bypass'`, with any capability levels | `bypassPermissions` | `true` | omitted |
| mode omitted; all capabilities `allow` | `bypassPermissions` | `true` | omitted |
| mode omitted; only `fileWrite` is `allow` and the others are omitted or `ask` | `acceptEdits` | omitted | omitted |
| mode omitted; every capability is omitted or `ask`, including an empty policy | `default` | omitted | omitted |
| mode omitted; every other mix containing `allow` or `deny` | `default` | omitted | callback per [[claude-code-5](#claude-code-5)], [[claude-code-20](#claude-code-20)], and [[claude-code-21](#claude-code-21)] |

### claude-code-19

Where Claude Code has no independently active supported filesystem-sandbox write-grant surface, when the adapter maps `PermissionPolicy.writablePaths`, it shall apply [[engine-53](../engine.md#engine-53)] validation and [[engine-54](../engine.md#engine-54)] reporting according to this matrix without changing the permission controls selected by [[claude-code-4](#claude-code-4)]:

| `writablePaths` input | Outcome |
| --- | --- |
| absent or empty | omit `WritablePathsPermissionMapping` |
| valid non-empty entries | canonical paths with `enforcement: 'ambient'` |
| any invalid entry | reject the mapping |

### claude-code-5

When the Claude Agent SDK invokes `canUseTool(toolName, input, options)`, the callback shall conform to its `CanUseTool` contract by resolving to `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }` rather than a bare boolean or `undefined`.

### claude-code-20

When `canUseTool` classifies a tool name, it shall map its leading identifier to a permission capability according to this table:

| Tool identifier | Capability |
| --- | --- |
| `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | `fileWrite` |
| `Bash` | `shellExecute` |
| `WebFetch` | `networkAccess` |
| every other identifier | unclassified |

### claude-code-21

When `canUseTool` decides a classified or unclassified call, it shall resolve according to this headless decision matrix:

| Classification and level | Result |
| --- | --- |
| classified; `allow` | `{ behavior: 'allow', updatedInput }` |
| classified; `deny` | `{ behavior: 'deny', message }`, naming the capability |
| classified; `ask` | `{ behavior: 'deny', message }`, naming the capability and unavailable interactive approval |
| unclassified | `{ behavior: 'allow', updatedInput }` |

### Options Mapping

### claude-code-46

When `run(prompt, options)` invokes the SDK query, the adapter shall select its prompt representation according to this matrix after [[attachments-2](../attachments.md#attachments-2)] prepares any [[attachments-1](../attachments.md#attachments-1)] attachments, per [[10]] and [[7]]:

| Prepared attachments | SDK prompt                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none                 | original `prompt` string unchanged                                                                                                                                                                                                 |
| one or more          | an async iterable yielding exactly one `user` message with `parent_tool_use_id: null`, `message.role: 'user'`, and content consisting of the unchanged prompt in a text block followed by one block per attachment in caller order |

- Each raster image block has `type: 'image'` and a base64 source carrying the prepared MIME type and the file's bytes.
- Each PDF block has `type: 'document'` and a base64 source carrying `media_type: 'application/pdf'` and the file's bytes.
- The adapter reads attachment bytes before invoking the SDK query so a read failure never becomes an SDK generator-abort error.

### claude-code-73

When attachment or MCP preparation is cancelled through the caller's `abortSignal`, the adapter shall yield exactly one terminal `done` with `status: 'interrupted'`, no result or token counts, `usage.toolUses: 0`, elapsed preparation duration, and the inbound non-empty resume token when present, without invoking the SDK [[engine-73](../engine.md#engine-73)].

### claude-code-6

When the adapter maps `AgentOptions` to SDK query options, it shall pass through `cwd`, `model`, `maxTurns`, and `maxBudgetUsd` when present and leave their SDK values `undefined` when absent, while passing through only a non-empty `resume` and otherwise leaving it `undefined`.

### claude-code-33

When the adapter maps `AgentOptions.abortSignal`, it shall control SDK cancellation according to this per-run lifecycle matrix:

| Input or lifecycle state | SDK `abortController` outcome |
| --- | --- |
| signal absent | `undefined` |
| signal already aborted | fresh controller aborted before `query()` |
| signal aborts during the run | fresh controller aborted when the signal fires |
| run ends | caller-signal listener removed |
| runs overlap or occur in sequence | controller and listener state isolated per run |

### claude-code-9

When the adapter maps `AgentOptions.allowedTools` under the portable tool restriction in [[engine-17](../engine.md#engine-17)], it shall preserve the raw list and apply the provider controls in this matrix, which isolates only the ambient settings source its empty row covers and makes no claim about other provider context, MCP confinement being the same for every row [[claude-code-70](#claude-code-70)]:

| `allowedTools` input | SDK controls |
| --- | --- |
| omitted | leave `tools`, `allowedTools`, and `settingSources` `undefined`, preserving native tool and settings behavior |
| empty | `tools: []`, `allowedTools: []`, and `settingSources: []` |
| non-empty | copy the list to `tools`, pass it to `allowedTools`, and leave `settingSources` `undefined` |

### claude-code-70

When the adapter maps a run to SDK query options, it shall confine the run's MCP servers to those the query itself passes [[claude-code-74](#claude-code-74)], whatever its `allowedTools`, `effort`, or `fastMode`, per [DR-030](../../decisions/030-players-see-only-their-own-mcp-servers.md), [DR-032](../../decisions/032-browser-tools-and-media-output.md), and [[7]]:

| SDK control | Value | Ambient source it removes |
| --- | --- | --- |
| `strictMcpConfig` | `true` | project `.mcp.json`, user-settings MCP servers, plugins, and on-disk agent frontmatter |
| `settings.disableClaudeAiConnectors` | `true`, in the same settings object as the effort and fast-mode keys | the account's auto-fetched claude.ai connectors, with the reminder that they need authorizing |
| `mcpServers` | explicitly prepared caller servers, or omitted when none were configured | — |

- `settingSources` is untouched, so filesystem settings and `CLAUDE.md` still load as [[claude-code-9](#claude-code-9)] maps them.

### claude-code-74

When a run prepares caller MCP servers or a managed browser, the adapter shall admit the validated configuration [[mcp-1](../mcp.md#mcp-1)], [[mcp-2](../mcp.md#mcp-2)] and resolved browser server [[mcp-3](../mcp.md#mcp-3)] through this SDK mapping, per [DR-032](../../decisions/032-browser-tools-and-media-output.md) and [[11]]:

| Effective input | Outcome |
| --- | --- |
| nonempty server map or `browser: true`, together with any explicit `allowedTools` | reject before browser installation or SDK loading because the native built-in tool selector cannot enforce the portable MCP allowlist |
| absent server map without a browser | omit SDK `mcpServers` and preserve the existing tool mapping [[claude-code-9](#claude-code-9)] |
| empty explicit map without a browser | pass `mcpServers: {}` and preserve the existing tool mapping [[claude-code-9](#claude-code-9)] |
| stdio server | pass its `type`, `command`, and copied optional `args` and `env` |
| HTTP server | pass its `type`, `url`, and copied optional `headers` |
| one or more prepared servers | pass only those servers and auto-approve their tools through SDK `allowedTools` entries `mcp__<server-name>__*`, without changing the built-in `tools` selection or permission mode |
| `disallowedTools` supplied | preserve the SDK deny mapping and its precedence [[claude-code-22](#claude-code-22)] |

### claude-code-77

When the first native initialization reports MCP connection states for the selected servers in [[claude-code-74](#claude-code-74)], the adapter shall emit the ordinary `init` selected by [[claude-code-15](#claude-code-15)] and apply this readiness matrix:

| Native state | Outcome |
| --- | --- |
| a selected server reports `failed`, `needs-auth`, or `disabled` | stop consuming the SDK stream and select [[claude-code-42](#claude-code-42)]'s failure with the server name, status, and guidance to check command or endpoint, authentication, and native policy |
| `connected`, `pending`, unknown or missing status, absent status list, or an unselected server | preserve normal stream processing, because pending and cached servers can connect after initialization and omitted evidence does not establish failure |

### claude-code-22

When the adapter maps `AgentOptions.disallowedTools`, it shall pass the raw list through when present and leave the SDK value `undefined` otherwise, preserving deny precedence over `allowedTools` per [[engine-17](../engine.md#engine-17)].

### claude-code-8

When the adapter maps the Claude-specific `AgentOptions.effort` vocabulary in [[engine-40](../engine.md#engine-40)] per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), it shall produce this SDK-option matrix per [[1]] and [[2]]:

| `AgentOptions.effort` | SDK `effort` | SDK `settings.ultracode` |
| --- | --- | --- |
| omitted | omitted | omitted |
| `minimal` | `low` | `false` |
| `low` | `low` | `false` |
| `medium` | `medium` | `false` |
| `high` | `high` | `false` |
| `xhigh` | `xhigh` | `false` |
| `max` | `max` | `false` |
| `ultracode` | `xhigh` | `true` |
| `ultra` or any other unsupported value | reject before invoking the SDK, naming the adapter and allowed values | not invoked |

### claude-code-23

Where `AgentOptions.effort` is `ultracode`, when the adapter maps the same permission input with and without that effort, it shall leave every permission control unchanged.

### Fast Mode

### claude-code-52

When the adapter maps `AgentOptions.fastMode` under [[engine-75](../engine.md#engine-75)], it shall produce this Claude SDK settings matrix per [[4]], [[5]], and [[7]] while preserving [[claude-code-8](#claude-code-8)]'s independently selected `settings.ultracode` value in the same settings object:

| `AgentOptions.fastMode` | `settings.fastMode` | `settings.fastModePerSessionOptIn` |
| --- | --- | --- |
| omitted | omitted | omitted |
| `true` | `true` | omitted |
| `false` | `false` | omitted |

Every combination with omitted effort, ordinary effort, and `ultracode` retains both independently selected settings without one replacing the other.

### claude-code-53

When the adapter normalizes Claude SDK initialization or terminal result data, it shall map authentic fast-mode members into [[engine-78](../engine.md#engine-78)] through this matrix per [[4]], [[6]], [[7]], and [[8]]:

| SDK source member | Unified member |
| --- | --- |
| streamed `system/init.fast_mode_state` | `InitPayload.fastMode.state` |
| streamed `system/init.fast_mode_disabled_reason` | `InitPayload.fastMode.disabledReason` |
| success or error result `fast_mode_state` | `DonePayload.fastMode.state` |
| success or error result `fast_mode_disabled_reason` | `DonePayload.fastMode.disabledReason` |
| success or error result `usage.speed` equal to `'standard'` or `'fast'`; at least one of `usage.input_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, or `usage.output_tokens` is a finite positive safe integer | `DonePayload.fastMode.responseSpeed` |
| result `usage.speed` absent, null, or any other value; or none of those four counters is a finite positive safe integer | omit `DonePayload.fastMode.responseSpeed` |
| absent other source member | omit the corresponding member and omit `fastMode` when no member remains |

Every mapped value is forwarded verbatim, `cooldown` remains state without an invented disabled reason, and `AgentOptions.fastMode` never becomes an observation source.

### Subagent Model and Effort

### claude-code-60

When the adapter maps `AgentOptions.subagentModel` under [[engine-91](../engine.md#engine-91)], it shall select these variables of [[claude-code-34](#claude-code-34)]'s per-run environment clone through this matrix per [[9]]:

| `AgentOptions.subagentModel` | `CLAUDE_CODE_SUBAGENT_MODEL` | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` |
| --- | --- | --- |
| omitted | the caller environment's value or absence | the caller environment's value or absence |
| `inherit` | absent, removing any caller value | `'1'` |
| any other accepted value | the value, verbatim | `'1'` |

### claude-code-61

When the adapter maps `AgentOptions.subagentModel` and `AgentOptions.subagentEffort` under [[engine-91](../engine.md#engine-91)] and [[engine-97](../engine.md#engine-97)], it shall contribute to [[claude-code-62](#claude-code-62)]'s system-prompt parts no part when `subagentModel` is omitted, and otherwise the delegation directive below as the final part, its `{first}` selected through this matrix, `{model}` being the `subagentModel` value verbatim and `{effort}` the [[claude-code-8](#claude-code-8)] SDK effort of the accepted `subagentEffort`:

| `subagentModel` | `subagentEffort` | `{first}` |
| --- | --- | --- |
| `inherit` | omitted | `Your subagents run on your own model; give each one the effort its task warrants.` |
| any other value | omitted | `Your subagents run on {model}; give each one the effort its task warrants.` |
| `inherit` | accepted value | `Your subagents run on your own model at {effort} effort.` |
| any other value | accepted value | `Your subagents run on {model} at {effort} effort.` |

```text
{first} Offload to them the work you can specify completely and bound tightly — well-defined, fine-grained tasks a subagent can implement well — and keep the deep thinking, reasoning, and design work yourself. Offloading must never lower the quality of what you deliver: brief each subagent fully, and verify its result before you build on it.
```

### claude-code-67

When the adapter maps `AgentOptions.subagentModel` and `AgentOptions.subagentEffort` under [[engine-91](../engine.md#engine-91)] and [[engine-97](../engine.md#engine-97)], it shall select the SDK `agents` option through this matrix per [[9]] and [[7]]:

| `subagentModel` | `subagentEffort` | SDK `agents` |
| --- | --- | --- |
| omitted | omitted | omitted |
| accepted value | accepted value | a definition named `delegate` and one named `general-purpose`, replacing that built-in, both at the value's [[claude-code-8](#claude-code-8)] SDK effort, and none named `Explore` or `Plan`, which keep their built-in definitions |
| accepted value | omitted | one definition named `delegate-<effort>` per distinct [[claude-code-8](#claude-code-8)] SDK effort of the [[engine-40](../engine.md#engine-40)] `ClaudeEffort` values other than `ultracode`, in that vocabulary's order — `delegate-low`, `delegate-medium`, `delegate-high`, `delegate-xhigh`, and `delegate-max` — then one named `general-purpose`, replacing that built-in, at `medium`, and none named `Explore` or `Plan`, which keep their built-in definitions |

Each definition carries exactly these fields, `{model}` being the `subagentModel` value verbatim, `{on}` being `your model` for `inherit` and `{model}` otherwise, and `{effort}` the definition's SDK effort:

| Field | `delegate` and `delegate-<effort>` | `general-purpose` |
| --- | --- | --- |
| `description` | `Runs on {on} at {effort} effort.` | with `subagentEffort` accepted, `General-purpose agent for research, code search and multi-step tasks, on {on} at {effort} effort.`; with it omitted, `General-purpose agent for research, code search and multi-step tasks, on {on} at medium effort; start a delegate-<effort> subagent for another effort.` |
| `prompt` | the delegate prompt below | the delegate prompt below |
| `model` | `{model}`, `inherit` passing as `inherit` | absent, so the model [[claude-code-60](#claude-code-60)]'s environment binds applies |
| `effort` | `{effort}` | `{effort}` |

```text
You are a delegate subagent. Complete exactly the task you are given, within the bounds it sets, using the tools available to you. Do not widen the task or change anything it does not ask for. When you finish, report precisely what you did and what you verified, and name anything you could not do or could not verify.
```

### claude-code-62

When the adapter prepares an SDK query, it shall compose the SDK `systemPrompt` from its ordered system-prompt parts through this matrix per [[5]] and [[7]]:

| Parts | SDK `systemPrompt` |
| --- | --- |
| none | omitted |
| one or more | `{ type: 'custom', prompt, snapshot: false }`, where `prompt` joins the parts in order with one blank line between consecutive parts |

### claude-code-63

The adapter module shall export `subagentDirective(selection)`, returning [[claude-code-61](#claude-code-61)]'s directive for a `selection` of `{ model, effort? }`, `model` being a model or `inherit` and an omitted `effort` the agent's choice, with a bare model string read as `{ model }`, and `composeClaudeSystemPrompt(parts)`, returning [[claude-code-62](#claude-code-62)]'s `systemPrompt` value for `parts`, or `undefined` for none.

### Terminal Results

### claude-code-24

When the adapter normalizes an SDK `result` that is not the internal no-op in [[claude-code-10](#claude-code-10)], it shall emit terminal events according to this ordered classification matrix, using the first non-empty status field from `status`, `stopReason`, and `stop_reason` and comparing its value case-insensitively where a row calls for one:

| First matching result signal | Event sequence and terminal status |
| --- | --- |
| `subtype: 'error_max_turns'` | `done` with `status: 'max_turns'` |
| `subtype: 'error_max_budget_usd'` | `done` with `status: 'max_budget'` |
| any other `error_*` subtype, `is_error: true`, or `isError: true` | non-recoverable `error`, then `done` with `status: 'error'` |
| status `success`, `completed`, or `ok` | `done` with `status: 'success'` |
| status `interrupted`, `cancelled`, or `aborted` | `done` with `status: 'interrupted'` |
| status `max_turns` or `maxturns` | `done` with `status: 'max_turns'` |
| status `max_budget`, `maxbudget`, or `budget_exceeded` | `done` with `status: 'max_budget'` |
| status `error` or `failed` | `done` with `status: 'error'` |
| status absent or unrecognized | `done` with `status: 'success'` |

- A synthesized `error` uses its non-empty subtype or `CLAUDE_CODE_RESULT_ERROR` as code, replacing a `SESSION_RESUME_REJECTED` subtype with that fallback [[engine-84](../engine.md#engine-84)], joins non-empty `errors` entries as its message before falling back to non-empty `result`, subtype, and `Claude Code SDK error`, and carries `recoverable: false`.
- Terminal `done.result` prefers non-empty `result`, then error text produced by subtype or error-flag classification, and is otherwise omitted; status-only classification does not promote the `errors` array to result text.
- Terminal duration prefers numeric `durationMs`, then numeric `duration_ms`, then elapsed run time.

### Resume Token

### claude-code-7

When a Claude Code run starts without `AgentOptions.resume`, the adapter shall pass a UUID generated through [[engine-7](../engine.md#engine-7)] as SDK `sessionId` so the run has a stable identifier once Claude persists the conversation.

### claude-code-25

When the SDK stream yields a normal terminal `result`, the adapter shall select `DonePayload.resumeToken` for `Cligent` continuity [[engine-5](../engine.md#engine-5)] per [DR-003](../../decisions/003-role-scoped-session-management.md) according to this priority matrix, using the latest backend identifier selected by [[claude-code-51](#claude-code-51)]:

| Available identifier | `resumeToken` |
| --- | --- |
| a backend session identifier observed before or on the result | the latest backend identifier |
| no backend identifier; non-empty inbound `AgentOptions.resume` | the inbound identifier |
| neither; fresh run activity reached the result | the generated SDK `sessionId` from [[claude-code-7](#claude-code-7)] |

### claude-code-26

When an abort causes the adapter to emit terminal `done` with `status: 'interrupted'`, the adapter shall select `DonePayload.resumeToken` according to this continuity matrix:

| Observed before abort | `resumeToken` |
| --- | --- |
| non-system SDK activity and one or more backend session identifiers observed at any point | the latest backend identifier selected by [[claude-code-51](#claude-code-51)] |
| no backend identifier; fresh-run non-system SDK activity | the generated SDK `sessionId` from [[claude-code-7](#claude-code-7)] |
| neither; non-empty inbound `AgentOptions.resume` | the inbound identifier |
| none of the above | omitted |

### Tool Accounting

### claude-code-50

When the adapter emits terminal `done`, it shall set `usage.toolUses` to the number of distinct `toolUseId` values in normalized `tool_use` events observed during the run, ignoring SDK-reported main-loop tool counts and preserving the observed count independently of token and cost accounting.

### Token Accounting

### claude-code-12

When the adapter selects the terminal token source, it shall publish numerically valid [[engine-56](../engine.md#engine-56)] accounting with [[engine-58](../engine.md#engine-58)] coverage according to this authenticity matrix:

| `modelUsage` input | Token outcome |
| --- | --- |
| non-empty non-array object covering main-loop, subagent, and internal inference requests [[3]], with every entry a non-array object carrying finite non-negative safe-integer input, cache-read, cache-creation, and output counters under one or both agreeing aliases, and with every per-record and cross-record sum remaining a safe integer | `coverage: 'complete'` report derived only from that map |
| absent, empty, not a non-array object, any entry or required counter malformed or conflicting across aliases, or any derived sum not a safe integer | omit `tokens` and never promote main-loop `usage` |

### claude-code-29

When the adapter publishes a per-model record from valid `modelUsage`, it shall carry this authentic [[engine-59](../engine.md#engine-59)] record shape:

- camel-case or snake-case SDK token counters map to the same fields;
- inclusive input and output totals;
- exact uncached, cache-read, and cache-write input details;
- the non-empty canonical model and provider when supplied, otherwise the map key and no provider;
- the first finite numeric `costUSD`, then `costUsd`, as `agent-estimate` when that selected value is non-negative;
- a `web_search_request` priced unit from one or both agreeing non-negative safe-integer `webSearchRequests` and `web_search_requests` counters when supplied; and
- omission of absent or malformed optional cost and absent, malformed, or conflicting web-search output without invalidating otherwise valid token counters.

### claude-code-30

Where Claude Code includes reasoning tokens in its inclusive output total without exposing an exact subset, when the adapter publishes token accounting, it shall omit output reasoning detail per [[engine-57](../engine.md#engine-57)], ignoring any per-model `thinkingTokens`, which counts only turns run on a runtime that records it and is therefore absent or partial for a resumed session begun on an older runtime [[7]].

### claude-code-31

When the adapter selects terminal whole-run cost, it shall prefer a finite numeric `total_cost_usd`, then `totalCostUsd`, expose the selected value with [[engine-61](../engine.md#engine-61)] provenance independently under [[engine-62](../engine.md#engine-62)] when it is non-negative even if tokens are absent, and otherwise omit whole-run cost.

## Internal Behavior

### Resume-Repair Signature

### claude-code-28

When the adapter evaluates the internal no-op signature used by [[claude-code-10](#claude-code-10)], it shall ignore `modelUsage` and match exactly when this main-loop counter matrix resolves to zero, treating a valid counter as a finite non-negative safe integer and requiring simultaneous camel- and snake-case aliases to agree:

| Counter | Accepted input |
| --- | --- |
| base input: `inputTokens` / `input_tokens` | one or both aliases present and validly zero |
| output: `outputTokens` / `output_tokens` | one or both aliases present and validly zero |
| cache read: `cacheReadInputTokens` / `cache_read_input_tokens` | absent or validly zero |
| cache creation: `cacheCreationInputTokens` / `cache_creation_input_tokens` | absent or validly zero |
| tools: `toolUses` / `tool_uses` | the greater of distinct observed tool uses and a valid reported count is zero; an absent, malformed, or conflicting reported count falls back to the observed count |

### Session-Identifier Selection

### claude-code-51

When the adapter observes an SDK message, it shall update the current run session identifier according to this selector matrix:

| Message candidates | Outcome |
| --- | --- |
| one or more non-empty values | replace it with the first `sessionId`, then `session_id`, then nested `session.id`, so the latest message carrying a usable identifier wins |
| no non-empty value | retain the current identifier |

### Query Environment

### claude-code-34

When the adapter prepares an SDK query, it shall pass a per-run clone of the caller's process environment with `CLAUDECODE` omitted and no other change than [[claude-code-60](#claude-code-60)]'s subagent-model variables, while leaving the caller's environment unchanged.

### Native Binary Lookup

### claude-code-57

When the adapter locates the native binary the Claude Agent SDK spawns, it shall mirror the SDK's own lookup by resolving each candidate platform package in this order from the SDK's location and selecting the first whose binary exists:

| Host | Candidate packages, in order |
| --- | --- |
| Linux whose process report carries no glibc runtime version (musl) | `@anthropic-ai/claude-agent-sdk-linux-<arch>-musl`, then `@anthropic-ai/claude-agent-sdk-linux-<arch>` |
| any other Linux | `@anthropic-ai/claude-agent-sdk-linux-<arch>`, then `@anthropic-ai/claude-agent-sdk-linux-<arch>-musl` |
| Android | `@anthropic-ai/claude-agent-sdk-linux-<arch>-android` |
| any other platform | `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` |

- The binary is the package's `claude` file, `claude.exe` on Windows.
- The SDK's location is the ESM loader's file resolution of the SDK where available, else the SDK manifest on the adapter's module search paths, canonicalized through symbolic links to the SDK's physical tree.
- Where no candidate's binary exists, the SDK publishes no native binary for the host only when its manifest, the nearest `package.json` at or above the SDK's location, is the SDK's and declares at least one optional dependency, none of them a candidate package; a manifest that is unreadable, is not the SDK's, or declares no optional dependency — the field absent, empty, or not a map — is no such evidence.

## Verification

### claude-code-201

Given the native non-terminal message cases, when the adapter runs, the verification shall assert every event dispatch, assistant field and content-block mapping and order, stream-delta mapping, and native-error payload in [[claude-code-3](#claude-code-3)] and [[claude-code-32](#claude-code-32)].

### claude-code-43

Given the system-message sequences, with and without a message `model` and a requested model, when the adapter runs, the verification shall assert every handshake selection, payload including `reportedModel` presence and absence, and exactly-once outcome in [[claude-code-15](#claude-code-15)].

### claude-code-44

Given the terminal-result cases, when the adapter runs, the verification shall assert every ordered status, diagnostic, result, and duration outcome in [[claude-code-24](#claude-code-24)] and the terminal tool-use count in [[claude-code-50](#claude-code-50)].

### claude-code-45

Given the SDK query failure-phase cases, when the adapter runs without an abort, the verification shall assert every error-message fallback, terminal sequence, and duration outcome in [[claude-code-42](#claude-code-42)] and the terminal tool-use count in [[claude-code-50](#claude-code-50)].

### claude-code-49

Given SDK query invocation, iterator-failure, and iterator-exhaustion exit cases with the mapped controller aborted, when the adapter completes without an SDK terminal result, the verification shall assert the sole interrupted terminal, elapsed duration, result omission, and thrown-value suppression in [[claude-code-48](#claude-code-48)] and the terminal tool-use count in [[claude-code-50](#claude-code-50)].

### claude-code-47

Given prompt and present/absent `AgentOptions` cases, when the adapter invokes the SDK query, the verification shall assert unchanged prompt delivery and every scalar query-option outcome in [[claude-code-46](#claude-code-46)] and [[claude-code-6](#claude-code-6)].

### claude-code-202

Where the Claude Agent SDK is not installed, when `isAvailable()` is called, the verification shall assert that it returns `false` [[claude-code-13](#claude-code-13)].

### claude-code-35

Where an installed package meets the absent-SDK precondition in [[claude-code-202](#claude-code-202)], when a consumer imports the Claude adapter subpath, the verification shall assert that the module loads without resolving the peer [[claude-code-2](#claude-code-2)].

### claude-code-36

Where the absent-SDK precondition in [[claude-code-202](#claude-code-202)] holds, when `run()` is called, the verification shall assert that consumption throws the installation error [[claude-code-14](#claude-code-14)].

### claude-code-58

Given candidate orders for every host row, including this process on Linux with a process report that carries and then lacks a glibc runtime version, fake module trees that link a consumer to an SDK whose platform packages sit only beside its physical location, SDK manifests that name none of the host's candidates, are unreadable, belong to another package, or declare no optional dependencies, and a loadable SDK whose lookup finds or misses the binary, when the lookup runs and `isAvailable()` answers, the verification shall assert every candidate order, selected binary, and publishes-no-binary conclusion in [[claude-code-57](#claude-code-57)] and each loadable-SDK row in [[claude-code-13](#claude-code-13)].

### claude-code-59

Where a loadable SDK's lookup finds no native binary, both on a host the SDK publishes binaries for and on one it publishes none for, when `run()` is consumed, the verification shall assert that it throws before any SDK query with each row's message in [[claude-code-56](#claude-code-56)]:

- the published host's first candidate package, `<platform>-<arch>`, `npm ci` in a checkout, and reinstalling the SDK;
- the unpublished host's `<platform>-<arch>`, with neither `npm ci` nor a reinstall.

### claude-code-203

Given an application configuration selects either representative ordinary effort or `ultracode`, when the runtime constructs and invokes the corresponding `Cligent`, the verification shall assert that the selected row reaches the SDK effort and orchestration surface [[claude-code-8](#claude-code-8)].

### claude-code-204

Given the complete policy-mode, capability-level, tool-category, and callback-decision matrices, when the public permission mapper and any resulting callback run, the verification shall assert every vendor control and decision outcome in [[claude-code-4](#claude-code-4)], [[claude-code-20](#claude-code-20)], and [[claude-code-21](#claude-code-21)].

### claude-code-37

Where the installed Claude Agent SDK declarations and the adapter's public declarations are compiled together, the verification shall assert that the mapped callback is assignable to the SDK's `CanUseTool` contract and resolves only its accepted result union [[claude-code-5](#claude-code-5)].

### claude-code-210

Given fresh and resumed normal-terminal runs with and without backend identifier aliases and replacements, when the adapter completes, the verification shall assert the SDK `sessionId` input, identifier selector in [[claude-code-51](#claude-code-51)], and `DonePayload.resumeToken` output matrix in [[claude-code-7](#claude-code-7)] and [[claude-code-25](#claude-code-25)].

### claude-code-218

Given every Claude effort input, when the adapter maps a run, the verification shall assert this provider-control matrix [[claude-code-8](#claude-code-8)]:

- each supported explicit value produces its exact SDK `effort` and `settings.ultracode` pair;
- omission produces neither SDK field;
- `ultracode` leaves the same permission input's controls unchanged [[claude-code-23](#claude-code-23)]; and
- another adapter's value or an unknown string is rejected before backend invocation with the adapter and allowed values named and, when accompanied by a live caller signal, leaves no caller listener registered after rejection [[claude-code-33](#claude-code-33)].

### claude-code-54

Where `fastMode` omitted, `true`, and `false` are crossed with omitted effort, ordinary effort, and `ultracode`, when the adapter reaches the Claude SDK boundary, the check shall assert [[claude-code-52](#claude-code-52)]'s exact `settings.fastMode`, `settings.ultracode`, and absent `settings.fastModePerSessionOptIn` values in one settings object.

### claude-code-55

Where SDK initialization plus success and error results cover every fast-mode state, every disabled reason, both response speeds with each listed main-loop counter in turn as the sole finite positive value, null and unrecognized speeds, recognized speeds with no finite positive counter across absent, all-zero, and malformed counter sets, cooldown without a reason, and absent members, when the adapter emits unified events, the check shall assert [[claude-code-53](#claude-code-53)]'s exact init and done mappings, served-response-evidence and default-only omissions, verbatim values, and no-request-echo rule.

### claude-code-219

Where a `Cligent` is constructed on the adapter with `CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first to create and then to update a temporary file in a throwaway working directory, the adapter's auto-mode SDK knobs per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) shall let both non-destructive writes proceed without interactive approval [[claude-code-4](#claude-code-4)]:

- the file shall exist with the expected contents after each phase;
- neither stream shall contain `permission_request`, a denied tool result, or an error;
- each stream shall terminate with successful `done`;
- filesystem state shall be the ground-truth assertion, because adapters normalize file edits differently;
- the harness shall retry the complete fresh probe after, and only after, an explicit upstream-overload, rate-limit, or service-unavailable failure, shall make at most two retries, and shall treat any other failure and the third consecutive named transient failure as fatal;
- the leg shall run against the real SDK, which any checkout able to run this suite has installed as a `devDependency`, so SDK absence shall not be a skip condition; the leg shall self-skip, with one stderr diagnostic naming the missing dependency, when the adapter's credential is absent from the environment, shall hard-fail instead under `CI`, and a missing dependency for one adapter shall never skip another's leg.

### claude-code-220

Given the adapter has been aborted, when the run yields terminal `done` with `status: 'interrupted'`, the verification shall assert the identifier selector in [[claude-code-51](#claude-code-51)] and the resume token each observed state requires [[claude-code-26](#claude-code-26)]:

| Observed before abort | `DonePayload.resumeToken` |
| --- | --- |
| non-system SDK activity and one or more backend session identifiers observed during the run | the latest observed backend identifier |
| no backend identifier and a non-empty `AgentOptions.resume` value | the inbound `resume` value |
| no `AgentOptions.resume` and no non-system SDK activity | omitted, a generated SDK `sessionId` having been passed |
| no `AgentOptions.resume` and non-system SDK activity | the SDK-provided or generated SDK `sessionId` |

### claude-code-222

Given absent, empty, valid, and invalid `writablePaths` cases across the permission-control matrix, when the adapter maps each policy, the verification shall assert omission, canonical ambient output, or rejection and preservation of every control selected by [[claude-code-19](#claude-code-19)] and [[claude-code-4](#claude-code-4)].

### claude-code-38

Given the continuation-repair cases, when the adapter consumes each SDK stream, the verification shall assert this result matrix:

- every qualifying result before resumed-turn activity is skipped until a non-qualifying terminal result arrives [[claude-code-10](#claude-code-10)], with only main-loop counters deciding the signature [[claude-code-28](#claude-code-28)];
- the same qualifying result on a fresh run or after `text`, `text_delta`, `thinking`, or orphan `tool_result` activity terminates successfully and stops consumption [[claude-code-10](#claude-code-10)];
- an observed `tool_use` makes the zero signature fail and routes the result through ordinary terminal normalization [[claude-code-28](#claude-code-28)], [[claude-code-24](#claude-code-24)].

### claude-code-39

Given every absent, already-aborted, later-aborted, completed-run, and multiple-run signal case, when the adapter reaches the SDK query boundary, the verification shall assert every controller, propagation, cleanup, and isolation outcome in [[claude-code-33](#claude-code-33)].

### claude-code-40

Given a caller environment containing `CLAUDECODE` and unrelated values, when the adapter reaches the SDK query boundary on successive runs, the verification shall assert each query receives its own clone without `CLAUDECODE`, all other values survive, and the caller environment remains unchanged [[claude-code-34](#claude-code-34)].

### claude-code-41

Given a non-aborted SDK stream with no terminal result, when the stream ends, the verification shall assert the exact `MISSING_RESULT` payload followed by terminal error with elapsed duration and no result or resume token, including after one or more skipped internal no-op results [[claude-code-18](#claude-code-18)], with the terminal tool-use count from [[claude-code-50](#claude-code-50)].

### claude-code-229

Given every allowlist and denylist presence case, when the adapter maps a run, the verification shall assert this raw-list provider-control matrix [[claude-code-9](#claude-code-9)], [[claude-code-22](#claude-code-22)]:

| Tool-list input | Observable SDK options |
| --- | --- |
| neither list supplied | allowlist controls and `disallowedTools` are `undefined` |
| explicit empty `allowedTools` | `tools: []`, `allowedTools: []`, and `settingSources: []` |
| non-empty `allowedTools` | raw list in `tools` and `allowedTools`, and `settingSources: undefined` |
| `disallowedTools` supplied with or without an allowlist | raw denylist passed through with deny precedence |

### claude-code-71

Given no caller MCP servers or browser and `allowedTools` omitted, empty, and non-empty, each crossed with effort omitted and `ultracode` and with `fastMode` omitted and `true`, when the adapter reaches the SDK query boundary, the verification shall assert `strictMcpConfig: true`, no `mcpServers` key, and `settings.disableClaudeAiConnectors: true` beside the effort and fast-mode keys in one settings object, with `settingSources` as the allowlist alone selects it [[claude-code-70](#claude-code-70)].

### claude-code-240

Given authentic zero, nonzero, absent, and malformed terminal accounting, when a caller reads `usage`, the verification shall assert this output matrix:

- valid `modelUsage` produces complete whole-agent-tree totals and one authentic record per model [[claude-code-12](#claude-code-12)], [[claude-code-29](#claude-code-29)];
- records omit reasoning detail, including where `modelUsage` carries `thinkingTokens` [[claude-code-30](#claude-code-30)];
- whole-run and per-model cost preserve finite non-negative USD estimates, including present zero and absent cost, and whole-run cost survives absent tokens [[claude-code-29](#claude-code-29)], [[claude-code-31](#claude-code-31)];
- `web_search_request` quantities preserve zero and nonzero values [[claude-code-29](#claude-code-29)]; and
- absent, empty, or malformed `modelUsage` omits tokens and never promotes main-loop usage [[claude-code-12](#claude-code-12)], while observed tool uses remain independently preserved [[claude-code-50](#claude-code-50)].

### claude-code-64

Where `subagentModel` and `subagentEffort` take each combination below, with and without caller-environment values of both variables, when the adapter reaches the SDK query boundary, the verification shall assert this matrix:

| `subagentModel` and `subagentEffort` | Assertion |
| --- | --- |
| both omitted | both variables keep the caller environment's value or absence [[claude-code-60](#claude-code-60)]; no `systemPrompt` key and no `agents` key is passed [[claude-code-61](#claude-code-61)], [[claude-code-62](#claude-code-62)], [[claude-code-67](#claude-code-67)]; the serialized query options equal those of the same input without either key |
| model ID, effort omitted | `CLAUDE_CODE_SUBAGENT_MODEL` equals the ID verbatim and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` equals `'1'`, replacing caller values [[claude-code-60](#claude-code-60)]; `systemPrompt` is the custom, unsnapshotted prompt whose text is exactly the directive naming the ID and leaving the effort to the agent [[claude-code-61](#claude-code-61)], [[claude-code-62](#claude-code-62)]; `agents` holds exactly the five `delegate-<effort>` definitions on the ID with their descriptions, prompt, and efforts, then `general-purpose` without a model at `medium` with the delegate prompt and its description naming the ID and pointing to the `delegate-<effort>` types, and no `Explore` or `Plan` key [[claude-code-67](#claude-code-67)] |
| `inherit`, effort omitted | `CLAUDE_CODE_SUBAGENT_MODEL` is absent even where the caller sets it and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` equals `'1'` [[claude-code-60](#claude-code-60)]; the directive names the agent's own model [[claude-code-61](#claude-code-61)]; the five `delegate-<effort>` definitions carry `model: 'inherit'`, and they and `general-purpose` at `medium` carry "your model" descriptions [[claude-code-67](#claude-code-67)] |
| model ID, effort `high` | the variables as for the ID alone [[claude-code-60](#claude-code-60)]; the directive pins the ID at `high` effort [[claude-code-61](#claude-code-61)]; `agents` holds exactly `delegate` on the ID and `general-purpose` without a model, both at `high` with their descriptions and the delegate prompt, and no `Explore` or `Plan` key [[claude-code-67](#claude-code-67)] |
| `inherit`, effort `minimal` | the variables as for `inherit` alone [[claude-code-60](#claude-code-60)]; the directive and both definitions name `low`, the SDK effort of `minimal`, the descriptions naming "your model" [[claude-code-61](#claude-code-61)], [[claude-code-67](#claude-code-67)] |
| any | the caller environment remains unchanged and no other clone value differs from it apart from the omitted `CLAUDECODE` [[claude-code-34](#claude-code-34)] |

### claude-code-65

Where a consumer imports the adapter module, the verification shall assert [[claude-code-63](#claude-code-63)]'s exports: `subagentDirective(selection)` equals the exact [[claude-code-61](#claude-code-61)] directive for each of the four model-and-effort combinations, and for a bare model string equals the directive for `{ model }`; `composeClaudeSystemPrompt(parts)` returns `undefined` for no part, the custom unsnapshotted prompt for one part, and for a caller part followed by the directive a prompt that keeps that order with one blank line between them [[claude-code-62](#claude-code-62)].

### claude-code-66

Under [[claude-code-219](#claude-code-219)]'s real-run harness, where `ANTHROPIC_API_KEY` is available, when a `Cligent` on the adapter runs with `subagentModel: 'claude-haiku-4-5'`, a non-Haiku main `model`, a permission policy denying file writes, shell execution, and network access, and a prompt directing one `general-purpose` Agent-tool subagent, asked for with the competing per-call model `sonnet`, to read a one-word file with the Read tool and return its contents, the acceptance check shall assert [[claude-code-60](#claude-code-60)]'s effect on a real run through these conditions:

- a successful terminal `done` whose result carries the word;
- every Agent-tool call's input carrying `sonnet` or no model, never a Haiku one, so that a Haiku subagent frame can come only from the environment pair and not from the main agent's own choice, with the observed per-call models written to stderr;
- at least one SDK assistant frame produced inside the subagent, each naming a Haiku model;
- terminal usage records that name a Haiku model.

### claude-code-68

Under [[claude-code-66](#claude-code-66)]'s harness, key, and permission policy, with a `PreToolUse` hook the harness adds to the tapped query recording each tool call's agent type and effort level, when a `Cligent` on the adapter runs with main `model: 'claude-sonnet-5-5'` and a prompt asking for exactly one Agent-tool subagent, naming no subagent type, to read a one-word file with the Read tool and return its contents, the acceptance check shall assert a successful terminal `done` whose result carries the word, write the named subagent types, the observed tool calls, and the subagent models to stderr, and assert this matrix:

| `subagentModel` and `subagentEffort` | Assertion |
| --- | --- |
| `claude-haiku-4-5`, `low` | every tool call inside a subagent reports a pinned definition's agent type, `delegate` or `general-purpose`, or an `Explore` or `Plan` type an Agent call named; where an Agent call omits the type, a `general-purpose` subagent runs, the pin such a call lands on [[claude-code-67](#claude-code-67)]; every SDK assistant frame inside the subagent names a Haiku model [[claude-code-60](#claude-code-60)] |
| `claude-haiku-4-5`, omitted | every tool call inside a subagent reports one of the five `delegate-<effort>` agent types, or `general-purpose`, the replacement a call naming no type lands on [[claude-code-67](#claude-code-67)]; every subagent frame names a Haiku model [[claude-code-60](#claude-code-60)] |
| `inherit`, omitted, with main `effort: 'high'` | every tool call inside a subagent reports one of the five `delegate-<effort>` agent types at that effort level, or `general-purpose`, where a call naming no type lands, at `medium`, so none runs at the agent's `high` unless its Agent call chose `delegate-high` [[claude-code-67](#claude-code-67)]; every subagent frame names a Sonnet model [[claude-code-60](#claude-code-60)] |

### claude-code-69

Under [[claude-code-68](#claude-code-68)]'s harness and hook, when a `Cligent` on the adapter runs with main `model: 'claude-sonnet-5-5'`, `effort: 'high'`, `subagentModel: 'inherit'`, and `subagentEffort: 'low'`, and a prompt directing one `general-purpose` and then one `Explore` Agent-tool subagent, each by its subagent type, to read the one-word file and reply with a `TOOLS:` line naming every tool available to it and then the word, the acceptance check shall assert that a pinned effort replaces `general-purpose` alone, as Claude Code 2.1.284 lets a registered definition replace a built-in one by name, through these conditions:

- a successful terminal `done` whose result carries the word;
- Agent-tool calls naming both `general-purpose` and `Explore`;
- every tool call inside a `general-purpose` subagent reporting effort `low`, the pinned effort of its replacing definition [[claude-code-67](#claude-code-67)];
- every tool call inside an `Explore` subagent reporting effort `high`, the main agent's, no definition replacing that built-in [[claude-code-67](#claude-code-67)];
- the `TOOLS:` line of the reply each Agent call returns, read from the raw stream, naming `Read` and neither `Write` nor `Edit` for `Explore`, its built-in read-only restrictions intact, and both for `general-purpose` [[claude-code-67](#claude-code-67)];
- every subagent frame naming a Sonnet model, the model [[claude-code-60](#claude-code-60)]'s environment binds;
- the observed types, levels, and listed tools written to stderr.

### claude-code-72

Given temporary image and PDF files and absent, empty, invalid, unsupported, and valid attachments, when `Cligent` runs through the adapter and the installed Claude SDK against a recording CLI fixture, verification shall assert [[claude-code-46](#claude-code-46)]'s content, byte encoding, order, unchanged text-only transport, resumed transport, and refusal before SDK invocation, and [[claude-code-73](#claude-code-73)]'s interrupted terminal before attachment submission.

### claude-code-75

Given caller stdio and HTTP servers and native user-message tool results, when a `Cligent` run crosses the installed SDK serialization boundary with a recording CLI fixture, integration verification shall assert explicit configuration and server-scoped approval [[claude-code-74](#claude-code-74)], unchanged connector and ambient-source confinement [[claude-code-70](#claude-code-70)], tool-name correlation, raw screenshot bytes, media emission order, orphan results, native errors, and suppression of ordinary or replayed user messages [[claude-code-3](#claude-code-3)], together with rejection of incompatible allowlists before browser preparation or SDK loading [[claude-code-74](#claude-code-74)] and the selected-server initialization status matrix [[claude-code-77](#claude-code-77)].

### claude-code-76

Given the installed native Claude SDK and CLI, packaged managed browser runtime, and a loopback model API fixture with isolated configuration and fake credentials, when a `Cligent` browser run navigates to a loopback page and captures a screenshot, acceptance verification shall assert native server admission and scoped tool approval [[claude-code-74](#claude-code-74)], successful tool-result correlation and a PNG media event [[claude-code-3](#claude-code-3)], the same screenshot in a subsequent native model request, and the final explanation in the ordinary terminal result [[claude-code-10](#claude-code-10)].

## References

[1]: https://platform.claude.com/docs/en/build-with-claude/effort "Claude effort parameter"
[2]: https://code.claude.com/docs/en/workflows#let-claude-decide-with-ultracode "Claude Code workflows: let Claude decide with ultracode"
[3]: https://code.claude.com/docs/en/agent-sdk/cost-tracking "Claude Code cost and usage tracking"
[4]: https://code.claude.com/docs/en/fast-mode "Claude Code fast mode"
[5]: https://code.claude.com/docs/en/agent-sdk/typescript "Claude Agent SDK TypeScript reference"
[6]: https://platform.claude.com/docs/en/build-with-claude/fast-mode#checking-which-speed-was-used "Checking which Claude serving speed was used"
[7]: https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.284/sdk.d.ts "Claude Agent SDK 0.3.284 declarations"
[8]: https://unpkg.com/@anthropic-ai/sdk@0.98.0/resources/beta/messages/messages.d.ts "Anthropic TypeScript SDK 0.98.0 beta message declarations"
[9]: https://code.claude.com/docs/en/sub-agents "Claude Code subagents"
[10]: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode "Claude Agent SDK streaming input and image attachments"
[11]: https://code.claude.com/docs/en/agent-sdk/mcp "Claude Agent SDK explicit MCP servers and scoped tool approvals"
