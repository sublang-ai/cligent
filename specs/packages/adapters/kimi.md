<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# kimi: Kimi Code Adapter

## Intent

This package lets a consumer of the agent-adapter contract run Kimi Code through one per-run `kimi acp` child process over ACP stdio, per [DR-011](../../decisions/011-kimi-code-acp-integration.md).
It owns how a portable request becomes an ACP session and prompt, how that session's traffic becomes unified events, permission replies, resume continuity, and the honest absence of token accounting, not what a caller does with them and not the CLI's own behavior.
Its requirements are stated in this project's `AgentAdapter`, `AgentEvent`, `AgentOptions`, `PermissionPolicy`, `DonePayload`, and `Cligent` vocabulary, which the engine defines and without which this adapter's behavior cannot be stated.

## External Behavior

### Adapter Identity

### kimi-1

The public adapter module shall expose `KimiAdapter` implementing `AgentAdapter<KimiEffort>` with `agent: 'kimi'` for the maintained Kimi Code product [[1]].

### Availability

### kimi-2

When `isAvailable()` uses the adapter's default probe, it shall run the documented `kimi --version` command on `PATH` with a 5,000 ms timeout, without starting ACP, authenticating, or mutating Kimi configuration, and classify the result through this matrix [[3]]:

| Probe outcome | Result |
| --- | --- |
| the command succeeds within the timeout and [[engine-25](../engine.md#engine-25)] does not find its version below the supported floor | `true` |
| the executable is missing, exits nonzero, times out, or reports a version below that floor | `false` |

### ACP Lifecycle

### kimi-3

When a mapped, non-pre-aborted `run()` reaches process invocation, the adapter shall spawn exactly one `kimi acp` child with `shell: false`, the absolute effective working directory, the inherited environment, piped stdin and stdout, and stderr drained into a bounded diagnostic tail.

### kimi-14

When the child starts ACP, the adapter shall initialize protocol version 1 with empty client capabilities and reject any other negotiated version, advertising neither filesystem nor terminal reverse-RPC support [[2]][[6]].

### kimi-4

After initialization, the adapter shall select session setup through this matrix, always sending the absolute effective cwd and `mcpServers: []`:

| `AgentOptions.resume` | Session operation and identity |
| --- | --- |
| absent or empty | call `session/new`; reject an empty returned session identifier |
| non-empty | call `session/resume` with that identifier; call neither `session/load` nor history replay |

### kimi-16

While no caller abort or setup or configuration failure intervenes after session setup, the adapter shall perform the run sequence in this order: apply a provided model through `session/set_config_option`, apply a provided thinking value, apply a mapped permission mode, emit `init` as the run's first unified event, then call `session/prompt` with exactly one text content block, with omitted controls causing no corresponding configuration call.

### kimi-17

When the adapter emits `init`, it shall select the payload through this matrix:

| Member | Selection |
| --- | --- |
| `cwd` | the absolute effective working directory |
| `model`, no requested model | the initial session configuration's selected model, otherwise `unknown` |
| `model`, requested model | the post-update selected model, otherwise the requested value |
| `tools` | `[]` |
| `capabilities.toolsKnown` | `false` |
| `capabilities.toolsSource` | `'unavailable'`, distinguishing an unknown surface from a configured empty set |
| `capabilities.acpProtocolVersion` | negotiated ACP protocol version |
| `capabilities.writablePaths` | the report from [[kimi-8](#kimi-8)] when present, otherwise omitted |

### Event Normalization

### kimi-5

After `init` and while no terminal has been selected, the adapter shall dispatch validated ACP traffic through this matrix:

| ACP traffic | Outcome |
| --- | --- |
| `session/update` `agent_message_chunk` | text handling in [[kimi-19](#kimi-19)] |
| `session/update` `agent_thought_chunk` or `user_message_chunk` | no unified event |
| `session/update` `tool_call` or `tool_call_update` | the correlated lifecycle in [[kimi-18](#kimi-18)] |
| `session/update` `plan`, `plan_update`, or `plan_removed` | one `kimi:plan` extension carrying the validated update |
| another `session/update` case | no unified event |
| `session/request_permission` | the request and reply selected by [[kimi-22](#kimi-22)] |
| prompt response, ACP failure, or child exit | the terminal selected by [[kimi-33](#kimi-33)], [[kimi-6](#kimi-6)], [[kimi-29](#kimi-29)], and [[kimi-28](#kimi-28)] |

### kimi-30

For a run that reaches `init`, a validated same-session update arriving after session setup but before that event shall be retained in arrival order and dispatched immediately afterward through [[kimi-5](#kimi-5)]'s ordinary normalization.

### kimi-18

For each native `toolCallId`, the adapter shall emit at most one correlated `tool_use` followed by at most one terminal `tool_result`, selecting their payloads through these matrices:

| `tool_use` member | Selection |
| --- | --- |
| state | merge later non-null title and kind plus later defined status, content, `rawInput`, and `rawOutput` values, including null, under the native identifier |
| emission point | as soon as `rawInput` is an object or parses to a JSON object; otherwise when a terminal update forces the fallback |
| `toolName` | latest title, then kind, otherwise `unknown_tool` |
| `toolUseId` | native `toolCallId` |
| `input`, object | that object |
| `input`, string containing a JSON object | the parsed object |
| `input`, another non-empty string | `{ raw: <string> }` at terminal |
| `input`, absent, null, or empty string | `{}` at terminal |
| `input`, another value including an array | `{ value: <value> }` at terminal |
| `description` | title when non-empty, otherwise omitted |

| `tool_result` member | Selection |
| --- | --- |
| terminal trigger | first `completed` or `failed` state on either tool update form, after its `tool_use` |
| `toolName` / `toolUseId` | the correlated selections above |
| status | `completed` to `success`; `failed` to `error` |
| output | defined `rawOutput`, including null; otherwise newline-joined text content; otherwise the content array or null |
| duration | the terminal update's observation time minus the call's first observed update time |

### kimi-19

When the adapter normalizes a validated `agent_message_chunk`, `agent_thought_chunk`, or `user_message_chunk`, it shall select this matrix:

| Content | Outcome |
| --- | --- |
| `agent_message_chunk` text, including an empty string | emit `text_delta` with the exact text; append the deltas in order for `DonePayload.result`; omit that result only when no assistant text accumulated |
| non-text agent-message content, `agent_thought_chunk`, or `user_message_chunk` | emit no `text_delta` and contribute neither text nor terminal result |

### Terminal Outcomes

### kimi-33

When a Kimi run reaches preflight or terminal selection, the adapter shall select the first applicable row in priority order per [DR-011](../../decisions/011-kimi-code-acp-integration.md), closing caller-abort eligibility at the row's commitment point while still replacing a lower-priority committed non-abort candidate if a higher-priority one becomes known:

| Priority state | Outcome | Commitment point |
| --- | --- | --- |
| caller signal already aborted at adapter entry | one interrupted `done` before runtime and option validation; no child spawn | adapter entry |
| no entry abort; runtime or option validation rejects | propagate the rejection before spawning or emitting events | validation rejection |
| caller abort after spawn and before another terminal cause commits | one interrupted `done` ahead of every native stop, authentication, protocol, setup, prompt, process, or cleanup candidate; after an active-prompt drain, queue it before abort-initiated final child termination and apply [[kimi-25](#kimi-25)]'s bounded delivery handoff; report any later abnormal or forced-cleanup failure only through [[kimi-35](#kimi-35)] | caller-signal observation |
| no caller abort; authentication-classified ACP failure | `KIMI_AUTH_REQUIRED` and error `done` through [[kimi-21](#kimi-21)] | ACP operation rejection |
| no higher candidate; protocol failure | `KIMI_ACP_ERROR` and error `done` through [[kimi-27](#kimi-27)] and [[kimi-29](#kimi-29)] | protocol rejection, before forced teardown |
| no higher candidate; child spawn or asynchronous process error, nonzero or unexpected-signal close, required `SIGKILL`, or survival through final grace | `KIMI_ACP_ERROR` and error `done` through [[kimi-29](#kimi-29)], overriding every native stop including `cancelled` | spawn/process failure, close observation, or the decision to escalate beyond `SIGTERM` |
| no higher candidate; another setup or prompt failure | `KIMI_ACP_ERROR` and error `done` through [[kimi-29](#kimi-29)] | operation rejection, before cleanup |
| valid native stop after a clean close or adapter-owned cleanup `SIGTERM` | the [[kimi-6](#kimi-6)] mapping | clean close observation or immediately before sending cleanup `SIGTERM` |

### kimi-6

When [[kimi-33](#kimi-33)] selects a valid ACP prompt response, the adapter shall map its stop reason through this matrix:

| ACP `stopReason` | Outcome |
| --- | --- |
| `end_turn` | `done.status: 'success'` |
| `cancelled` | `done.status: 'interrupted'` |
| `max_tokens` or `max_turn_requests` | `done.status: 'max_turns'` |
| `refusal` | non-recoverable `KIMI_REFUSAL` error with `Kimi refused the prompt`, followed by `done.status: 'error'` |

### kimi-21

When [[kimi-33](#kimi-33)] selects missing authentication reported by ACP JSON-RPC code `-32000` or an authentication diagnostic, the adapter shall emit non-recoverable `KIMI_AUTH_REQUIRED` with actionable `kimi login` guidance and shall never launch login itself; Kimi Code `0.39.1`'s default native ACP path admits exactly these authentication routes [[8]][[10]][[11]][[12]][[13]][[14]]:

| Runtime state | Session gate |
| --- | --- |
| stored OAuth material resolved from the default model, or any provider reports logged in, including after `kimi login` | admitted |
| configured default-model alias resolving to non-OAuth credentials | admitted |
| both `KIMI_MODEL_NAME` and `KIMI_MODEL_API_KEY` environment values | admitted through a runtime-only synthesized provider and default alias |
| bare `MOONSHOT_API_KEY` or `KIMI_API_KEY` | not admitted because no default-model alias exists |

### kimi-29

When [[kimi-33](#kimi-33)] selects a non-authentication child spawn, ACP operation, process, close, or containment failure, the adapter shall emit non-recoverable `KIMI_ACP_ERROR` whose message preserves the thrown diagnostic, any structured `data.details`, `data.detail`, or `data.message`, and the bounded stderr tail without duplicating text, followed by `done.status: 'error'`.

### kimi-28

For every terminal path selected by [[kimi-33](#kimi-33)], the adapter shall emit its applicable non-recoverable unified error followed by exactly one `done` carrying elapsed duration, [[kimi-12](#kimi-12)]'s resume selection, [[kimi-13](#kimi-13)]'s usage, and [[kimi-19](#kimi-19)]'s accumulated result when non-empty.

### kimi-35

When [[kimi-25](#kimi-25)]'s caller-abort cleanup discovers a secondary failure after queuing interrupted `done`, the adapter shall select its diagnostic sink through this matrix:

| Reporter state | Outcome |
| --- | --- |
| constructor supplies a non-throwing `reportCleanupFailure` | invoke that reporter exactly once with the exact cleanup `Error`; call no default reporter |
| constructor omits `reportCleanupFailure` | call `console.error` exactly once with `Kimi ACP cleanup after caller abort failed: ${error.message}` |
| supplied reporter throws | suppress that exception, call no default reporter, preserve interrupted `done`, emit no later event, and start no further cleanup |

### Permission Mapping

### kimi-7

When the adapter maps the closed `PermissionPolicy.mode` set in [[engine-21](../engine.md#engine-21)] under [[engine-52](../engine.md#engine-52)] per [DR-005](../../decisions/005-per-adapter-permission-configuration.md), it shall select this exhaustive matrix:

| Policy input | Outcome |
| --- | --- |
| `permissions` absent | set no ACP mode and preserve Kimi's native permission configuration |
| supplied policy with mode omitted, including `{}` and every capability-level combination | reject before spawn because ACP cannot deterministically impose Cligent's default-ask policy over Kimi's earlier native decisions [[4]] |
| `mode: 'auto'`, with any capability levels | set ACP mode `auto`; ignore the capability levels because the whole-mode selection takes precedence |
| `mode: 'bypass'`, with any capability levels | reject before spawn because Kimi `yolo` is not an unchecked bypass |

### kimi-22

When an active prompt receives `session/request_permission` for its session, the adapter shall emit `permission_request` with the native tool identifier, title then kind then `unknown_tool` name, a headless-run reason, and input selected immediately through this matrix, then select its reply through the option matrix [[7]]:

| Native input | Unified input |
| --- | --- |
| object | that object |
| string containing a JSON object | the parsed object |
| another non-empty string | `{ raw: <string> }` |
| absent, null, or empty string | `{}` |
| another value including an array | `{ value: <value> }` |

| State or offered options | Reply |
| --- | --- |
| caller abort requested | cancelled |
| reject-kind option whose id is `plan_reject_and_exit` or whose trimmed case-insensitive name is `Reject and Exit` | that option, before every other reject |
| otherwise, one or more `reject_once` options | first such option |
| otherwise, one or more `reject_always` options | first such option |
| no reject option | cancelled rather than any allow option |

### kimi-8

Where Kimi exposes no independently active filesystem sandbox or ACP filesystem capability, when the adapter maps `PermissionPolicy.writablePaths` per [[engine-53](../engine.md#engine-53)] and [[engine-54](../engine.md#engine-54)], it shall select this matrix without changing [[kimi-7](#kimi-7)]'s mode outcome:

| Input | Outcome |
| --- | --- |
| absent or empty | omit `WritablePathsPermissionMapping` |
| valid non-empty entries under `mode: 'auto'` | canonical paths with `enforcement: 'ambient'` |
| any invalid entry | reject before spawn |

### Options Mapping

### kimi-9

When the adapter maps the Kimi values in [[engine-40](../engine.md#engine-40)], it shall select this matrix per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), [[engine-50](../engine.md#engine-50)], and [[5]]:

| `AgentOptions.effort` | Outcome |
| --- | --- |
| omitted | set no ACP `thinking` override |
| `'off'` | set ACP `thinking` to `off` |
| `'on'` | set ACP `thinking` to `on`, selecting the chosen model's native default rather than a portable tier |
| any other dynamic value | reject before spawn with the metadata-backed error naming Kimi and the allowed values |

### kimi-23

When the adapter maps `AgentOptions.model` after session setup, it shall select this matrix:

| Model input | Outcome |
| --- | --- |
| provided, including an empty string | apply that exact value through ACP config option `model` |
| omitted | apply no model override and retain the session's selected model, which is the provider default only for a fresh session with no prior override |

### kimi-10

When the adapter maps tool-list options per [[engine-17](../engine.md#engine-17)], it shall select this matrix:

| Input | Outcome |
| --- | --- |
| both `allowedTools` and `disallowedTools` absent | preserve Kimi's native tool registry |
| either field explicitly provided, including an empty array | reject before spawn because ACP exposes no exact tool-registry restriction |

### kimi-24

Where `maxTurns` or `maxBudgetUsd` is explicitly provided, including zero, the adapter shall reject before spawn because Kimi ACP exposes no compatible per-run control.

### Abort Handling

### kimi-11

When caller abort is requested before another terminal cause commits, the adapter shall select the lifecycle through this matrix:

| Abort phase | Outcome |
| --- | --- |
| signal already aborted at adapter entry | select [[kimi-33](#kimi-33)]'s interruption before preflight, spawn no child, and yield exactly one interrupted `done` |
| child spawned but session setup incomplete | select interruption, queue exactly one interrupted `done`, and terminate the child after [[kimi-25](#kimi-25)]'s bounded delivery handoff |
| backend session known | send `session/cancel` exactly once, suppress any later configuration or prompt stage, continue draining an active prompt response and queued updates when possible, queue exactly one [[engine-73](../engine.md#engine-73)] interrupted `done`, begin final child termination only after [[kimi-25](#kimi-25)]'s bounded delivery handoff, and report only [[kimi-35](#kimi-35)]'s secondary diagnostic afterward |

### Resume Token

### kimi-12

When the adapter emits terminal `done`, it shall select `resumeToken` through this matrix:

| Terminal state | Selection |
| --- | --- |
| any status after a backend session identifier is known | backend identifier |
| `error` or `interrupted`, no backend identifier, non-empty inbound `AgentOptions.resume` | inbound resume value |
| every other no-backend state | omitted; any locally generated correlation identifier remains non-resumable |

### Token Accounting

### kimi-13

For the pinned Kimi Code runtime, every terminal `done` shall omit token and cost reports under [[engine-31](../engine.md#engine-31)], count `usage.toolUses` from distinct emitted native tool calls per [[engine-65](../engine.md#engine-65)], and preserve prompt status and accumulated result independently, because its ACP prompt response supplies only a stop reason while its later `usage_update` supplies session context occupancy rather than invocation-scoped input/output or cost accounting [[9]], and [DR-011](../../decisions/011-kimi-code-acp-integration.md) forbids reading private Kimi session state outside ACP.

### kimi-31

Where a schema-valid ACP prompt-response or session-update surface lacks the evidence required for an accounting axis, the adapter shall omit that axis independently from public token and cost accounting under [[engine-62](../engine.md#engine-62)]:

| Axis | Evidence required before promotion |
| --- | --- |
| token report | invocation ownership and input/output, cache, and reasoning semantics |
| cost report | invocation ownership and amount, currency, and provenance semantics [[engine-61](../engine.md#engine-61)] |

## Internal Behavior

### Protocol Dependency

### kimi-15

The adapter shall consume the official generic `@agentclientprotocol/sdk` public surface at the exact version paired with the Kimi Code conformance target by [[package-23](../package.md#package-23)], without importing a legacy or unpublished Kimi-specific SDK or that generic SDK's private build output.

### Wire Validation

### kimi-27

When ACP bytes and messages cross the adapter-owned wire boundary, it shall validate only structure and fields the adapter consumes, admit unknown fields, drop unhandled update cases, failure-isolate the optional unstable usage extension, and select every boundary case through this matrix, with every `protocol failure` terminating the child and selecting its observable outcome through [[kimi-33](#kimi-33)], and with a selected protocol error flowing through [[kimi-29](#kimi-29)] and [[kimi-28](#kimi-28)]:

| Boundary state | Outcome |
| --- | --- |
| inbound UTF-8 JSON lines split or coalesced across arbitrary chunks, including one unterminated final line | reconstruct and forward each complete non-empty message in order |
| invalid UTF-8 or JSON, or the accumulated decoded buffer exceeding 16 MiB in JavaScript code units immediately after one input chunk is appended | protocol failure |
| inbound value not a JSON-RPC 2.0 object; invalid request, notification, response, error, or id shape; response id not pending | protocol failure |
| handled initialize, session, configuration, prompt, update, or permission payload missing or invalid in a consumed field | protocol failure |
| valid object with unknown fields, or `session/update` with an unhandled non-empty case | admit the unknown fields without treating them as malformed; drop an unhandled update before the SDK |
| malformed optional prompt usage with otherwise valid stop reason | treat usage as absent without changing the terminal status |
| handled update before a backend session, handled update for another session, or permission request outside the active prompt/session | protocol failure without exposing its private update or request payload as a unified event |

### Session Identity

### kimi-26

When the adapter assigns `AgentEvent.sessionId`, it shall select the identifier through this matrix:

| Identity state | Selection |
| --- | --- |
| before a backend identifier, no non-empty inbound resume | one generated non-empty identifier from [[engine-7](../engine.md#engine-7)] |
| before a backend identifier, non-empty inbound resume | inbound resume value |
| after `session/new` or `session/resume` succeeds | backend identifier for every later event |

### Process Containment

### kimi-25

After a run has spawned a child, cleanup shall perform this containment sequence and apply its outcome cases:

| Stage or outcome case | Required behavior |
| --- | --- |
| cleanup begins before the terminal cause commits | retain the abort listener, end stdin, and await close for a bounded grace |
| terminal cause commits | remove the abort listener and close protocol resources with the child or after final grace |
| caller-abort terminal queued | wait until an active consumer advances past it or one event-loop handoff completes, whichever occurs first; then continue containment without requiring another iterator request |
| child still open after the first grace | send `SIGTERM` and await another bounded grace |
| child still open after the second grace | send `SIGKILL` and await one final grace |
| terminal prompt response already selected when cleanup sends `SIGTERM` | preserve the selected outcome |
| cleanup already in progress or complete | reuse its one promise and outcome; repeat no protocol close, stdin end, or process signal |
| process requires `SIGKILL` or remains alive after final grace, with no caller abort or higher authentication / protocol candidate selected | surface the failure through [[kimi-29](#kimi-29)] and select error through [[kimi-33](#kimi-33)] |
| caller-aborted run later closes nonzero or on an unexpected signal, requires `SIGKILL`, or survives final grace | preserve its queued interrupted terminal and report the exact cleanup failure once through [[kimi-35](#kimi-35)], without emitting another event or starting another cleanup sequence |

## Verification

### kimi-201

Given canned valid ACP traffic, when the adapter normalizes one prompt, the resulting unified stream shall satisfy this matrix:

| Native traffic | Assertions |
| --- | --- |
| text, non-text message, thought, and user chunks, including empty text and a no-text run | exact ordered `text_delta` values only for text, with exact concatenation or omitted terminal result as [[kimi-5](#kimi-5)] and [[kimi-19](#kimi-19)] select |
| distinct and duplicate tool-call lifecycles spanning every update form and fallback | one correlated `tool_use` and at most one terminal `tool_result` per native identifier, with every state-merge, emission, name, identifier, input, description, trigger, status, output, duration, and ordering selection in [[kimi-18](#kimi-18)] |
| plan, plan update, and plan removal | one exact `kimi:plan` event and payload for each [[kimi-5](#kimi-5)] |
| permission requests spanning every payload fallback and option order | exact observable payload followed by every reply priority in [[kimi-22](#kimi-22)] |
| every valid stop reason | exactly one terminal admitted by [[kimi-33](#kimi-33)] with [[kimi-6](#kimi-6)]'s exact status and refusal error, [[kimi-12](#kimi-12)]'s resume selection, [[kimi-13](#kimi-13)]'s accounting, and [[kimi-28](#kimi-28)]'s result and elapsed duration |
| ACP or child failure | non-recoverable error before exactly one error terminal [[kimi-29](#kimi-29)] [[kimi-28](#kimi-28)] |

### kimi-202

Where application configuration selects a representative model and `effort: 'on'` for this adapter, when the runtime constructs and invokes the corresponding `Cligent`, the model shall be forwarded unchanged, ACP thinking shall select that model's native default, and the configuration order shall match [[kimi-16](#kimi-16)], [[kimi-23](#kimi-23)], and [[kimi-9](#kimi-9)].

### kimi-203

Given caller abort at each lifecycle phase, when the adapter runs, it shall satisfy this matrix, every row using [[kimi-33](#kimi-33)]'s priority, [[kimi-12](#kimi-12)]'s resume selection, removing the caller listener, closing protocol resources, and initiating no cleanup sequence more than once under [[kimi-11](#kimi-11)], [[kimi-25](#kimi-25)], and [[kimi-28](#kimi-28)]:

| Phase | Assertions |
| --- | --- |
| already aborted | no spawn and one interrupted terminal |
| before backend session | one cleanup sequence, no later configuration or prompt, one interrupted terminal |
| during configuration | one cancel after backend identity, no later stage, and one interrupted terminal |
| active prompt | one cancel, queued response and updates drained when possible, one interrupted terminal emitted before final child termination |

### kimi-34

Under [[kimi-230](#kimi-230)]'s controlled ACP-subprocess harness, given each primary candidate paired with each close state, when the adapter runs, the check shall assert exactly one [[kimi-25](#kimi-25)] containment sequence, exactly one terminal, terminal-versus-close order, exact [[kimi-35](#kimi-35)] diagnostic cardinality, and this [[kimi-33](#kimi-33)] matrix:

| Primary candidate | clean or adapter-owned `SIGTERM` close | nonzero close | unexpected-signal close | requires `SIGKILL`, including one caller-aborted child surviving final grace |
| --- | --- | --- | --- | --- |
| `end_turn` | no error; success `done` after close [[kimi-6](#kimi-6)] | `KIMI_ACP_ERROR`, then error `done` after close [[kimi-29](#kimi-29)] | same | same, with one `SIGTERM`, one `SIGKILL`, and no repeated cleanup |
| `refusal` | `KIMI_REFUSAL`, then error `done` after close [[kimi-6](#kimi-6)] | `KIMI_ACP_ERROR` rather than refusal, then error `done` after close [[kimi-29](#kimi-29)] | same | same, bounded and idempotent |
| native `cancelled` | no error; interrupted `done` after close [[kimi-6](#kimi-6)] | `KIMI_ACP_ERROR`, then error `done` after close [[kimi-29](#kimi-29)] | same | same, bounded and idempotent |
| caller abort, including during the post-prompt close wait before close or signal escalation commits another cause | no error; interrupted `done` queued before abort-initiated stdin close or child termination, delivered first while the consumer advances, and containment continuing after one event-loop handoff when consumption stalls [[kimi-11](#kimi-11)] | the same terminal order and one later secondary cleanup diagnostic, with no later unified event | same | the same terminal order, exact one-time signal sequence and diagnostic, and bounded completion even when the child survives final grace |

### kimi-36

Under [[kimi-230](#kimi-230)]'s controlled ACP-subprocess harness, given caller abort followed by a cleanup failure, when each [[kimi-35](#kimi-35)] reporter state is selected, the check shall assert this matrix:

| Reporter state | Assertions |
| --- | --- |
| supplied non-throwing reporter | one call with the exact cleanup `Error`, no default report, and interrupted `done` unchanged |
| omitted reporter | one exact default `console.error` diagnostic and interrupted `done` unchanged |
| supplied throwing reporter | one attempted call, no default report, the reporter exception suppressed, one cleanup sequence, interrupted `done` unchanged, and no later event |

### kimi-204

Given the complete `PermissionPolicy` mode and capability matrix plus every headless permission-option shape, when the adapter maps a run, it shall satisfy these assertions:

- absent policy preserves native configuration; every supplied no-mode capability combination rejects; capability-populated `auto` selects only auto plus [[kimi-8](#kimi-8)]'s independent writable report; and capability-populated `bypass` rejects [[kimi-7](#kimi-7)];
- an active request emits the exact unified payload and selects `Reject and Exit`, first reject-once, first reject-always, or cancellation in [[kimi-22](#kimi-22)]'s priority, including caller abort; and
- no rejected or invalid mapping reaches the spawn seam [[kimi-7](#kimi-7)] [[kimi-8](#kimi-8)].

### kimi-32

Given a schema-valid ACP `usage_update` carrying context occupancy and a prompt response carrying hypothetical usage counters before the evidence gate is met, when repository integration verification runs prompts carrying each form, it shall assert that each prompt completes while terminal usage contains only independently observed tool calls and no token or cost report [[kimi-13](#kimi-13)] [[kimi-31](#kimi-31)].

### kimi-218

Given an `AgentOptions.effort` value that is omitted, `off`, `on`, another adapter's value, or an arbitrary unknown string, and an `AgentOptions.model` value that is omitted or provided, when the adapter maps a run, it shall satisfy this matrix:

| Inputs | Assertions |
| --- | --- |
| effort omitted, `off`, or `on`; model omitted | exact [[kimi-9](#kimi-9)] outcome, no model override, and the ACP call order and omissions in [[kimi-16](#kimi-16)] and [[kimi-23](#kimi-23)] |
| effort omitted, `off`, or `on`; model provided, including empty | exact [[kimi-9](#kimi-9)] outcome and [[kimi-23](#kimi-23)] model behavior in [[kimi-16](#kimi-16)]'s ACP call order |
| another adapter's effort or an arbitrary unknown string; any model | rejection before spawn naming Kimi and exactly its allowed values |

### kimi-219

Where a `Cligent` is constructed on the adapter with `CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first to create and then to update a temporary file in a throwaway working directory, the adapter's auto-mode ACP mode per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) shall let both non-destructive writes proceed without interactive approval [[kimi-7](#kimi-7)]:

- the file shall exist with the expected contents after each phase;
- neither stream shall contain `permission_request`, a denied tool result, or an error;
- each stream shall terminate with successful `done`;
- filesystem state shall be the ground-truth assertion, because adapters normalize file edits differently;
- the harness shall retry the complete fresh probe after, and only after, an explicit upstream-overload, rate-limit, or service-unavailable failure, shall make at most two retries, and shall treat any other failure and the third consecutive named transient failure as fatal;
- the leg shall self-skip when the `kimi` CLI the adapter spawns is absent from `PATH` or its credential is absent, shall hard-fail instead under `CI`, and a missing dependency for one adapter shall never skip another's leg;
- Kimi Code `0.39.1` admits a prior interactive OAuth `kimi login`, a configured default model resolving to non-OAuth credentials, or the `KIMI_MODEL_NAME` plus `KIMI_MODEL_API_KEY` environment overlay, while a bare `MOONSHOT_API_KEY` satisfies none of them [[kimi-21](#kimi-21)];
- the harness exercises the OAuth route exclusively, so its credential probe shall run with the `KIMI_MODEL_*` overlay removed exactly as the live legs do, inheriting it being what would let an environment-configured model report a spent OAuth credential as usable and make those legs fail instead of self-skipping;
- because Kimi rotates its refresh token on every refresh and persists the replacement into the refreshing home, a credential restored from an immutable CI secret is single-use;
- the harness shall therefore probe credential usability once, before any Kimi leg runs and against the same shared clone the suite will use, and shall distinguish two conditions: an absent fixture or CLI remains a hard failure under `CI`, while a present-but-spent credential shall self-skip every live Kimi leg — the composite fanout included — with a precise reason, under `CI` as well, because no runner configuration can supply a fresh token and a failure there would not indicate a defect in the behavior under test;
- the credential-free ACP initialization conformance check shall remain mandatory in `CI` regardless, so a protocol-surface regression still fails the build;
- locally, the Kimi source home shall resolve in order from `CLIGENT_KIMI_ACCEPTANCE_HOME`, an absolute `KIMI_CODE_HOME`, or the documented `~/.kimi-code` default, and the Kimi CLI shall resolve from `PATH` or that source home's managed `bin` directory;
- under `CI`, `CLIGENT_KIMI_ACCEPTANCE_HOME` shall name an absolute, dedicated source home containing regular files at `config.toml` and `credentials/kimi-code.json`, missing or invalid Kimi credentials or CLI failing like every other adapter dependency;
- the harness shall dereference and copy only the source config and credentials into one temporary `KIMI_CODE_HOME`, harden the copied config, credential files, and directories to owner-only permissions, share that clone across the complete acceptance suite including bounded retries and fanout, restore the caller's environment and PATH around each consumer, and remove the temporary home after the suite, without mutating the source;
- acceptance files shall run serially so the shared clone has one writer, and an absent or invalid automatically discovered local source shall self-skip with a precise reason; and
- a dedicated CI source is disposable, and a local source may require `kimi login` again, because an OAuth refresh against the clone may leave its prior token stale.

### kimi-230

Given the installed Kimi target and fake ACP subprocesses whose protocol traffic crosses real stdio, when repository system verification runs fresh, resumed, successful, aborted, and failing prompts, it shall assert this matrix:

| Surface | Assertions |
| --- | --- |
| package and target | `KimiAdapter` loads with its typed identity, the official SDK public surface compiles at [[kimi-15](#kimi-15)]'s paired target, and no private SDK build path is consumed [[kimi-1](#kimi-1)] |
| availability | the real default probe invokes only `kimi --version`, respects its timeout and version floor, selects every result in [[kimi-2](#kimi-2)], and starts neither ACP nor authentication |
| process | one child for every run reaching invocation, with [[kimi-3](#kimi-3)]'s cwd, environment, pipes, and drained bounded stderr; one [[kimi-25](#kimi-25)] cleanup sequence shall either observe its close or report its [[kimi-33](#kimi-33)] primary or [[kimi-35](#kimi-35)] secondary outcome after final grace |
| wire | split, coalesced, and unterminated-final-line framing; oversized decoded buffers; every invalid JSON-RPC object, envelope, id, pending response, error, and consumed payload; unknown fields and update cases; optional usage; and handled pre-session or cross-session traffic select [[kimi-27](#kimi-27)]'s exact outcome, with each protocol failure terminating without exposing private traffic |
| setup | protocol version 1 and empty capabilities succeed while another negotiated version rejects; fresh and resumed session selection and ordered configuration satisfy [[kimi-14](#kimi-14)], [[kimi-4](#kimi-4)], and [[kimi-16](#kimi-16)] |
| prompt | `init` carries [[kimi-26](#kimi-26)]'s backend session identity and every [[kimi-17](#kimi-17)] fallback; valid same-session text, tool, and plan updates arriving during configuration stay hidden until `init`, then dispatch immediately in exact arrival order through [[kimi-30](#kimi-30)] and [[kimi-5](#kimi-5)] before [[kimi-16](#kimi-16)]'s one-text-block prompt, with buffered tool duration spanning [[kimi-18](#kimi-18)]'s original first and terminal observation times |
| permissions and options | reverse requests reject per [[kimi-22](#kimi-22)]; unsupported policy, including writable-path failures, rejects per [[kimi-7](#kimi-7)] and [[kimi-8](#kimi-8)]; empty and non-empty tool lists reject per [[kimi-10](#kimi-10)]; invalid effort rejects per [[kimi-9](#kimi-9)]; and zero and nonzero limits reject per [[kimi-24](#kimi-24)], all before spawn |
| failures | structured authentication, bare-key, protocol, operation, arbitrary process-close, and forced-cleanup candidates preserve diagnostics and select the complete priority in [[kimi-33](#kimi-33)] through [[kimi-21](#kimi-21)], [[kimi-27](#kimi-27)], [[kimi-29](#kimi-29)], and [[kimi-28](#kimi-28)] |
| isolation | an aborted run retains no [[kimi-25](#kimi-25)] caller listener, and event identity changes only through [[kimi-26](#kimi-26)] |

### kimi-220

Given normal, failed, and aborted runs before or after backend identity, when the adapter emits events and terminal `done`, it shall select their identity and continuity through this matrix [[kimi-26](#kimi-26)] [[kimi-12](#kimi-12)] [[kimi-28](#kimi-28)]:

| Observed state | Event `sessionId` | `DonePayload.resumeToken` |
| --- | --- | --- |
| backend session identifier observed | backend identifier | backend identifier |
| no backend identifier and non-empty inbound resume | inbound resume | inbound resume only for error or interruption; otherwise omitted |
| no backend identifier and no non-empty inbound resume | one generated correlation identifier | omitted |

### kimi-222

Given `PermissionPolicy.writablePaths`, when the adapter maps permissions, it shall select this complete matrix without changing the permission or tool outcome [[kimi-8](#kimi-8)]:

| Input | Assertion |
| --- | --- |
| absent or empty | no writable-path report |
| valid non-empty entries with `mode: 'auto'` | canonical paths and `enforcement: 'ambient'` |
| any invalid entry | rejection before spawn |

### kimi-229

Where either tool-list field is omitted, empty, or non-empty, when the adapter maps a run, omission shall preserve the native tool registry while every explicitly provided list shall reject before spawning `kimi acp` [[kimi-10](#kimi-10)].

### kimi-240

Given authentic accounting is sought across successful, interrupted, max-turn, refusal, errored, and synthetic terminal paths, when a caller reads terminal usage, the adapter shall publish no token or cost report for the pinned ACP runtime, including after its context-only `usage_update`, while preserving prompt status, accumulated result, and the distinct observed tool-call count [[kimi-13](#kimi-13)] [[kimi-31](#kimi-31)].

## References

[1]: https://github.com/MoonshotAI/kimi-code "MoonshotAI Kimi Code"
[2]: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html "Kimi Code ACP reference"
[3]: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command "Kimi Code command reference"
[4]: https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files "Kimi Code configuration"
[5]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/config-options.ts "Kimi Code ACP configuration options"
[6]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/kaos-acp.ts "Kimi Code ACP filesystem bridge"
[7]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/approval.ts "Kimi Code ACP permission options"
[8]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/acp-server/src/server.ts#L619-L640 "Kimi Code 0.39.1 native ACP authentication gate"
[9]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/acp-server/src/session.ts#L907-L937 "Kimi Code 0.39.1 ACP prompt response and context-usage update"
[10]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/agent-core-v2/src/app/kosongConfig/envOverlay.ts#L87-L174 "Kimi Code 0.39.1 environment model overlay"
[11]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/agent-core-v2/src/app/auth/authService.ts#L628-L695 "Kimi Code 0.39.1 default-model and OAuth readiness"
[12]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/agent-core-v2/src/app/kosongConfig/configSection.ts#L23-L71 "Kimi Code 0.39.1 environment provider credentials"
[13]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/apps/kimi-code/src/cli/sub/acp.ts#L1-L44 "Kimi Code 0.39.1 native ACP dispatch"
[14]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/agent-core-v2/src/kosong/model/modelAuth.ts#L27-L73 "Kimi Code 0.39.1 model and provider authentication resolution"
