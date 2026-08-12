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
| assistant `message.part.updated` (text, no delta) | `text` |
| assistant `message.part.updated` (text, with delta) | `text_delta` |
| `message.part.updated` (tool part, per [OPENCODE-016](#opencode-016)) | `tool_use` / `tool_result` |
| assistant `message.part.updated` (thinking) | `thinking` |
| `message.part.updated` (file part) | `opencode:file_part` (extension) |
| `message.part.updated` (image part) | `opencode:image_part` (extension) |
| `permission.updated` / `permission.asked` | Headless reply behavior in [OPENCODE-020](#opencode-020), including `opencode:permission_decision` after successful auto replies and `permission_request` outside auto mode |
| `permission.replied` (rejected) | `tool_result` (`status: 'denied'`) |
| `session.idle` | `done` (usage) |
| Errors | `error` |

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

## Session Filtering

### OPENCODE-006

While the SSE stream carries events for all sessions, the adapter shall emit only events matching the current `sessionId`. Events that carry no session or thread identifier shall pass through unfiltered, since many event types in a multiplexed stream lack explicit session tags.

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
`permission.asked` event belonging to its session reaches the adapter, the
adapter shall resolve it exactly once through the applicable SDK
permission-response route, including for permission names unknown to cligent.
Under `mode: 'auto'`, it shall answer `once` and shall not emit a normalized
`permission_request`, preserving the headless auto-mode contract.
After the applicable SDK route confirms a successful auto `once` reply, the
adapter shall emit exactly one `opencode:permission_decision` extension event
with the native request identifier, permission name, patterns, correlated tool
use identifier, `decision: 'once'`, `automated: true`, normalized input, and
optional reason.
The extension event shall record a completed automated decision and shall not
be substituted for the interactive `permission_request` event.
Outside auto mode, it shall emit `permission_request` for observability and
answer `reject` fail-closed without emitting an automated-decision extension.
The response shall preserve the native request identifier and, where the SDK
route requires it, the session identifier; permission events belonging to
other sessions shall receive no response per [OPENCODE-006](#opencode-006).
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
While a run is awaiting OpenCode's global SSE stream, when an event survives
the current-session filtering of [OPENCODE-006](#opencode-006), including an
untagged pass-through event, the adapter shall restart the deadline; an event
explicitly tagged for another session shall not restart it.
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
v2 SDK path or `query.directory` on the legacy path. On caller interruption, any
known active session abort shall be attempted before the interrupted `done`, and
managed process termination shall begin only after that terminal event;
external mode shall leave the caller-owned server running while still aborting
active session work on interruption or non-idle inactivity.

## Resume Token

### OPENCODE-011

When OpenCode provides a session identifier before terminal `done`, the adapter shall set `DonePayload.resumeToken` to that identifier, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md#session-continuity-via-resume-token).
When an abort causes terminal `done` with `status: 'interrupted'`, the adapter shall preserve continuity by setting `DonePayload.resumeToken` to the first available value in this order: the OpenCode-provided session identifier observed before the abort; otherwise the non-empty `AgentOptions.resume` value passed into the run; otherwise no `resumeToken`.

## Options Mapping

### OPENCODE-012

Per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), the adapter shall map portable `AgentOptions.effort` values from [ENG-020](../engine.md#eng-020) to the top-level `variant` field on the OpenCode v2 session prompt body per [[1]].
The prompt-body surface, rather than session creation, shall be used so the value applies to both fresh and resumed sessions.
Provider dispatch shall use the `provider/model` prefix in `AgentOptions.model`.
When the provider has no documented built-in variant set, the adapter shall leave `variant` unset and defer to the user's `opencode.jsonc`.

| `AgentOptions.effort` | Anthropic | OpenAI | Google | Other |
| --- | --- | --- | --- | --- |
| `minimal` | `high` | `minimal` | `low` | unset |
| `low` | `high` | `low` | `low` | unset |
| `medium` | `high` | `medium` | `low` | unset |
| `high` | `high` | `high` | `high` | unset |
| `xhigh` | `max` | `xhigh` | `high` | unset |
| `max` | `max` | `xhigh` | `high` | unset |

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
rules, replacing prior session rules [[3]].
Because permission evaluation is last-match-wins and session rules follow agent
rules, an enabled tool can override a native or explicitly supplied deny, and a
prompt-scoped request can change a resumed session after that cligent call ends
[[4]][[5]].
The provider also canonicalizes some tool identifiers to shared permission
names, so this surface cannot guarantee
[ENG-017](../engine.md#eng-017)'s exact identifier semantics [[4]].
When both options are omitted, the adapter shall send no prompt `tools` data
and preserve OpenCode's native available-tool surface.

## References

[1]: https://opencode.ai/docs/models/ "OpenCode model configuration"
[2]: https://opencode.ai/docs/server/ "OpenCode server"
[3]: https://github.com/anomalyco/opencode/blob/v1.18.13/packages/opencode/src/session/prompt.ts "OpenCode 1.18.13 prompt-tool permission replacement"
[4]: https://github.com/anomalyco/opencode/blob/v1.18.13/packages/opencode/src/permission/index.ts "OpenCode 1.18.13 permission evaluation"
[5]: https://github.com/anomalyco/opencode/blob/v1.18.13/packages/opencode/src/session/tools.ts "OpenCode 1.18.13 agent/session permission merge"
