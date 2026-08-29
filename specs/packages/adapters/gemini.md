<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# gemini: Gemini CLI Adapter

## Intent

This package lets a consumer of the agent-adapter contract run Gemini CLI as a spawned child process whose NDJSON stream becomes unified events, per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md).
It owns how a portable request becomes a Gemini CLI invocation and how that invocation's stream, exit code, policy files, and telemetry become unified events, permission rules, resume continuity, and token accounting, not what a caller does with them and not the CLI's own behavior.
Its requirements are stated in this project's `AgentAdapter`, `AgentEvent`, `AgentOptions`, `PermissionPolicy`, `DonePayload`, and `Cligent` vocabulary, which the engine defines and without which this adapter's behavior cannot be stated.

## External Behavior

### Adapter Identity

### gemini-1

The adapter shall implement `AgentAdapter` with `agent: 'gemini'`.

### gemini-18

The adapter module shall load without a Gemini SDK package, because it communicates with the `gemini` executable.

### Availability

### gemini-2

When `isAvailable()` uses the adapter's default probe, it shall classify the `gemini` executable through this matrix:

| Probe outcome | Result |
| --- | --- |
| `gemini --version` succeeds within 5,000 ms and [[engine-25](../engine.md#engine-25)] does not find the reported version below the supported floor | `true` |
| the executable is missing, exits nonzero, times out, or reports a version below that floor | `false` |

### Process Lifecycle

### gemini-3

When `run()` starts Gemini CLI, the adapter shall execute one headless stream invocation according to this flow:

1. Spawn `gemini` with `--output-format`, `stream-json`, and the option arguments selected by [[gemini-7](#gemini-7)].
2. Put the arbitrary prompt in the final joined token `--prompt=<prompt>`, so Gemini CLI 0.50 does not reinterpret a leading-dash prompt as an option [[4]].
3. Pipe stdout through `parseNDJSON()` per [[ndjson-1](../ndjson.md#ndjson-1)].

### gemini-19

While no native `result` has selected a terminal and the run is not aborted, when settings or policy setup rejects, spawn throws synchronously, the child exposes no stdout, the child reports an asynchronous launch error, or stdout iteration throws, the adapter shall emit `init` first if needed, then a non-recoverable `error` with code `GEMINI_STREAM_ERROR` and the thrown `Error` message or `Gemini adapter failed while reading stream`, followed by terminal `done` with `status: 'error'`, the normal-terminal resume selection in [[gemini-9](#gemini-9)], elapsed duration, usage containing only [[gemini-27](#gemini-27)]'s tool count, and no result.

### gemini-5

While no native `result` has selected a terminal, when the child closes normally, the adapter shall select its terminal outcome from this matrix, using elapsed duration, the resume token in [[gemini-9](#gemini-9)], and usage containing only [[gemini-27](#gemini-27)]'s tool count in every row:

| Close state | Terminal outcome |
| --- | --- |
| the run requested abort, or signal is `SIGTERM` | `done.status: 'interrupted'`; omit the result even when trimmed stderr is non-empty [[gemini-8](#gemini-8)] |
| code `0` | `done.status: 'success'`; trimmed stderr, when non-empty, is the result |
| code `53` | `done.status: 'max_turns'`; trimmed stderr, when non-empty, is the result |
| code `1`, code `42`, another nonzero or null code, or any other signal | a non-recoverable `GEMINI_EXIT_ERROR` followed by `done.status: 'error'`, both carrying trimmed stderr or `Gemini CLI exited with code <code-or-null> without a result event` |

### Environment

### gemini-10

When the adapter builds the child environment, it shall select `GEMINI_CLI_TRUST_WORKSPACE` from this matrix:

| Parent environment | Child value |
| --- | --- |
| variable absent | `'true'` |
| variable present, including `'false'` or an empty string | the existing value unchanged |

### Event Normalization

### gemini-4

When the adapter receives a parsed Gemini stream object before a terminal has been selected, it shall dispatch it according to this matrix:

| Non-empty `type` | Outcome |
| --- | --- |
| `init` | the handshake selected by [[gemini-20](#gemini-20)] |
| `message` | the text selection in [[gemini-21](#gemini-21)] |
| `tool_use` or `tool_call_request` | one `tool_use` selected by [[gemini-22](#gemini-22)] |
| `tool_result` or `tool_call_response` | one `tool_result` selected by [[gemini-23](#gemini-23)] |
| `error` | one `error` selected by [[gemini-24](#gemini-24)] |
| `result` | the terminal selection in [[gemini-25](#gemini-25)] |
| absent, empty, non-string, or any other value | no event beyond any first-event `init` that [[gemini-20](#gemini-20)] requires for a non-empty unknown type |

### gemini-20

When a run selects its `init`, the adapter shall emit exactly one handshake according to this matrix, with tools and capabilities selected by [[gemini-16](#gemini-16)]:

| Stream state | Emission and payload |
| --- | --- |
| first parsed object is native `init` | emit from that object |
| first non-empty native type is not `init`, including an unknown type | emit before dispatching that object |
| malformed input arrives before any native event | emit before its recoverable error |
| stream closes or fails before any event | synthesize before the terminal path |
| an `init` was already emitted | suppress every later native `init` |

- The model is the requested model when present, otherwise the first non-empty source `model`, otherwise `unknown`.
- The cwd is the requested cwd when present, otherwise the first non-empty source `cwd`, otherwise the process cwd.
- The handshake carries the session identifier selected by [[gemini-43](#gemini-43)].

### gemini-21

When a native `message` is dispatched, the adapter shall emit `text` from the first non-empty string among `content`, `text`, and `message`, or emit no text when none exists.

### gemini-22

When a native tool-use event is dispatched, the adapter shall select its unified payload from this matrix:

| Payload member | Selection |
| --- | --- |
| nested container | first object-valued `value.functionCall`, `value.function_call`, top-level `functionCall`, top-level `function_call`, or `value`; top-level payload fields still take priority in the member rows below |
| `toolName` | first non-empty top-level `toolName`, `tool_name`, or `name`, then nested `name`, `toolName`, or `tool_name`, otherwise `unknown_tool` |
| `toolUseId` | first non-empty top-level `toolUseId`, `tool_id`, `id`, or `callId`, then nested `callId`, `id`, or `tool_id`, otherwise an identifier generated through [[engine-7](../engine.md#engine-7)] |
| `input` source | first non-nullish top-level `input`, `parameters`, `args`, or `arguments`, then nested `args`, `parameters`, or `input` |
| non-null object input, including an array | that value |
| string input containing a JSON object or array | the parsed value |
| malformed string input | `{ raw: <input> }` |
| every other input | `{}` |

### gemini-23

When a native tool-result event is dispatched, the adapter shall select its unified payload from this matrix:

| Payload member | Selection |
| --- | --- |
| nested container | first object-valued `value.functionResponse`, `value.function_response`, top-level `functionResponse`, top-level `function_response`, or `value`; top-level payload fields still take priority in the member rows below |
| `toolName` | first non-empty top-level `toolName`, `tool_name`, or `name`, then nested `name`, `toolName`, or `tool_name`, otherwise `unknown_tool` |
| `toolUseId` | first non-empty top-level `toolUseId`, `tool_id`, `id`, or `callId`, then nested `callId`, `id`, or `tool_id`, otherwise an identifier generated through [[engine-7](../engine.md#engine-7)] |
| status source | non-empty top-level `status`, otherwise non-empty nested `status`, compared case-insensitively |
| `status: 'denied'` | source status is `denied`, taking precedence over every error flag |
| `status: 'error'` | top-level `isError` or `is_error` is `true`, nested `isError` is `true`, or source status is `error` |
| `status: 'success'` | every other state |
| `output` | first non-nullish top-level `output`, `result`, or `content`, then nested `output`, `result`, or `response`, otherwise `null` |
| `durationMs` | first finite top-level `durationMs` or `duration_ms`, otherwise omitted |

### gemini-24

When a native `error` event is dispatched, the adapter shall select its unified payload from this matrix:

| Payload member | Selection |
| --- | --- |
| `code` | non-empty top-level `code`, nested `error.code`, nested `error.type`, otherwise omitted |
| `message` | non-empty top-level `message`, nested `error.message`, otherwise `Gemini CLI error` |
| `recoverable` | `true` when top-level or nested-error `recoverable` or `retryable` is `true`, otherwise `false` |

### gemini-25

When the first native `result` is dispatched, the adapter shall ignore later parsed input, wait for child close, and then emit exactly one `done`, preceded by an `error` only for an error-classified result, according to this matrix:

| Selection | Outcome |
| --- | --- |
| status absent, empty, non-string, `success`, `completed`, `ok`, or unrecognized | `done.status: 'success'` |
| status `interrupted`, `cancelled`, or `aborted` | `done.status: 'interrupted'` |
| status `max_turns` or `maxturns` | `done.status: 'max_turns'` |
| status `max_budget`, `maxbudget`, or `budget_exceeded` | `done.status: 'max_budget'` |
| status `error` or `failed` | `done.status: 'error'` and a preceding error selected by the candidate row below |
| result-error candidate | first non-empty nested `error.message`, top-level `errorMessage`, or top-level `result` determines whether the ordinary [[gemini-24](#gemini-24)] payload is used; without a candidate, use code `GEMINI_RESULT_ERROR` and a diagnostic containing the raw error, result, and status |
| `result` | first non-empty top-level `result`, then nested `error.message`, otherwise omitted |
| `durationMs` | first finite top-level `durationMs`, then `duration_ms`, otherwise elapsed run time |
| `resumeToken` | the terminal selection in [[gemini-9](#gemini-9)] |
| `usage` | [[gemini-27](#gemini-27)]'s tool count plus the token report selected by [[gemini-17](#gemini-17)] |
| non-aborted stream failure after this result but before close | preserve the selected result terminal and omit tokens |

Status comparisons are case-insensitive.

### gemini-26

When `parseNDJSON()` yields `{ ok: false }` before a terminal is selected per [[ndjson-4](../ndjson.md#ndjson-4)], the adapter shall emit `init` first if needed, then a recoverable `error` with code `NDJSON_PARSE_ERROR` and a message containing the parser diagnostic and raw line, and continue consuming the stream.

### gemini-27

When the adapter emits any terminal `done`, it shall set `usage.toolUses` to the number of distinct identifiers selected for native tool-use events by [[gemini-22](#gemini-22)], ignoring provider-reported counts and preserving the observed count when tokens are absent.

### Permission Mapping

### gemini-6

Where a supplied `PermissionPolicy` has `mode` omitted, the adapter shall map its capability levels to non-interactive User-tier Gemini Policy Engine rules per [[3]] and this matrix:

| Capability | Current built-in tools |
| --- | --- |
| `fileWrite` | `replace`, `write_file` |
| `shellExecute` | `run_shell_command` |
| `networkAccess` | `google_web_search`, `web_fetch` |

| Level | Rule outcome |
| --- | --- |
| `allow` | `decision = "allow"`, priority 997 |
| `ask`, or omitted inside the supplied policy | `decision = "ask_user"`, priority 997, which denies in headless mode |
| `deny` | `decision = "deny"`, priority 999 |

### gemini-12

When the adapter maps the closed `PermissionPolicy.mode` set in [[engine-21](../engine.md#engine-21)] under [[engine-52](../engine.md#engine-52)] per [DR-005](../../decisions/005-per-adapter-permission-configuration.md), it shall select the provider controls from this exhaustive matrix:

| Policy input | Approval and capability outcome |
| --- | --- |
| `permissions` absent | no approval-mode or capability rules; when tool lists are also absent, no generated policy or `--policy`, preserving Gemini's native defaults and discovered user policies |
| supplied policy with mode omitted, including `{}` | no approval-mode flag; capability rules from [[gemini-6](#gemini-6)], with every omitted level treated as `ask` |
| `mode: 'auto'`, with any capability levels | `--approval-mode yolo`; ignore capability fields, adding no Cligent-selected capability grant; absent tool lists leave no policy rules or file |
| `mode: 'bypass'`, with any capability levels | `--approval-mode yolo`, Gemini exposing no distinct bypass tier; ignore capability fields; absent tool lists leave no policy rules or file |

Independently supplied tool lists compose with every row through [[gemini-29](#gemini-29)].

### gemini-29

Where either tool-list option is supplied, the adapter shall map the effective list to Policy Engine rules and init metadata according to this matrix per [[engine-17](../engine.md#engine-17)]:

| Input | Outcome |
| --- | --- |
| `allowedTools` absent | capability allows may populate the configured tool set; no catch-all list rule |
| `allowedTools` present | de-duplicate and sort its entries, remove every denied entry, emit priority-999 allows for the survivors, then a priority-998 catch-all deny even when no survivor remains; capability allows do not widen the list |
| `disallowedTools` present or capability denial applies | de-duplicate and sort the union, emit priority-999 denies before same-priority allows, and remove denied names from the effective allowlist |

### gemini-30

Where Gemini exposes no independently active supported filesystem-sandbox write-grant surface, when the adapter maps `PermissionPolicy.writablePaths` per [[engine-53](../engine.md#engine-53)] and [[engine-54](../engine.md#engine-54)], it shall produce this matrix without changing the tool-list, capability, or approval-mode outcome:

| Input | Outcome |
| --- | --- |
| absent or empty | omit `WritablePathsPermissionMapping` |
| valid non-empty entries | canonical paths with `enforcement: 'ambient'` |
| any invalid entry | reject before spawn |

### gemini-13

Where a user-provided tool name is empty, contains Gemini Policy Engine wildcard syntax `*`, or contains an unpaired Unicode surrogate, the adapter shall reject it before spawn with an error naming the offending option and index.

### gemini-31

When an accepted tool name is written to a generated policy, the adapter shall encode it as a valid TOML basic string, escaping quotes, backslashes, controls, and DEL (`U+007F`) while preserving valid Unicode.

### gemini-14

Where mapping generates at least one Policy Engine rule, the adapter shall deliver a per-run User-tier `--policy=<path>` file whose every rule has `interactive = false`, with policy delivery itself leaving system settings and system-defaults paths unchanged and installed Admin-tier authority intact.

### gemini-32

When `run()` maps permission controls, the adapter shall emit neither deprecated `--allowed-tools` arguments nor deprecated `tools.exclude` settings.

### Options Mapping

### gemini-7

When the adapter maps ordinary `AgentOptions` to Gemini arguments and process options, it shall select this matrix:

| Option | Outcome |
| --- | --- |
| absent or empty `model` | no model argument |
| non-empty `model` without an effort alias from [[gemini-11](#gemini-11)] | one joined `--model=<model>` token |
| matching effort alias | one joined `--model=cligent-reasoning-effort` token |
| non-empty `resume` | one joined `--resume=<token>` token |
| absent or empty `resume` | no resume argument and the fresh-run identity from [[gemini-43](#gemini-43)] |
| `cwd` | child working directory, otherwise the spawn default |
| any `maxTurns` or `maxBudgetUsd` | no vendor control, including no `--max-session-turns`, because Gemini exposes no compatible mapped limit on this surface |

### gemini-11

Per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), where a portable `AgentOptions.effort` is provided, the adapter shall select its per-run Gemini model alias and thinking control from these matrices per [[1]] and [[2]]:

| Model condition | Outcome |
| --- | --- |
| concrete ID matching `^gemini-3` | unique self-contained alias retaining the original model and carrying mapped `thinkingLevel` |
| concrete ID matching `^gemini-2\.5` | unique self-contained alias retaining the original model and carrying mapped `thinkingBudget` |
| model unset, a CLI alias such as `auto`, `pro`, `flash`, `flash-lite`, or `chat-base*`, or another non-matching value | no effort alias; preserve ordinary model forwarding and ignore effort for that call |

| Gemini 3 effort | `thinkingLevel` |
| --- | --- |
| `minimal` | `MINIMAL` |
| `low` | `LOW` |
| `medium` | `MEDIUM` |
| `high`, `xhigh`, or `max` | `HIGH`, the nearest supported ceiling per [[engine-42](../engine.md#engine-42)] |

| Gemini 2.5 effort | `thinkingBudget` |
| --- | --- |
| `minimal` | `1024` |
| `low` | `4096` |
| `medium` | `8192` |
| `high` | `16384` |
| `xhigh` | `24576` |
| `max` | `32768` for `gemini-2.5-pro*`; `24576` for every other matching Gemini 2.5 ID, including `gemini-2.5-flash*` and `gemini-2.5-flash-lite*` |

The Gemini 2.5 values stay within the documented Pro `128..32768`, Flash `0..24576`, and Flash Lite `512..24576` bounds, and `max` uses the family ceiling rather than the dynamic-thinking sentinel because [[engine-39](../engine.md#engine-39)] defines the greatest reasoning depth.

### gemini-15

When the adapter validates `AgentOptions.effort`, it shall select this matrix:

| Input | Outcome |
| --- | --- |
| omitted | no effort-specific alias; preserve Gemini CLI and user-configuration defaults |
| a value in the Gemini portable vocabulary | mapping through [[gemini-11](#gemini-11)] |
| another built-in adapter's value, including `ultracode` or `ultra`, or any unknown string | reject before spawn with [[engine-50](../engine.md#engine-50)]'s metadata-backed error naming this adapter and its allowed values |

### gemini-16

When the adapter builds `init` tool availability, it shall select this matrix:

| Inputs | `tools` and capability metadata |
| --- | --- |
| `allowedTools` supplied, including empty | effective allowlist; `toolsKnown: true`; `toolsSource: 'configured'`, overriding a broader stream list |
| no explicit allowlist; source event has a non-empty string or object-name tool list | valid non-empty source names; `toolsKnown: true`; `toolsSource: 'stream'` |
| no explicit or source list; capability mapping produces non-empty allowed tools | capability-derived tools; `toolsKnown: true`; `toolsSource: 'configured'` |
| no tool source | `[]`; `toolsKnown: false`; `toolsSource: 'unavailable'` |

Every row also reports the effective disallowed-tool list from [[gemini-29](#gemini-29)].

### Token Accounting

### gemini-17

When a native result carries StreamStats, the adapter shall derive `usage.tokens` only from authentic run-owned `gemini_cli.api_response` telemetry that [[gemini-39](#gemini-39)] reconciles to those stats, never from a stream-only reconstruction or estimate.

### gemini-37

When a valid telemetry response contributes tokens, the adapter shall normalize its counters according to this matrix, reflecting Gemini's pinned `UsageMetadata` definition [[9]]:

| Public member | Exact value |
| --- | --- |
| input `total` | `input_token_count + tool_token_count`, because tool-result prompts are model input |
| input `uncached` | `input_token_count - cached_content_token_count + tool_token_count` |
| input `cacheRead` | `cached_content_token_count` |
| output `total` | `output_token_count + thoughts_token_count` |
| output `visible` | `output_token_count` |
| output `reasoning` | `thoughts_token_count` |

### gemini-38

When the adapter publishes an authentic token report, it shall include one [[engine-59](../engine.md#engine-59)] record per distinct successful response, including root and descendant-agent responses without exposing hidden conversation, with actual model, non-empty telemetry `auth_type` as provider, `requests: 1` per [[engine-60](../engine.md#engine-60)], the tokens from [[gemini-37](#gemini-37)], and totals equal to the safe member-wise sum of those records [[8]].

### gemini-40

When valid successful-response records reconcile to StreamStats, the adapter shall classify request coverage per [[engine-58](../engine.md#engine-58)] from this matrix:

| Run-owned evidence | Token outcome |
| --- | --- |
| at least one reconciled response, no `gemini_cli.api_error`, and no unmatched zero-token routed model | exact report with `coverage: 'complete'` |
| at least one reconciled response plus either failed-request signal | exact successful-response records retained with `coverage: 'partial'` |
| capture unavailable or unreadable, no valid response, malformed or invalid record sequence, duplicate conflict, unsafe sum, or any total or model reconciliation failure | omit `tokens` rather than estimate |

### gemini-41

When the adapter publishes terminal usage, it shall omit direct dollar cost per [[engine-31](../engine.md#engine-31)] because Gemini CLI reports none on this surface; the provider field in [[gemini-38](#gemini-38)] preserves the API-key, Vertex, account/subscription, or gateway rate-card domain instead.

### Abort Handling

### gemini-8

While a run has not emitted terminal `done`, when its caller signal is already aborted or fires, the adapter shall request `SIGTERM` from an active child, give cancellation precedence over any pending native result, and yield terminal `done` with [[engine-73](../engine.md#engine-73)] status `'interrupted'`, the resume token in [[gemini-9](#gemini-9)], elapsed duration, usage containing only [[gemini-27](#gemini-27)]'s tool count, and no result.

### Resume Token

### gemini-9

When the adapter selects a terminal `done`, it shall preserve continuity according to this matrix per [DR-003](../../decisions/003-role-scoped-session-management.md):

| Terminal state | `DonePayload.resumeToken` |
| --- | --- |
| any status after a backend session identifier was observed | latest backend identifier |
| `interrupted`, no backend identifier, non-empty inbound `AgentOptions.resume` | inbound resume value |
| `interrupted`, no backend identifier or non-empty inbound resume | omitted |
| any non-interrupted status with no backend identifier, including a resumed run | omitted |

## Internal Behavior

### Per-Run Configuration

### gemini-33

When an internal consumer calls the source-module compatibility settings helpers, the adapter shall retain their historical return shape according to this matrix without letting it drive `run()`:

| Tool lists and optional alias | Settings outcome |
| --- | --- |
| both lists empty and alias absent | `undefined` |
| allowed list only | `tools.core` only |
| denied list only | `tools.exclude` only |
| both lists | both tool members |
| alias only | `modelConfigs.customAliases` only |
| alias plus either or both lists | alias and the corresponding tool members |

The helpers ignore policy rules, approval mode, writable paths, and command arguments.

### gemini-34

Where [[gemini-11](#gemini-11)] selects an effort alias, when the adapter prepares Gemini defaults, it shall produce the override through this matrix while leaving `GEMINI_CLI_SYSTEM_SETTINGS_PATH` unchanged so system overrides, Admin policy, user settings, and project settings retain authority:

| Defaults state | Outcome |
| --- | --- |
| non-empty `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` | read that file |
| otherwise | read `system-defaults.json` beside the configured system-settings path or its macOS, Windows, or other-platform default |
| selected file absent with `ENOENT` | begin from `{}` |
| selected file uses line or block comments | strip comments for parsing while preserving parsed unrelated values |
| another read error, malformed JSON, or non-object root, `modelConfigs`, or `customAliases` | reject through [[gemini-19](#gemini-19)] |
| valid object | preserve unrelated values and aliases, replace only the reserved Cligent alias with its self-contained model and thinking configuration |

The selected override is a unique per-run `system-defaults.json` written with mode `0600`; a write failure removes its newly created directory before rejecting, and a successful return points only the child environment at that file until [[gemini-35](#gemini-35)] cleans it.

### gemini-35

After any run path initializes temporary telemetry, policy, or settings resources, when control leaves the run, the adapter shall attempt every initialized cleanup and select this outcome only after all attempts settle:

| Cleanup results | Outcome |
| --- | --- |
| no rejection | initialized resources removed after success, error, or abort; preserve the run's ordinary outcome |
| one rejection | throw that rejection directly |
| multiple rejections | throw `AggregateError` with `Failed to clean up Gemini temporary runtime files` |

### Telemetry Reconciliation

### gemini-36

When the adapter reads a local telemetry object sequence, it shall accept response records according to this matrix:

| Object | Outcome |
| --- | --- |
| event other than `gemini_cli.api_response` or `gemini_cli.api_error` | ignore |
| `gemini_cli.api_error` | retain a failed-request signal without token counters |
| response with non-empty model, prompt ID, and auth type; first available `timestamp`, `timeUnixNano`, `hrTime`, or `observedTimestamp`; safe non-negative integer input, output, cache, thinking, tool, and total counters; cache not exceeding input; and total equal to input plus output, thinking, and tool | accept |
| exact duplicate identity and signature | de-duplicate |
| duplicate identity with a different signature, an unidentifiable response, or any invalid required field or relation | invalidate the token report |

Identity consists of timestamp, prompt ID, and model; the duplicate signature consists of auth type, role, every counter, duration, and status code.

### gemini-39

When the adapter reconciles accepted telemetry responses against native StreamStats, it shall require safe exact agreement for raw total, input, output, cache, and uncached-input counters both across the whole run and per model, allowing only an otherwise valid unmatched stream model whose five counters are all zero as a failed-request signal and rejecting any unmatched telemetry model or nonzero unmatched stream model.

### gemini-42

For each run, when the adapter prepares authentic accounting, it shall create a unique run-owned local telemetry file, force telemetry enabled and local after inherited settings, disable prompt logging, traces, and collector use, read only after child close, continue the coding-agent run with tokens absent if capture setup fails, and prevent inherited telemetry settings from redirecting or contaminating the file [[8]].

### Session Identity

### gemini-43

When the adapter selects the session identifier carried by unified events, it shall apply this matrix to every parsed object through the first native result:

| State or source | Selection |
| --- | --- |
| before any backend identifier, non-empty inbound `resume` | inbound value |
| before any backend identifier, absent or empty inbound `resume` | one generated non-empty identifier shared by all pre-backend events |
| parsed object with aliases | first non-empty `sessionId`, `session_id`, `threadId`, `thread_id`, `session.id`, or `thread.id` |
| later object with another valid alias | replace the current identifier with the latest selected backend value |
| missing, empty, or invalid alias | retain both the current identifier and whether a backend identifier is already known |
| object after the first native result | ignore, including its identity aliases |

### Abort and Process Containment

### gemini-44

When a run owns a caller abort signal and child process, it shall contain their lifecycle according to this matrix:

| State | Outcome |
| --- | --- |
| live signal before spawn | install one run-scoped listener; if it fires before the child exists, remember the request and terminate the child with `SIGTERM` immediately after spawn |
| signal already aborted | install no listener, remember the request, and terminate after spawn |
| signal fires while child is active | request `SIGTERM` from the active child; final containment may request it again if close has not completed |
| signal fires after child exit | send no kill |
| any run exit | remove an installed listener; if the child remains active, send `SIGTERM`, await close, then perform [[gemini-35](#gemini-35)]'s resource cleanup |

## Verification

### gemini-201

Given canned native Gemini NDJSON flows, when the adapter runs, the emitted events shall match this normalization matrix:

| Flow | Assertions |
| --- | --- |
| canonical init, message, tool use, tool result, native error, and result | exact ordered event types, session identity, init tool source, and canonical payload fields [[gemini-4](#gemini-4)], [[gemini-16](#gemini-16)], [[gemini-20](#gemini-20)], [[gemini-21](#gemini-21)], [[gemini-22](#gemini-22)], [[gemini-23](#gemini-23)], [[gemini-24](#gemini-24)], [[gemini-25](#gemini-25)], [[gemini-27](#gemini-27)], [[gemini-43](#gemini-43)] |
| direct snake-case tool fields | selected name, identifier, input, and success status [[gemini-22](#gemini-22)], [[gemini-23](#gemini-23)] |
| top-level and value-wrapped `functionCall` / `functionResponse` | selected name, identifier, input, output, and success status [[gemini-22](#gemini-22)], [[gemini-23](#gemini-23)] |
| malformed line after init followed by valid message and result | recoverable diagnostic with raw input, continued text, and terminal done [[gemini-21](#gemini-21)], [[gemini-25](#gemini-25)], [[gemini-26](#gemini-26)] |
| error result with nested message, or without an error candidate | error before done, nested message propagation, or raw `GEMINI_RESULT_ERROR` diagnostic [[gemini-24](#gemini-24)], [[gemini-25](#gemini-25)] |

### gemini-202

Where an application configuration selects a representative effort value for this adapter, when the runtime constructs and invokes the corresponding `Cligent`, Gemini 3 and Gemini 2.5 concrete-model aliases shall be created, while a representative unmatched model creates no effort override and preserves ordinary model forwarding [[gemini-11](#gemini-11)].

### gemini-203

Given a caller abort signal and child-process lifecycle states, when the adapter run proceeds, it shall select this containment matrix:

| State | Assertion |
| --- | --- |
| signal already aborted | install no listener, remember cancellation, and terminate the child after spawn [[gemini-44](#gemini-44)] |
| live signal fires before spawn | remember cancellation and terminate the child after spawn [[gemini-44](#gemini-44)] |
| live signal fires while the child is active with no pending native result | request `SIGTERM` and yield the interrupted terminal described below [[gemini-8](#gemini-8)], [[gemini-44](#gemini-44)] |
| live signal fires after a native result but before child close | give cancellation precedence and yield the interrupted terminal rather than the buffered result [[gemini-8](#gemini-8)], [[gemini-44](#gemini-44)] |
| signal fires after child exit | send no kill [[gemini-44](#gemini-44)] |
| run exits while its child remains active | request `SIGTERM`, await close, then clean temporary resources [[gemini-35](#gemini-35)], [[gemini-44](#gemini-44)] |
| run installed a listener | remove it on exit [[gemini-44](#gemini-44)] |

Every interrupted terminal consists only of `done` after init, with the resume selection in [[gemini-9](#gemini-9)], elapsed duration, usage containing the observed tool count and no tokens, and no result [[gemini-8](#gemini-8)], [[gemini-27](#gemini-27)].

### gemini-204

Given direct permission mappings, when the adapter maps capability, mode, and tool-list cases, it shall produce this matrix:

| Cases | Assertions |
| --- | --- |
| all 27 no-mode capability combinations | exact decisions, priorities, non-interactive flags, and built-in tool groups [[gemini-6](#gemini-6)] |
| missing policy and explicit empty policy | no rules versus five default-ask rules [[gemini-12](#gemini-12)] |
| bare `auto` and `bypass` | `yolo` and no capability rules [[gemini-12](#gemini-12)] |
| capability-populated `auto`, with and without independent lists | capability suppression, `yolo`, and independent list rules [[gemini-12](#gemini-12)], [[gemini-29](#gemini-29)] |
| closed non-empty and empty allowlists | deny precedence, effective filtering, rule order, and catch-all denial [[gemini-29](#gemini-29)] |
| ordinary command mapping | no deprecated `--allowed-tools` argument [[gemini-32](#gemini-32)] |

### gemini-207

Given setup and child-process terminal conditions with no native result, when the adapter yields terminal events, it shall report this outcome matrix:

| Condition | Terminal class |
| --- | --- |
| non-aborted settings or policy setup rejects; spawn throws; child exposes no stdout; child reports an asynchronous launch error; or stdout iteration throws | synthetic stream error |
| abort was requested or close signal is `SIGTERM` | interrupted close |
| close code is `0` | successful close |
| close code is `53` | exhausted close |
| close code is `1`, `42`, another nonzero or null value, or another signal is present | errored close |

- Each synthetic-error row asserts init first if needed, a non-recoverable `GEMINI_STREAM_ERROR` with the exact thrown-`Error` message or fallback diagnostic, then error `done` with elapsed duration, normal-terminal resume selection, only the observed tool count, and no tokens or result [[gemini-9](#gemini-9)], [[gemini-19](#gemini-19)], [[gemini-27](#gemini-27)].
- The missing-stdout row additionally asserts child termination and close before temporary-resource cleanup [[gemini-35](#gemini-35)], [[gemini-44](#gemini-44)].
- The interrupted-close row supplies non-empty stderr and asserts result omission [[gemini-5](#gemini-5)], [[gemini-8](#gemini-8)].
- Each non-interrupted close row asserts the selected status and error-before-done ordering, exact fallback message, trimmed-stderr result, elapsed duration, normal resume selection, and usage containing only the observed tool count that its state requires [[gemini-5](#gemini-5)], [[gemini-9](#gemini-9)], [[gemini-27](#gemini-27)].

### gemini-213

Given a normally terminating stream whose session identity varies, when the adapter emits terminal `done`, it shall set or omit `DonePayload.resumeToken` according to this matrix:

| Stream state | Assertion |
| --- | --- |
| backend identifier provided | latest identifier in `resumeToken` [[gemini-9](#gemini-9)], [[gemini-43](#gemini-43)] |
| no backend identifier, including an early error | omitted [[gemini-9](#gemini-9)] |

### gemini-216

When the adapter spawns Gemini CLI, the child environment shall carry `GEMINI_CLI_TRUST_WORKSPACE` according to this matrix [[gemini-10](#gemini-10)]:

| Parent value | Assertion |
| --- | --- |
| absent | `'true'` |
| `'false'` or empty | preserved unchanged |

### gemini-218

Where each portable effort input and model condition is supplied, when the adapter maps a run, the observable provider controls shall match this matrix:

| Input class | Assertions |
| --- | --- |
| every Gemini 3 effort | exact `thinkingLevel` alias and no direct thinking flag [[gemini-11](#gemini-11)] |
| every Gemini 2.5 Flash effort and Pro `max` | exact bounded `thinkingBudget` alias and no direct thinking flag [[gemini-11](#gemini-11)] |
| unset model, CLI alias, or non-matching model | no alias; ordinary model forwarding preserved [[gemini-11](#gemini-11)] |
| omitted effort | no effort, orchestration, or settings-alias override [[gemini-15](#gemini-15)] |
| another adapter's value or arbitrary unknown string | pre-spawn metadata-backed rejection naming this adapter and its allowed values [[gemini-15](#gemini-15)] |
| generated alias | self-contained model configuration delivered through the temporary defaults mechanism [[gemini-34](#gemini-34)] |

### gemini-219

Where the `gemini` executable the adapter spawns, its API-key credential, and its host OS-level sandbox are available, when a `Cligent` with `permissions = { mode: 'auto' }` runs fresh headless create and update requests in a throwaway working directory, the adapter's native auto posture shall let both non-destructive writes complete through this shared real-run flow [[gemini-12](#gemini-12)]:

- expected file state after each phase;
- no `permission_request`, denied tool result, or error;
- successful terminal `done`;
- filesystem state as ground truth because adapters normalize edits differently;
- at most two complete fresh retries, only after explicit upstream overload, rate-limit, service-unavailable, or upstream invalid-stream failures, with every other failure and the third consecutive named transient fatal;
- self-skip for missing executable or credential outside CI, hard failure under CI, and no cross-adapter skip;
- self-skip with a logged reason when the host sandbox cannot initialize, including under CI.

### gemini-220

Given the adapter has been aborted, when the run yields terminal `done` with `status: 'interrupted'`, it shall report the resume token each observed state requires [[gemini-9](#gemini-9)], [[gemini-43](#gemini-43)]:

| Observed before abort | `DonePayload.resumeToken` |
| --- | --- |
| backend session identifier | latest backend identifier |
| no backend identifier and non-empty inbound resume | inbound value |
| neither | omitted |

### gemini-222

Given direct writable-path mappings, when the adapter receives valid and invalid entries, it shall expose canonical valid paths with `enforcement: 'ambient'`, preserve the selected approval mode, and reject an invalid parent traversal before spawn [[gemini-30](#gemini-30)].

### gemini-225

Given direct Gemini mappings and a fake Gemini CLI implementing the 0.50 argument and Policy Engine surfaces while capturing argv, environment, and temporary files, when the explicit case matrix executes, the observed surfaces shall match these outcomes:

| Case | Assertions |
| --- | --- |
| arbitrary, leading-dash prompt | one final joined prompt token [[gemini-3](#gemini-3)] |
| model, non-empty or empty resume, cwd, and maxTurns | joined non-empty values, fresh empty resume, selected cwd, and no unsupported turn-limit flag [[gemini-7](#gemini-7)] |
| generated capability and list policy | exact rules and priorities, joined `--policy`, non-interactive contents, unchanged system paths, no deprecated runtime argument, and removal after success or spawn failure [[gemini-6](#gemini-6)], [[gemini-14](#gemini-14)], [[gemini-29](#gemini-29)], [[gemini-32](#gemini-32)], [[gemini-35](#gemini-35)] |
| absent policy and lists versus empty policy | no policy surface versus default-ask rules [[gemini-12](#gemini-12)] |
| invalid and accepted tool names | indexed pre-spawn rejection or valid TOML escaping [[gemini-13](#gemini-13)], [[gemini-31](#gemini-31)] |
| source-module compatibility settings helpers | historical undefined, tool-member, and model-alias shapes without runtime use [[gemini-33](#gemini-33)] |
| concrete-model effort | existing defaults and aliases preserved, self-contained alias merged into a temporary configured or sibling defaults copy, system settings unchanged, and temporary copy removed after success, stream error, and abort [[gemini-34](#gemini-34)], [[gemini-35](#gemini-35)] |
| run-owned telemetry environment and cleanup | private local controls override inherited settings, file read occurs after close, and cleanup occurs after success, stream error, and abort [[gemini-35](#gemini-35)], [[gemini-42](#gemini-42)] |
| multiple cleanup failures | all initialized cleanups attempted before an aggregate failure is surfaced [[gemini-35](#gemini-35)] |

### gemini-229

Where tool-list and stream-tool states vary, when the adapter maps policy and emits `init`, it shall select this matrix:

| State | Assertions |
| --- | --- |
| explicit empty `allowedTools` with a broader stream list | catch-all denial and configured known empty set [[gemini-16](#gemini-16)], [[gemini-29](#gemini-29)] |
| non-empty allowlist containing disallowed identifiers | effective allowlist only, provider surface closed, deny precedence preserved [[gemini-29](#gemini-29)] |
| explicit non-empty, stream, capability-derived, or unavailable source | tools and capability metadata selected by [[gemini-16](#gemini-16)] |

### gemini-240

Given run-owned telemetry and native StreamStats across an explicit accounting matrix, when the adapter emits terminal usage from authentic rather than stream-only counters, it shall select these outcomes [[gemini-17](#gemini-17)]:

| Case | Assertions |
| --- | --- |
| valid nonzero response with tool prompt, cache, visible output, and thinking | exact inclusive totals and subsets [[gemini-37](#gemini-37)] |
| root and descendant responses plus an exact duplicate | one record per distinct response, exact safe sums, model/provider/request provenance, duplicate removed [[gemini-36](#gemini-36)], [[gemini-38](#gemini-38)] |
| API error or unmatched zero-token routed model beside reconciled successes | exact successful records with partial coverage [[gemini-39](#gemini-39)], [[gemini-40](#gemini-40)] |
| missing exporter data, selected malformed counters, missing auth identity, conflicting duplicate, or selected stream mismatch | tokens omitted [[gemini-36](#gemini-36)], [[gemini-39](#gemini-39)], [[gemini-40](#gemini-40)] |
| any valid or invalid accounting | independently observed tool count preserved and no direct cost published [[gemini-27](#gemini-27)], [[gemini-41](#gemini-41)] |
| success, error, abort, or stream error | run-owned resources cleaned after use [[gemini-35](#gemini-35)], [[gemini-42](#gemini-42)] |

### gemini-241

Under [[gemini-219](#gemini-219)]'s real-target, credential, and sandbox precondition, when the real auto-mode adapter leg completes its headless create and update requests, each terminal shall carry a non-empty token report with positive inclusive totals, per-response records naming non-empty model and authentication provider with exactly one request, and failure rather than success when run-owned telemetry is absent or unreconciled [[gemini-37](#gemini-37)], [[gemini-38](#gemini-38)], [[gemini-40](#gemini-40)].

## References

[1]: https://ai.google.dev/gemini-api/docs/thinking 'Gemini API: Thinking'
[2]: https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md 'Google Gemini CLI: Configuration reference'
[3]: https://geminicli.com/docs/reference/policy-engine/ 'Gemini CLI: Policy engine'
[4]: https://geminicli.com/docs/cli/cli-reference/ 'Gemini CLI: CLI reference'
[8]: https://geminicli.com/docs/cli/telemetry/ 'Gemini CLI telemetry'
[9]: https://github.com/googleapis/js-genai/blob/38cac5bbf4941ec5fa760238bd423c0ecc2c6f04/src/types.ts#L2607-L2628 'Google Gen AI SDK 1.30.0 UsageMetadata'
