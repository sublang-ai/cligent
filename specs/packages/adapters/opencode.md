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

The adapter module shall be importable without the SDK installed so consumers can register the adapter unconditionally.
The SDK shall only be required at call time: `isAvailable()` shall return `false` and `run()` shall throw when the SDK is absent.

### opencode-3

`isAvailable()` shall check SDK presence and, in managed mode, also check that the `opencode` CLI is on PATH via a spawn-based probe.
It shall return `true` only if all checks pass.

### Two Modes

### opencode-4

The adapter shall support two modes, selectable via constructor options: managed mode (default; spawn `opencode` server process) and external mode (connect to a user-provided `serverUrl`).

### Event Normalization

### opencode-5

The adapter shall normalize SSE events to `AgentEvent` types:

| SSE Event                                                                       | AgentEvent                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| assistant `message.part.updated` (text, no delta)                               | `text`                                                                                                                                                                      |
| assistant `message.part.updated` (text, canonical sibling or legacy part delta) | `text_delta`                                                                                                                                                                |
| assistant text `message.part.delta` / `session.next.text.delta`                 | `text_delta`                                                                                                                                                                |
| reasoning `message.part.delta` / `session.next.reasoning.delta`                 | suppressed in favor of `thinking` snapshots                                                                                                                                 |
| `message.part.updated` (tool part, per [[opencode-16](#opencode-16)])           | `tool_use` / `tool_result`                                                                                                                                                  |
| assistant `message.part.updated` (thinking)                                     | `thinking`                                                                                                                                                                  |
| `message.part.updated` (file part)                                              | `opencode:file_part` (extension)                                                                                                                                            |
| `message.part.updated` (image part)                                             | `opencode:image_part` (extension)                                                                                                                                           |
| `permission.updated` / `permission.asked`                                       | Headless reply behavior in [[opencode-20](#opencode-20)], including `opencode:permission_decision` after successful auto replies and `permission_request` outside auto mode |
| `permission.replied` (rejected)                                                 | `tool_result` (`status: 'denied'`)                                                                                                                                          |
| `session.idle`                                                                  | `done` (usage)                                                                                                                                                              |
| Errors                                                                          | `error`                                                                                                                                                                     |

_The following root-stream accounting behavior is superseded by [[opencode-21](#opencode-21)]._

Where OpenCode supplies a canonical `StepFinishPart`, the adapter shall require finite non-negative integer `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, and `tokens.cache.write`, shall add both cache counters to the cache-exclusive input counter exactly once, shall add the disjoint reasoning counter to the visible-output counter exactly once, and shall accumulate the resulting input and output totals across steps [[3]][[4]].
Those five counters are already the disjoint partition of [[ENG-028](../../user/engine.md#eng-028)], so where step accounting is complete the adapter shall publish both breakdown sides from their step-wise sums, mapping `tokens.input` to `input`, `tokens.cache.read` to `cacheRead`, `tokens.cache.write` to `cacheWrite`, `tokens.output` to `output`, and `tokens.reasoning` to `reasoning`.
The adapter shall not consume `tokens.total`, which OpenCode passes through from the provider and which is therefore not guaranteed to equal the sum of the five counters.
A component OpenCode reports as a constant zero for a given provider, such as reasoning on providers that do not separate it, is indistinguishable from a measured zero: knowing which provider ran a step does not say which components that provider separates, so the adapter shall publish the zero as measured rather than infer absence.
Each step part is one model request, so the adapter shall publish one [[ENG-030](../../user/engine.md#eng-030)] billable record per step part, carrying `requests: 1`, that step's five counters as its tokens, and its own `cost` where present.
The rate-card identity of a step is the `modelID` and `providerID` of the assistant message that owns the part, correlated per [[opencode-17](#opencode-17)]; where the run supplied no such identity for a step's message, its record shall omit both fields.

### opencode-16

The adapter shall correlate tool-part snapshots by OpenCode's `part.callID`, using legacy identifier aliases (including `part.id`) only when `callID` is absent.
For each correlated tool call, the adapter shall emit at most one `tool_use`, carrying the tool name from `part.tool` and the input from `state.input`, and shall defer that emission past `pending` snapshots so streamed partial input is not captured.
When a correlated tool call not already denied first reaches a `completed` or `error` state — with or without earlier snapshots — the adapter shall have emitted exactly one `tool_use`/`tool_result` pair whose `tool_result` carries `status: 'success'` with `state.output` or `status: 'error'` with `state.error`, plus the duration when `state.time` supplies start and end.
Repeated running or terminal snapshots for one correlated call shall add no further `tool_use` or `tool_result` events, and `done.usage.toolUses` shall count each correlated call at most once.
Where a rejected permission reply per [[opencode-5](#opencode-5)] resolves — via the permission request's tool reference — to a correlated call, its denied `tool_result` shall carry that call's `callID` and tracked tool name rather than the permission name from the request, and afterwards tool-state updates for that call shall add neither a second terminal `tool_result` nor a `tool_use` behind the terminal result.
Where the rejected reply resolves to a call whose terminal `tool_result` was already emitted, the adapter shall emit no denied `tool_result`.
Tool-part snapshots without lifecycle state shall keep their pre-lifecycle normalization: one immediate `tool_use` per correlated identifier from top-level fields.

### opencode-17

The adapter shall correlate conversational part events to their OpenCode
message by message identifier and use the message role from `message.updated`
or equivalent inline metadata before normalizing `text`, `text_delta`, or
`thinking` output.
Only content belonging to an `assistant` message shall be
emitted; content belonging to a `user` message shall be discarded, without
comparing its bytes to the submitted prompt.

Where a part event carrying a message identifier arrives before its role, the
adapter shall hold that event until the matching message role arrives.
It shall
then release held assistant events in their original order or discard held
user events.
This ordering shall hold across interleaved message identifiers:
a later message whose role resolves first shall not overtake earlier pending
content.
At terminal completion, unresolved content shall be discarded and
later role-resolved assistant content shall then be emitted in its original
order.
Legacy content events carrying no message identifier shall retain their
existing normalization because no role can be correlated, while respecting
the same ordering gate.

When `message.removed` identifies a message with held content, the adapter
shall discard that content and release any now-unblocked later events.
Removed
content shall neither remain resident nor hold the global ordering gate open.

Session filtering per [[opencode-6](#opencode-6)] shall precede role
correlation, so metadata from another session cannot release or discard the
current session's pending content.

### opencode-19

The adapter shall classify every OpenCode content delta before normalization.
For canonical v1 `message.part.updated`, it shall read the optional `delta`
beside `part` and classify it from `part.type`, while retaining the legacy
`part.delta` alias.
For v2 `session.next.text.delta` and
`session.next.reasoning.delta`, the event type shall be authoritative.
For the
generic v2 `message.part.delta`, the adapter shall correlate `partID` with the
type observed on `message.part.updated`; `field` alone shall not classify a
delta because both text and reasoning use text fields.
Explicit v2 deltas
shall correlate their `textID` or `reasoningID` with the same part identifier
carried by the settled snapshot.

Assistant text deltas shall normalize to `text_delta`.
Reasoning deltas shall
not normalize to `text_delta` or a second `thinking` event; settled reasoning
snapshots shall remain the single `thinking` representation.
Deltas belonging
to user messages shall remain suppressed per
[[opencode-17](#opencode-17)]. Generic deltas received before their part
metadata shall remain pending by `partID` and be released or suppressed once
the type resolves.
A generic delta whose type never resolves, or that carries
no correlatable `partID` or inline part type, shall not default to output.
An uncorrelatable generic delta shall be discarded immediately rather than
holding later classifiable content behind the ordering gate.

Repeated settled snapshots with the same part identifier, content kind, and
content shall emit at most once.
When emitted text deltas for a part exactly
reconstruct its later settled text snapshot, that snapshot shall be suppressed
so concatenating normalized `text` and `text_delta` yields the semantic output
once.
Interleaved parts shall keep independent type state and original stream
order even when later metadata resolves first.
Removing a part shall release
its queued payloads and discard its pending deltas, emitted-delta history,
settled-snapshot history, and classification state.
Removing its owning
message shall clear the same per-part state even when no individual
`message.part.removed` event follows.

### Session Filtering

### opencode-6

While the SSE stream carries events for all sessions [[2]], the adapter shall
emit ordinary output only for the current `sessionId`.
Events that carry no
session or thread identifier shall pass through unfiltered, since many event
types in a multiplexed stream lack explicit session tags.
Permission-control
events for a descendant session owned by the current run are the narrow
exception defined by [[opencode-20](#opencode-20)]; they shall not widen
ordinary child-session output.
Where another invocation or client drives the same OpenCode session
concurrently, or delayed background work from an earlier invocation later
writes to it [[16]], the adapter shall make no event-isolation guarantee
because the stream carries session identity but no turn identity; this is an
environmental constraint per [[ENG-018](../../user/engine.md#eng-018)], and callers
requiring concurrency shall use distinct sessions.

### Permission Mapping

### opencode-7

Where a `PermissionPolicy` is provided, the adapter shall map it to OpenCode permission controls per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md): `fileWrite` → `edit`, `shellExecute` → `bash`, `networkAccess` → `webfetch`.
Where `PermissionPolicy.mode` is `auto`, the adapter shall reproduce
OpenCode's native auto posture: it shall append no wildcard permission rule
and shall answer only permission asks that survive OpenCode's configured rules
with `once` per [[opencode-20](#opencode-20)].
This preserves native and user-configured explicit denies, which OpenCode
resolves before emitting an ask.
OpenCode models that automation posture independently from its permission
rules.
This independence covers explicitly supplied portable capability levels, not
`AgentOptions` tool lists, which are unsupported per
[[opencode-15](#opencode-15)].
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
[[ENG-022](../../user/engine.md#eng-022)], the adapter shall accept valid entries, expose
`WritablePathsPermissionMapping` per [[ENG-023](../../user/engine.md#eng-023)] with
`enforcement: 'ambient'` and canonical `paths`, and keep the existing OpenCode
permission mapping unchanged.
`writablePaths` is reporting, not confinement: the OpenCode process retains
ambient host filesystem authority, while `external_directory` is a
tool-approval rule rather than an OS sandbox.
Native auto may answer a surviving `external_directory` ask `once` without a
human.

### opencode-20

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
originating session identifiers.
The adapter shall discover pre-existing
descendants recursively before prompting a resumed root session and shall
extend that owned control scope from ordered session lifecycle events, while
permission events belonging to an unrelated session tree receive no response
per [[opencode-6](#opencode-6)].
Descendant discovery shall be bounded and a
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
with a run-owned abort signal.
On the five-second response timeout, it shall
abort that signal and close the SSE iterator so the underlying response and
stream I/O are cancelled before run cleanup completes.
When `AbortSignal` fires while the adapter awaits either the next SSE event or
a permission response, the adapter shall propagate it through the run-owned
signal to cancel active transport I/O, preempt that wait, and emit one `done`
with `status: 'interrupted'`.
The ensuing teardown shall release the abort
listener, terminate the managed server per [[opencode-9](#opencode-9)], and
perform bounded iterator and SDK client cleanup per
[[opencode-8](#opencode-8)].
Retained wait-control state shall remain bounded independently of the number of
completed SSE events and permission responses.

### opencode-13

Where `PermissionPolicy` is absent, the adapter shall omit adapter-generated
permission data from fresh-session creation, resumed-session updates, and
prompt requests on every supported SDK path.
OpenCode's native permission
defaults shall remain in effect.
If either tool-list option is explicitly
present, [[opencode-15](#opencode-15)] shall reject the run before SDK loading.

### Server Lifecycle

### opencode-8

Where managed mode is configured, the adapter shall spawn `opencode serve`
with the configured `--hostname` and `--port`, wait for ready, then connect the
SDK client per [[2]].
When the run completes or aborts, the adapter shall
gracefully shut down the managed server.
Run teardown shall request managed server termination before invoking or
awaiting SDK iterator and client cleanup.
Waits for iterator return, client
close, and client shutdown shall be bounded, so a non-settling SDK cleanup
hook cannot keep the managed server alive or prevent generator completion.
If the server remains alive after a bounded `SIGTERM` grace, teardown shall
send `SIGKILL` and bound the final close wait.

### opencode-9

When `AbortSignal` fires, the adapter shall preempt its active wait, yield
`done` (`status: 'interrupted'`), then send `SIGTERM` to the managed server;
the signal shall not be sent before the interrupted terminal event is yielded.

### opencode-10

When the managed server crashes, the adapter shall yield an `error` event (`code: 'OPENCODE_SERVER_EXIT'`) followed by `done` (`status: 'error'`) and clean up resources.

### opencode-18

Where `OpenCodeAdapterConfig.eventInactivityTimeoutMs` is omitted, the adapter
shall use a finite 300,000 ms relevant-event inactivity deadline; where it is
provided, the adapter shall require a finite number greater than zero and use
that value.
The deadline shall use monotonic elapsed time and split waits above
the host timer's maximum delay into safe chunks rather than expiring early.
The deadline shall measure only time actively awaiting OpenCode's global SSE
stream.
Time spent normalizing an event or suspended while a downstream
consumer processes a yielded event shall not consume the silence budget.
An event explicitly tagged for the current root session or any run-owned
descendant established per [[opencode-20](#opencode-20)] shall restart the
deadline.
Descendant activity is liveness evidence only: ordinary child
conversation remains filtered under [[opencode-6](#opencode-6)].
Tagged
events from an unrelated session and untagged global pass-through events shall
not restart it; pass-through eligibility is not proof of active-session
progress.
A buffered relevant event already available when
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
long it waits for the raced dispatch to settle.
Where that dispatch concurrently
settles with a session and event iterator, the adapter shall capture their
cleanup ownership, abort the known session, and return the iterator before
emitting interrupted `done`.
Any eager event iterator opened before prompt
dispatch shall be returned on dispatch abort or failure, and the dispatch-scoped
abort listener shall be removed on every exit.
A backend session identifier
created before dispatch abort shall remain the interrupted resume token per
[[opencode-11](#opencode-11)], including when the wrapper reports the abort as a
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
v2 SDK path or `query.directory` on the legacy path.
On caller interruption,
the adapter shall initiate any known active-session abort before promptly
emitting the interrupted `done`, without waiting for that control request to
settle beyond the engine's bounded abort-drain window.
It shall retain and
bound the cancellation attempt during post-terminal cleanup.
Managed process
termination shall begin only after that terminal event;
external mode shall leave the caller-owned server running while still aborting
active session work on interruption or non-idle inactivity.

### Resume Token

### opencode-11

When OpenCode provides a session identifier before terminal `done`, the adapter shall set `DonePayload.resumeToken` to that identifier, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md).
When an abort causes terminal `done` with `status: 'interrupted'`, the adapter shall preserve continuity by setting `DonePayload.resumeToken` to the first available value in this order: the OpenCode-provided session identifier observed before the abort; otherwise the non-empty `AgentOptions.resume` value passed into the run; otherwise no `resumeToken`.
A caller-supplied `AgentOptions.resume` value alone shall not count as an
OpenCode-provided identifier on a non-interrupted failure.
When OpenCode
rejects that resumed session before prompt dispatch, the adapter shall omit
`resumeToken` so `Cligent` clears the stale value per
[[ENG-006](../../user/engine.md#eng-006)].

### Options Mapping

### opencode-12

Per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), the adapter shall map portable `AgentOptions.effort` values from [[ENG-020](../../user/engine.md#eng-020)] to the top-level `variant` field on the OpenCode v2 session prompt body per [[1]].
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

Where a provider lacks a 1:1 variant for the requested effort, the adapter shall use the nearest documented variant for that provider per [[ENG-020](../../user/engine.md#eng-020)].

### opencode-14

When effort is omitted, the adapter shall not set a prompt-body `variant` and shall preserve OpenCode and user-configuration defaults.
Where effort is outside the OpenCode portable vocabulary, including `ultracode` or `ultra`, the adapter shall reject it before prompting the session with the metadata-backed allowed-values error from [[ENG-024](../../user/engine.md#eng-024)].

### opencode-15

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
[[ENG-017](../../user/engine.md#eng-017)]'s exact identifier semantics [[6]].
When both options are omitted, the adapter shall send no prompt `tools` data
and preserve OpenCode's native available-tool surface.

### Token Accounting

### opencode-21

The adapter shall submit the prompt without a message identifier, because OpenCode mints them itself [[14]] and a supplied foreign identifier leaves the session busy with no terminal event.
It shall instead resolve the invocation's canonical prompt identifier from its own event stream, and shall construct the current invocation's causal task tree from assistant `parentID` links [[15]] and task-part child-session metadata.
A resumed root session is not exclusively the invocation's: another caller may drive it concurrently, and a background task started earlier injects its result as a fresh prompt into that same session [[16]].
Stream position therefore cannot identify this invocation's prompt.
The adapter shall establish the event stream before dispatching the prompt, because the stream carries no replay and an event published before it is live is lost, including the invocation's own prompt.
Waiting for the stream shall be bounded, so a server that announces no connection cannot stall the dispatch that would provoke its first event.
No event published after that subscription, including the first event received while establishing it, shall be dropped from the run's normal processing.
The adapter shall resolve the boundary from the root-session message carrying the prompt text it submitted.
A message observed to be an assistant's shall not resolve the boundary however exactly its text repeats the prompt, while a message whose role was never observed shall remain eligible.
Where the submitted text still identifies more than one root-session message, the boundary shall be unproven, because guessing between them is what proving it is for.
Within [[opencode-6](#opencode-6)]'s single-writer constraint, ordering may stand in for that proof only where the invocation created the root session.
Such a run, including one whose resume value is absent or empty, may fall back to the first root-session sighting — a user message, or the identifier a root assistant names as its `parentID` — that it does not recognize as a background result.
A run carrying a non-empty resume value shall not fall back.
Where no boundary is resolved, no step is causal, so the adapter shall omit the token report per [[ENG-031](../../user/engine.md#eng-031)] rather than attribute across an unproven boundary or publish fabricated totals.
It shall collect canonical step-finish accounting for the root and those causal descendants before applying [[opencode-6](#opencode-6)]'s root-only conversation filter; foreign, merely pre-existing, and unscoped session activity shall not enter the ledger.
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

## Verification

### opencode-201

Given canned native OpenCode SSE events, when the adapter runs, the yielded `AgentEvent` types shall match its normalization table [[opencode-5](#opencode-5)].

### opencode-202

Where the OpenCode SDK is not installed, `isAvailable()` shall return `false` and `run()` shall throw [[opencode-2](#opencode-2)], and in managed mode `isAvailable()` shall return `true` only once the `opencode` CLI probe also passes [[opencode-3](#opencode-3)].

### opencode-204

Given all `PermissionLevel` combinations, the adapter shall map `PermissionPolicy` to the correct vendor-specific controls [[opencode-7](#opencode-7)].

### opencode-208

The OpenCode adapter shall filter events by `sessionId`, pass through events with no session or thread identifier per [[opencode-6](#opencode-6)], emit `opencode:file_part` and `opencode:image_part` extension events [[opencode-5](#opencode-5)], manage the server lifecycle in managed mode [[opencode-8](#opencode-8)], and yield `error` (`code: 'OPENCODE_SERVER_EXIT'`) followed by `done` (`status: 'error'`) on server crash [[opencode-10](#opencode-10)].
Where the managed server remains running, teardown shall send `SIGTERM` before
invoking SDK disposal and shall complete within a bounded interval when
iterator return, client close, and client shutdown all remain pending [[opencode-9](#opencode-9)].
If the server ignores `SIGTERM`, teardown shall send `SIGKILL` after a bounded
grace and shall bound the final close wait.

### opencode-212

The OpenCode adapter shall set `DonePayload.resumeToken` to the session identifier per [[opencode-11](#opencode-11)].
Given a caller-supplied resume identifier that OpenCode rejects during
pre-prompt lineage discovery, the error `done` shall omit `resumeToken`, and a
subsequent `Cligent.run()` shall create a fresh session rather than retrying the
stale identifier.

### opencode-218

Where each portable effort value is supplied, when the adapter maps a run, the observable provider control shall be the documented top-level prompt `variant` selected by provider [[opencode-12](#opencode-12)]:

- when effort is omitted, the adapter shall set no variant override [[opencode-14](#opencode-14)];
- where the supplied value belongs to another built-in adapter or is an arbitrary unknown string, the adapter shall reject it before prompting the session with an error naming the adapter and its allowed values [[opencode-14](#opencode-14)].

### opencode-219

Where a `Cligent` is constructed on the adapter with `CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first to create and then to update a temporary file in a throwaway working directory, the adapter's auto-mode permission knobs per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) shall let both non-destructive writes proceed without interactive approval [[opencode-7](#opencode-7)]:

- the file shall exist with the expected contents after each phase;
- neither stream shall contain `permission_request`, a denied tool result, or an error;
- each stream shall terminate with successful `done`;
- filesystem state shall be the ground-truth assertion, because adapters normalize file edits differently;
- the harness shall retry the complete fresh probe after, and only after, an explicit upstream-overload, rate-limit, or service-unavailable failure, shall make at most two retries, and shall treat any other failure and the third consecutive named transient failure as fatal;
- the leg shall self-skip when the `opencode` CLI the adapter spawns for its managed server is absent from `PATH` or the adapter's credential is absent from the environment, shall hard-fail instead under `CI`, and a missing dependency for one adapter shall never skip another's leg;
- where the host cannot initialize the adapter's OS-level sandbox, the leg shall self-skip with a logged reason, including under `CI`.

### opencode-220

Given the adapter has been aborted, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall report the resume token each observed state requires [[opencode-11](#opencode-11)]:

| Observed before abort | `DonePayload.resumeToken` |
| --- | --- |
| a backend session identifier observed during the run | the observed backend identifier |
| no backend identifier and a non-empty `AgentOptions.resume` value | the inbound `resume` value |
| no backend identifier and no non-empty inbound `resume` value | omitted |

### opencode-222

Given a `PermissionPolicy` whose `writablePaths` contains valid entries and no independently active filesystem-sandbox write-grant surface, the adapter's permission mapping shall expose canonical `WritablePathsPermissionMapping` paths with `enforcement: 'ambient'` and shall preserve the existing OpenCode permission mapping [[opencode-7](#opencode-7)].

### opencode-226

Where an effort value is valid for the adapter but unavailable to the selected model, account, or installed runtime, when the backend rejects the run, the adapter stream shall expose that upstream failure through its normal error path without substituting another effort [[opencode-12](#opencode-12)].

### opencode-227

Where no `PermissionPolicy` is supplied, when OpenCode starts fresh and resumed
runs through each supported SDK path, fresh-session creation and prompt calls
shall omit permission data and a resumed run shall issue no permission-bearing
session update [[opencode-13](#opencode-13)]. Prompt calls shall also omit tool-list data when both tool-list
options are absent [[opencode-15](#opencode-15)]. Where an empty policy is supplied instead, fresh and
resumed runs shall carry `ask` rules for `edit`, `bash`, and `webfetch` [[opencode-7](#opencode-7)].

### opencode-228

Where the exact OpenCode CLI conformance target is installed, when its
`serve --help` output is inspected, the managed-server help shall expose
`--hostname` and `--port` [[opencode-8](#opencode-8)].

### opencode-229

Where either tool-list field is explicitly provided, including an empty array and including alongside a portable permission rule such as `shellExecute: 'deny'`, when the adapter runs, it shall reject before its SDK loader, compatibility wrapper, session creation, subscription, or backend prompt is invoked [[opencode-15](#opencode-15)]:

- direct permission-mapper calls with either field present shall reject by the same contract;
- the diagnostic shall explain that OpenCode 1.18.13 merges prompt `tools` into persistent session permission rules, which can override native or explicit denies and cannot provide exact per-call tool availability.

### opencode-231

Given canonical OpenCode tool-part snapshot sequences whose `part.id` differs
from `part.callID` — pending through repeated running to `completed`, and
pending through running to `error` — the adapter shall emit exactly one
`tool_use`/`tool_result` pair per `callID`, correlated by `callID`, preserving
`state.input`, the terminal `state.output` or `state.error`, and the
state-supplied duration, and shall count each call once in
`done.usage.toolUses` [[opencode-16](#opencode-16)]. Given a terminal snapshot with no earlier snapshots for
its `callID`, the adapter shall still emit the correlated pair. Given
interleaved snapshots for distinct `callID`s, each pair shall stay isolated per
call. Given a rejected permission reply that resolves to a `callID` followed by
terminal tool-state updates for that call, the adapter shall emit exactly one
terminal `tool_result`, carrying the call's tool name where the permission
request named only the permission it gates. Given a rejected reply that
resolves to a call whose terminal result was already emitted, no denied
`tool_result` shall follow. Given repeated terminal snapshots, no event or
usage count shall duplicate [[opencode-5](#opencode-5)].

### opencode-232

Where OpenCode acceptance dependencies are present per this section's gating,
when a real managed-mode OpenCode run with auto-approved permissions is
prompted to create a file through its tools and the file exists with the
expected content afterwards, the collected stream shall contain no two
`tool_use` events sharing a `toolUseId`, at least one `tool_use` carrying
non-empty `input`, exactly one terminal `tool_result` for each emitted
`tool_use` `toolUseId` and none for any other id, no `permission_request` or
denied `tool_result`, and a successful `done` whose `usage.toolUses` equals
the `tool_use` count [[opencode-5](#opencode-5)], [[opencode-16](#opencode-16)]. The probe shall retry only on the explicit transient
upstream failures named in [[opencode-219](#opencode-219)], with the same attempt
bound. A failed attempt whose failures all match those markers shall retry
into a fresh throwaway directory even when the file was already created,
because the failure can arrive after the tool ran; an attempt reaching a
successful `done` shall never classify as transient, because its `result`
text is model-authored and capacity language there is not a failure.
An attempt that witnessed an invariant violation — a `permission_request`,
a denied `tool_result`, a duplicated `tool_use` or `tool_result` id, or a
`tool_result` whose id no `tool_use` announced — shall never classify as
transient even
alongside matching failure text, so a retried clean attempt cannot mask the
violation; an errored `tool_result` and a `tool_use` stranded without its
result shall not preclude retry, because a model-level command failure and
a transiently truncated attempt each produce them without any adapter
defect.
This item is the real-run counterpart to [[opencode-231](#opencode-231)]'s
canned-event lifecycle check: the canned fixtures encode the wire schema this
release was written against, so only a live run can catch a later OpenCode
release changing the `ToolPart` lifecycle shape the way the pre-1.18
normalization drifted.

### opencode-233

_Superseded for usage shape by [[opencode-240](#opencode-240)]._

Given the adapter receives complete finite non-negative integer token counters, including explicit zeroes, when it emits terminal `done`, `usage.tokenAvailability` shall be `'reported'` and its canonical step-finish visible output and disjoint reasoning counters shall be summed exactly once [[opencode-5](#opencode-5)]:

- its input count shall fold cache-read and cache-write counters into a cache-exclusive base exactly once;
- given a required token or cache counter is absent, or any present mapped counter is negative, fractional, non-finite, or non-numeric, `usage.tokenAvailability` shall be `'unavailable'`, an absent optional cache counter alone retaining zero contribution without invalidating otherwise complete accounting;
- given upstream omits complete token accounting, or the adapter synthesizes an errored, interrupted, exhausted, or other terminal path, `usage.tokenAvailability` shall be `'unavailable'` and no token estimate shall be introduced;
- where tool calls were observed or validly provider-reported on either path, `usage.toolUses` shall preserve the greatest independently known count even when token accounting is unavailable.

### opencode-234

Given canonical user and assistant message envelopes and conversational part
events, when role metadata arrives both before and after its parts, the adapter
shall emit only assistant `text`, `text_delta`, and `thinking` events [[opencode-5](#opencode-5)], [[opencode-17](#opencode-17)], preserve
their stream order across interleaved message identifiers even where a later
role resolves first, and emit no user content. An assistant reply byte-equal
to the submitted prompt shall still be emitted. Content with a message
identifier whose role never resolves shall not be emitted, shall not prevent
later known assistant content from flushing before terminal `done`, and legacy
content without a message identifier shall preserve its prior normalization.
Removing a message with held content shall discard that content and unblock
later events without waiting for terminal completion. Role metadata from a
foreign session shall not resolve current-session content [[opencode-6](#opencode-6)].

### opencode-235

Given short injected inactivity deadlines and canned OpenCode streams, when a
current session becomes permanently silent, the adapter shall query its status
and terminate within a bounded interval: idle shall produce one recoverable
idle-recovery diagnostic and one successful `done`; busy and retry shall each
abort the session and produce one non-recoverable timeout diagnostic plus one
error `done`; an omitted status-map entry shall exercise OpenCode's idle
representation; and a rejected or non-settling status query
shall make a bounded abort attempt and produce one status-query diagnostic plus
one error `done` [[opencode-18](#opencode-18)].
Given root-session or run-owned descendant progress events whose spacing stays
below the deadline, the adapter shall not query status. Descendant lifecycle,
conversation, and permission events shall each restart the deadline while
ordinary descendant output remains filtered and permission control retains its
native descendant-session routing [[opencode-6](#opencode-6)]. Repeated events explicitly tagged for
another session and repeated untagged workspace-global events shall not
postpone the current session's deadline. When a consumer pauses after a
normalized event for longer than the configured deadline, that downstream
backpressure shall not consume the provider-silence budget, and a buffered
current-session terminal event shall complete without status recovery. An
always-ready non-relevant backlog shall still expire.
Given pending iterators that do and do not honor `AbortSignal`, external and
managed runs shall return the iterator, close the client, initiate active
session cancellation where required, terminate only the managed server [[opencode-8](#opencode-8)], [[opencode-9](#opencode-9)], and
emit exactly one
terminal event when caller abort and inactivity race. Deterministic race probes
shall cover an already-ready terminal event and abort during prompt dispatch;
the latter shall abort the already-created external session. The legacy SDK
probe shall put the same working directory in the top-level `query.directory`
of create and prompt calls and omit it from the prompt body. A caller abort
shall start active-session cancellation before delivering an adapter-emitted
interrupted `done` within the engine drain window, retain the backend resume
token, and complete bounded cancellation cleanup afterwards; managed
`SIGTERM` shall still follow `done`. A deadline above the host timer maximum shall
remain pending until real relevant activity, and an owned managed child that
ignores `SIGTERM` shall receive `SIGKILL` after its grace.
Prompt-dispatch abort and failure probes shall stop any event stream opened
before dispatch settles, and a fresh backend session created before abort
shall remain the interrupted resume token [[opencode-11](#opencode-11)]. A run
result settling concurrently with caller abort shall preserve its session
identity, cancel its active work, and release its event stream before
interrupted `done`. A rejected SDK cleanup operation shall not prevent the
remaining cleanup operations or managed process termination. Legacy and v2
instance-disposal requests shall carry the run directory through
`query.directory` and `directory`, respectively.
Where the OpenCode CLI and SDK are available, when a credential-free real
managed server creates an idle session whose terminal SSE event is withheld,
the short-deadline acceptance probe shall recover through the real
`session.status` endpoint, dispose the SDK client, and observe the managed
server process exit without a multi-minute wait.

### opencode-236

Given canonical v1 sibling-delta, v2 explicitly typed delta, and v2 generic
delta events interleaving assistant text, assistant reasoning, and user text,
the adapter shall reconstruct assistant output through `text_delta` without
reasoning or user contamination [[opencode-5](#opencode-5)], [[opencode-19](#opencode-19)]. Generic deltas shall classify correctly when
part metadata arrives before or after them, while unresolved types shall not
default to output or block later known content. Interleaved part identifiers
shall preserve stream order when later metadata resolves first, and removing a
part shall discard content still pending on either kind or role. Reasoning
shall appear only through settled `thinking` snapshots, nonconsecutive
duplicate settled snapshots shall emit once, and an exact settled replay of a
part's `textID`-correlated deltas shall not duplicate the combined `text` plus
`text_delta` reconstruction. An incident-scale interleaved delta stream shall
preserve order and terminate within the test bound; after removing a message,
none of its parts shall emit later content and later messages shall continue [[opencode-17](#opencode-17)].

### opencode-237

Where `PermissionPolicy.mode` is `auto`, when fresh and resumed OpenCode runs
use each supported SDK path, neither the observable v1 prompt nor the v2
session ruleset shall contain an adapter-generated wildcard [[opencode-7](#opencode-7)]. Explicitly
supplied capability levels shall still map, including denies, while omitted
capabilities preserve native rules.
Where canonical v1 `permission.updated` and v2 `permission.asked` events are
supplied, including an unknown permission name, when the adapter handles
requests for its root session or a run-owned descendant under auto, it shall
emit no normalized
`permission_request` and answer each native request `once` through the matching
SDK route with request and session correlation intact, then emit exactly one
`opencode:permission_decision` extension carrying the request identifier,
native session identifier, permission, patterns, tool-use correlation,
completed `once` decision,
automated marker, normalized input, and optional reason [[opencode-20](#opencode-20)]. Outside auto it shall
emit the normalized request and answer `reject` without the extension.
Where a resumed root already owns child or grandchild sessions, the wrapper
shall recursively discover them through version-correct `session.children`
routes under one whole-traversal deadline before prompt dispatch. Ordered
lifecycle events shall add fresh descendants. Child permission asks shall use
the child identifier on session-scoped reply routes, while child conversational
output remains filtered [[opencode-6](#opencode-6)].
Where interleaved unrelated-session events and repeated owned events occur, the
adapter shall respond only to owned requests and shall not respond twice.
Where a request has a missing identifier, unavailable or failed reply route,
SDK result error, or reply that stays pending for five seconds, the adapter
shall terminate with the permission error and one error-status `done`, with
the session, request (or missing marker), and permission named in the error.
Failed, timed-out, and aborted replies shall emit no
`opencode:permission_decision` extension.
For a pending response in external mode, the five-second timeout shall abort
the SDK request's run-owned signal and cancel the underlying response I/O.
While a permission response is pending in managed mode, when `AbortSignal`
fires, the adapter shall terminate with one interrupted `done`, abort the
run-owned signal observed by both the SSE subscription and permission
response, close the underlying SSE iterator and SDK client, and send `SIGTERM`
to the managed server without waiting for that response [[opencode-8](#opencode-8)], [[opencode-9](#opencode-9)]. The interrupted
`done` shall be yielded before `SIGTERM`, and managed termination shall begin
before the bounded SDK cleanup waits.
Canonical wrapper fixtures shall prove that aborting a pending v1 and v2 SSE
request rejects the underlying subscription operation on the run-owned signal,
and that aborting pending v1 and v2 permission-response HTTP calls rejects each
native SDK operation on that same signal.
Where the exact OpenCode conformance target and credentials are available,
when a real managed-mode `mode: 'auto'` run writes and verifies a unique
absolute `/tmp` file by requesting an exact shell command under an explicit
`shellExecute: 'ask'` rule, the run shall emit a `bash` `tool_use` and at least
one successful automated `once` audit event for the `bash` permission,
complete without an outer timeout, `permission_request`, denied `tool_result`,
or `error`, and emit exactly one success-status `done`; the leg shall use the
same missing-dependency and transient-upstream gating as the existing OpenCode
real-run acceptance [[opencode-5](#opencode-5)].

### opencode-238

_Superseded by [[opencode-240](#opencode-240)]._

Given the adapter emits a terminal `done` with complete upstream accounting, when a caller reads `usage.breakdown`, the adapter shall publish both sides from its five step counters [[opencode-5](#opencode-5)]:

- given a runtime omits a cache or reasoning counter, the corresponding component shall be absent while the remaining members of a published side still sum to their aggregate, and where the omitted counter is the reasoning counter the whole output side shall be absent;
- given a component subtraction would be negative, the affected side shall be absent while the unaffected side is still published.

### opencode-239

_Superseded by [[opencode-240](#opencode-240)]._

Given the adapter emits a terminal `done` with complete upstream accounting, when a caller reads `usage.records`, the adapter shall publish one record per step part carrying `requests: 1` [[opencode-5](#opencode-5)]:

- given a run pinned no model and its runtime named none, a step whose message named no model shall yield a record without one, and no placeholder identifier shall appear;
- given a runtime reports a group's own cost, its record shall carry that cost, and the costs of a run's records shall not exceed the run's reported total;
- given upstream accounting is incomplete, absent, or fails the partition identities, the adapter shall publish no records on that terminal.

### opencode-240

Given authentic zero or nonzero accounting from the adapter, when a caller reads terminal `usage.tokens`, the report shall carry inclusive input and output totals, exact reported cache/reasoning subsets, and no removed flat fields or availability placeholder, while malformed or absent accounting shall omit `tokens` and preserve independently observed `toolUses` [[opencode-21](#opencode-21)]:

- OpenCode shall include canonical causal child and grandchild steps without emitting child conversation, exclude foreign or pre-existing background work, deduplicate and replace repeated part snapshots by session and part identifier, preserve billed completed steps across removal, and publish complete coverage only when its causal ledger is valid and settled;
- fresh and default-title root sessions shall suppress and verify OpenCode's hidden title request, while a meaningful resumed title shall remain unchanged; inability to prove suppression shall retain exact records as partial;
- the wrapper shall query the live server's global health before dispatch and shall permit complete accounting only for a healthy response naming the exact tested OpenCode version; a missing, failed, timed-out, unhealthy, malformed, or different-version response shall preserve exact records as partial without blocking the run;
- canonical compaction summaries and marked continuations shall extend the ledger only from their immediate causal boundary; overflow replay, unmarked or unlinked internal prompts, a causal or uncorrelatable retry, an accepted prompt without an assistant, or an unknown post-activation assistant step shall keep only the exact subset as partial, while an explicit foreign-assistant retry shall remain excluded;
- repeated internal-prompt snapshots shall preserve their first identity and every overflow or error signal; conflicting identities or evidence that becomes less severe shall retain only the original exact subset as partial;
- command continuations shall accept the canonical task-only assistant without inventing a model step, while background continuations shall correlate one-to-one with a causal child and shall remain partial when the child identity, result, or post-work settlement is unproved;
- task parts that reuse an existing `task_id` shall retain exact parent records as partial and shall exclude ambiguous child-session prompts and steps;
- repeated task-part snapshots shall enrich a missing child identity at most once, while a conflicting non-empty parent or child identity shall preserve only the first exact subset and force partial coverage;
- malformed task identity and descendant idle observed before later causal child accounting shall never support complete coverage;
- where OpenCode supplies cost, the emitted whole-run and record values shall be finite, non-negative, USD `agent-estimate` objects; measured zero shall remain present and a missing cost shall remain absent;
- OpenCode shall submit its prompt with no message identifier and shall resolve the causal boundary from the prompt text it submitted, which an assistant repeating that text verbatim shall not displace;
- before prompt dispatch, the adapter shall subscribe to the live event stream; no event published after subscription, including the first, shall be lost, and absence of a streamed connection event shall not defer prompt dispatch indefinitely;
- a background task's injected result, and a concurrent caller's prompt that streams first, shall neither resolve the boundary nor bill their work to the run;
- a run that created its root session, including a call whose resume value is absent or empty, may fall back to the first sighting it does not recognize as a background result; a run carrying a non-empty resume value shall not, and where no boundary resolves the terminal `usage.tokens` shall be absent rather than carry totals the run cannot attribute.

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
