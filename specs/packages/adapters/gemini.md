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

While no native `result` has selected a terminal and the run is not aborted, when skill preparation [[skills-2](../skills.md#skills-2)] or the skills delivery-context checks of [[gemini-51](#gemini-51)] reject, settings or policy setup rejects, spawn throws synchronously, the child exposes no stdout, the child reports an asynchronous launch error, or stdout iteration throws, the adapter shall emit `init` first if needed, then a non-recoverable `error` with code `GEMINI_STREAM_ERROR` and the thrown `Error` message or `Gemini adapter failed while reading stream`, followed by terminal `done` with `status: 'error'`, the normal-terminal resume selection in [[gemini-9](#gemini-9)], elapsed duration, usage containing only [[gemini-27](#gemini-27)]'s tool count, and no result.

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

When the adapter builds the child environment of a run, it shall select `GEMINI_CLI_TRUST_WORKSPACE` from this matrix:

| Parent environment | Child value |
| --- | --- |
| variable absent, on Windows in every letter case [[gemini-56](#gemini-56)] | `'true'` |
| variable present, including `'false'` or an empty string, on Windows in any letter case | the existing value unchanged, under the name it has |

### gemini-56

When the adapter builds the child environment of a run, it shall select its variables from this matrix:

| Parent environment or variable | Child environment |
| --- | --- |
| the parent's environment | its variables, on Windows keeping only the first, in sorted order, of each name's variants in letter case, as Node's spawn builds a child's environment there [[65]], each read there in any letter case [[60]] |
| a variable this adapter sets | replacing, on Windows, every variant of its name in letter case, and elsewhere the variable of exactly that name |

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
- The reported model [[engine-27](../engine.md#engine-27)] is the first non-empty source `model` unless it names the per-run effort alias selected by [[gemini-11](#gemini-11)], and is otherwise omitted.
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
| `code` | non-empty top-level `code`, nested `error.code`, nested `error.type`, otherwise omitted; replace upstream `SESSION_RESUME_REJECTED` with `GEMINI_STREAM_ERROR` because provider codes do not establish pre-execution rejection [[engine-84](../engine.md#engine-84)] |
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
| `permissions` absent | no approval-mode or capability rules; when tool lists and skills [[gemini-52](#gemini-52)] are also absent, no generated policy or `--policy`, preserving Gemini's native defaults and discovered user policies |
| supplied policy with mode omitted, including `{}` | no approval-mode flag; capability rules from [[gemini-6](#gemini-6)], with every omitted level treated as `ask` |
| `mode: 'auto'`, with any capability levels | `--approval-mode yolo`; ignore capability fields, adding no Cligent-selected capability grant; absent tool lists and skills leave no policy rules or file |
| `mode: 'bypass'`, with any capability levels | `--approval-mode yolo`, Gemini exposing no distinct bypass tier; ignore capability fields; absent tool lists and skills leave no policy rules or file |

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

### gemini-46

When a run supplies the per-call attachment option [[attachments-1](../attachments.md#attachments-1)], the adapter shall prepare the selected files [[attachments-2](../attachments.md#attachments-2)] and deliver an owned snapshot through native `@file` processing [[19]][[20]] according to this matrix:

| Input or phase | Outcome |
| --- | --- |
| absent or empty list | preserve the exact prompt forwarded by [[gemini-3](#gemini-3)] |
| accepted list | snapshot each file in an isolated temporary directory, using an ordered numeric prefix, content digest, and canonical extension for its selected MIME type; append only generated file references to the prompt |
| native invocation | add only the snapshot directory through `--include-directories`, retaining the requested cwd and the original files unchanged |
| filename or explicit MIME differing from its extension | transmit the selected snapshot bytes with the selected MIME type; never interpolate the original filename into a generated reference |
| file exceeding 20 MiB | reject before a provider prompt, including growth discovered while reading |
| native Windows or a temporary-directory path containing control characters, backslashes, or glob and argument-list metacharacters | reject with a precise contextual diagnostic before provider work; capability discovery reports an empty attachment MIME set with that diagnostic |
| supported POSIX temporary path containing spaces | escape each space in native `@file` syntax without shell interpretation |
| terminal, failure, cancellation, or abandoned stream | release the snapshot, before yielding a terminal event when one is emitted |

Transport acceptance remains independent of model eligibility and the validity of a file's encoded media.

### gemini-7

When the adapter maps ordinary `AgentOptions` to Gemini arguments and process options, it shall select this matrix:

| Option | Outcome |
| --- | --- |
| absent or empty `model` | no model argument |
| non-empty `model` without an effort alias from [[gemini-11](#gemini-11)] | one joined `--model=<model>` token |
| matching effort alias | one joined `--model=cligent-reasoning-effort` token, replaced by `--model=<model>` where [[gemini-34](#gemini-34)] delivers no alias |
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

### gemini-48

When a run supplies MCP servers or selects the browser preset, or capability discovery reports on the browser, the adapter shall deliver the prepared map through the private per-run settings home used by [[gemini-34](#gemini-34)], applying [[mcp-1](../mcp.md#mcp-1)], [[mcp-2](../mcp.md#mcp-2)], and [[mcp-3](../mcp.md#mcp-3)] through this matrix [[21]]:

| State or entry | Outcome |
| --- | --- |
| stdio | replace the named user-settings entry with `command`, `args` (empty when absent), optional `env`, and `trust: true` |
| HTTP | replace the named entry with `httpUrl`, optional `headers`, and `trust: true` |
| a per-run server, the browser's included, replacing a same-name user-settings entry that, expanded as [[gemini-34](#gemini-34)] expands a layer, fails the runtime's validation of an MCP server, a strict object admitting only `command`, `cwd`, `url`, `httpUrl`, `tcp`, `description`, `targetAudience`, and `targetServiceAccount` as strings, `args`, `includeTools`, and `excludeTools` as lists of strings, `env` and `headers` as objects of strings, `type` as one of `stdio`, `sse`, and `http`, `authProviderType` as one of `dynamic_discovery`, `google_credentials`, and `service_account_impersonation` [[88]], `timeout` as a number or a non-blank string `Number` reads as one, `trust` as a boolean or `true` or `false` in any letter case, and `extension` and `oauth` as objects of any values, the value types `extension` lists being read as any value, with `null` none of these [[76]][[84]][[85]][[89]][[90]], where the expanded user settings, outside every entry the run replaces, hold a string the runtime's validation could coerce at a boolean- or number-typed setting, `true` or `false` in any letter case or a non-blank string `Number` reads as a number [[50]][[87]], which this adapter does not tell apart from a string at another setting, so that such a string at any key counts | reject before browser preparation rather than replace it, naming the entry, the first that fails in the order JavaScript enumerates the caller's `mcpServers`, then the browser's, the first of its properties in the order JavaScript enumerates them that fails, or that it is no object, and the first such string met walking the parsed keys depth first in that order, with its path, keys joined by `.` and list indexes bracketed, because every per-run entry validates while unknown top-level keys pass [[86]], so the replacement can change whether the runtime's validation accepts the file, and so whether the runtime coerces that string [[47]], which this adapter does not check; a property a newer runtime admits fails here, and a string at a setting of another type counts, each a deliberately conservative rejection |
| trust | consent to admitted server calls under native per-server trust, without overriding explicit tool restrictions, project settings, system overrides, or Admin policy |
| unrelated user settings or MCP names | retain their parsed values |
| absent or empty map without browser | no MCP-specific settings overlay |
| the child's environment names no home [[gemini-34](#gemini-34)], the child's working directory [[gemini-34](#gemini-34)] resolves to the real home, or the native sandbox would be enabled [[gemini-34](#gemini-34)] | reject before browser preparation rather than silently omit the servers |
| capability discovery of the browser | the rows above applied as a run selecting the browser beside the requested MCP servers would apply them, each rejection reported rather than raised, the child's environment naming no home as a restriction and a rejected same-name replacement as another, reserving no directory and deciding with a path spelled as the overlay directory [[gemini-34](#gemini-34)] would be |
| injected settings writer cannot attest delivery of a non-empty map | setup failure before spawn |
| abort during preparation or settings setup | interrupted terminal and no child spawn |

The run creates no permanent MCP configuration, and overlay cleanup follows [[gemini-45](#gemini-45)] and [[gemini-35](#gemini-35)].

### Skills

### gemini-51

When a run supplies skills, the adapter shall deliver the prepared list [[skills-2](../skills.md#skills-2)] through the private per-run settings home used by [[gemini-34](#gemini-34)] and select this matrix per [DR-036](../../decisions/036-cross-agent-skill-installation.md), [[22]], and [[24]]:

| State or entry | Outcome |
| --- | --- |
| the child's environment names no home [[gemini-34](#gemini-34)], the child's working directory [[gemini-34](#gemini-34)] resolves to the real home, or the native sandbox would be enabled [[gemini-34](#gemini-34)] | reject before browser preparation rather than silently omit the skills, as [[gemini-48](#gemini-48)] rejects MCP servers |
| settings layers with more than one reading, a system settings or system-defaults file of unknown admission [[gemini-34](#gemini-34)] counted or skipped and a layer holding a string the runtime's validation may coerce [[gemini-34](#gemini-34)] read as written or coerced, across whose combinations of readings whether the native sandbox would be enabled [[gemini-34](#gemini-34)] or the runtime policy sources passed by [[gemini-55](#gemini-55)] differ | reject before browser preparation through [[gemini-19](#gemini-19)], the sandbox decision settled before the row above rejects a sandbox and the policy sources after the row below, naming once each file whose change of reading, under some reading of the others, changes the first decision so differing, in the order system defaults, user, workspace, and system settings, with, for a change of admission, that this adapter does not run the runtime's check of it, and, for a change of coercion, each setting so read and that the runtime coerces it only where the whole file validates, which this adapter does not check, because the runtime could take any of those readings |
| user settings, evaluated as [[gemini-34](#gemini-34)] evaluates a layer, set `skills.enabled` to a falsy value other than `null`, which the runtime reads as off, reading that setting by its truthiness with unset or `null` read as on [[80]][[81]], or to a `false` string in any letter case, which the runtime makes `false` only where the whole file validates [[gemini-34](#gemini-34)] | reject before browser preparation, naming `skills` and that setting, with, for the falsy value, that value as JSON and that the runtime reads it as off, and, for the string, that the runtime coerces it only where the whole file validates, which this adapter does not check, because enabling discovery for the run would also load the user's `.agents/skills`, extension, workspace, and built-in skills |
| overlay `.gemini/skills` | a real directory in place of the link [[gemini-34](#gemini-34)] would create, holding the run's skills materialized under [[skills-3](../skills.md#skills-3)] and one overlay link per entry of the real `.gemini/skills` whose entry name and runtime skill name, the frontmatter `name` with each of `:\/<>*?"|` replaced by `-` [[78]] or the entry name where none parses, both differ from every run skill's name once lowercased, as the runtime compares skill names [[24]] |
| overlay `settings.json` | every user-scope `skills.disabled` entry whose form expanded as [[gemini-34](#gemini-34)] expands a layer equals a run skill's name once lowercased removed from a list, and a lone string so naming one, which counts as a one-entry list, replaced by `:`, which names no skill, since the runtime replaces each `:` in a skill's frontmatter `name` by `-` [[78]], and, like the string it replaces, fails the runtime's validation of that list setting [[77]], with every other entry and parsed value retained as written, as [[gemini-34](#gemini-34)] copies them, so that the rewrite leaves whether the runtime's validation accepts the file unchanged [[gemini-34](#gemini-34)] |
| workspace trust | unchanged, because user-tier skills load before the trust gate [[24]] |
| abort during skill preparation or settings setup | interrupted terminal and no child spawn, as [[gemini-48](#gemini-48)] selects for MCP servers |

### gemini-52

When a run supplies skills [[gemini-51](#gemini-51)], the adapter shall open `activate_skill`, which the bundled headless policy denies at a lower priority [[23]], through this matrix:

| Tool-list state | Outcome |
| --- | --- |
| `allowedTools` absent and no `disallowedTools` naming `activate_skill` | one `interactive = false` rule allowing `activate_skill` at priority 999 in the per-run policy delivered by [[gemini-14](#gemini-14)], generated even where no permission or tool-list rule exists |
| `allowedTools` naming `activate_skill` and no `disallowedTools` naming it | no additional rule, because the [[gemini-29](#gemini-29)] allow already covers it |
| `allowedTools` empty or present without `activate_skill`, or `disallowedTools` naming `activate_skill` | throw before any event and before browser preparation, naming `skills` and the conflicting tool option, as [[gemini-13](#gemini-13)] rejects an invalid tool name, because an explicit restriction is never weakened [[engine-17](../engine.md#engine-17)] |

### gemini-55

Where the per-run policy file [[gemini-14](#gemini-14)] holds only [[gemini-52](#gemini-52)]'s `activate_skill` allow, the adapter shall pass the runtime's own policy sources as further `--policy` values after that file, because `--policy` paths replace them [[21]], selecting them through this matrix:

| Runtime state | Outcome |
| --- | --- |
| a system settings or system-defaults file | contributes its `policyPaths` and the folder-trust setting deciding whether the workspace settings merge only as [[gemini-34](#gemini-34)] locates, counts, and evaluates it |
| workspace trust deciding whether the workspace settings merge | untrusted where the child's `GEMINI_RESTRICTED_MODE` is `true` or its `GEMINI_CLI_TRUST_WORKSPACE` [[gemini-10](#gemini-10)] is `false`; otherwise trusted where that variable is `true` or where the system-defaults, user, and system settings, each evaluated and merged in that order as [[gemini-34](#gemini-34)] states, give a falsy `security.folderTrust.enabled` other than unset or null, which the runtime reads as on [[45]][[46]]; otherwise as the trusted-folders file decides [[35]] |
| the trusted-folders file | the file the child opens [[gemini-34](#gemini-34)] at a non-empty `GEMINI_CLI_TRUSTED_FOLDERS_PATH`, which it takes verbatim [[30]], holding no rules where it opens none [[33]], and otherwise under the real home [[gemini-34](#gemini-34)] at `.cache/.gemini/trustedFolders.json` where the child's `SANDBOX` is `sandbox-exec` and at `.gemini/trustedFolders.json` where it is not, as the child's runtime directory moves [[34]] |
| a trusted-folders rule | keyed by its key normalized as the runtime normalizes paths: resolved against the child's working directory [[gemini-34](#gemini-34)], every backslash then replaced by `/`, and the result lowercased on macOS and Windows, a later key normalizing to an earlier one replacing that rule's level [[32]][[33]] |
| the workspace's trust under the trusted-folders file | the level of the rule whose effective path, its normalized key or that key's parent directory for `TRUST_PARENT`, contains the child's working directory, each taken through the runtime's real-path reading, which resolves the symbolic links of an existing path and otherwise keeps its spelling, and normalized again, and, on Windows where either compared path holds `~`, as an 8.3 short name does [[39]], each then decoded as a URI component where it decodes and taken through the native real path, a missing entry resolved as its parent's real path joined to its name or, for a symbolic link, as its target's, with any extended-length prefix dropped, a failure leaving each path as resolved so far [[38]], the rule with the longest normalized key deciding and the first listed winning a tie: `TRUST_FOLDER` and `TRUST_PARENT` trust the workspace, while `DO_NOT_TRUST`, no matching rule, an invalid level, and an unreadable or malformed file do not [[33]] |
| the effective `policyPaths` the runtime merges across its settings scopes [[gemini-34](#gemini-34)], the system-defaults, user, trusted workspace, and system settings in that order, each evaluated as [[gemini-34](#gemini-34)] evaluates a layer, are non-empty | those paths in merged order, each resolved as the runtime resolves a merged path where no `--policy` is given [[57]][[58]]: a leading `%userprofile%` in any letter case, or a `~` alone or before `/`, replaced by the real home [[gemini-34](#gemini-34)] as spelled before its lexical resolution, rather than by the overlay the child receives in `GEMINI_CLI_HOME` [[10]], which it would splice only because this adapter redirected its home, and spliced onto which an entry such as `~/../pol` or `%USERPROFILE%pol` would name a path beside the overlay in a temporary directory other local users may share, where one of them could create it, the result normalized, an empty or null entry dropped [[63]], and a relative one resolved against the child's working directory [[gemini-34](#gemini-34)] |
| no effective `policyPaths`, and the real home's `.gemini/policies` directory [[gemini-34](#gemini-34)] exists | that directory |
| neither | no further value |
| a passed source or the per-run file path contains `,` or differs from its trimmed form | reject setup before spawn through [[gemini-19](#gemini-19)], naming that path, because the runtime splits every `--policy` value on commas and trims each part [[25]][[26]] |

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

Where [[gemini-11](#gemini-11)] selects an effort alias, when the adapter prepares the child environment, it shall deliver the alias through a per-run user-settings home, since Gemini CLI loads system settings and system defaults only from paths it finds secure, leaving every system and real-home file's contents unchanged and system overrides, Admin policy, and project settings in authority, through this matrix, evaluated top to bottom [[2]][[10]][[11]]:

| Step or state | Outcome |
| --- | --- |
| the child's working directory | the real path [[37]] of the run cwd as given, a relative one taken from the parent's working directory, which is the directory a POSIX child reports [[36]] and so resolves every relative path it is given against, except where macOS resolves a firmlink such as `/System/Volumes/Data` to its canonical path, which this adapter does not, the one known divergence; on Windows, or where no real path can be read, the run cwd resolved against the parent's working directory |
| the child's environment, which holds every variable these rows name | the environment [[gemini-56](#gemini-56)] builds |
| real home | the caller's non-empty `GEMINI_CLI_HOME` in the parent's environment as [[gemini-56](#gemini-56)] gives it to the child, otherwise, unless the child's environment names no home as the row below states, the operating-system home derived from that environment as the child derives it, rather than from this process's: its `HOME` on POSIX and its `USERPROFILE` on Windows wherever present, and otherwise the home the operating system records for the process user, which this process shares [[82]][[83]]; whichever of these three applies resolved lexically against the child's working directory, because the runtime takes its home verbatim and joins each path under it by segments, which drops each `..` lexically [[40]] |
| no non-empty `GEMINI_CLI_HOME`, and the operating-system home derived as the row above states empty, whether from `HOME`, `USERPROFILE`, or the recorded home, which the child's home lookup returns as it is [[82]][[83]] and in place of which the runtime keeps its user state under the temporary directory [[40]], or a `USERPROFILE` of fewer than three bytes in UTF-8 on Windows, for which the child's home lookup fails [[83]]: the child's environment naming no home | deliver no alias, creating no overlay and sending `--model=<model>` in its place, leaving effort unapplied, because no real home exists for an overlay to mirror |
| the child's working directory resolves to the real home | deliver no alias: create no overlay and send `--model=<model>` in its place, leaving effort unapplied, because Gemini skips workspace settings, project commands, and workspace policies only for a workspace that is its home [[12]][[13]][[14]] |
| overlay directory | a new private temporary directory, reserved before any row below reads the child's home, which it is wherever the overlay is delivered, and, wherever no overlay populates it, removed unpopulated among the cleanups [[gemini-35](#gemini-35)] attempts |
| real `.gemini/settings.json` absent with `ENOENT` | begin from `{}` |
| real settings use line or block comments | strip comments for parsing, preserving every parsed value, including unknown keys and existing aliases |
| another read error, malformed JSON, or non-object root, `modelConfigs`, or `customAliases` | reject through [[gemini-19](#gemini-19)] |
| a file the child opens at a path it takes verbatim | on POSIX, none where nothing exists at that path as spelled, a relative one appended to the child's working directory without lexical normalization, as the child's existence check tests that spelling [[33]][[47]], where the operating system resolves each `..` that follows a symbolic link against the directory that link names and finds nothing at a trailing `/` or `/.`, or a `..`, after a non-directory [[42]], and otherwise the real path [[37]] of that spelling; on Windows, that path resolved against the child's working directory, because Windows evaluates each `..` lexically [[41]], and none where nothing exists there |
| system settings and system-defaults files | the files the child opens, as the row above states, at a non-empty `GEMINI_CLI_SYSTEM_SETTINGS_PATH` and `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, which it takes verbatim, otherwise at the platform's system settings path and at the `system-defaults.json` joined by segments beside the system settings path, which drops each `..` lexically [[27]] |
| a system settings or system-defaults file | read as empty where the child opens none [[11]]; otherwise checked for admission at its path resolved lexically against the child's working directory, where the runtime checks it [[52]] and by which [[gemini-51](#gemini-51)] names it, and the file the child opens counted where the runtime admits it, read as empty where the runtime skips it [[11]], and read and counted where its admission is unknown: on POSIX, admitted where nothing exists at that lexical path, or where it is a regular file that, with every directory above it up to the root along both its given and its real path, is owned by root and writable by neither group nor others, every symbolic link on its given path is itself owned by root, and no status read fails other than for a missing entry, and skipped otherwise [[28]][[29]]; on Windows, of unknown admission, because the runtime admits that existing file only where a PowerShell script it runs finds the file and every directory above it below the drive root, along both its given and its real path, owned by, and writable by no identity other than, the Administrators group, SYSTEM, a service account, or the creator owner or group, which this adapter does not run [[28]][[31]] |
| a system settings, system-defaults, user, or workspace settings layer a decision reads | evaluated as the runtime loads it [[47]]: every string at any depth expanded for `$VAR`, `${VAR}`, and `${VAR:-default}` against the parent's environment as [[gemini-56](#gemini-56)] gives it to the child, plus [[gemini-10](#gemini-10)]'s default, so that a string naming `GEMINI_CLI_TRUST_WORKSPACE` expands to that default, and `GEMINI_CLI_NO_RELAUNCH` set to `true` where the runtime relaunches to load its settings, unless `GEMINI_CLI_NO_RELAUNCH` or `SANDBOX` is non-empty [[61]][[62]], a set variable, even one set to the empty string, taking its value, and an unset one its default or else staying as written [[48]]; then read both as written and with `true` or `false` in any letter case made a boolean at `security.folderTrust.enabled`, `skills.enabled`, `advanced.ignoreLocalEnv`, `tools.sandbox`, and an object `tools.sandbox`'s `enabled`, where those two readings differ in effect, because the runtime's schema validation so preprocesses boolean-typed settings, a boolean being the first form `tools.sandbox` takes, but keeps the file's strings unless the whole file validates, which this adapter does not check [[47]][[49]][[50]][[53]][[54]][[59]][[72]]; since the runtime reads each of these settings by its truthiness [[17]][[35]][[46]][[68]][[80]][[81]], only a `false` string in any letter case reads differently, and at a top-level `tools.sandbox`, whose string requests a sandbox unless it is exactly empty, `0`, or `false` [[16]], only one other than exactly `false`; it diverges where a string names a variable this adapter or the runtime sets only for the child, `GEMINI_CLI_HOME` naming the overlay, a telemetry control [[gemini-42](#gemini-42)], or the `NODE_OPTIONS` of the relaunched process [[64]], each expanding to the parent's value here |
| settings layers a decision merges | merged in the order given over the schema's defaults of the top-level `policyPaths`, an empty list, and `advanced.excludedEnvVars`, a list of `DEBUG` and `DEBUG_MODE` [[72]], later layers winning: a plain-object value merges into a plain-object value key by key, any other value, `null` and arrays included, replaces, and `__proto__`, `constructor`, and `prototype` keys are skipped, except that each of those two settings, while its merged value is a list, takes the runtime's union strategy, appending a layer's list or lone value and keeping only each value's first occurrence, so that the top-level `policyPaths` always merges to a list, as the runtime merges them, its other schema defaults and per-setting merge strategies changing no decision so drawn [[43]][[44]][[55]][[56]] |
| the environment the child decides its sandbox in, once its settings load [[73]] | the environment it expands its settings in, as the evaluation row above states, plus each variable of the one `.env` file it then loads that this environment lacks, on Windows in every letter case [[gemini-56](#gemini-56)], the file parsed as dotenv 17.1.0, which the runtime pins, parses it [[66]][[68]][[70]][[71]]: the file found from the child's working directory upward, in each directory its `.gemini/.env` where the workspace is trusted and then its `.env` unless `advanced.ignoreLocalEnv` is truthy and the directory is not the child's home, the overlay directory as the child receives it in `GEMINI_CLI_HOME` [[10]], which no directory from the working directory upward is, and past the root the `.gemini/.env` where trusted and then the `.env` the child spells under that home, which the overlay links to the real home's files, so that those decide, each file existing as the runtime's `existsSync` finds it, which on Windows also reads the status of the file a symbolic link names, so that a dangling link does not exist there [[79]], and a file that cannot be read loading nothing [[67]]; where the workspace is untrusted only `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION` loading, and a file whose path as the child spells it lacks `.gemini` skipping each name its `advanced.excludedEnvVars` holds, a string holding each of its substrings and another truthy value stopping the loading at the first name checked against it, or, where that setting is falsy, `DEBUG`, `DEBUG_MODE`, `GEMINI_CLI_IDE_SERVER_STDIO_COMMAND`, and `GEMINI_CLI_IDE_SERVER_STDIO_ARGS` [[69]]; the workspace trusted as [[gemini-55](#gemini-55)] decides, but under the folder-trust setting of the system-default, user, trusted workspace, and system settings merged as the row above states, from which these settings are also taken; the Cloud Shell setup, which sets only `GOOGLE_CLOUD_PROJECT`, and the `-s`, `--sandbox`, and `--ignore-env` flags, which this adapter never passes, left out |
| Gemini would start its own sandbox under any reading of a layer the rows above allow: in the environment it decides its sandbox in, `SANDBOX` empty or unset and a `GEMINI_SANDBOX` other than empty, `0`, or `false`, or, with none, a `tools.sandbox` requesting it in the system-default, user, workspace, and system settings merged in that order, the workspace settings counting only where the workspace is trusted [[gemini-55](#gemini-55)], each layer evaluated and each system file located and counted as the rows above state: `true`, a string other than empty, `0`, or `false`, or, on macOS, whose `sandbox-exec` always exists, another truthy value, where an object with a truthy `enabled` counts as its `command`, `true` where that is unset or null, and an array or another object as `false` | deliver no alias, as for the real home, because the sandbox confines writes to paths under the home it is given, which the overlay's links leave [[16]][[17]][[18]][[51]] |
| overlay | the overlay directory, given to the child as `GEMINI_CLI_HOME`, whose `.gemini/settings.json` is the real user settings with the reserved Cligent alias replaced by its self-contained model and thinking configuration and any admitted MCP entries selected by [[gemini-48](#gemini-48)], which the runtime's validation accepts exactly where it accepts the real settings, because each rewrite keeps or removes only values whose validity it preserves, `modelConfigs.customAliases` validating any entry [[74]][[75]] and each per-run MCP entry validating, except that a same-name MCP replacement, which can make the settings validate, proceeds only as [[gemini-48](#gemini-48)] admits it, where that changes no reading the runtime coerces |
| every other real `.gemini` entry and every other real home entry | an overlay link to the real entry, so credentials, sessions, trust state, and other home state read and write through to the real home: a symbolic link, except on Windows a junction for a directory and a hard link for a file where symbolic links are not permitted |
| real `.gemini`, `.gemini/tmp`, or `.gemini/history` absent | create it in the real home before linking, so session state lands there directly |

The overlay settings file is written with mode `0600`; a setup failure removes the overlay before rejecting, and a successful return points only the child environment at the overlay until [[gemini-45](#gemini-45)] reconciles it and [[gemini-35](#gemini-35)] removes it.

### gemini-45

When cleanup reaches a run's settings overlay after its child has closed, the adapter shall reconcile into the real home each entry of the overlay home and of its `.gemini` that is no longer the link it created, before removing the overlay, attempting every entry and rejecting cleanup with each one it could not reconcile, through this matrix, because the CLI replaces some files by writing a temporary file and renaming it over the link [[15]]:

| Overlay entry at cleanup | Real-home outcome |
| --- | --- |
| the link the adapter created, or a link naming the same real entry in its place, or no entry where that link was | nothing |
| the overlay's `.gemini/settings.json` | nothing; settings written during the run stay in the overlay |
| the overlay's `.gemini/skills` directory created by [[gemini-51](#gemini-51)] | nothing for the run's skills and the links it placed; reconcile every other entry Gemini created there through the rows below, creating a missing real `.gemini/skills` but never a missing real `.gemini` |
| a `.gemini` name marking an unfinished or locked write, with a `.tmp` segment or a `.rollback` or `.lock` suffix | nothing |
| `.gemini/projects.json` | add the project entries the real registry lacks while holding the registry's `.lock` directory, which counts as stale after 10 s untouched; a lock still held after 10 s leaves the registry to Gemini's ownership markers |
| another non-directory entry | replace the real entry with it atomically, unless the real entry is a directory |
| a directory absent from the real home | move it into the real home |
| a directory the real home also holds | copy in only the entries the real directory lacks, at every depth |

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

### gemini-57

When capability discovery is asked for the browser against Gemini fixtures that vary the user settings, the child environment, and the per-run servers, integration checks shall verify the child's environment naming no home reported as a restriction, a same-name replacement that the entry schema and a coercible string reject reported as another, and a supported report that creates no directory [[gemini-48](#gemini-48)].

### gemini-49

When a real fixture subprocess reads its per-run Gemini settings and policy files, the integration check shall verify both MCP transports, same-name transport replacement, preservation of ambient settings, scoped trust without removing explicit tool denials, unchanged real settings, overlay cleanup, browser delivery rejected before spawn in home-workspace and native-sandbox cases [[gemini-48](#gemini-48)], and this case matrix:

| Case | Assertions |
| --- | --- |
| under an injected Windows platform and the adapter's own admission check, a run without skills selecting the browser beside an existing system settings file disabling the sandbox the user settings request | the file counted [[gemini-34](#gemini-34)]: the browser prepared and delivered through the overlay [[gemini-48](#gemini-48)] |
| without skills, a per-run MCP server beside user settings holding an entry of its name made invalid by an unknown key beside `"5"` at `model.maxSessionTurns`, beside `"TRUE"` in a list inside a list element, and beside `${COERCED_FLAG}` with `COERCED_FLAG` set to `false`; an entry of its name with a `trust` of `"yes"` beside `"5"`; an entry of its name with a `null` `command` beside `"5"`; entries of its name with a `type` of `"ws"`, with `args` holding a number, with `env` holding a number, with a string `oauth`, and with an `authProviderType` of `"oauth2"`, each beside `"5"`; and a `null` entry of its name beside `"5"` | a rejection naming the entry, the failing property or that the entry is no object, and the string with its path, `custom.nested[0].list[1]` for the list element and the expanded `false` for the variable, as `init`, a non-recoverable `GEMINI_STREAM_ERROR`, and error `done`, without spawn [[gemini-19](#gemini-19)], [[gemini-48](#gemini-48)] |
| without skills, a per-run MCP server beside user settings holding a valid entry of its name, with string `args` and `env`, a `type` of `stdio`, a `timeout` of `" 30 "`, a `trust` of `"FALSE"`, an `authProviderType` value, an `extension` holding `null`, and an `oauth` object, beside `"TRUE"` and `"5"` elsewhere; beside user settings holding an entry of its name made invalid by an unknown key beside only its own `trust` of `"false"`; and beside user settings holding an entry of its name made invalid by an unknown key beside a blank string `" "` elsewhere | the server delivered through the overlay, replacing the entry and keeping every other value as written [[gemini-48](#gemini-48)] |

### gemini-47

When integration tests run with supplied attachment values, they shall verify snapshot identity and order, explicit MIME canonicalization, unchanged cwd and originals, omitted and empty-list prompt preservation, size and contextual rejection before spawn, cancellation, and snapshot cleanup before terminal delivery [[gemini-46](#gemini-46)].

### gemini-50

Where the pinned native CLI is installed, when an isolated loopback provider records the real adapter invocation, the acceptance test shall verify exact bytes, MIME types, and ordering for every advertised media format, source filenames containing spaces and glob characters, an extension overridden by MIME, a space-bearing temporary directory, unchanged cwd, and snapshot cleanup [[gemini-46](#gemini-46)].

### gemini-201

Given canned native Gemini NDJSON flows, when the adapter runs, the emitted events shall match this normalization matrix:

| Flow | Assertions |
| --- | --- |
| canonical init, message, tool use, tool result, native error, and result | exact ordered event types, session identity, init tool source, and canonical payload fields [[gemini-4](#gemini-4)], [[gemini-16](#gemini-16)], [[gemini-20](#gemini-20)], [[gemini-21](#gemini-21)], [[gemini-22](#gemini-22)], [[gemini-23](#gemini-23)], [[gemini-24](#gemini-24)], [[gemini-25](#gemini-25)], [[gemini-27](#gemini-27)], [[gemini-43](#gemini-43)] |
| native init naming a model, the per-run effort alias, or no model, with and without a requested model | `reportedModel` presence and absence beside the unchanged `model` selection [[gemini-20](#gemini-20)] |
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
| generated alias | self-contained model configuration delivered through the per-run user-settings overlay [[gemini-34](#gemini-34)] |

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
| concrete-model effort | the child's `GEMINI_CLI_HOME` is a private overlay [[gemini-56](#gemini-56)] whose `0600` settings are the real user settings, read from the caller's `GEMINI_CLI_HOME` or the home the child environment's `HOME` names, with comments stripped and unknown keys and existing aliases preserved, plus the self-contained alias; every other real `.gemini` and home entry is a link, and a credential written through it lands in the real file; missing shared state directories are created in the real home; malformed settings reject before spawn; system settings and defaults paths are untouched; a working directory that is, or links to, the real home, with no overlay directory reserved while the child runs, or, on POSIX, that a `..` after a symbolic link places in it, a child environment naming no home, its `HOME` empty, or absent beside an empty recorded home, and `GEMINI_CLI_HOME` unset under an injected Linux environment platform, with none reserved either, and a sandbox the environment, a trusted workspace `.gemini/.env`, a project `.env` that a user `advanced.ignoreLocalEnv` of `"false"` loads only coerced, a `.gemini/.env` above the real home that a user `advanced.ignoreLocalEnv` reaches past the home's `.env` setting `GEMINI_SANDBOX=false` from a run cwd inside the home, or the merged settings layers request, including an existing system settings file under an injected Windows platform, a user sandbox object whose `enabled` is `"false"`, which requests one as written, and a user request that a `GEMINI_SANDBOX=false` in the `.env` of a real home whose path holds `.gemini` leaves standing under user `advanced.excludedEnvVars` naming it, the child's home being the overlay, get no overlay and `--model=<model>`, while a request a higher layer overrides, or one in the settings of a workspace `GEMINI_CLI_TRUST_WORKSPACE=false` distrusts [[gemini-55](#gemini-55)], does not; and the overlay is removed after success, stream error, abort, and a setup failure once it exists, as is its reserved directory wherever no overlay is delivered [[gemini-34](#gemini-34)], [[gemini-35](#gemini-35)] |
| overlay reconciliation | a registry replaced during the run adds to the real `projects.json` only the entries it lacks, keeping a real entry on conflict and releasing the lock; other replaced `.gemini` and home files replace the real ones; new files and directories move into the real home; a directory the real home holds gains only missing entries; while untouched, recreated and deleted links, overlay settings, and `.gemini` unfinished-write leftovers leave the real home unchanged, a home-level name of the same form moving in [[gemini-45](#gemini-45)] |
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

### gemini-53

When a real fixture subprocess reads its per-run Gemini settings, skills, and policy files for runs with skill fixtures, the integration check shall verify this case matrix and the overlay's removal after every case [[gemini-35](#gemini-35)]:

| Case | Assertions |
| --- | --- |
| a real `.gemini/skills` entry with and without a shadowing name, case variant, or same entry name under another skill name | the overlay skills directory's layout and links [[gemini-51](#gemini-51)] |
| user settings naming a run skill or its case variant in a `skills.disabled` list, a lone-string `skills.disabled` naming a run skill's case variant, a lone string naming no run skill, and a `skills.disabled` list of `$RUN_SKILL`, set to a run skill's name in upper case, and `${OTHER_SKILL}`, set to another skill's | the settings rewrite, the matched lone string replaced by `:` and the unmatched lone string and `${OTHER_SKILL}` retained as written, with the real settings file byte-identical [[gemini-51](#gemini-51)] |
| an untrusted workspace | unchanged trust [[gemini-51](#gemini-51)] |
| a real-home cwd, a requested native sandbox, user settings setting `skills.enabled` to `false`, `0`, the empty string, `${ENABLE_SKILLS}` with `ENABLE_SKILLS` set to the empty string, and `"false"`, and a skill path that fails preparation | each rejection as `init`, a non-recoverable `GEMINI_STREAM_ERROR`, and error `done`, without spawn or browser preparation [[gemini-19](#gemini-19)], [[gemini-51](#gemini-51)], each falsy value named as JSON that the runtime reads as off and `"false"` named as a string the runtime coerces only where the whole file validates [[gemini-51](#gemini-51)] |
| user settings setting `skills.enabled` to `null` and to `"0"` | skills delivered, each read as on, with the settings kept as written [[gemini-51](#gemini-51)] |
| user settings enabling a `docker` sandbox object that trusted workspace settings complete with `networkAccess: false`; a user `tools.sandbox` of `${USE_SANDBOX:-false}` under `USE_SANDBOX=true`; admitted system settings' `tools.sandbox` of `true` over a trusted workspace's `false`; a user sandbox object enabled with a `null` `command`; and a trusted workspace `tools.sandbox` of `${WS_SANDBOX:-true}` with `WS_SANDBOX` unset | a sandbox rejection as for a requested native sandbox [[gemini-51](#gemini-51)], the layers merged and evaluated [[gemini-34](#gemini-34)] |
| workspace `tools: null` over a user `tools.sandbox` of `true`; a user sandbox object enabled with an empty `command`; a user `tools.sandbox` of `${USE_SANDBOX:-false}` with `USE_SANDBOX` unset; admitted system settings' `tools.sandbox` of `false` over a trusted workspace's `true`; a trusted workspace `tools.sandbox` of `[]` over a user `docker` sandbox object; a trusted workspace `tools.sandbox` of `${WS_SANDBOX:-true}` under `WS_SANDBOX=false`; and a user `tools.sandbox` of `${EMPTY_SANDBOX:-docker}` with `EMPTY_SANDBOX` set to the empty string | skills delivered [[gemini-51](#gemini-51)], the merged and evaluated layers starting no native sandbox, a lower-case `false` so read either way [[gemini-34](#gemini-34)] |
| user settings whose `__proto__` key holds a `tools.sandbox` of `true` | skills delivered [[gemini-51](#gemini-51)], the key skipped in the merge, with `Object.prototype` unchanged [[gemini-34](#gemini-34)] |
| on POSIX, a user `tools.sandbox` of `1` under an injected macOS platform and under an injected Linux platform | a sandbox rejection as for a requested native sandbox on macOS and skills delivered on Linux [[gemini-51](#gemini-51)], as [[gemini-34](#gemini-34)] reads a value neither `true` nor a string |
| user settings setting `security.folderTrust.enabled` to `"false"` beside a workspace `tools.sandbox` of `true` under file-based trust with no trusted-folders rule, `tools.sandbox` to `"FALSE"`, alone and beside `advanced.ignoreLocalEnv` of `"TRUE"`, an object `tools.sandbox`'s `enabled` to `"false"`, and `advanced.ignoreLocalEnv` to `"false"` beside a project `.env` setting `GEMINI_SANDBOX=docker`, alone and beside a `tools.sandbox` of `"false"`; and user settings setting `security.folderTrust.enabled` to `"false"`, to `"FALSE"`, and to `${UNSET_TRUST:-false}` with `UNSET_TRUST` unset, under file-based trust with no trusted-folders rule, beside workspace `policyPaths` | a rejection naming the user settings, only the setting whose `false` string reads differently as written and coerced, an exact `"false"` at a top-level `tools.sandbox` reading alike [[gemini-34](#gemini-34)], and that the runtime coerces that string only where the whole file validates, for whether the native sandbox starts in the first six cases and for the policy sources in the others, as `init`, a non-recoverable `GEMINI_STREAM_ERROR`, and error `done`, without spawn [[gemini-19](#gemini-19)], [[gemini-51](#gemini-51)], each layer read both as written and coerced [[gemini-34](#gemini-34)] |
| user settings setting `security.folderTrust.enabled` to `"TRUE"` under file-based trust beside workspace `policyPaths`, with and without a trusted-folders rule trusting the workspace | skills delivered without a rejection [[gemini-51](#gemini-51)], the string reading alike as written and coerced [[gemini-34](#gemini-34)], and the workspace `policyPaths` appended only where the rule trusts the workspace [[gemini-55](#gemini-55)] |
| cancellation during skill preparation and during settings setup | `init` and interrupted `done`, without spawn or a remaining overlay [[gemini-51](#gemini-51)] |
| absent, `activate_skill`-bearing, denying, and excluding tool lists, and a permission-bearing policy | the generated `activate_skill` rule, a same-priority deny serialized before it, and every tool-list outcome, an excluding list throwing before any event [[gemini-52](#gemini-52)] |
| a user policy directory with and without `policyPaths` in user, admitted system, and trusted-workspace settings, some naming an environment variable, one path named in both user and workspace settings, and a lone system-settings value; and a lone admitted system-defaults value that a user list repeats after its own path | the merged policy sources appended only beside the skills-only policy, in merge order, each path once [[gemini-55](#gemini-55)], the layers merged by union, each lone value joining, and each expanded [[gemini-34](#gemini-34)] |
| user `policyPaths` naming a variable unset with no default and naming `GEMINI_CLI_TRUST_WORKSPACE` while the caller leaves it unset; and user `policyPaths` naming in upper case a variable set in mixed case, under an injected Windows environment platform and under the host's | the unset variable kept as written and the child's default `true` [[gemini-10](#gemini-10)] expanded [[gemini-34](#gemini-34)]; the mixed-case variable read only on Windows [[gemini-56](#gemini-56)] and expanded [[gemini-34](#gemini-34)]; each source resolved and appended [[gemini-55](#gemini-55)] |
| user `policyPaths` naming `GEMINI_CLI_NO_RELAUNCH` while the caller leaves it unset, with `SANDBOX` unset and set, and while the caller sets it to the empty string | `true` expanded where the runtime relaunches, as it does for the empty string, and the name kept as written under the `SANDBOX` [[gemini-34](#gemini-34)], each source appended [[gemini-55](#gemini-55)] |
| under an injected Windows environment platform, on POSIX, user `policyPaths` naming `cligent_root` while `CLIGENT_ROOT` and `cligent_root` hold different values; on POSIX, a lower-case `gemini_cli_trust_workspace=false` beside a trusted-folders rule trusting the workspace and workspace `policyPaths`; on POSIX, a lower-case `gemini_cli_home` naming the real home; on POSIX, a lower-case `gemini_sandbox=false` beside a trusted workspace `.gemini/.env` setting `GEMINI_SANDBOX=docker`; and a lower-case `gemini_cli_system_settings_path` override naming `policyPaths`, admitted through an injected admission check | the value of `CLIGENT_ROOT`, which sorts first [[gemini-56](#gemini-56)], expanded [[gemini-34](#gemini-34)]; no upper-case default added [[gemini-10](#gemini-10)] and the workspace untrusted, with the user policy directory appended [[gemini-55](#gemini-55)]; the real home's settings in the overlay [[gemini-34](#gemini-34)], which alone the child receives under that name [[gemini-56](#gemini-56)]; skills delivered, the file's variable not loaded beside the lower-case one [[gemini-34](#gemini-34)]; and the override's file checked [[gemini-34](#gemini-34)] and its `policyPaths` appended [[gemini-55](#gemini-55)] |
| `GEMINI_SANDBOX=docker` in a trusted workspace's `.gemini/.env`, alone and under user `advanced.excludedEnvVars` naming it or user `advanced.ignoreLocalEnv`; in the workspace's project `.env`, alone and under a lone-string user `advanced.excludedEnvVars` of `GEMINI_SANDBOX_OTHER`; in a project `.env` two directories above the run cwd; in the home's `.gemini/.env` and, alone, in its `.env`, with the run cwd outside the home; in a `.gemini/.env` above the home, beside the home's `.env` setting `GEMINI_SANDBOX=false` under user `advanced.ignoreLocalEnv`, with the run cwd inside a real home spelled as its real path; and, as `GEMINI_SANDBOX=false` excluded by user `advanced.excludedEnvVars` beside a user `tools.sandbox` of `true`, in the `.env` of a real home whose path holds `.gemini`, with the run cwd outside it | a sandbox rejection as for a requested native sandbox [[gemini-51](#gemini-51)], the variable loaded into the environment the child decides its sandbox in, the lone string merged by union into the schema's default list, the search climbing from the run cwd and falling back to the home's files, and, the child's home being the overlay, the real home's `.env` skipped under `advanced.ignoreLocalEnv` and, spelled under the overlay, read as a project file [[gemini-34](#gemini-34)] |
| a `.gemini/.env` setting `GEMINI_SANDBOX=docker` in a workspace `GEMINI_CLI_TRUST_WORKSPACE=false` distrusts, beside a project `.env` setting it too; in a workspace user settings trust by disabling folder trust while its own settings enable it under file-based trust with no trusted-folders rule; beside a parent `GEMINI_SANDBOX=false`; and beside a parent `GEMINI_SANDBOX` set to the empty string; a trusted workspace `.gemini/.env` setting another variable beside a project `.env` setting `GEMINI_SANDBOX=docker` in the same directory; a project `.env` setting `GEMINI_SANDBOX=docker` under user `advanced.excludedEnvVars` naming it and under user `advanced.ignoreLocalEnv`; and, beside a user `tools.sandbox` of `true`, a `.gemini/.env` holding `SANDBOX=1`, holding `export GEMINI_SANDBOX="false" # trailing` after a comment line, holding `GEMINI_SANDBOX='false'`, and holding, with CRLF line ends, `GEMINI_SANDBOX: false` after another variable | skills delivered [[gemini-51](#gemini-51)], the variable not loaded where the workspace is untrusted for the file, held by the parent, even empty, excluded, ignored, or in a file found after the directory's `.gemini/.env`, and otherwise loaded as parsed [[gemini-34](#gemini-34)] |
| an empty `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` beside a system-defaults file naming `policyPaths` beside the system settings path, admitted through an injected admission check | that file read [[gemini-34](#gemini-34)], its `policyPaths` appended [[gemini-55](#gemini-55)] |
| a `GEMINI_CLI_HOME` with a trailing `/` beside user `policyPaths` of `%USERPROFILE%pol` and `~/../team-pol`; and user `policyPaths` of an empty string and `null` beside a user policy directory | each entry spliced onto the real home as spelled, not onto the overlay, spliced onto which the second would name a path beside the overlay in its temporary directory, then normalized, the first inside the real home and the second beside it; and both entries dropped, with no user policy directory appended in their place [[gemini-55](#gemini-55)] |
| with `GEMINI_CLI_HOME` unset, a decoy standing in for this process's own home lookup, and another home for the one the operating system records for the process user, under injected Linux and Windows environment platforms: the child environment's `HOME` and `USERPROFILE`, respectively, naming a home whose user settings name `policyPaths` of `~/pol`, the other variable naming the decoy; that home's `.env` setting `GEMINI_SANDBOX=docker`; that variable absent; an empty `HOME` under Linux, a `USERPROFILE` of `C:` under Windows, and, under Linux, that variable absent beside an empty recorded home; and, under Windows, a `USERPROFILE` of `€`, three bytes in UTF-8, naming a directory in the run cwd | the overlay holding that home's settings and the entry spliced onto that home [[gemini-34](#gemini-34)], [[gemini-55](#gemini-55)]; a sandbox rejection as for a requested native sandbox [[gemini-51](#gemini-51)], that home's `.env` loaded [[gemini-34](#gemini-34)]; the overlay holding the recorded home's settings, not the decoy's [[gemini-34](#gemini-34)]; a skills rejection naming the variable and its value, or the recorded home and its value, as `init`, a non-recoverable `GEMINI_STREAM_ERROR`, and error `done`, without spawn [[gemini-19](#gemini-19)], [[gemini-34](#gemini-34)], [[gemini-51](#gemini-51)]; and the overlay holding that directory's settings [[gemini-34](#gemini-34)] |
| on POSIX as a non-root user under the adapter's own admission check, user-owned system settings and defaults requesting the native sandbox, disabling folder trust, and naming `policyPaths`, beside workspace `policyPaths` no trusted-folders rule trusts | no layer counted: skills delivered without a sandbox rejection [[gemini-34](#gemini-34)], the workspace `policyPaths` unmerged, and the user policy directory appended in place of any system `policyPaths` [[gemini-55](#gemini-55)] |
| system settings or defaults admitted through an injected admission check, because a test cannot create root-owned files, requesting the native sandbox, or disabling folder trust and naming `policyPaths` | a sandbox rejection as for a requested native sandbox [[gemini-34](#gemini-34)], or, with exactly the configured paths checked, the workspace trusted and the system-defaults, workspace, and system-settings `policyPaths` appended in that order [[gemini-55](#gemini-55)] |
| a relative system settings override requesting the native sandbox under a run cwd other than the parent's, admitted through an injected admission check | a sandbox rejection [[gemini-34](#gemini-34)] |
| on POSIX, relative system settings, system-defaults, trusted-folders, and `GEMINI_CLI_HOME` overrides climbing with `..` out of a run cwd entered through a symbolic link, each system file admitted through an injected admission check, beside decoys where lexical resolution from the link lands | each resolved against the run cwd's real path [[gemini-34](#gemini-34)]: both system files checked, their `policyPaths` and the real home's user `policyPaths` merged, and the trusted-folders rule trusting the workspace [[gemini-55](#gemini-55)] |
| on POSIX, a run cwd ending in `..` after a symbolic link, with a relative trusted-folders override, beside decoy trusted-folders and workspace files, the latter requesting the native sandbox, where lexical resolution lands | the child running in the physical directory the operating system resolves [[gemini-34](#gemini-34)], whose trusted-folders file trusts it and whose workspace `policyPaths` are appended [[gemini-55](#gemini-55)] |
| on POSIX, system settings and trusted-folders overrides naming files with a trailing `/`, the system settings file requesting the native sandbox under an injected admission check and the trusted-folders file trusting the workspace | no file the child finds read [[gemini-34](#gemini-34)]: skills delivered with no admission checked [[gemini-51](#gemini-51)], and the workspace untrusted, with the user policy directory appended [[gemini-55](#gemini-55)] |
| on POSIX, a trusted-folders override `jump/../trusted.json`, where `jump` is a symbolic link in the run cwd to a directory elsewhere, the file in the parent of the directory the link names, which `jump/../trusted.json` opens, trusting the workspace beside a decoy distrusting it where lexical resolution lands | the file the child opens read [[gemini-34](#gemini-34)]: the workspace trusted, with its `policyPaths` appended [[gemini-55](#gemini-55)] |
| on POSIX, a system settings override `jump/../sys/settings.json` through such a link opening no file, beside a decoy requesting the native sandbox where lexical resolution lands, under an injected admission check | nothing checked or read [[gemini-34](#gemini-34)]: skills delivered [[gemini-51](#gemini-51)] |
| on POSIX, that override with `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` unset, beside system-defaults files naming `policyPaths` at the lexically joined path and through the link, under an injected admission check | the system defaults checked and read at the lexically joined path [[gemini-34](#gemini-34)], their `policyPaths` appended [[gemini-55](#gemini-55)] |
| on POSIX as a non-root user under the adapter's own admission check, system settings and defaults overrides climbing out of such a link to user-owned files naming `policyPaths`, without and with user-owned decoys where lexical resolution lands | admission checked at the lexical path and the opened file read [[gemini-34](#gemini-34)]: without decoys, both files counted, their `policyPaths` appended; with them, both skipped, the user policy directory appended [[gemini-55](#gemini-55)] |
| file-based trust under the default folder-trust setting with rules keyed `.`; keyed `..\` followed by the run cwd's name; keyed a child of the run cwd under `TRUST_PARENT`; keyed the run cwd in the `.cache/.gemini` file under a `sandbox-exec` `SANDBOX`, beside a `.gemini` file distrusting it; keyed the run cwd in the `.gemini` file under another `SANDBOX`, beside a `.cache/.gemini` file distrusting it; keyed the run cwd plus `/.` segments distrusting it and then a child of the run cwd under `TRUST_PARENT`, the longer raw key the shorter normalized one; on POSIX, keyed the run cwd trusting it and then an equally long link to it distrusting it; on POSIX, keyed `../proj` for a run cwd entered through a symbolic link to a `proj` directory, beside a decoy `proj` where lexical resolution lands, with workspace `policyPaths` of `ws-pol` and `../ws-pol`; keyed the run cwd's real path in upper case on macOS and Windows; and keyed that path with backslash separators on Windows | the workspace trusted, with its `policyPaths` appended, each resolved against the run cwd's real path [[gemini-55](#gemini-55)] |
| file-based trust under the default folder-trust setting with rules keyed the parent process's working directory; keyed `.` and then the run cwd's real path distrusting it; keyed the run cwd distrusting it and then its parent trusting it; keyed in NFC a run cwd named in NFD; keyed the run cwd trusting it beside a rule of an invalid level; on POSIX, keyed the run cwd distrusting it and then an equally long link to it trusting it; keyed the run cwd's real path in upper case on other platforms; keyed that path with backslash separators on other platforms; a malformed file whose text names a trusting rule; and an unreadable file | the workspace untrusted, with the user policy directory appended in place of its `policyPaths` [[gemini-55](#gemini-55)] |
| a rule keyed `.` under `GEMINI_RESTRICTED_MODE=true` and the default `GEMINI_CLI_TRUST_WORKSPACE`, and under `GEMINI_CLI_TRUST_WORKSPACE=false`; and, with no rule, admitted system defaults disabling folder trust beside user settings enabling it or setting `security` to `null`, and user settings disabling it beside admitted system settings enabling it | the workspace untrusted, with the user policy directory appended in place of its `policyPaths` [[gemini-55](#gemini-55)], the layers merged [[gemini-34](#gemini-34)] |
| under an injected Windows platform and the adapter's own admission check, an existing system settings file naming neither `policyPaths` nor folder trust, one with empty `policyPaths`, and absent system files | skills delivered [[gemini-51](#gemini-51)] with the user policy directory appended [[gemini-34](#gemini-34)], [[gemini-55](#gemini-55)] |
| under an injected Windows platform and the adapter's own admission check, an existing system-defaults file disabling folder trust under the default `GEMINI_CLI_TRUST_WORKSPACE`, beside workspace `policyPaths` | skills delivered [[gemini-51](#gemini-51)] with the workspace `policyPaths` appended [[gemini-34](#gemini-34)], [[gemini-55](#gemini-55)] |
| a per-run MCP server beside the browser, and the browser alone, under file-based trust with no trusted-folders rule, beside user settings setting `security.folderTrust.enabled` to `"false"` and then holding an entry of that server's name made invalid by an unknown key, with a `trust` of `"TRUE"` | a rejection naming the entry, its unknown key, and the first string's path, `security.folderTrust.enabled`, as `init`, a non-recoverable `GEMINI_STREAM_ERROR`, and error `done`, without spawn or browser preparation [[gemini-19](#gemini-19)], [[gemini-48](#gemini-48)] |
| under file-based trust with no trusted-folders rule, a per-run MCP server beside user settings holding an entry of its name made invalid by an unknown key and no string the runtime could coerce, and beside user settings setting `security.folderTrust.enabled` to `"false"` and holding only an entry of another name | the server delivered through the overlay, replacing any same-name entry and keeping every other value as written [[gemini-48](#gemini-48)] |
| under an injected Windows platform and the adapter's own admission check, an existing system settings file naming `policyPaths`; an existing system-defaults file disabling folder trust under file-based trust, beside workspace `policyPaths` and no trusted-folders rule; an existing system settings file disabling the sandbox the user settings request, beside an existing system-defaults file changing nothing; existing system settings disabling and system defaults requesting the sandbox; an existing system-defaults file disabling folder trust under file-based trust, beside workspace settings disabling the sandbox the user settings request and no trusted-folders rule; existing system settings requesting the sandbox beside user settings setting `tools.sandbox` to `"FALSE"`; an existing system-defaults file setting `tools.sandbox` to `"FALSE"`; and an existing system settings file requesting the sandbox and setting `security.folderTrust.enabled` to `"false"` under the default `GEMINI_CLI_TRUST_WORKSPACE` | a rejection naming, for the policy sources, the system settings in the first case and the system defaults in the second, and, for whether the native sandbox starts, only the system settings in the third, both files in the fourth, in the fifth the system defaults, whose folder trust decides whether the workspace settings count [[gemini-34](#gemini-34)], in the sixth the user settings, for their coerced `tools.sandbox`, before the system settings, in the seventh the system defaults once, for both their admission and their coerced `tools.sandbox`, and in the eighth the system settings for their admission alone, their string, whose coercion that default leaves without effect, unnamed, each file once in merge order, with that this adapter does not run the runtime's check of each file named for its admission and that the runtime coerces each string named only where the whole file validates, as `init`, a non-recoverable `GEMINI_STREAM_ERROR`, and error `done`, without spawn or browser preparation [[gemini-19](#gemini-19)], [[gemini-51](#gemini-51)] |
| under an injected Windows platform and the adapter's own admission check, an existing system settings file completing with `networkAccess: false` the `docker` sandbox object the user settings enable | a sandbox rejection naming no file, counting and skipping the file merging to the same request [[gemini-34](#gemini-34)], [[gemini-51](#gemini-51)] |
| a comma-bearing or untrimmed `policyPaths` entry, and a comma-bearing temporary directory | a setup rejection before spawn naming the path [[gemini-55](#gemini-55)] |
| no skills | no policy file [[gemini-12](#gemini-12)] |
| an entry Gemini adds during the run, beside a present or absent real `.gemini/skills` | reconciliation of the added entry, creating the real skills directory where absent, with the run's entries left unreconciled [[gemini-45](#gemini-45)] |
| a real `.gemini` removed during the run while Gemini adds entries to the overlay's `.gemini` and skills directory | a cleanup rejection naming each entry, with the real `.gemini` not recreated [[gemini-45](#gemini-45)] |

### gemini-54

Where [[gemini-219](#gemini-219)]'s executable and credential preconditions hold and no native sandbox is requested, when a run supplies a fixture skill whose body directs a unique token reply and the prompt names the skill, the acceptance check shall verify against the real runtime that the reply carries the token [[gemini-51](#gemini-51)], [[gemini-52](#gemini-52)] and that the overlay is gone once the adapter's own event stream completes [[gemini-35](#gemini-35)].

## References

[1]: https://ai.google.dev/gemini-api/docs/thinking 'Gemini API: Thinking'
[2]: https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md 'Google Gemini CLI: Configuration reference'
[3]: https://geminicli.com/docs/reference/policy-engine/ 'Gemini CLI: Policy engine'
[4]: https://geminicli.com/docs/cli/cli-reference/ 'Gemini CLI: CLI reference'
[8]: https://geminicli.com/docs/cli/telemetry/ 'Gemini CLI telemetry'
[9]: https://github.com/googleapis/js-genai/blob/38cac5bbf4941ec5fa760238bd423c0ecc2c6f04/src/types.ts#L2607-L2628 'Google Gen AI SDK 1.30.0 UsageMetadata'
[10]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/paths.ts#L17-L28 'Gemini CLI 0.61.0 home directory honoring GEMINI_CLI_HOME'
[11]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings.ts#L849-L890 'Gemini CLI 0.61.0 root-owned system files, user settings, and home-workspace settings skip'
[12]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/config/storage.ts#L207-L224 'Gemini CLI 0.61.0 workspace-is-home check'
[13]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/services/FileCommandLoader.ts#L216-L226 'Gemini CLI 0.61.0 project commands skipped in the home directory'
[14]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/policy.ts#L108-L118 'Gemini CLI 0.61.0 workspace policies skipped in the home directory'
[15]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/config/projectRegistry.ts#L103-L135 'Gemini CLI 0.61.0 project registry saved through a temporary file and rename'
[16]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/sandboxConfig.ts#L43-L63 'Gemini CLI 0.61.0 sandbox request: SANDBOX, then GEMINI_SANDBOX over the configured value'
[17]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/sandboxConfig.ts#L126-L148 'Gemini CLI 0.61.0 tools.sandbox setting forms'
[18]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/utils/sandbox.ts#L216-L224 'Gemini CLI 0.61.0 macOS sandbox home path from the real path of its home'
[19]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/nonInteractiveCli.ts#L257-L275 'Gemini CLI 0.61.0 headless prompt reference expansion'
[20]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/fileUtils.ts#L577-L614 'Gemini CLI 0.61.0 audio, image, PDF, and video file content'

[21]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/policy/config.ts "Gemini CLI native per-server MCP trust rules and priority"
[22]: https://geminicli.com/docs/cli/skills/ "Gemini CLI Agent Skills and their discovery tiers"
[23]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/policy/policies/write.toml#L96-L108 "Gemini CLI 0.61.0 headless activate_skill denial"
[24]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/skills/skillManager.ts#L54-L114 "Gemini CLI 0.61.0 skill discovery order and user-tier loading before the trust gate"
[25]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/config.ts#L347-L354 "Gemini CLI 0.61.0 --policy option coerced as comma-separated values"
[26]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/config.ts#L115-L128 "Gemini CLI 0.61.0 comma splitting and trimming of each coerced value"
[27]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings.ts#L106-L127 "Gemini CLI 0.61.0 system settings and system defaults paths read verbatim from their environment overrides"
[28]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/security.ts#L499-L737 "Gemini CLI 0.61.0 system-file admission of a file and every directory above it along its given and real paths"
[29]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/security.ts#L369-L398 "Gemini CLI 0.61.0 root ownership and group- or other-write check"
[30]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/config/storage.ts#L131-L136 "Gemini CLI 0.61.0 trusted-folders path read verbatim from GEMINI_CLI_TRUSTED_FOLDERS_PATH"
[31]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/security.ts#L91-L163 "Gemini CLI 0.61.0 Windows admission through a PowerShell ACL check of owner and write access"
[32]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/paths.ts#L331-L352 "Gemini CLI 0.61.0 normalizePath: resolved against the process working directory, forward slashes, lowercased on macOS and Windows"
[33]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/trust.ts#L121-L331 "Gemini CLI 0.61.0 trusted-folders rules keyed by normalized path, real paths read through existsSync and realpathSync, and the longest matching key deciding"
[34]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/config/storage.ts#L92-L136 "Gemini CLI 0.61.0 runtime directory under .cache inside a sandbox-exec SANDBOX, holding the default trusted-folders file"
[35]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/trust.ts#L47-L83 "Gemini CLI 0.61.0 workspace trust from GEMINI_RESTRICTED_MODE, GEMINI_CLI_TRUST_WORKSPACE, folder trust, then the trusted-folders file"
[36]: https://pubs.opengroup.org/onlinepubs/9799919799/functions/getcwd.html "POSIX.1-2024 getcwd: a working-directory pathname with no dot, dot-dot, or symbolic-link component"
[37]: https://pubs.opengroup.org/onlinepubs/9799919799/functions/realpath.html "POSIX.1-2024 realpath: an absolute pathname resolving to the same directory entry without dot, dot-dot, or symbolic links"
[38]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/paths.ts#L360-L520 "Gemini CLI 0.61.0 isSubpath, on Windows taking paths holding ~ through resolveToRealPath and robustRealpath"
[39]: https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file#short-vs-long-names "Microsoft: short 8.3 names, which hold a tilde"
[40]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/config/storage.ts#L54-L60 "Gemini CLI 0.61.0 global .gemini directory joined by path segments under the home, normalizing it lexically, or under the temporary directory where the home is empty"
[41]: https://learn.microsoft.com/en-us/dotnet/standard/io/file-path-formats#evaluate-relative-components "Microsoft: Windows path normalization evaluating . and .. components lexically"
[42]: https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap04.html#tag_04_16 "POSIX.1-2024 pathname resolution: a symbolic link's contents prefixed to the remaining pathname, dot-dot naming the parent of its predecessor directory, each component looked up in a predecessor that must be a directory, and trailing slashes resolving only to a directory"
[43]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/utils/deepMerge.ts#L20-L96 "Gemini CLI 0.61.0 settings deep merge: prototype keys and undefined values skipped, a union-strategy path holding a list appending a list or lone value without duplicates, plain objects merged, any other value replacing"
[44]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings.ts#L255-L281 "Gemini CLI 0.61.0 settings merged from schema defaults, system defaults, user, trusted workspace, then system settings"
[45]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings.ts#L919-L928 "Gemini CLI 0.61.0 initial trust check merging schema defaults, system defaults, user, then system settings"
[46]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/trustedFolders.ts#L31-L35 "Gemini CLI 0.61.0 folder trust read as on where unset or null"
[47]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings.ts#L781-L842 "Gemini CLI 0.61.0 settings file load: environment variables expanded, then validated data kept only where the whole file validates"
[48]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/utils/envVarResolver.ts#L23-L156 "Gemini CLI 0.61.0 every settings string expanded for $VAR, ${VAR}, and ${VAR:-default}, an unset variable kept as written"
[49]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings-validation.ts#L17-L31 "Gemini CLI 0.61.0 schema validation building a union of a setting's forms and boolean-typed settings"
[50]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings-validation.ts#L143-L151 "Gemini CLI 0.61.0 boolean-typed settings preprocessed from true or false in any letter case"
[51]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/sandboxConfig.ts#L101-L118 "Gemini CLI 0.61.0 sandbox-exec on macOS for any truthy request, docker or podman only for true"
[52]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/security.ts#L481-L490 "Gemini CLI 0.61.0 system-file admission checking the path resolved lexically"
[53]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settingsSchema.ts#L3403-L3441 "Gemini CLI 0.61.0 tools.sandbox forms: a boolean, a string, then a strict sandbox object"
[54]: https://github.com/colinhacks/zod/blob/v3.25.76/packages/zod/src/v3/types.ts#L2998-L3018 "Zod 3.25.76, which Gemini CLI 0.61.0 depends on: a union returning its first alternative that validates"
[55]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settingsSchema.ts#L142-L179 "Gemini CLI 0.61.0 policyPaths: a path-array setting defaulting to an empty list and merged by the union strategy"
[56]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings.ts#L59-L80 "Gemini CLI 0.61.0 merge strategy looked up along a setting's schema path"
[57]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/config.ts#L820-L822 "Gemini CLI 0.61.0 merged policyPaths taken where no --policy is given, each through resolvePath"
[58]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/utils/resolvePath.ts#L10-L21 "Gemini CLI 0.61.0 resolvePath: a leading %userprofile% or ~ replaced by the home directory, then normalized"
[59]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings-validation.ts#L187-L192 "Gemini CLI 0.61.0 schema validation building a boolean-typed setting definition's preprocessed boolean schema"
[60]: https://nodejs.org/api/process.html#processenv "Node.js process.env: environment variables case-insensitive on Windows"
[61]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/index.ts#L84-L91 "Gemini CLI 0.61.0 relaunch into a child process unless GEMINI_CLI_NO_RELAUNCH or SANDBOX is non-empty"
[62]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/utils/processUtils.ts#L75-L86 "Gemini CLI 0.61.0 relaunched process environment setting GEMINI_CLI_NO_RELAUNCH to true"
[63]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/policy/config.ts#L120-L129 "Gemini CLI 0.61.0 non-empty policyPaths replacing the user policies directory, then every empty entry filtered out"
[64]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/utils/processUtils.ts#L90-L108 "Gemini CLI 0.61.0 single-executable relaunch appending its Node flags to NODE_OPTIONS"
[65]: https://github.com/nodejs/node/blob/v22.20.0/lib/child_process.js#L699-L728 "Node.js 22.20.0 spawn on Windows sorting a child's environment names and keeping only the first of each name's variants in letter case"
[66]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings.ts#L927-L942 "Gemini CLI 0.61.0 environment loaded under the system-default, user, trusted workspace, and system settings merged"
[67]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings.ts#L561-L598 "Gemini CLI 0.61.0 .env file found from the working directory upward, then under the home"
[68]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings.ts#L655-L733 "Gemini CLI 0.61.0 loadEnvironment: trust, ignoreLocalEnv, untrusted and excluded names, and only variables the environment lacks"
[69]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings.ts#L84-L96 "Gemini CLI 0.61.0 default excluded variables and the variables an untrusted workspace loads"
[70]: https://github.com/motdotla/dotenv/blob/v17.1.0/lib/main.js#L36-L75 "dotenv 17.1.0 parse: optionally export-prefixed lines, trimmed and unquoted values, escapes expanded in double quotes"
[71]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/package.json#L47 "Gemini CLI 0.61.0 pinning dotenv 17.1.0"
[72]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settingsSchema.ts#L2048-L2068 "Gemini CLI 0.61.0 advanced.excludedEnvVars defaulting to DEBUG and DEBUG_MODE under the union strategy, and the boolean advanced.ignoreLocalEnv"
[73]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/gemini.tsx#L568-L573 "Gemini CLI 0.61.0 sandbox decided once settings load, unless SANDBOX is set"
[74]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settingsSchema.ts#L1163-L1172 "Gemini CLI 0.61.0 modelConfigs.customAliases, an object setting declaring no properties"
[75]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings-validation.ts#L208-L227 "Gemini CLI 0.61.0 object settings declaring no properties validated as records of any values, or of their declared additional properties"
[76]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settingsSchema.ts#L161-L174 "Gemini CLI 0.61.0 mcpServers entries each validated as an MCP server configuration"
[77]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settingsSchema.ts#L2534-L2544 "Gemini CLI 0.61.0 skills.disabled, a list of strings"
[78]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/skills/skillLoader.ts#L179-L180 "Gemini CLI 0.61.0 skill frontmatter name sanitized by replacing each filename-reserved character, the colon included, with a hyphen"
[79]: https://github.com/nodejs/node/blob/v22.20.0/src/node_file.cc#L1012-L1041 "Node.js 22.20.0 existsSync: access, then on Windows also stat, so a dangling symbolic link does not exist"
[80]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/config.ts#L1055 "Gemini CLI 0.61.0 skills.enabled read as on where unset or null"
[81]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/config/config.ts#L1537-L1545 "Gemini CLI 0.61.0 skills discovered only where skills support is truthy"
[82]: https://github.com/nodejs/node/blob/v22.20.0/deps/uv/src/unix/core.c#L1195-L1228 "Node.js 22.20.0 libuv home lookup on POSIX: HOME wherever set, even empty, otherwise the password-database home of the effective user, returned as it is, even empty"
[83]: https://github.com/nodejs/node/blob/v22.20.0/deps/uv/src/win/util.c#L976-L1015 "Node.js 22.20.0 libuv home lookup on Windows: USERPROFILE wherever set, failing where it holds fewer than three bytes, otherwise the process user's profile directory, returned as it is, even empty"
[84]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settingsSchema.ts#L3038-L3139 "Gemini CLI 0.61.0 MCP server configuration: no additional properties, each property's declared type, extension values of a list of types, any oauth object, and authProviderType values"
[85]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings-validation.ts#L17-L75 "Gemini CLI 0.61.0 definitions validated by type: string enums exactly, each property optional, no additional properties as a strict object, typed additional properties checked, and a list of types as any value"
[86]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings-validation.ts#L279-L288 "Gemini CLI 0.61.0 root settings schema passing unknown keys through"
[87]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/settings-validation.ts#L135-L142 "Gemini CLI 0.61.0 number-typed settings preprocessed from a non-blank string Number reads as a number"
[88]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/config/config.ts#L523-L527 "Gemini CLI 0.61.0 AuthProviderType values"
[89]: https://github.com/colinhacks/zod/blob/v3.25.76/packages/zod/src/v3/types.ts#L4488-L4494 "Zod 3.25.76, which Gemini CLI 0.61.0 pins, checking an optional property's value against the property's type, with only undefined passing unchecked"
[90]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/package.json#L72 "Gemini CLI 0.61.0 pinning zod 3.25.76"
