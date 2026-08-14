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

| SSE Event                                                                       | AgentEvent                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| assistant `message.part.updated` (text, no delta)                               | `text`                                                                                                                                                                      |
| assistant `message.part.updated` (text, canonical sibling or legacy part delta) | `text_delta`                                                                                                                                                                |
| assistant text `message.part.delta` / `session.next.text.delta`                 | `text_delta`                                                                                                                                                                |
| reasoning `message.part.delta` / `session.next.reasoning.delta`                 | suppressed in favor of `thinking` snapshots                                                                                                                                 |
| `message.part.updated` (tool part, per [OPENCODE-016](#opencode-016))           | `tool_use` / `tool_result`                                                                                                                                                  |
| assistant `message.part.updated` (thinking)                                     | `thinking`                                                                                                                                                                  |
| `message.part.updated` (file part)                                              | `opencode:file_part` (extension)                                                                                                                                            |
| `message.part.updated` (image part)                                             | `opencode:image_part` (extension)                                                                                                                                           |
| `permission.updated` / `permission.asked`                                       | Headless reply behavior in [OPENCODE-020](#opencode-020), including `opencode:permission_decision` after successful auto replies and `permission_request` outside auto mode |
| `permission.replied` (rejected)                                                 | `tool_result` (`status: 'denied'`)                                                                                                                                          |
| `session.idle`                                                                  | `done` (usage)                                                                                                                                                              |
| Errors                                                                          | `error`                                                                                                                                                                     |

_The following root-stream accounting behavior is superseded by [OPENCODE-021](#opencode-021)._

Where OpenCode supplies a canonical `StepFinishPart`, the adapter shall require finite non-negative integer `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, and `tokens.cache.write`, shall add both cache counters to the cache-exclusive input counter exactly once, shall add the disjoint reasoning counter to the visible-output counter exactly once, and shall accumulate the resulting input and output totals across steps [[3]][[4]].
Those five counters are already the disjoint partition of [ENG-028](../engine.md#eng-028), so where step accounting is complete the adapter shall publish both breakdown sides from their step-wise sums, mapping `tokens.input` to `input`, `tokens.cache.read` to `cacheRead`, `tokens.cache.write` to `cacheWrite`, `tokens.output` to `output`, and `tokens.reasoning` to `reasoning`.
The adapter shall not consume `tokens.total`, which OpenCode passes through from the provider and which is therefore not guaranteed to equal the sum of the five counters.
A component OpenCode reports as a constant zero for a given provider, such as reasoning on providers that do not separate it, is indistinguishable from a measured zero: knowing which provider ran a step does not say which components that provider separates, so the adapter shall publish the zero as measured rather than infer absence.
Each step part is one model request, so the adapter shall publish one [ENG-030](../engine.md#eng-030) billable record per step part, carrying `requests: 1`, that step's five counters as its tokens, and its own `cost` where present.
The rate-card identity of a step is the `modelID` and `providerID` of the assistant message that owns the part, correlated per [OPENCODE-017](#opencode-017); where the run supplied no such identity for a step's message, its record shall omit both fields.

### OPENCODE-016

The adapter shall correlate tool-part snapshots by OpenCode's `part.callID`, using legacy identifier aliases (including `part.id`) only when `callID` is absent.
For each correlated tool call, the adapter shall emit at most one `tool_use`, carrying the tool name from `part.tool` and the input from `state.input`, and shall defer that emission past `pending` snapshots so streamed partial input is not captured.
When a correlated tool call not already denied first reaches a `completed` or `error` state — with or without earlier snapshots — the adapter shall have emitted exactly one `tool_use`/`tool_result` pair whose `tool_result` carries `status: 'success'` with `state.output` or `status: 'error'` with `state.error`, plus the duration when `state.time` supplies start and end.
Repeated running or terminal snapshots for one correlated call shall add no further `tool_use` or `tool_result` events, and `done.usage.toolUses` shall count each correlated call at most once.
Where a rejected permission reply per [OPENCODE-005](#opencode-005) resolves — via the permission request's tool reference — to a correlated call, its denied `tool_result` shall carry that call's `callID` and tracked tool name rather than the permission name from the request, and afterwards tool-state updates for that call shall add neither a second terminal `tool_result` nor a `tool_use` behind the terminal result.
Where the rejected reply resolves to a call whose terminal `tool_result` was already emitted, the adapter shall emit no denied `tool_result`.
Tool-part snapshots without lifecycle state shall keep their pre-lifecycle normalization: one immediate `tool_use` per correlated identifier from top-level fields.

### OPENCODE-017

The adapter shall correlate conversational part events to their OpenCode
message by message identifier and use the message role from `message.updated`
or equivalent inline metadata before normalizing `text`, `text_delta`, or
`thinking` output. Only content belonging to an `assistant` message shall be
emitted; content belonging to a `user` message shall be discarded, without
comparing its bytes to the submitted prompt.

Where a part event carrying a message identifier arrives before its role, the
adapter shall hold that event until the matching message role arrives. It shall
then release held assistant events in their original order or discard held
user events. This ordering shall hold across interleaved message identifiers:
a later message whose role resolves first shall not overtake earlier pending
content. At terminal completion, unresolved content shall be discarded and
later role-resolved assistant content shall then be emitted in its original
order. Legacy content events carrying no message identifier shall retain their
existing normalization because no role can be correlated, while respecting
the same ordering gate.

When `message.removed` identifies a message with held content, the adapter
shall discard that content and release any now-unblocked later events. Removed
content shall neither remain resident nor hold the global ordering gate open.

Session filtering per [OPENCODE-006](#opencode-006) shall precede role
correlation, so metadata from another session cannot release or discard the
current session's pending content.

### OPENCODE-019

The adapter shall classify every OpenCode content delta before normalization.
For canonical v1 `message.part.updated`, it shall read the optional `delta`
beside `part` and classify it from `part.type`, while retaining the legacy
`part.delta` alias. For v2 `session.next.text.delta` and
`session.next.reasoning.delta`, the event type shall be authoritative. For the
generic v2 `message.part.delta`, the adapter shall correlate `partID` with the
type observed on `message.part.updated`; `field` alone shall not classify a
delta because both text and reasoning use text fields. Explicit v2 deltas
shall correlate their `textID` or `reasoningID` with the same part identifier
carried by the settled snapshot.

Assistant text deltas shall normalize to `text_delta`. Reasoning deltas shall
not normalize to `text_delta` or a second `thinking` event; settled reasoning
snapshots shall remain the single `thinking` representation. Deltas belonging
to user messages shall remain suppressed per
[OPENCODE-017](#opencode-017). Generic deltas received before their part
metadata shall remain pending by `partID` and be released or suppressed once
the type resolves. A generic delta whose type never resolves, or that carries
no correlatable `partID` or inline part type, shall not default to output.
An uncorrelatable generic delta shall be discarded immediately rather than
holding later classifiable content behind the ordering gate.

Repeated settled snapshots with the same part identifier, content kind, and
content shall emit at most once. When emitted text deltas for a part exactly
reconstruct its later settled text snapshot, that snapshot shall be suppressed
so concatenating normalized `text` and `text_delta` yields the semantic output
once. Interleaved parts shall keep independent type state and original stream
order even when later metadata resolves first. Removing a part shall release
its queued payloads and discard its pending deltas, emitted-delta history,
settled-snapshot history, and classification state. Removing its owning
message shall clear the same per-part state even when no individual
`message.part.removed` event follows.

## Session Filtering

### OPENCODE-006

While the SSE stream carries events for all sessions, the adapter shall emit
ordinary output only for the current `sessionId`. Events that carry no session
or thread identifier shall pass through unfiltered, since many event types in
a multiplexed stream lack explicit session tags. Permission-control events for
a descendant session owned by the current run are the narrow exception defined
by [OPENCODE-020](#opencode-020); they shall not widen ordinary child-session
output.

## Permission Mapping

### OPENCODE-007

Where a `PermissionPolicy` is provided, the adapter shall map it to OpenCode permission controls per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm): `fileWrite` → `edit`, `shellExecute` → `bash`, `networkAccess` → `webfetch`.
Where `PermissionPolicy.mode` is `auto`, the adapter shall reproduce
OpenCode's native auto posture: it shall append no wildcard permission rule
and shall answer only permission asks that survive OpenCode's configured rules
with `once` per [OPENCODE-020](#opencode-020).
This preserves native and user-configured explicit denies, which OpenCode
resolves before emitting an ask.
OpenCode models that automation posture independently from its permission
rules.
This independence covers explicitly supplied portable capability levels, not
`AgentOptions` tool lists, which are unsupported per
[OPENCODE-015](#opencode-015).
When `mode: 'auto'` accompanies explicitly supplied portable capability levels,
the adapter shall map only those present fields; omitted fields shall remain
absent so OpenCode's native and user rules retain authority.
Where the OpenCode v2 SDK path is active, the adapter shall apply the
equivalent `PermissionRuleset` at `session.create` for fresh sessions and at
`session.update` before prompting resumed sessions, because the v2 prompt body
no longer accepts the legacy `permission` map.
A provided empty `PermissionPolicy` shall remain distinct from absence and map
the three omitted capabilities to `ask`.
Where `PermissionPolicy.writablePaths` is non-empty per
[ENG-022](../engine.md#eng-022), the adapter shall accept valid entries, expose
`WritablePathsPermissionMapping` per [ENG-023](../engine.md#eng-023) with
`enforcement: 'ambient'` and canonical `paths`, and keep the existing OpenCode
permission mapping unchanged.
`writablePaths` is reporting, not confinement: the OpenCode process retains
ambient host filesystem authority, while `external_directory` is a
tool-approval rule rather than an OS sandbox.
Native auto may answer a surviving `external_directory` ask `once` without a
human.

### OPENCODE-020

While an OpenCode run is headless, when a `permission.updated` or
`permission.asked` event belonging to its root session or a descendant session
owned by that run reaches the adapter, the adapter shall resolve it exactly
once through the applicable SDK
permission-response route, including for permission names unknown to cligent.
Under `mode: 'auto'`, it shall answer `once` and shall not emit a normalized
`permission_request`, preserving the headless auto-mode contract.
After the applicable SDK route confirms a successful auto `once` reply, the
adapter shall emit exactly one `opencode:permission_decision` extension event
with the native request and session identifiers, permission name, patterns,
correlated tool use identifier, `decision: 'once'`, `automated: true`,
normalized input, and optional reason.
The extension event shall record a completed automated decision and shall not
be substituted for the interactive `permission_request` event.
Outside auto mode, it shall emit `permission_request` for observability and
answer `reject` fail-closed without emitting an automated-decision extension.
The response and correlation key shall preserve the native request and
originating session identifiers. The adapter shall discover pre-existing
descendants recursively before prompting a resumed root session and shall
extend that owned control scope from ordered session lifecycle events, while
permission events belonging to an unrelated session tree receive no response
per [OPENCODE-006](#opencode-006). Descendant discovery shall be bounded and a
failure shall terminate before the resumed prompt is dispatched.
Where the event has no request identifier, or the applicable response route is
unavailable, rejects, returns an SDK error, or does not settle within five
seconds, the adapter shall emit a non-recoverable permission error whose
message names the session identifier, request identifier (or its absence), and
permission name, then emit `done` with `status: 'error'` rather than continue
waiting on the SSE stream.
Missing, failed, timed-out, or aborted replies shall emit no
`opencode:permission_decision` event.
The adapter shall drive the active SSE subscription and permission response
with a run-owned abort signal. On the five-second response timeout, it shall
abort that signal and close the SSE iterator so the underlying response and
stream I/O are cancelled before run cleanup completes.
When `AbortSignal` fires while the adapter awaits either the next SSE event or
a permission response, the adapter shall propagate it through the run-owned
signal to cancel active transport I/O, preempt that wait, and emit one `done`
with `status: 'interrupted'`. The ensuing teardown shall release the abort
listener, terminate the managed server per [OPENCODE-009](#opencode-009), and
perform bounded iterator and SDK client cleanup per
[OPENCODE-008](#opencode-008).
Retained wait-control state shall remain bounded independently of the number of
completed SSE events and permission responses.

### OPENCODE-013

Where `PermissionPolicy` is absent, the adapter shall omit adapter-generated
permission data from fresh-session creation, resumed-session updates, and
prompt requests on every supported SDK path. OpenCode's native permission
defaults shall remain in effect. If either tool-list option is explicitly
present, [OPENCODE-015](#opencode-015) shall reject the run before SDK loading.

## Server Lifecycle

### OPENCODE-008

Where managed mode is configured, the adapter shall spawn `opencode serve`
with the configured `--hostname` and `--port`, wait for ready, then connect the
SDK client per [[2]]. When the run completes or aborts, the adapter shall
gracefully shut down the managed server.
Run teardown shall request managed server termination before invoking or
awaiting SDK iterator and client cleanup. Waits for iterator return, client
close, and client shutdown shall be bounded, so a non-settling SDK cleanup
hook cannot keep the managed server alive or prevent generator completion.
If the server remains alive after a bounded `SIGTERM` grace, teardown shall
send `SIGKILL` and bound the final close wait.

### OPENCODE-009

When `AbortSignal` fires, the adapter shall preempt its active wait, yield
`done` (`status: 'interrupted'`), then send `SIGTERM` to the managed server;
the signal shall not be sent before the interrupted terminal event is yielded.

### OPENCODE-010

When the managed server crashes, the adapter shall yield an `error` event (`code: 'OPENCODE_SERVER_EXIT'`) followed by `done` (`status: 'error'`) and clean up resources.

### OPENCODE-018

Where `OpenCodeAdapterConfig.eventInactivityTimeoutMs` is omitted, the adapter
shall use a finite 300,000 ms relevant-event inactivity deadline; where it is
provided, the adapter shall require a finite number greater than zero and use
that value. The deadline shall use monotonic elapsed time and split waits above
the host timer's maximum delay into safe chunks rather than expiring early.
The deadline shall measure only time actively awaiting OpenCode's global SSE
stream. Time spent normalizing an event or suspended while a downstream
consumer processes a yielded event shall not consume the silence budget.
An event explicitly tagged for the current root session or any run-owned
descendant established per [OPENCODE-020](#opencode-020) shall restart the
deadline. Descendant activity is liveness evidence only: ordinary child
conversation remains filtered under [OPENCODE-006](#opencode-006). Tagged
events from an unrelated session and untagged global pass-through events shall
not restart it; pass-through eligibility is not proof of active-session
progress. A buffered relevant event already available when
the consumer resumes shall be processed before timeout recovery, while an
always-ready stream of non-relevant events shall still exhaust the carried
active-wait budget.
When the deadline expires, the adapter shall cancel the pending SSE read and
query the active session's current status through the SDK, bounding that query
to the lesser of 10,000 ms and the configured inactivity deadline.
Where the query reports `idle`, including the OpenCode status map omitting the
session because idle entries are not retained, the adapter shall emit one
recoverable `error`
with code `OPENCODE_INACTIVITY_IDLE_RECOVERED` followed by exactly one terminal
`done`, using `success` unless an earlier session error requires `error`,
without waiting for another SSE event.
Where the query reports `busy`, `retry`, or another non-idle state, the adapter
shall abort that session and emit one non-recoverable `error` with code
`OPENCODE_INACTIVITY_TIMEOUT` followed by exactly one error `done`.
Where the status request fails or times out, the adapter shall make a bounded
best-effort session abort and emit one
non-recoverable `error` with code
`OPENCODE_INACTIVITY_STATUS_QUERY_FAILED` followed by exactly one error
`done`.
Each inactivity diagnostic shall identify the session, last relevant event,
elapsed inactivity, configured deadline, server mode and state, queried state
or query failure, and session-abort outcome where attempted.
When caller abort races a pending SSE read, status query, or inactivity
recovery in either server mode, the adapter shall give the caller abort
terminal precedence once observed, including when a terminal SSE event is
already ready in the same race turn, and emit exactly one interrupted `done`.
When caller abort arrives during SDK session creation or prompt dispatch, the
adapter shall propagate cancellation into supported SDK request surfaces,
abort any session whose identifier has already been created, and bound how
long it waits for the raced dispatch to settle. Where that dispatch concurrently
settles with a session and event iterator, the adapter shall capture their
cleanup ownership, abort the known session, and return the iterator before
emitting interrupted `done`. Any eager event iterator opened before prompt
dispatch shall be returned on dispatch abort or failure, and the dispatch-scoped
abort listener shall be removed on every exit. A backend session identifier
created before dispatch abort shall remain the interrupted resume token per
[OPENCODE-011](#opencode-011), including when the wrapper reports the abort as a
failed run result.
On the legacy SDK path, the adapter shall scope session creation, prompt, status,
and abort requests to the same working directory through each generated
method's top-level `query.directory` field rather than placing the directory in
a request body.
After any terminal path, the adapter shall cancel and return the pending event
iterator, make independent bounded SDK-client close and shutdown attempts even
when an earlier cleanup rejects, and terminate its managed server, escalating
its owned child from `SIGTERM` to `SIGKILL` after a bounded grace when necessary.
Instance disposal shall carry the run working directory as `directory` on the
v2 SDK path or `query.directory` on the legacy path. On caller interruption,
the adapter shall initiate any known active-session abort before promptly
emitting the interrupted `done`, without waiting for that control request to
settle beyond the engine's bounded abort-drain window. It shall retain and
bound the cancellation attempt during post-terminal cleanup. Managed process
termination shall begin only after that terminal event;
external mode shall leave the caller-owned server running while still aborting
active session work on interruption or non-idle inactivity.

## Resume Token

### OPENCODE-011

When OpenCode provides a session identifier before terminal `done`, the adapter shall set `DonePayload.resumeToken` to that identifier, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md#session-continuity-via-resume-token).
When an abort causes terminal `done` with `status: 'interrupted'`, the adapter shall preserve continuity by setting `DonePayload.resumeToken` to the first available value in this order: the OpenCode-provided session identifier observed before the abort; otherwise the non-empty `AgentOptions.resume` value passed into the run; otherwise no `resumeToken`.
A caller-supplied `AgentOptions.resume` value alone shall not count as an
OpenCode-provided identifier on a non-interrupted failure. When OpenCode
rejects that resumed session before prompt dispatch, the adapter shall omit
`resumeToken` so `Cligent` clears the stale value per
[ENG-006](../engine.md#eng-006).

## Options Mapping

### OPENCODE-012

Per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), the adapter shall map portable `AgentOptions.effort` values from [ENG-020](../engine.md#eng-020) to the top-level `variant` field on the OpenCode v2 session prompt body per [[1]].
The prompt-body surface, rather than session creation, shall be used so the value applies to both fresh and resumed sessions.
Provider dispatch shall use the `provider/model` prefix in `AgentOptions.model`.
When the provider has no documented built-in variant set, the adapter shall leave `variant` unset and defer to the user's `opencode.jsonc`.

| `AgentOptions.effort` | Anthropic | OpenAI    | Google | Other |
| --------------------- | --------- | --------- | ------ | ----- |
| `minimal`             | `high`    | `minimal` | `low`  | unset |
| `low`                 | `high`    | `low`     | `low`  | unset |
| `medium`              | `high`    | `medium`  | `low`  | unset |
| `high`                | `high`    | `high`    | `high` | unset |
| `xhigh`               | `max`     | `xhigh`   | `high` | unset |
| `max`                 | `max`     | `xhigh`   | `high` | unset |

Where a provider lacks a 1:1 variant for the requested effort, the adapter shall use the nearest documented variant for that provider per [ENG-020](../engine.md#eng-020).

### OPENCODE-014

When effort is omitted, the adapter shall not set a prompt-body `variant` and shall preserve OpenCode and user-configuration defaults.
Where effort is outside the OpenCode portable vocabulary, including `ultracode` or `ultra`, the adapter shall reject it before prompting the session with the metadata-backed allowed-values error from [ENG-024](../engine.md#eng-024).

### OPENCODE-015

Where either `AgentOptions.allowedTools` or `AgentOptions.disallowedTools` is
explicitly present, including as an empty array, the adapter shall reject
before loading the SDK or invoking the backend.
The exported permission mapper shall reject either option before returning a
provider mapping, and the exported compatibility wrapper shall reject any
direct prompt `tools` value before session creation, update, subscription, or
prompt invocation.
OpenCode 1.18.13's prompt `tools` field is deprecated as an independent
control: the provider converts its booleans into persistent session permission
rules, replacing prior session rules [[5]].
Because permission evaluation is last-match-wins and session rules follow agent
rules, an enabled tool can override a native or explicitly supplied deny, and a
prompt-scoped request can change a resumed session after that cligent call ends
[[6]][[7]].
The provider also canonicalizes some tool identifiers to shared permission
names, so this surface cannot guarantee
[ENG-017](../engine.md#eng-017)'s exact identifier semantics [[6]].
When both options are omitted, the adapter shall send no prompt `tools` data
and preserve OpenCode's native available-tool surface.

## Token Accounting

### OPENCODE-021

The adapter shall assign the submitted prompt a canonical message identifier and shall construct the current invocation's causal task tree from assistant `parentID` links and task-part child-session metadata.
It shall collect canonical step-finish accounting for the root and those causal descendants before applying [OPENCODE-006](#opencode-006)'s root-only conversation filter; foreign, merely pre-existing, and unscoped session activity shall not enter the ledger.
Each step shall be keyed by native session and part identifier, an identical repeat shall count once, and a changed snapshot shall replace the earlier value rather than add to it.
Removing a completed part shall not erase its billed request from the invocation ledger.

For a fresh root session, the adapter shall set and verify a static, non-sensitive, non-default title so OpenCode skips its otherwise unobservable title-model request.
For a resumed root, it shall preserve a meaningful title and shall retitle and verify only a default title; inability to prove that title inference is suppressed shall make exact observed accounting partial [[9]].
Before prompt dispatch, the compatibility wrapper shall query the live server's canonical global-health endpoint and shall permit complete accounting only when it reports healthy at the exact `1.18.13` conformance version.
A missing route, failed or timed-out query, malformed response, unhealthy server, or different version shall not block the run, but shall make exact observed accounting partial because the hidden-request boundaries were verified only for that server version [[13]].
Canonical automatic compaction, its summary, and a synthetic continuation carrying `metadata.compaction_continue: true` may extend the causal ledger only from their immediate causal message boundary.
Repeated internal-prompt snapshots shall preserve their first canonical kind, message, and child identity and every observed overflow or error signal; conflicting identity evidence shall retain only the original exact subset and shall make coverage partial.
An overflow replay, an unmarked or unlinked internal prompt, a post-activation assistant step with an unproved parent, and a causal prompt without a linked assistant shall remain excluded and shall make exact observed accounting partial [[10]].
The exact command-task continuation may extend causality from its immediately preceding causal task part even though that programmatic assistant has no model step.
A task that names an existing `task_id` shall make coverage partial and its child records shall remain excluded because the reused session's subsequent user messages carry no native link back to that task invocation.
A repeated task-part snapshot shall preserve its first canonical parent identity and may enrich a missing child identity once; a conflicting non-empty parent or child identity shall retain only the original exact subset and shall make coverage partial.
A synthetic background-result prompt may extend causality only once for the matching causal background child; a missing child identity, unmatched or error result, or child idle preceding its latest causal observation shall make coverage partial [[11]].
A retry status whose immediately preceding assistant is causal, or whose request cannot be correlated, shall make coverage partial because OpenCode exposes no accounting for the failed model attempt; a retry tied to an explicit foreign assistant shall remain excluded [[12]].

Each valid step shall yield one `requests: 1` record carrying inclusive input and output totals, uncached, cache-read, cache-write, visible-output, and reasoning details, the owning message's provider and model where known, and the step's non-negative cost as `agent-estimate` where present.
The report shall have complete coverage only when every causal step is canonical and valid and no causal descendant remains active at root completion; otherwise exact observed steps may be reported with partial coverage, while malformed or ambiguous accounting shall never be promoted to complete.
OpenCode's generic idle event supplies no authoritative usage object, so the adapter shall not substitute alias-shaped idle counters for the step ledger.
The whole-run cost shall be present only when coverage is complete and every causal step reports a valid cost, including measured zero, and shall be labeled `agent-estimate` rather than billed cost [[8]].

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
