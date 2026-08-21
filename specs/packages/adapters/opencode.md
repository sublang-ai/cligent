<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# opencode: OpenCode Adapter

## Intent

This package lets a consumer of the agent-adapter contract run OpenCode through the `@opencode-ai/sdk`, against either a server the adapter spawns and owns or one the caller supplies, per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md).
It owns how a portable request becomes an OpenCode session and prompt, how a portable permission policy becomes OpenCode permission rules and headless replies, and how that session's multiplexed event stream becomes unified events, resume continuity, and causally scoped token accounting, together with the server lifecycle and inactivity recovery those require, not what a caller does with them and not the server's own behavior.
Its requirements are stated in this project's `AgentAdapter`, `AgentEvent`, `AgentOptions`, `PermissionPolicy`, `DonePayload`, and `Cligent` vocabulary, which the engine defines and without which this adapter's behavior cannot be stated.

## External Behavior

### Adapter Identity

### opencode-1

The adapter shall implement `AgentAdapter` with `agent: 'opencode'`.

### SDK Loading

### opencode-2

Where the OpenCode SDK is not installed, the adapter module shall remain
importable so consumers can register it unconditionally.

### opencode-3

When `isAvailable()` uses the adapter's default probes, it shall classify the
configured server mode through this matrix:

| Mode and probe outcome | Result |
| --- | --- |
| external mode and the OpenCode SDK is loadable under [[engine-26](../engine.md#engine-26)] runtime readiness | `true` |
| external mode and the SDK is not loadable | `false` |
| managed mode, the SDK is loadable, and `opencode --version` succeeds within 5,000 ms with a version that [[engine-25](../engine.md#engine-25)] does not find below the supported floor | `true` |
| managed mode, the SDK is loadable, the CLI command succeeds, and its installed version is unreadable | `true` under [[engine-26](../engine.md#engine-26)]'s fail-open unreadable-version rule |
| managed mode and either runtime is missing, the CLI exits nonzero or times out, or a readable CLI version is below that floor | `false` |

### opencode-22

Where the OpenCode SDK is not installed and neither tool-list field is
present, when `run()` is called, the adapter shall throw
`OpenCodeAdapter requires @opencode-ai/sdk. Install it to use this adapter.`,
appending the loader's `Error` message when one exists.

### opencode-23

Where managed `run()` can load the SDK but the paired OpenCode CLI version is
below [[engine-25](../engine.md#engine-25)]'s supported floor, the adapter shall
refuse before spawning the server with that runtime gate's installed-version,
required-version, resolution, and repair diagnostic.

### Two Modes

### opencode-4

The adapter shall support two modes, selectable via constructor options: managed mode (default; spawn `opencode` server process) and external mode (connect to a user-provided `serverUrl`).

### Event Normalization

### opencode-5

When the adapter receives a current-run OpenCode SSE event after `init`, it
shall dispatch the event according to this table:

| SSE Event                                                                       | AgentEvent                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| assistant `message.part.updated` (text, no delta)                               | `text`                                                                                                                                                                      |
| assistant `message.part.updated` (text, canonical sibling or legacy part delta) | `text_delta`                                                                                                                                                                |
| assistant text `message.part.delta` / `session.next.text.delta`                 | `text_delta`                                                                                                                                                                |
| reasoning `message.part.delta` / `session.next.reasoning.delta`                 | suppressed in favor of `thinking` snapshots                                                                                                                                 |
| `message.part.updated` (tool part)                                             | the lifecycle selected by [[opencode-16](#opencode-16)]                                                                                                                     |
| assistant `message.part.updated` (thinking)                                     | `thinking`                                                                                                                                                                  |
| `message.part.updated` (file part)                                              | `opencode:file_part` (extension)                                                                                                                                            |
| `message.part.updated` (image part)                                             | `opencode:image_part` (extension)                                                                                                                                           |
| `permission.updated` / `permission.asked`                                       | the headless outcome selected by [[opencode-20](#opencode-20)]                                                                                                              |
| `permission.replied`                                                            | the reply outcome selected by [[opencode-16](#opencode-16)]                                                                                                                 |
| `session.idle` or idle `session.status`                                          | the terminal selected by [[opencode-26](#opencode-26)]                                                                                                                      |
| `error` or `session.error`                                                       | the payload and state effect selected by [[opencode-27](#opencode-27)]                                                                                                      |
| absent or any other event type                                                   | no event                                                                                                                                                                    |

### opencode-24

When a run emits its first unified event, the adapter shall emit exactly one
`init` whose session identity comes from [[opencode-25](#opencode-25)] and whose
payload is selected by this matrix:

| Available state | `InitPayload` |
| --- | --- |
| normal setup reaches a usable SSE iterator | `model`: non-nullish requested model, otherwise non-empty wrapper model, otherwise `unknown`; `cwd`: non-nullish requested cwd, otherwise non-empty wrapper cwd, otherwise `process.cwd()`; `tools`: the wrapper's array entries that are non-empty strings or objects with non-empty string `name`; `capabilities.mode`: configured server mode; `capabilities.toolsKnown`: whether that tool list is non-empty; `capabilities.toolsSource`: `sdk` when known and `unavailable` otherwise |
| setup fails before normal init, including after a wrapper result with no usable stream | `model`: non-nullish requested model or `unknown`; `cwd`: non-nullish requested cwd or `process.cwd()`; `tools: []`; configured `capabilities.mode`; `capabilities.toolsKnown: false`; `capabilities.toolsSource: 'unavailable'` |

### opencode-25

When the adapter selects a run or event session identity, it shall use the first
non-empty value in the applicable row and ignore generic stream-event `id`
fields:

| Selection | Priority |
| --- | --- |
| provisional run identity | inbound `AgentOptions.resume`, otherwise an identifier generated through [[engine-7](../engine.md#engine-7)] |
| wrapper result | `sessionId`, `session_id`, `threadId`, `thread_id`, top-level `id`, `session.id`, `thread.id` |
| stream envelope or its `data`, `info`, `message`, then `part` | `sessionID`, `sessionId`, `session_id`, `threadId`, `thread_id`, `session.id`, `thread.id`; for `session.created`, `session.updated`, or `session.deleted` only, fall back to `info.id` |
| unified event identity before a backend result is known | the provisional run identity |
| unified event identity after the wrapper identifies the backend session | that backend identity |

### opencode-26

While no terminal has been emitted, when a current-session `session.idle` or a
`session.status` whose nested `status.type` is `idle` arrives, the adapter shall
emit exactly one `done` selected by this matrix after flushing resolvable queued
content:

| State | Terminal payload |
| --- | --- |
| caller abort already observed | `status: 'interrupted'`, continuity from [[opencode-11](#opencode-11)], usage selected by [[opencode-21](#opencode-21)], and elapsed duration |
| an earlier `session.error` was observed | `status: 'error'` regardless of the idle event's status, continuity from [[opencode-11](#opencode-11)], its non-empty string `result`, exact usage from [[opencode-21](#opencode-21)], and first finite `durationMs`, `duration_ms`, or elapsed duration |
| no earlier session error | case-insensitive status `success` / `completed` / `ok` / absent / unrecognized → `success`; `interrupted` / `cancelled` / `aborted` → `interrupted`; `max_turns` / `maxturns` → `max_turns`; `max_budget` / `maxbudget` / `budget_exceeded` → `max_budget`; `error` / `failed` → `error`, with the same result, resume, usage, and duration selection as above |

### opencode-27

When a current-session `error` or `session.error` event arrives, the adapter
shall emit one `error` and update terminal state according to this matrix:

| Input | Normalized outcome |
| --- | --- |
| generic `error` | normalize the whole event and apply no terminal-status override |
| `session.error` | normalize `event.error` when non-nullish, otherwise the whole event, and remember an error-status override for the later idle terminal |
| code within the selected normalization source | first non-empty top-level `code`, nested `error.code`, or nested `error.type`; omit when none exists |
| message within the selected normalization source | first non-empty top-level `message`, nested `error.message`, `data.message`, or `error.data.message`; otherwise `OpenCode SDK error` |
| recoverability within the selected normalization source | `true` when its top-level or nested `error` has `recoverable: true` or `retryable: true`; otherwise `false` |

### opencode-28

While no terminal has been emitted, when setup or stream processing throws,
the adapter shall first emit [[opencode-24](#opencode-24)]'s `init` if needed,
flush resolvable queued content, and select this terminal sequence:

| State | Sequence |
| --- | --- |
| caller abort observed | one interrupted `done` with [[opencode-11](#opencode-11)] continuity, usage selected by [[opencode-21](#opencode-21)], and elapsed duration; no adapter error |
| other thrown `Error` | non-recoverable `OPENCODE_STREAM_ERROR` carrying its message, then one error `done` with ordinary failure continuity, usage selected by [[opencode-21](#opencode-21)], and elapsed duration |
| other thrown value | the same error sequence with message `OpenCode adapter failed during stream` |

### opencode-29

While no terminal has been emitted, when the SSE iterator ends, the adapter
shall flush resolvable queued content and select this terminal sequence:

| State | Sequence |
| --- | --- |
| caller abort observed | one interrupted `done` with [[opencode-11](#opencode-11)] continuity, usage selected by [[opencode-21](#opencode-21)], and elapsed duration |
| no caller abort | non-recoverable `MISSING_SESSION_IDLE` error with message `Protocol violation: OpenCode stream ended without session.idle`, then one error `done` with ordinary failure continuity, usage selected by [[opencode-21](#opencode-21)], and elapsed duration |

### opencode-30

_Superseded by [[opencode-21](#opencode-21)]; retained for the released
root-stream accounting design._

Where OpenCode supplies root-stream step accounting, the adapter shall select
the legacy report through this matrix [[3]][[4]]:

| Input | Legacy outcome |
| --- | --- |
| canonical `StepFinishPart` with finite non-negative integer `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, and `tokens.cache.write` | add both cache counters to cache-exclusive input exactly once, add reasoning to visible output exactly once, and accumulate those totals across steps |
| valid step with complete accounting | both [[engine-28](../engine.md#engine-28)] breakdown sides from step-wise sums: input → `input`, cache read → `cacheRead`, cache write → `cacheWrite`, output → `output`, reasoning → `reasoning` |
| `tokens.total` | ignore because the provider-passed value need not equal the five-counter sum |
| a valid component reported as zero | preserve measured zero rather than infer absence from provider identity |
| each valid step | one [[engine-30](../engine.md#engine-30)] record with `requests: 1`, its five counters, its cost when present, and the owning assistant message's `modelID` / `providerID` when known, omitting both identities otherwise [[opencode-17](#opencode-17)] |

### opencode-16

When the adapter receives a tool-part snapshot or correlated rejected permission
reply, it shall evolve that call through this matrix:

| Input or state | Unified outcome |
| --- | --- |
| call identity | first non-empty `part.callID`, `part.callId`, `part.toolUseId`, or `part.id`; otherwise an identifier generated through [[engine-7](../engine.md#engine-7)] |
| tool name | first non-empty `part.toolName`, `part.name`, string `part.tool`, or `part.tool.name`; otherwise `unknown_tool`, with every later non-fallback name replacing the retained name |
| input | first non-nullish `state.input`, `part.input`, `part.arguments`, `part.args`, or `part.tool.input`; any object, including an array, is preserved, any JSON object or array string is parsed, an invalid string becomes `{ raw: <string> }`, and null, a primitive, or a string decoding to one becomes `{}` |
| description | first non-empty `part.description` or `state.title`; omit when neither exists |
| `pending` | retain correlation without emitting a use |
| first non-pending snapshot before a result | one `tool_use` with the selected identity, name, input, and optional description; increment observed tool use once |
| first `completed` snapshot | ensure that use exists, then one success `tool_result` whose output is `state.output` or `null` |
| first `error` snapshot | ensure that use exists, then one error `tool_result` whose output is `state.error` or `null` |
| terminal snapshot with finite `state.time.start` and `.end` | `durationMs` is `end - start`; otherwise omit duration |
| repeated running or terminal snapshot | no duplicate use, result, or tool count |
| tool part without lifecycle state | one immediate use per selected identifier from the same selectors |
| rejected permission reply before a terminal result | one denied result with the call identity and tracked tool name, output from the first defined permission reason, event reason, permission output, event output, or `null`; suppress any later result and any use that would follow the denial |
| rejected permission reply after a terminal result | no denied result |

### opencode-17

When conversational part and message-role events interleave, the adapter shall
apply this ordered correlation matrix after [[opencode-6](#opencode-6)] session
filtering:

| Event state | Outcome |
| --- | --- |
| role from top-level `role`, `info.role`, or `message.role`, case-insensitively `assistant` | emit that message's `text`, `text_delta`, and `thinking` content without comparing its bytes to the prompt |
| corresponding role is `user` | discard its content |
| identified part arrives before role | hold it until the role resolves |
| later message resolves while earlier content is held | keep global stream order until the earlier entry resolves or is removed |
| terminal completion with unresolved roles | discard unresolved entries and release later known assistant content in original order |
| legacy content with no message identifier | preserve ordinary normalization while respecting the same ordering gate |
| `message.removed` identifies held content | discard it, release any newly unblocked events, and release its retained payload |
| metadata from another session | neither release nor discard current-session content |

### opencode-19

When OpenCode content deltas and settled snapshots interleave, the adapter shall
normalize them through this correlation matrix:

| Input or state | Outcome |
| --- | --- |
| v1 `message.part.updated` | classify the sibling `delta`, otherwise legacy `part.delta`, from `part.type` |
| v2 `session.next.text.delta` / `session.next.reasoning.delta` | classify from the event type and correlate `textID` / `reasoningID` with the settled part identifier |
| generic v2 `message.part.delta` with known inline or correlated part type | classify by that type, never by `field` alone |
| assistant text delta | `text_delta` |
| reasoning delta | no delta event; retain the settled snapshot as the single `thinking` representation |
| user delta | suppress per [[opencode-17](#opencode-17)] |
| generic delta preceding its part metadata | hold by part identifier, then release or suppress when type resolves |
| generic delta with no correlatable identifier or type | discard immediately without blocking later content |
| generic delta whose type never resolves | discard at terminal rather than defaulting to output |
| repeated settled snapshot with the same part identifier, kind, and content | emit at most once |
| settled text exactly reconstructed by emitted deltas for its part | suppress the snapshot so semantic output appears once |
| interleaved part identifiers | preserve independent state and original stream order even when later metadata resolves first |
| part removal | release queued payloads and clear pending deltas, emitted-delta history, settled history, and classification state |
| owning-message removal | clear the same state for all of its parts without requiring individual removals |

### Session Filtering

### opencode-6

While OpenCode's global SSE stream multiplexes sessions [[2]], the adapter shall
select event visibility through this matrix:

| Event scope | Visibility |
| --- | --- |
| current root session | ordinary output and control processing |
| no explicit session or thread identity | pass through because many global event kinds are untagged |
| run-owned descendant | permission control only through [[opencode-20](#opencode-20)] and lifecycle ownership only through [[opencode-56](#opencode-56)]; no ordinary child conversation |
| unrelated identified session | no output or control processing |
| same OpenCode session concurrently driven by another invocation/client, or receiving delayed background work from an earlier invocation [[16]] | no turn-level isolation guarantee because the stream exposes no turn identity; callers needing [[engine-18](../engine.md#engine-18)] concurrency use distinct sessions |

### Permission Mapping

### opencode-7

When the exported permission mapper receives the closed
[[engine-21](../engine.md#engine-21)] policy-mode set under [[engine-52](../engine.md#engine-52)], it shall select OpenCode
permission controls through this exhaustive [DR-005](../../decisions/005-per-adapter-permission-configuration.md)
matrix, mapping `fileWrite` → `edit`, `shellExecute` → `bash`, and
`networkAccess` → `webfetch`:

| Policy | Mapping and headless posture |
| --- | --- |
| missing | no adapter-generated permission control; preserve OpenCode defaults |
| supplied with omitted mode, including `{}` | normalize every omitted capability to `ask`, retaining the distinction from a missing policy |
| supplied with omitted mode and capability values | map every present value and normalize every omitted capability to `ask` |
| `mode: 'auto'` without capability values | no wildcard or capability rule; preserve native and user-configured rules and answer only surviving asks `once` through [[opencode-20](#opencode-20)] |
| `mode: 'auto'` with capability values | map only present values, leave omitted values absent, append no wildcard, and apply the same surviving-ask response posture |
| `mode: 'bypass'` with absent or valid `writablePaths` | reject with the SDK/server-architecture diagnostic because no unchecked-bypass route exists; a direct mapper call rejects immediately, while `run()` rejects after SDK loading but before managed spawn, client creation, session work, subscription, or prompt |
| any mode with invalid `writablePaths` | [[opencode-31](#opencode-31)] validation rejects before mode-specific mapping |

### opencode-31

When a `PermissionPolicy` carries `writablePaths`, the adapter shall select its
independent reporting surface through this matrix:

| Input | `WritablePathsPermissionMapping` |
| --- | --- |
| absent or empty | omitted per [[engine-54](../engine.md#engine-54)] |
| valid non-empty entries | canonical [[engine-53](../engine.md#engine-53)] paths with `enforcement: 'ambient'` per [[engine-54](../engine.md#engine-54)], leaving the OpenCode permission rules unchanged |
| invalid entry | reject under [[engine-53](../engine.md#engine-53)] validation |

`ambient` records that this is not confinement: OpenCode retains host
filesystem authority, `external_directory` remains a tool-approval rule, and
native auto can answer a surviving ask `once`.

### opencode-20

While a headless run receives `permission.updated` or `permission.asked` for
its root or a descendant owned through [[opencode-56](#opencode-56)], the
adapter shall resolve each native request once through this outcome matrix,
including unknown permission names:

| State | Observable outcome |
| --- | --- |
| `mode: 'auto'` and the `once` reply succeeds | no `permission_request`; after confirmation, exactly one `opencode:permission_decision` with native request and session identifiers, permission name, patterns, correlated tool-use identifier, `decision: 'once'`, `automated: true`, normalized input, and optional reason |
| outside auto mode before any reply attempt or failure | one `permission_request` with normalized tool name, correlation identifier, input, and optional reason |
| outside auto mode and the `reject` reply succeeds | no automated-decision extension after that request |
| request already resolved | no second reply or event |
| unrelated session tree | no response or event per [[opencode-6](#opencode-6)] |
| missing request identifier | non-recoverable `OPENCODE_PERMISSION_REQUEST_INVALID` naming session, missing request, and permission, then error `done` |
| unavailable route, rejected operation, SDK-result error, or no settlement within five seconds | non-recoverable `OPENCODE_PERMISSION_REPLY_FAILED` naming session, request, permission, and failure, then error `done` |
| caller abort before or during response | one interrupted `done` with no automated-decision extension |

Failed, timed-out, and aborted paths use [[opencode-35](#opencode-35)] transport
cancellation before cleanup.

### opencode-13

Where `PermissionPolicy` is absent, the adapter shall omit adapter-generated
permission data from fresh-session creation, resumed-session updates, and
prompt requests on every supported SDK path so OpenCode's native defaults
remain in effect.

### Server Lifecycle

### opencode-8

Where managed mode is configured, when a mapped run reaches server startup, the
adapter shall spawn `opencode serve` with the configured URL's `--hostname` and
`--port`, the requested working directory, and piped stdio, wait within the
configured readiness timeout for either output stream to announce an HTTP(S)
URL, then connect the SDK client to that URL [[2]].

### opencode-9

When `AbortSignal` fires during a managed run, the adapter shall preempt its
active wait, yield [[engine-73](../engine.md#engine-73)] `done` with `status: 'interrupted'`, and only afterwards send
`SIGTERM` to the managed server.

### opencode-10

When the managed server exits unexpectedly before readiness or while the
adapter awaits its SSE stream, the adapter shall select this outcome: absent a
concurrent caller abort, a non-recoverable `OPENCODE_SERVER_EXIT` error naming
code and signal followed by one error `done`; after caller abort is observed,
only [[opencode-39](#opencode-39)]'s interrupted terminal; then
[[opencode-36](#opencode-36)] cleanup in either case.

### opencode-18

When `OpenCodeAdapterConfig.eventInactivityTimeoutMs` is constructed, the
adapter shall select its relevant-event deadline through this matrix:

| Configuration | Outcome |
| --- | --- |
| omitted | 300,000 ms |
| finite number greater than zero | that value |
| zero, negative, non-finite, or non-numeric | reject configuration |

### opencode-37

While awaiting OpenCode's global SSE stream, the adapter shall carry
[[opencode-18](#opencode-18)]'s deadline as a monotonic active-wait budget
through this matrix:

| Activity | Budget effect |
| --- | --- |
| current root or run-owned descendant event | reset to the configured deadline, even though ordinary descendant conversation remains filtered by [[opencode-6](#opencode-6)] |
| unrelated tagged event or untagged global pass-through event | no reset |
| event normalization or downstream suspension at a yield | no consumption |
| buffered relevant event ready when the consumer resumes | process before recovery |
| always-ready non-relevant backlog | continue consuming the carried active-wait budget |
| delay above the host timer maximum | split into safe chunks without early expiry |

### opencode-38

When [[opencode-37](#opencode-37)]'s relevant-event deadline expires, the
adapter shall cancel the pending SSE read, bound a current-session status query
to the lesser of 10,000 ms and the configured deadline, and select this recovery
outcome:

| Status outcome | Terminal sequence |
| --- | --- |
| `idle`, including omission from OpenCode's status map | one recoverable `OPENCODE_INACTIVITY_IDLE_RECOVERED` diagnostic, then one success `done`, or error `done` when an earlier session error requires it |
| `busy`, `retry`, or another non-idle state | bounded session abort, one non-recoverable `OPENCODE_INACTIVITY_TIMEOUT` diagnostic, then one error `done` |
| status request fails or times out | bounded best-effort session abort, one non-recoverable `OPENCODE_INACTIVITY_STATUS_QUERY_FAILED` diagnostic, then one error `done` |

Each diagnostic identifies the session, last relevant event, elapsed
inactivity, configured deadline, server mode and state, queried state or query
failure, and attempted session-abort outcome.

### opencode-39

When caller abort races a pending SSE read, status query, inactivity recovery,
or ready terminal event in either server mode, the adapter shall give the
observed caller abort precedence and emit exactly one interrupted `done`.

### Resume Token

### opencode-11

When the adapter emits terminal `done`, it shall select
`DonePayload.resumeToken` through this [DR-003](../../decisions/003-role-scoped-session-management.md)
matrix:

| Terminal state | Resume token |
| --- | --- |
| backend session identifier observed | the latest observed backend identifier |
| interrupted before a backend identifier and inbound `AgentOptions.resume` is non-empty | the inbound value |
| interrupted before a backend identifier and no non-empty inbound value | omitted |
| successful, max-turn, or max-budget terminal before a backend identifier | omitted |
| non-interrupted failure before a backend identifier, including rejected stale resume | omitted so [[engine-6](../engine.md#engine-6)] clears the stale value |

### Options Mapping

### opencode-12

Per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), when a
portable `AgentOptions.effort` from [[engine-39](../engine.md#engine-39)] is
provided with a `provider/model` selection, the adapter shall put this provider
variant on the prompt body for both fresh and resumed sessions [[1]]:

| `AgentOptions.effort` | Anthropic | OpenAI    | Google | Other |
| --------------------- | --------- | --------- | ------ | ----- |
| `minimal`             | `high`    | `minimal` | `low`  | unset |
| `low`                 | `high`    | `low`     | `low`  | unset |
| `medium`              | `high`    | `medium`  | `low`  | unset |
| `high`                | `high`    | `high`    | `high` | unset |
| `xhigh`               | `max`     | `xhigh`   | `high` | unset |
| `max`                 | `max`     | `xhigh`   | `high` | unset |

The nearest documented provider variant satisfies lossy rows under
[[engine-42](../engine.md#engine-42)], while an unmatched provider leaves the
field unset for `opencode.jsonc`.

### opencode-14

When effort selection does not use [[opencode-12](#opencode-12)]'s mapping, the
adapter shall apply this matrix:

| Input | Outcome |
| --- | --- |
| effort omitted | no prompt-body `variant`, preserving OpenCode and user defaults |
| valid effort with absent model or a model lacking a provider prefix | no prompt-body `variant` |
| value outside the OpenCode vocabulary, including `ultracode` or `ultra` | reject before prompting with [[engine-50](../engine.md#engine-50)]'s metadata-backed adapter and allowed-values error |

### opencode-15

When tool-list input reaches an OpenCode surface, the adapter shall enforce
[[engine-17](../engine.md#engine-17)]'s exact-identifier boundary through this
matrix:

| Input | Outcome |
| --- | --- |
| `AgentOptions.allowedTools` or `disallowedTools` explicitly present, including `[]` | reject before SDK loading or backend work |
| either field passed to the exported permission mapper | reject before returning a provider mapping |
| direct compatibility-wrapper prompt `tools` value | reject before session creation, update, subscription, or prompt |
| both option fields omitted and no direct wrapper value | send no prompt `tools` data, preserving OpenCode's native available-tool surface |

OpenCode 1.18.13's prompt `tools` field is deprecated as an independent
control: the provider converts its booleans into persistent session permission
rules, replacing prior session rules [[5]].
Because permission evaluation is last-match-wins and session rules follow agent
rules, an enabled tool can override a native or explicitly supplied deny, and a
prompt-scoped request can change a resumed session after that cligent call ends
[[6]][[7]].
The provider also canonicalizes some tool identifiers to shared permission
names, so this surface cannot guarantee exact per-call identifiers [[6]].

### opencode-44

When `run()` prepares the compatibility-wrapper request and native prompt, the
adapter shall map ordinary options through this matrix:

| Portable input | OpenCode request |
| --- | --- |
| prompt | one native text part with the exact string and no caller-supplied message identifier, because OpenCode mints the identifier and a foreign one leaves the session busy without a terminal [[14]] |
| non-empty `cwd` | wrapper `cwd` and the version-specific request placement in [[opencode-41](#opencode-41)]; omit provider directory data for absent or empty `cwd` |
| any model string containing `/` | split at its first slash into native `{ providerID, modelID }`, including an empty side |
| non-empty model without `/` | pass through unchanged |
| absent or empty model | omit the native model |
| `maxTurns`, including zero | prompt `steps` with the exact value |
| omitted `maxTurns` | omit `steps` |
| any `maxBudgetUsd` | no OpenCode request member because this runtime has no corresponding control |
| non-empty resume | select the existing session rather than create one |
| permission, effort, or tool-list input | the outcomes in [[opencode-7](#opencode-7)], [[opencode-12](#opencode-12)], [[opencode-14](#opencode-14)], and [[opencode-15](#opencode-15)] |

### Token Accounting

### opencode-21

When terminal `done` reports authentic OpenCode usage, the adapter shall build
the public [[engine-31](../engine.md#engine-31)] shape from
[[opencode-45](#opencode-45)] through [[opencode-51](#opencode-51)] through this
matrix:

| Ledger state | Report |
| --- | --- |
| no proven prompt boundary or no authentic valid step | omit `tokens` rather than attribute across an unproved boundary or publish placeholders |
| at least one exact valid causal step, but any causal step is malformed or ambiguous, hidden-request suppression is unproved, or a causal descendant remains active | [[engine-58](../engine.md#engine-58)] `tokens.coverage: 'partial'` with the exact valid subset |
| every causal step is canonical and valid, hidden-request boundaries are proved, and every causal descendant is settled | [[engine-58](../engine.md#engine-58)] `tokens.coverage: 'complete'` |
| each valid canonical step | one [[engine-59](../engine.md#engine-59)] record with `requests: 1` per [[engine-60](../engine.md#engine-60)], inclusive input and output totals, exact details per [[engine-57](../engine.md#engine-57)], owning-message provider/model when known, and its finite non-negative cost as USD `agent-estimate` under [[engine-61](../engine.md#engine-61)] when present [[8]] |
| generic idle usage aliases | ignore because the idle event is not an authenticated accounting source |
| complete coverage and every causal step has a valid cost, including measured zero | whole-run [[engine-61](../engine.md#engine-61)] USD `agent-estimate` cost equal to the step sum |
| incomplete coverage or any causal step lacks a valid cost | omit whole-run cost independently of exact token records per [[engine-62](../engine.md#engine-62)] |

### Permission Transport

### opencode-32

When the private provider-default permission-reset sentinel reaches the
compatibility wrapper, it shall clear prior session controls through this
matrix without exposing the sentinel to the SDK:

| SDK path | Reset placement |
| --- | --- |
| legacy fresh or resumed session | an empty `permission` object on the prompt |
| v2 fresh session | an empty `PermissionRuleset` on `session.create` |
| v2 resumed session | an empty `PermissionRuleset` on `session.update` before the prompt |

## Internal Behavior

### opencode-33

When the compatibility wrapper delivers the mapping from
[[opencode-7](#opencode-7)], it shall select this version-specific SDK surface:

| Mapping and SDK path | Delivery |
| --- | --- |
| absent policy | no creation, update, or prompt permission member per [[opencode-13](#opencode-13)] |
| legacy path with a supplied policy | permission object on the prompt, not session creation |
| v2 fresh session with a supplied policy | equivalent wildcard-pattern `PermissionRuleset` entries on `session.create`, not the prompt |
| v2 resumed session with a supplied policy | equivalent entries on `session.update` before prompting, not the prompt |
| private reset sentinel | the empty surfaces in [[opencode-32](#opencode-32)] |

### opencode-34

Before prompting a resumed root, the compatibility wrapper shall discover its
pre-existing session tree through the version-correct `session.children` route
under one whole-traversal deadline through this matrix:

| Discovery result | Outcome |
| --- | --- |
| resumed root | include as owned and inspect its children |
| child array entry with a non-empty `id` | include as owned and recursively inspect its children |
| child array entry without a non-empty `id` | ignore |
| unavailable route, non-array result, failure, abort, or deadline expiry | fail before prompt dispatch |

### opencode-56

When session-ownership evidence reaches an active run, the adapter shall evolve
its run-owned control scope through this matrix:

| Evidence | Ownership effect |
| --- | --- |
| wrapper result | include the selected root and every non-empty identifier discovered through [[opencode-34](#opencode-34)] |
| valid task part in an owned session naming a distinct child session | include that child, even when it resumes an older session outside the root ancestry |
| ordered `session.created` or `session.updated` with a non-empty identifier and an already-owned parent | include the identified child on fresh and resumed runs |
| `session.deleted` for an owned non-root session | remove that descendant |
| unrelated or malformed ownership evidence | leave the scope unchanged |

### opencode-35

While the adapter awaits SSE or a permission response, it shall use one
run-owned abort signal and bounded correlation state so a missing, failed,
five-second timed-out, or caller-aborted reply cancels response and stream I/O,
closes the iterator during bounded terminal cleanup, releases the caller listener,
and leaves retained wait-control and correlation state bounded independently of
the number of completed events and permission responses.

### Managed Resource Ownership

### opencode-36

After any managed terminal path, the adapter shall perform teardown in this
order: request child `SIGTERM`; independently bound iterator return, client
close, and client shutdown even when an earlier phase rejects; after a bounded
grace send `SIGKILL` if the child remains alive; and bound the final close wait.

### opencode-40

When caller abort occurs during SDK session creation or prompt dispatch, the
adapter shall propagate cancellation through supported request surfaces, bound
the race wait, capture any concurrently returned session and iterator, abort
the known session, return every eager iterator opened before dispatch, remove
the dispatch listener on every exit, and preserve a backend identifier created
before the abort as [[opencode-11](#opencode-11)]'s interrupted resume token.

### opencode-41

When a compatibility-wrapper operation carries a non-empty run working
directory, it shall place that directory through this SDK-version matrix:

| Operation | Legacy SDK | v2 SDK |
| --- | --- | --- |
| session create, get, update, children, prompt, status, or abort | top-level `query.directory`, never the request body | top-level `directory` |
| event subscription | top-level `query.directory` | top-level `directory` |
| instance disposal | `query.directory` | `directory` |

### opencode-42

After every terminal or failed-dispatch path, the adapter shall abort and
return the active iterator, make independently bounded client close, shutdown,
and instance-disposal attempts despite earlier rejection, remove run and
dispatch abort listeners, release content and permission correlation state,
and then complete [[opencode-36](#opencode-36)] for an owned managed child.

### opencode-43

When caller interruption or non-idle inactivity occurs after a backend session
is known, the adapter shall start one bounded session-abort attempt, retain it
through post-terminal cleanup without delaying interrupted `done` beyond the
engine abort-drain window, begin managed process termination only after that
terminal, and leave an external caller-owned server running.

### Causal Accounting

### opencode-45

Before dispatching the prompt, the compatibility wrapper shall subscribe to
the live non-replaying event stream, eagerly request its first event, wait only
within a bounded connection grace, and transfer that first result plus the
remaining iterator without dropping any event published after subscription.

### opencode-46

When selecting the invocation's causal prompt boundary, the adapter shall apply
this matrix under [[opencode-6](#opencode-6)]'s single-writer constraint [[14]][[15]][[16]]:

| Evidence | Boundary outcome |
| --- | --- |
| unique root-session user message carrying the exact submitted text | its native message identifier |
| message known to be assistant, even with identical text | ineligible |
| message whose role was never observed | eligible |
| multiple matching eligible root messages | unproved rather than guessed |
| invocation created the root session, including absent or empty resume | if text proof is unavailable, first non-background root user sighting or identifier named as a root assistant's `parentID` |
| non-empty inbound resume | no ordering fallback |
| synthetic background result | never the invocation boundary |

### opencode-47

After [[opencode-46](#opencode-46)] proves a boundary, the adapter shall build
the invocation ledger through this matrix before applying
[[opencode-6](#opencode-6)]'s root-only conversation filter:

| Causal or step state | Ledger effect |
| --- | --- |
| same-session assistant whose `parentID` names a causal prompt | mark that assistant message causal [[15]] |
| valid non-reused task part on a causal assistant naming a distinct child session | mark the next ordered non-internal user prompt in that child after the task causal and repeat the parent/task propagation through descendants |
| canonical step-finish in the root or causally linked owned descendant | key by native session and part identifier |
| identical keyed repeat | count once |
| changed keyed snapshot | replace rather than add |
| removal after completion | retain the billed request |
| foreign, merely pre-existing, unscoped, or not causally linked activity | exclude |
| tagged owned step missing canonical session, part, or owning-message identity, or whose owning message belongs to another session | exclude and make exact coverage partial |
| wholly untagged step | exclude as unscoped without itself making coverage partial |

### opencode-48

Before prompt dispatch, the wrapper shall suppress OpenCode's hidden title-model
request through this matrix, making exact observed accounting partial whenever
suppression cannot be proved [[9]]:

| Root state | Action |
| --- | --- |
| fresh | create with a static non-sensitive non-default title and verify the returned title |
| resumed with a non-default title, including empty, or a parent session | preserve it |
| resumed with a recognized default title | retitle to the static value and verify the returned title |
| missing required get route, missing update route for a default title, failed or malformed required operation, or unverified changed title | continue the run with partial accounting |

### opencode-49

Before prompt dispatch, the wrapper shall query the canonical global-health
route and permit complete accounting only for a healthy response naming exact
OpenCode version `1.18.13`, while a missing route, failure, timeout, malformed or
unhealthy response, or other version leaves the run unblocked with partial
accounting [[13]].

### opencode-50

When compaction or retry evidence enters the causal ledger, the adapter shall
classify it through this matrix [[10]][[12]]:

| Evidence | Accounting effect |
| --- | --- |
| canonical automatic compaction, summary, and `metadata.compaction_continue: true` continuation | extend only from the immediate causal message boundary |
| repeated internal-prompt snapshot | preserve first canonical kind, message, and child identity plus every overflow or error signal |
| conflicting identity or evidence that later appears less severe | retain the original exact subset and make coverage partial |
| overflow replay, unmarked or unlinked internal prompt, post-activation assistant with unproved parent, or causal prompt without a linked assistant | exclude and make coverage partial |
| retry after a causal assistant or with uncorrelatable request | make coverage partial because the failed model attempt has no accounting |
| retry tied to an explicit foreign assistant | exclude without attributing it to the run |

### opencode-51

When task and background continuation evidence enters the causal ledger, the
adapter shall classify it through this matrix [[11]]:

| Evidence | Accounting effect |
| --- | --- |
| exact command-task continuation immediately after a causal task part | extend causality without inventing a model step for its programmatic assistant |
| task naming an existing `task_id` | retain exact parent records as partial and exclude later ambiguous child prompts and steps |
| repeated task-part snapshot | preserve first parent identity, enrich a missing child identity once, and treat conflicting non-empty parent or child identity as partial with only the original exact subset |
| synthetic successful background-result prompt matched to one causal child | extend causality once |
| missing child identity, unmatched or error background result, or child idle before its latest causal observation | retain exact subset as partial |
| causal descendant still active at root completion | retain exact subset as partial |

## Verification

### opencode-201

Given a canned wrapper result and native OpenCode SSE sequence, when the adapter
runs, the yielded stream shall match this integration matrix:

| Fixture | Assertion |
| --- | --- |
| wrapper model, cwd, and string/object-name tools | first event is [[opencode-24](#opencode-24)] `init` with requested model priority, wrapper cwd, normalized tools, configured mode, and known SDK tool capabilities |
| foreign identified event followed by local and untagged events | [[opencode-6](#opencode-6)] filtering and pass-through |
| text, delta, thinking, file, and image parts | exact [[opencode-5](#opencode-5)] event types and payloads |
| stateless tool part | [[opencode-16](#opencode-16)] selected identity, name, and input |
| permission ask and rejected reply | [[opencode-20](#opencode-20)] request followed by [[opencode-16](#opencode-16)] denied result with correlation intact |
| generic recoverable error | [[opencode-27](#opencode-27)] code, message, and recoverability |
| idle with `max_turns`, generic usage aliases, and `duration_ms` | [[opencode-26](#opencode-26)] max-turn terminal and duration, ignoring unauthenticated usage aliases while preserving observed tool count [[opencode-21](#opencode-21)] |
| setup or stream throws an `Error`, a non-`Error`, or after caller abort | [[opencode-24](#opencode-24)] init-first fallback and every [[opencode-28](#opencode-28)] error/interrupted terminal row |
| iterator exhausts before idle, with and without caller abort | both [[opencode-29](#opencode-29)] terminal rows |

### opencode-202

Given injected and physical runtime layouts, when availability or `run()` is
entered, the adapter shall satisfy this runtime matrix:

| Case | Assertion |
| --- | --- |
| physically absent SDK | module import succeeds [[opencode-2](#opencode-2)], `isAvailable()` is false [[opencode-3](#opencode-3)], and `run()` throws [[opencode-22](#opencode-22)] |
| external mode with loadable SDK | availability is true without a CLI probe |
| managed mode with loadable SDK | availability is true only after `opencode --version` succeeds within 5,000 ms at or above the [[opencode-3](#opencode-3)] floor |
| managed mode with unreadable CLI version | availability is true under the fail-open runtime rule |
| managed mode with missing, nonzero, timed-out, or readable below-floor CLI | availability is false |
| managed `run()` with below-floor CLI after SDK load | refusal occurs before server spawn with [[opencode-23](#opencode-23)] diagnostic |

### opencode-203

Where application configurations select representative efforts for this
adapter, when the runtime constructs and invokes each corresponding `Cligent`,
the integration check shall assert [[opencode-12](#opencode-12)]'s known-provider
prompt variants and an unmatched provider's absent effort override with
ordinary model forwarding.

### opencode-52

Given fresh and resumed wrapper calls over every supported SDK path, when
ordinary `AgentOptions` are mapped, the captured native requests shall assert
[[opencode-44](#opencode-44)]'s exact prompt without a caller-supplied message
identifier, model, cwd, zero and nonzero `maxTurns`, omitted `maxTurns`, ignored
`maxBudgetUsd`, and session-selection rows, including `steps` on both legacy and
v2 prompt bodies.

### opencode-204

Given the complete [DR-005](../../decisions/005-per-adapter-permission-configuration.md)
input space, when permission mapping runs directly and through the adapter, the
checks shall assert every [[opencode-7](#opencode-7)] row: missing policy,
supplied empty and partial no-mode policies, all capability-level combinations,
capability-empty and capability-populated auto without a wildcard, bypass
rejection directly plus after SDK load but before any managed spawn or SDK
client/session/prompt work, and invalid writable-path validation before bypass
mapping.

### opencode-208

Given local, foreign, descendant, and untagged canonical events, when the
adapter consumes the multiplexed stream, it shall assert [[opencode-6](#opencode-6)]
visibility and the `opencode:file_part` / `opencode:image_part` extension rows
of [[opencode-5](#opencode-5)].

### opencode-53

Given injected managed and external server seams, when runs start, terminate,
abort, crash, or encounter stuck cleanup, the checks shall cover this lifecycle
matrix:

| Case | Assertion |
| --- | --- |
| managed startup | exact `opencode serve --hostname <host> --port <port>`, cwd, readiness wait, and discovered URL before client creation [[opencode-4](#opencode-4)], [[opencode-8](#opencode-8)] |
| external startup | no child spawn and caller URL used [[opencode-4](#opencode-4)] |
| ordinary managed teardown | `SIGTERM` before bounded SDK cleanup [[opencode-36](#opencode-36)] |
| caller abort | interrupted `done` before managed `SIGTERM` [[opencode-9](#opencode-9)] |
| caller abort during SDK loading, managed readiness, or a stream wait | preempt the active wait and preserve [[opencode-9](#opencode-9)] terminal-before-signal order |
| managed child crash before or after readiness | `OPENCODE_SERVER_EXIT`, then error `done`, then cleanup [[opencode-10](#opencode-10)] |
| non-settling iterator/client cleanup | generator and managed termination remain bounded [[opencode-36](#opencode-36)] |
| child ignores `SIGTERM` | `SIGKILL` after bounded grace and bounded final close [[opencode-36](#opencode-36)] |

### opencode-212

Given backend identity aliases, inbound resumes, and terminal paths, when the
adapter emits unified events and `done`, the checks shall cover this matrix:

| Case | Assertion |
| --- | --- |
| wrapper result alias in [[opencode-25](#opencode-25)] | selected backend identifier becomes event identity and normal resume token [[opencode-11](#opencode-11)] |
| stream explicit alias | filtering uses it without treating generic message `id` as a session |
| interrupted before backend identity | non-empty inbound resume or omission according to [[opencode-11](#opencode-11)] |
| rejected resumed lineage before prompt | error `done` omits resume; a following `Cligent.run()` creates fresh rather than retrying stale state |

### opencode-218

Given every portable effort, omission, another adapter's native value, and an
arbitrary unknown string, when the adapter maps a run, the checks shall assert
[[opencode-12](#opencode-12)]'s provider variant matrix, unmatched-provider and
model-less omission, and [[opencode-14](#opencode-14)]'s default-preserving and
metadata-backed rejection rows before prompt dispatch.

### opencode-219

Where a `Cligent` is constructed on the adapter with `CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first to create and then to update a temporary file in a throwaway working directory, the adapter's auto-mode permission knobs per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) shall let both non-destructive writes proceed without interactive approval [[opencode-7](#opencode-7)]:

- expected file contents after both phases;
- no `permission_request`, denied result, or error, and one successful `done`
  per stream;
- filesystem state as ground truth because adapters normalize file edits
  differently;
- at most two complete fresh retries, only after explicit upstream overload,
  rate-limit, or service-unavailable failure, with every other failure and the
  third consecutive named transient fatal;
- the real installed dev-dependency SDK, never an SDK-absence skip;
- a logged self-skip outside CI, and a hard failure in CI, for missing PATH CLI
  or credentials, without one adapter's missing dependency skipping another;
- a logged self-skip, including in CI, when the host cannot initialize the
  adapter's OS sandbox.

### opencode-220

Given the adapter has been aborted, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall report the resume token each observed state requires [[opencode-11](#opencode-11)]:

| Observed before abort | `DonePayload.resumeToken` |
| --- | --- |
| a backend session identifier observed during the run | the observed backend identifier |
| no backend identifier and a non-empty `AgentOptions.resume` value | the inbound `resume` value |
| no backend identifier and no non-empty inbound `resume` value | omitted |

### opencode-222

Given absent, empty, valid, and invalid `PermissionPolicy.writablePaths`, when
permission mapping runs without another filesystem grant surface, the checks
shall assert [[opencode-31](#opencode-31)]'s omission, canonical ambient report,
unchanged OpenCode rules, and validation-rejection rows.

### opencode-227

Given fresh and resumed calls over every supported SDK path, when permission
and tool controls vary, the checks shall assert this delivery matrix:

| Input | Assertion |
| --- | --- |
| absent policy | no permission data in create, update, or prompt [[opencode-13](#opencode-13)], [[opencode-33](#opencode-33)] |
| explicit empty policy | `ask` controls for edit, bash, and webfetch, routed through [[opencode-33](#opencode-33)] |
| private reset sentinel | the empty legacy and v2 reset surfaces in [[opencode-32](#opencode-32)] |
| both tool-list fields absent | no prompt tool data [[opencode-15](#opencode-15)] |

### opencode-228

Where the exact OpenCode CLI conformance target is installed, when its
`serve --help` output is inspected, the managed-server help shall expose
`--hostname` and `--port` [[opencode-8](#opencode-8)].

### opencode-229

Given each explicitly present tool-list field, including empty arrays and a list
beside a portable deny, when every public mapping surface is invoked, the
checks shall assert [[opencode-15](#opencode-15)]'s adapter pre-loader, direct
mapper, and wrapper pre-operation rejection rows plus a diagnostic explaining
OpenCode 1.18.13's persistent permission-rule replacement and lack of exact
per-call tool availability.

### opencode-231

Given canonical, compatibility, malformed, repeated, interleaved, and
permission-denied tool inputs, when the adapter normalizes them, the checks
shall exhaust [[opencode-16](#opencode-16)]'s identifier, name, input,
description, lifecycle, output, duration, de-duplication, count,
pre-terminal-denial, and post-terminal-denial matrix, including distinct `part.id` and
`part.callID` plus terminal snapshots with no predecessor.

### opencode-232

Where OpenCode acceptance dependencies are present per [[opencode-219](#opencode-219)]'s gating,
when a real managed-mode OpenCode run with auto-approved permissions is
prompted to create a file through its tools and the file exists with the
expected content afterwards, the collected stream shall satisfy this real-wire
contract [[opencode-5](#opencode-5)], [[opencode-16](#opencode-16)]:

- unique `tool_use.toolUseId` values, at least one non-empty use input, exactly
  one terminal result per announced identifier, and no result for any other
  identifier;
- no permission request or denied result, and one successful `done` whose tool
  count equals the use count;
- the retry markers and attempt bound from [[opencode-219](#opencode-219)], with
  every retry using a fresh directory even if an earlier failed attempt wrote
  the file;
- no transient classification after successful `done` or after an invariant
  violation, even beside matching capacity text;
- an errored result or a use stranded by a truncated attempt remains eligible
  for a named transient retry.

This is [[opencode-231](#opencode-231)]'s real-release counterpart because only
the live SDK can expose a changed `ToolPart` wire shape.

### opencode-233

_Superseded for usage shape by [[opencode-240](#opencode-240)]._

Given complete, incomplete, malformed, absent, and synthetic terminal
accounting, when the adapter emits the superseded usage shape, it shall select
this legacy matrix [[opencode-30](#opencode-30)]:

| Input | Legacy assertion |
| --- | --- |
| complete finite non-negative integer counters, including zero | `'reported'`; input folds cache read/write into the cache-exclusive base once and output adds disjoint reasoning once |
| absent required counter or negative, fractional, non-finite, or non-numeric present mapped counter | `'unavailable'`, while an absent optional cache counter contributes zero without invalidation |
| absent complete accounting or synthesized error, interruption, exhaustion, or other terminal | `'unavailable'` without an estimate |
| independently observed or valid provider-reported tool calls on any row | preserve the greatest known count |

### opencode-234

Given canonical and legacy content whose role metadata precedes, follows, never
reaches, or is removed from interleaved parts, when normalization runs, the
checks shall exhaust [[opencode-17](#opencode-17)]'s assistant/user selection,
byte-equal assistant reply, ordering gate, unresolved-terminal flush, legacy
unidentified content, removal release, retained-payload cleanup, and
foreign-session isolation rows, with event types from [[opencode-5](#opencode-5)]
and filtering from [[opencode-6](#opencode-6)].

### opencode-235

Given valid and invalid deadlines, canned streams, controllable clocks,
pending operations, and injected managed/external resources, when liveness or
caller abort is exercised, the checks shall exhaust this matrix:

| Concern | Assertions |
| --- | --- |
| timeout configuration | [[opencode-18](#opencode-18)] default, positive override, and invalid values |
| active-wait clock | every reset, no-reset, pause, buffered-event, backlog, monotonic, and host-delay-chunk row in [[opencode-37](#opencode-37)] |
| status recovery | idle, omitted-map idle, busy, retry, other non-idle, failed query, non-settling query, bounded abort, diagnostic members, and terminal counts in [[opencode-38](#opencode-38)] |
| race precedence | pending read, query, recovery, ready idle, and ready rejection races each produce only [[opencode-39](#opencode-39)]'s interrupted terminal |
| dispatch abort/failure | cancellation, known-session abort, raced-result ownership, iterator return, listener cleanup, and resume continuity from [[opencode-40](#opencode-40)] |
| directory scoping | every legacy and v2 request row of [[opencode-41](#opencode-41)] |
| post-terminal cleanup | signal-honoring and ignoring iterators, independently failed phases, bounded client/disposal waits, and managed escalation in [[opencode-42](#opencode-42)] |
| active-session interruption | pre-terminal abort start, bounded retained attempt, backend resume, managed-after-terminal ordering, and external-server preservation in [[opencode-43](#opencode-43)] |

### opencode-54

Where the OpenCode CLI and SDK are available, when a credential-free real
managed server creates an idle session whose terminal SSE event is withheld,
the short-deadline acceptance probe shall recover through the real
`session.status` endpoint, emit [[opencode-38](#opencode-38)]'s idle diagnostic
and terminal, dispose the SDK client, and observe the managed server process
exit without a multi-minute wait.

### opencode-236

Given canonical v1 sibling, v2 typed, v2 generic, malformed, repeated,
interleaved, removed, and incident-scale delta streams across assistant text,
assistant reasoning, and user text, when normalization runs, the checks shall
exhaust [[opencode-19](#opencode-19)]'s classifier, correlation, pending,
suppression, de-duplication, order, removal, state-release, and bounded-drain
rows together with [[opencode-17](#opencode-17)] role gating and
[[opencode-5](#opencode-5)] event types.

### opencode-237

Given fresh, resumed, root, descendant, unrelated, repeated, malformed,
failed, timed-out, and aborted permission fixtures over both SDK paths and
server modes, when the adapter maps and resolves them, the checks shall exhaust
this matrix:

| Concern | Assertions |
| --- | --- |
| auto mapping and delivery | no wildcard, present capabilities including denies, omitted capabilities preserved, and version-correct create/update/prompt placement [[opencode-7](#opencode-7)], [[opencode-33](#opencode-33)] |
| successful root/descendant v1 and v2 asks, including unknown names | once-only native correlation and exact auto extension, or observable request plus reject outside auto [[opencode-20](#opencode-20)] |
| resumed lineage discovery | recursive whole-deadline traversal, invalid-entry tolerance, and failure-before-prompt [[opencode-34](#opencode-34)] |
| run ownership evolution | wrapper seeding, task-part child adoption, fresh and resumed lifecycle addition, owned-descendant deletion, unrelated/malformed preservation, child-route identity, and filtered child conversation [[opencode-56](#opencode-56)], [[opencode-6](#opencode-6)] |
| unrelated or repeated events | no foreign response and no duplicate response |
| missing identifier or unavailable, failed, SDK-error, or timed-out route | exact permission error, one error terminal, and no automated-decision extension [[opencode-20](#opencode-20)] |
| pending v1/v2 response or SSE transport under timeout/caller abort | one run-owned signal cancels native I/O, closes iterator/client, bounds retained state, and preserves [[opencode-35](#opencode-35)] terminal ordering with [[opencode-9](#opencode-9)] |

### opencode-55

Where [[opencode-219](#opencode-219)]'s real OpenCode condition holds, when a
managed auto-mode run writes and verifies a unique absolute `/tmp` file through
an exact shell command under `shellExecute: 'ask'`, the acceptance leg shall
observe a `bash` use and at least one successful automated `once` audit event,
no outer timeout, permission request, denied result, or error, and exactly one
success `done` [[opencode-5](#opencode-5)], [[opencode-20](#opencode-20)].

### opencode-238

_Superseded by [[opencode-240](#opencode-240)]._

Given complete, omitted-component, and inconsistent legacy step counters, when
a caller reads the superseded `usage.breakdown`, it shall match this matrix
[[opencode-30](#opencode-30)]:

| Input | Legacy assertion |
| --- | --- |
| complete five-counter accounting | both partition sides from the step sums |
| omitted cache or reasoning counter | omit that component while remaining published members reconcile, except omitted reasoning removes the whole output side |
| a component subtraction would be negative | omit the affected side and retain the unaffected side |

### opencode-239

_Superseded by [[opencode-240](#opencode-240)]._

Given complete, identity-free, cost-bearing, incomplete, absent, and
inconsistent legacy step accounting, when a caller reads superseded
`usage.records`, it shall match this matrix [[opencode-30](#opencode-30)]:

| Input | Legacy assertion |
| --- | --- |
| each complete step part | one record with `requests: 1` |
| no pinned or runtime model | no model and no placeholder |
| runtime-reported step cost | that cost, with record costs not exceeding the run total |
| incomplete, absent, or partition-inconsistent accounting | no records |

### opencode-240

Given authentic zero, nonzero, partial, malformed, ambiguous, and absent OpenCode
accounting, when a caller reads terminal usage, the checks shall exhaust this
causal report matrix while preserving independently observed `toolUses`
[[opencode-21](#opencode-21)]:

| Concern | Assertions |
| --- | --- |
| stream establishment | before-prompt subscription, bounded handshake wait, first-event preservation, and cleanup transfer [[opencode-45](#opencode-45)] |
| prompt boundary | no caller-supplied message identifier plus every proof, exclusion, ambiguity, fresh fallback, resumed no-fallback, background, and concurrent-prompt row in [[opencode-44](#opencode-44)] and [[opencode-46](#opencode-46)] |
| step ledger | assistant-`parentID` and task-child causal propagation, causal descendant inclusion without child conversation, foreign/pre-existing/unscoped exclusion, key de-duplication/replacement, removal retention, identity failure, and settled coverage [[opencode-47](#opencode-47)] |
| title suppression | fresh, default resumed, meaningful resumed, parent, and every unproved-suppression row in [[opencode-48](#opencode-48)] |
| health gate | healthy exact version plus every partial-without-blocking row in [[opencode-49](#opencode-49)] |
| compaction and retry | canonical continuation, overflow, unlinked/unknown prompt, repeated/conflicting identity, missing assistant, causal/uncorrelated retry, and foreign retry rows in [[opencode-50](#opencode-50)] |
| task/background continuation | command continuation, reused task, repeated/conflicting task identity, one-to-one background success, missing/unmatched/error result, idle ordering, malformed identity, and active-child rows in [[opencode-51](#opencode-51)] |
| public token report | inclusive totals, exact cache/reasoning subsets, complete/partial/omitted coverage, exact records, no removed flat or availability fields, and generic-idle alias rejection [[opencode-21](#opencode-21)] |
| cost | finite non-negative USD `agent-estimate` records, measured-zero retention, missing-cost omission, and whole-run cost only for complete all-cost coverage |

## References

[1]: https://opencode.ai/docs/models/ 'OpenCode model configuration'
[2]: https://opencode.ai/docs/server/ 'OpenCode server'
[3]: https://github.com/anomalyco/opencode/blob/a105350812f05f914c768e468559dbd6bd508d8e/packages/core/src/session/runner/publish-llm-event.ts#L16-L27 'OpenCode 1.18.13 step-finish token split'
[4]: https://github.com/anomalyco/opencode/blob/a105350812f05f914c768e468559dbd6bd508d8e/packages/opencode/src/cli/cmd/stats.ts#L193-L202 'OpenCode 1.18.13 token roll-up'
[5]: https://github.com/anomalyco/opencode/blob/v1.18.13/packages/opencode/src/session/prompt.ts 'OpenCode 1.18.13 prompt-tool permission replacement'
[6]: https://github.com/anomalyco/opencode/blob/v1.18.13/packages/opencode/src/permission/index.ts 'OpenCode 1.18.13 permission evaluation'
[7]: https://github.com/anomalyco/opencode/blob/v1.18.13/packages/opencode/src/session/tools.ts 'OpenCode 1.18.13 agent/session permission merge'
[8]: https://github.com/anomalyco/opencode/blob/v1.18.13/packages/opencode/src/session/session.ts#L338-L406 'OpenCode 1.18.13 usage cost calculation'
[9]: https://github.com/anomalyco/opencode/blob/a105350812f05f914c768e468559dbd6bd508d8e/packages/opencode/src/session/prompt.ts#L190-L276 'OpenCode 1.18.13 title inference'
[10]: https://github.com/anomalyco/opencode/blob/a105350812f05f914c768e468559dbd6bd508d8e/packages/opencode/src/session/compaction.ts#L356-L535 'OpenCode 1.18.13 compaction and continuation flow'
[11]: https://github.com/anomalyco/opencode/blob/a105350812f05f914c768e468559dbd6bd508d8e/packages/opencode/src/tool/task.ts#L64-L243 'OpenCode 1.18.13 foreground and background task continuations'
[12]: https://github.com/anomalyco/opencode/blob/a105350812f05f914c768e468559dbd6bd508d8e/packages/opencode/src/session/processor.ts#L630-L680 'OpenCode 1.18.13 retry accounting boundary'
[13]: https://github.com/anomalyco/opencode/blob/a105350812f05f914c768e468559dbd6bd508d8e/packages/sdk/js/src/v2/gen/types.gen.ts#L7226-L7252 'OpenCode 1.18.13 global-health version response'
[14]: https://github.com/anomalyco/opencode/blob/a105350812f05f914c768e468559dbd6bd508d8e/packages/opencode/src/session/prompt.ts#L656-L670 'OpenCode 1.18.13 user message created with role "user" and an identifier minted by MessageID.ascending() when the caller supplies none'
[15]: https://github.com/anomalyco/opencode/blob/a105350812f05f914c768e468559dbd6bd508d8e/packages/opencode/src/session/prompt.ts#L1186-L1200 'OpenCode 1.18.13 assistant message created with parentID set to the last user message id'
[16]: https://github.com/anomalyco/opencode/blob/a105350812f05f914c768e468559dbd6bd508d8e/packages/opencode/src/tool/task.ts#L216-L252 'OpenCode 1.18.13 background task result injected into the parent session'
