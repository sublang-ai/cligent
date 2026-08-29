<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# claude-code: Claude Code Adapter

## Intent

This package lets a consumer of the agent-adapter contract run Claude Code through the `@anthropic-ai/claude-agent-sdk`, per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md).
It owns how a portable request becomes an SDK query and how that query's stream becomes unified events, permission decisions, resume continuity, and token accounting, not what a caller does with them and not the SDK's own behavior.
Its requirements are stated in this project's `AgentAdapter`, `AgentEvent`, `AgentOptions`, `PermissionPolicy`, `DonePayload`, and `Cligent` vocabulary, which the engine defines and without which this adapter's behavior cannot be stated.

## External Behavior

### Adapter Identity

### claude-code-1

The adapter shall implement `AgentAdapter` with `agent: 'claude-code'`.

### SDK Loading

### claude-code-2

Where the Claude Agent SDK is not installed, the adapter module shall remain importable so consumers can register it unconditionally.

### claude-code-13

Where the Claude Agent SDK is missing under [[engine-26](../engine.md#engine-26)] runtime readiness, when `isAvailable()` is called, the adapter shall return `false`.

### claude-code-14

Where the Claude Agent SDK is not installed, when `run()` is called, the adapter shall throw `ClaudeCodeAdapter requires @anthropic-ai/claude-agent-sdk. Install it to use this adapter.`.

### Event Normalization

### claude-code-3

When the adapter normalizes a non-terminal, non-system SDK message, it shall yield `AgentEvent` values according to this dispatch matrix:

| SDK Message | AgentEvent |
| --- | --- |
| `assistant` | each event selected by the ordered assistant mapping below |
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

- A `tool_result` selects `toolUseId` from the first non-empty `toolUseId`, `tool_use_id`, and `id`, or generates one through [[engine-7](../engine.md#engine-7)]; selects `toolName` from non-empty `name`, then `toolName`, or `unknown_tool`; selects output from the first non-nullish `output`, `result`, and `content`, or `null`; and selects numeric duration from `durationMs`, then `duration_ms`, or omits it.
- Its status is `denied` for case-insensitive source status `denied`, otherwise `error` for `isError: true`, `is_error: true`, or case-insensitive source status `error`, and otherwise `success`.

### claude-code-32

When the adapter normalizes an SDK `error` message, it shall select its payload according to this field-priority matrix:

| Payload member | First available value |
| --- | --- |
| `code` | non-empty top-level `code`, nested `error.code`, nested `error.type`, otherwise omitted |
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

- An emitted `init` selects model from non-empty message `model`, requested model, then `unknown`; selects cwd from non-empty message `cwd`, requested cwd, then the process cwd; and retains each non-empty string tool or object tool name.

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

When `run(prompt, options)` invokes the SDK query, the adapter shall pass `prompt` through unchanged.

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

When the adapter maps `AgentOptions.allowedTools` under the portable tool restriction in [[engine-17](../engine.md#engine-17)], it shall preserve the raw list and apply the provider controls in this matrix, which isolates only the ambient sources those controls cover and makes no claim about other provider context:

| `allowedTools` input | SDK controls |
| --- | --- |
| omitted | leave `tools`, `allowedTools`, `settingSources`, and `strictMcpConfig` `undefined`, preserving native tool, MCP, and settings behavior |
| empty | `tools: []`, `allowedTools: []`, `settingSources: []`, and `strictMcpConfig: true` |
| non-empty | copy the list to `tools`, pass it to `allowedTools`, set `strictMcpConfig: true`, and leave `settingSources` `undefined` |

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

- A synthesized `error` uses its non-empty subtype or `CLAUDE_CODE_RESULT_ERROR` as code, joins non-empty `errors` entries as its message before falling back to non-empty `result`, subtype, and `Claude Code SDK error`, and carries `recoverable: false`.
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

Where Claude Code includes reasoning tokens in its inclusive output total without exposing the subset, when the adapter publishes token accounting, it shall omit output reasoning detail per [[engine-57](../engine.md#engine-57)].

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

When the adapter prepares an SDK query, it shall pass a per-run clone of the caller's process environment with `CLAUDECODE` omitted while leaving the caller's environment unchanged.

## Verification

### claude-code-201

Given the native non-terminal message cases, when the adapter runs, the verification shall assert every event dispatch, assistant field and content-block mapping and order, stream-delta mapping, and native-error payload in [[claude-code-3](#claude-code-3)] and [[claude-code-32](#claude-code-32)].

### claude-code-43

Given the system-message sequences, when the adapter runs, the verification shall assert every handshake selection, payload, and exactly-once outcome in [[claude-code-15](#claude-code-15)].

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

### claude-code-219

Where a `Cligent` is constructed on the adapter with `CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first to create and then to update a temporary file in a throwaway working directory, the adapter's auto-mode SDK knobs per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) shall let both non-destructive writes proceed without interactive approval [[claude-code-4](#claude-code-4)]:

- the file shall exist with the expected contents after each phase;
- neither stream shall contain `permission_request`, a denied tool result, or an error;
- each stream shall terminate with successful `done`;
- filesystem state shall be the ground-truth assertion, because adapters normalize file edits differently;
- the harness shall retry the complete fresh probe after, and only after, an explicit upstream-overload, rate-limit, or service-unavailable failure, shall make at most two retries, and shall treat any other failure and the third consecutive named transient failure as fatal;
- the leg shall run against the real SDK, which any checkout able to run this suite has installed as a `devDependency`, so SDK absence shall not be a skip condition; the leg shall self-skip when the adapter's credential is absent from the environment, shall hard-fail instead under `CI`, and a missing dependency for one adapter shall never skip another's leg.

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
| explicit empty `allowedTools` | `tools: []`, `allowedTools: []`, `settingSources: []`, and `strictMcpConfig: true` |
| non-empty `allowedTools` | raw list in `tools` and `allowedTools`, `strictMcpConfig: true`, and `settingSources: undefined` |
| `disallowedTools` supplied with or without an allowlist | raw denylist passed through with deny precedence |

### claude-code-240

Given authentic zero, nonzero, absent, and malformed terminal accounting, when a caller reads `usage`, the verification shall assert this output matrix:

- valid `modelUsage` produces complete whole-agent-tree totals and one authentic record per model [[claude-code-12](#claude-code-12)], [[claude-code-29](#claude-code-29)];
- records omit reasoning detail [[claude-code-30](#claude-code-30)];
- whole-run and per-model cost preserve finite non-negative USD estimates, including present zero and absent cost, and whole-run cost survives absent tokens [[claude-code-29](#claude-code-29)], [[claude-code-31](#claude-code-31)];
- `web_search_request` quantities preserve zero and nonzero values [[claude-code-29](#claude-code-29)]; and
- absent, empty, or malformed `modelUsage` omits tokens and never promotes main-loop usage [[claude-code-12](#claude-code-12)], while observed tool uses remain independently preserved [[claude-code-50](#claude-code-50)].

## References

[1]: https://platform.claude.com/docs/en/build-with-claude/effort "Claude effort parameter"
[2]: https://code.claude.com/docs/en/workflows#let-claude-decide-with-ultracode "Claude Code workflows: let Claude decide with ultracode"
[3]: https://code.claude.com/docs/en/agent-sdk/cost-tracking "Claude Code cost and usage tracking"
