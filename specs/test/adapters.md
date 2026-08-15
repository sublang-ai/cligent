<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TADAPT: Adapter Tests

## Intent

Verification criteria for all adapters. Shared patterns apply to each adapter; per-adapter sections cover unique behaviors.

## Shared

### TADAPT-001

Verifies: [CLAUDE-003](../user/adapters/claude-code.md#claude-003), [CODEX-003](../user/adapters/codex.md#codex-003), [GEMINI-004](../user/adapters/gemini.md#gemini-004), [GEMINI-005](../user/adapters/gemini.md#gemini-005), [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [KIMI-005](../user/adapters/kimi.md#kimi-005), [KIMI-006](../user/adapters/kimi.md#kimi-006)

Given canned native events for each adapter, when running the adapter, the yielded `AgentEvent` types shall match the normalization table for that adapter.
For the Codex adapter, the canned events shall be shaped as the SDK's canonical exported event types — including the multi-phase `command_execution` and `mcp_tool_call` item lifecycles of [CODEX-003](../user/adapters/codex.md#codex-003) — rather than invented aliases.

### TADAPT-002

Verifies: [CLAUDE-002](../user/adapters/claude-code.md#claude-002), [CODEX-002](../user/adapters/codex.md#codex-002), [OPENCODE-002](../user/adapters/opencode.md#opencode-002), [OPENCODE-003](../user/adapters/opencode.md#opencode-003)

Where the adapter uses an SDK (Claude Code, Codex, OpenCode), when the SDK is not installed, `isAvailable()` shall return `false` and `run()` shall throw.

### TADAPT-003

Verifies: [ENG-009](../user/engine.md#eng-009), [GEMINI-008](../user/adapters/gemini.md#gemini-008), [KIMI-011](../user/adapters/kimi.md#kimi-011)

When `AbortSignal` fires during an adapter's `run()`, the adapter shall yield `done` (`status: 'interrupted'`).

### TADAPT-004

Verifies: [CLAUDE-004](../user/adapters/claude-code.md#claude-004), [CLAUDE-005](../user/adapters/claude-code.md#claude-005), [CODEX-004](../user/adapters/codex.md#codex-004), [GEMINI-006](../user/adapters/gemini.md#gemini-006), [OPENCODE-007](../user/adapters/opencode.md#opencode-007), [KIMI-007](../user/adapters/kimi.md#kimi-007)

Given all `PermissionLevel` combinations, each adapter shall map `PermissionPolicy` to the correct vendor-specific controls.

### TADAPT-022

Verifies: [CLAUDE-004](../user/adapters/claude-code.md#claude-004), [GEMINI-006](../user/adapters/gemini.md#gemini-006), [OPENCODE-007](../user/adapters/opencode.md#opencode-007), [KIMI-008](../user/adapters/kimi.md#kimi-008), [ENG-022](../user/engine.md#eng-022), [ENG-023](../user/engine.md#eng-023)

Given a Claude Code, Gemini, OpenCode, or supported `mode: 'auto'` Kimi `PermissionPolicy` whose `writablePaths` contains valid entries and no independently active filesystem-sandbox write-grant surface, the adapter's permission mapping shall expose canonical `WritablePathsPermissionMapping` paths with `enforcement: 'ambient'` and shall preserve the existing adapter-specific permission/tool mapping. Given invalid `writablePaths`, the mapping shall reject the policy.

## Codex

### TADAPT-006

Verifies: [CODEX-003](../user/adapters/codex.md#codex-003)

The Codex adapter shall emit `codex:file_change` extension events for file changes.

### TADAPT-017

Verifies: [CODEX-003](../user/adapters/codex.md#codex-003)

Given Codex emits an error whose message is a JSON-encoded object string, the Codex adapter shall expose the human-readable detail/message content in the normalized `error.message`, may unwrap nested error envelopes to reach that content, and shall not pass the raw JSON string through to pane-facing consumers.

### TADAPT-021

Verifies: [CODEX-004](../user/adapters/codex.md#codex-004), [ENG-022](../user/engine.md#eng-022), [ENG-023](../user/engine.md#eng-023)

Given a Codex `PermissionPolicy` whose local access resolves to `:workspace` and whose `writablePaths` contains valid entries, the Codex permission mapping shall expose canonical `WritablePathsPermissionMapping` paths with `enforcement: 'profile'`, select a generated extra-writes permission profile that extends `:workspace`, and represent `write` grants under `:workspace_roots` for each canonical path. Given non-empty `writablePaths` with Codex local access resolved to `:read-only`, the mapping shall reject the policy. Given non-empty `writablePaths` with Codex local access resolved to `:danger-full-access`, the mapping shall report the canonical paths with `enforcement: 'ambient'`, shall not generate an extra-writes profile, and shall not narrow the broader posture.

## Gemini

### TADAPT-007

Verifies: [NDJSON-001](../user/ndjson.md#ndjson-001), [NDJSON-002](../user/ndjson.md#ndjson-002), [NDJSON-003](../user/ndjson.md#ndjson-003), [NDJSON-004](../user/ndjson.md#ndjson-004), [NDJSON-005](../user/ndjson.md#ndjson-005), [GEMINI-003](../user/adapters/gemini.md#gemini-003)

Given partial lines, malformed JSON, and empty lines, `parseNDJSON()` shall produce the correct `NDJSONParseResult` values. Given process exit codes 0, 1, 42, and 53, the Gemini adapter shall yield the corresponding `done` status. Given the child process reports an asynchronous launch error, the Gemini adapter shall emit a non-recoverable `error` followed by terminal `done` with `status: 'error'`.

### TADAPT-025

Verifies: [GEMINI-003](../user/adapters/gemini.md#gemini-003), [GEMINI-006](../user/adapters/gemini.md#gemini-006), [GEMINI-007](../user/adapters/gemini.md#gemini-007), [GEMINI-011](../user/adapters/gemini.md#gemini-011), [GEMINI-012](../user/adapters/gemini.md#gemini-012), [GEMINI-013](../user/adapters/gemini.md#gemini-013), [GEMINI-014](../user/adapters/gemini.md#gemini-014)

Given a fake Gemini CLI implementing the 0.50 argument and Policy Engine surfaces while capturing argv and temporary files, when the adapter runs, arbitrary prompts, model values, and non-empty resume tokens shall arrive through joined option tokens; absent or empty resume shall create a fresh run whose pre-backend events share a generated non-empty correlation identifier; unsupported turn-limit and deprecated tool controls shall be absent; generated policy rules, precedence, serialization, native-default omission, configuration authority, and cleanup shall match the cited Gemini items.

## OpenCode

### TADAPT-008

Verifies: [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [OPENCODE-006](../user/adapters/opencode.md#opencode-006), [OPENCODE-008](../user/adapters/opencode.md#opencode-008), [OPENCODE-009](../user/adapters/opencode.md#opencode-009), [OPENCODE-010](../user/adapters/opencode.md#opencode-010)

The OpenCode adapter shall filter events by `sessionId`, pass through events with no session or thread identifier per [OPENCODE-006](../user/adapters/opencode.md#opencode-006), emit `opencode:file_part` and `opencode:image_part` extension events, manage the server lifecycle in managed mode, and yield `error` (`code: 'OPENCODE_SERVER_EXIT'`) followed by `done` (`status: 'error'`) on server crash.
Where the managed server remains running, teardown shall send `SIGTERM` before
invoking SDK disposal and shall complete within a bounded interval when
iterator return, client close, and client shutdown all remain pending.
If the server ignores `SIGTERM`, teardown shall send `SIGKILL` after a bounded
grace and shall bound the final close wait.

### TADAPT-027

Verifies: [OPENCODE-007](../user/adapters/opencode.md#opencode-007), [OPENCODE-013](../user/adapters/opencode.md#opencode-013), [OPENCODE-015](../user/adapters/opencode.md#opencode-015)

Where no `PermissionPolicy` is supplied, when OpenCode starts fresh and resumed
runs through each supported SDK path, fresh-session creation and prompt calls
shall omit permission data and a resumed run shall issue no permission-bearing
session update. Prompt calls shall also omit tool-list data when both tool-list
options are absent. Where an empty policy is supplied instead, fresh and
resumed runs shall carry `ask` rules for `edit`, `bash`, and `webfetch`.

### TADAPT-028

Verifies: [OPENCODE-008](../user/adapters/opencode.md#opencode-008), [PKG-012](../dev/package.md#pkg-012)

Where the exact OpenCode CLI conformance target is installed, when its version
and `serve --help` output are inspected, the reported version shall equal the
exact CI target and the managed-server help shall expose `--hostname` and
`--port`.

### TADAPT-031

Verifies: [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [OPENCODE-016](../user/adapters/opencode.md#opencode-016)

Given canonical OpenCode tool-part snapshot sequences whose `part.id` differs
from `part.callID` — pending through repeated running to `completed`, and
pending through running to `error` — the adapter shall emit exactly one
`tool_use`/`tool_result` pair per `callID`, correlated by `callID`, preserving
`state.input`, the terminal `state.output` or `state.error`, and the
state-supplied duration, and shall count each call once in
`done.usage.toolUses`. Given a terminal snapshot with no earlier snapshots for
its `callID`, the adapter shall still emit the correlated pair. Given
interleaved snapshots for distinct `callID`s, each pair shall stay isolated per
call. Given a rejected permission reply that resolves to a `callID` followed by
terminal tool-state updates for that call, the adapter shall emit exactly one
terminal `tool_result`, carrying the call's tool name where the permission
request named only the permission it gates. Given a rejected reply that
resolves to a call whose terminal result was already emitted, no denied
`tool_result` shall follow. Given repeated terminal snapshots, no event or
usage count shall duplicate.

### TADAPT-034

Verifies: [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [OPENCODE-006](../user/adapters/opencode.md#opencode-006), [OPENCODE-017](../user/adapters/opencode.md#opencode-017)

Given canonical user and assistant message envelopes and conversational part
events, when role metadata arrives both before and after its parts, the adapter
shall emit only assistant `text`, `text_delta`, and `thinking` events, preserve
their stream order across interleaved message identifiers even where a later
role resolves first, and emit no user content. An assistant reply byte-equal
to the submitted prompt shall still be emitted. Content with a message
identifier whose role never resolves shall not be emitted, shall not prevent
later known assistant content from flushing before terminal `done`, and legacy
content without a message identifier shall preserve its prior normalization.
Removing a message with held content shall discard that content and unblock
later events without waiting for terminal completion. Role metadata from a
foreign session shall not resolve current-session content.

### TADAPT-035

Verifies: [OPENCODE-006](../user/adapters/opencode.md#opencode-006), [OPENCODE-008](../user/adapters/opencode.md#opencode-008), [OPENCODE-009](../user/adapters/opencode.md#opencode-009), [OPENCODE-011](../user/adapters/opencode.md#opencode-011), [OPENCODE-018](../user/adapters/opencode.md#opencode-018)

Given short injected inactivity deadlines and canned OpenCode streams, when a
current session becomes permanently silent, the adapter shall query its status
and terminate within a bounded interval: idle shall produce one recoverable
idle-recovery diagnostic and one successful `done`; busy and retry shall each
abort the session and produce one non-recoverable timeout diagnostic plus one
error `done`; an omitted status-map entry shall exercise OpenCode's idle
representation; and a rejected or non-settling status query
shall make a bounded abort attempt and produce one status-query diagnostic plus
one error `done`.
Given root-session or run-owned descendant progress events whose spacing stays
below the deadline, the adapter shall not query status. Descendant lifecycle,
conversation, and permission events shall each restart the deadline while
ordinary descendant output remains filtered and permission control retains its
native descendant-session routing. Repeated events explicitly tagged for
another session and repeated untagged workspace-global events shall not
postpone the current session's deadline. When a consumer pauses after a
normalized event for longer than the configured deadline, that downstream
backpressure shall not consume the provider-silence budget, and a buffered
current-session terminal event shall complete without status recovery. An
always-ready non-relevant backlog shall still expire.
Given pending iterators that do and do not honor `AbortSignal`, external and
managed runs shall return the iterator, close the client, initiate active
session cancellation where required, terminate only the managed server, and
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
shall remain the interrupted resume token. A run
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

### TADAPT-036

Verifies: [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [OPENCODE-017](../user/adapters/opencode.md#opencode-017), [OPENCODE-019](../user/adapters/opencode.md#opencode-019)

Given canonical v1 sibling-delta, v2 explicitly typed delta, and v2 generic
delta events interleaving assistant text, assistant reasoning, and user text,
the adapter shall reconstruct assistant output through `text_delta` without
reasoning or user contamination. Generic deltas shall classify correctly when
part metadata arrives before or after them, while unresolved types shall not
default to output or block later known content. Interleaved part identifiers
shall preserve stream order when later metadata resolves first, and removing a
part shall discard content still pending on either kind or role. Reasoning
shall appear only through settled `thinking` snapshots, nonconsecutive
duplicate settled snapshots shall emit once, and an exact settled replay of a
part's `textID`-correlated deltas shall not duplicate the combined `text` plus
`text_delta` reconstruction. An incident-scale interleaved delta stream shall
preserve order and terminate within the test bound; after removing a message,
none of its parts shall emit later content and later messages shall continue.

### TADAPT-037

Verifies: [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [OPENCODE-006](../user/adapters/opencode.md#opencode-006), [OPENCODE-007](../user/adapters/opencode.md#opencode-007), [OPENCODE-008](../user/adapters/opencode.md#opencode-008), [OPENCODE-009](../user/adapters/opencode.md#opencode-009), [OPENCODE-020](../user/adapters/opencode.md#opencode-020)

Where `PermissionPolicy.mode` is `auto`, when fresh and resumed OpenCode runs
use each supported SDK path, neither the observable v1 prompt nor the v2
session ruleset shall contain an adapter-generated wildcard. Explicitly
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
automated marker, normalized input, and optional reason. Outside auto it shall
emit the normalized request and answer `reject` without the extension.
Where a resumed root already owns child or grandchild sessions, the wrapper
shall recursively discover them through version-correct `session.children`
routes under one whole-traversal deadline before prompt dispatch. Ordered
lifecycle events shall add fresh descendants. Child permission asks shall use
the child identifier on session-scoped reply routes, while child conversational
output remains filtered.
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
to the managed server without waiting for that response. The interrupted
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
real-run acceptance.

## Tool Filtering

### TADAPT-009

Verifies: [ENG-017](../user/engine.md#eng-017)

Given `allowedTools` and `disallowedTools` options, each adapter shall enforce whitelist and precedence semantics or reject before backend invocation when it has no compatible restriction surface, per [ENG-017](../user/engine.md#eng-017).

### TADAPT-029

Verifies: [ENG-017](../user/engine.md#eng-017), [CLAUDE-009](../user/adapters/claude-code.md#claude-009), [CODEX-011](../user/adapters/codex.md#codex-011), [GEMINI-006](../user/adapters/gemini.md#gemini-006), [GEMINI-016](../user/adapters/gemini.md#gemini-016), [OPENCODE-015](../user/adapters/opencode.md#opencode-015), [KIMI-010](../user/adapters/kimi.md#kimi-010)

Where `allowedTools` is an explicit empty list, when the built-in adapters run, the adapters shall enforce the closed empty set where supported: Claude Code receives SDK `tools: []`, `allowedTools: []`, `settingSources: []`, and `strictMcpConfig: true`; and Gemini emits only its applicable deny rules including the catch-all deny and reports a configured known empty set.
Where a non-empty allowlist and disallowed identifiers are provided, when Claude Code and Gemini run, each adapter shall close its provider tool registry to the effective allowlist and preserve deny precedence, while Claude Code shall also reject ambient MCP additions.
Where either tool-list field is explicitly provided to OpenCode, including an empty array and including alongside a portable permission rule such as `shellExecute: 'deny'`, when the adapter runs, it shall reject before its SDK loader, compatibility wrapper, session creation, subscription, or backend prompt is invoked. Direct permission-mapper calls with either field present shall reject by the same contract. The diagnostic shall explain that OpenCode 1.18.13 merges prompt `tools` into persistent session permission rules, which can override native or explicit denies and cannot provide exact per-call tool availability.
Where either tool-list field is explicitly provided to Codex, including an empty array, when the adapter runs, it shall reject before its SDK loader or client is invoked.
Where either tool-list field is explicitly provided to Kimi, including an empty array, when the adapter runs, it shall reject before spawning `kimi acp`.

## Effort

### TADAPT-018

Verifies: [ENG-020](../user/engine.md#eng-020), [ENG-024](../user/engine.md#eng-024), [CLAUDE-008](../user/adapters/claude-code.md#claude-008), [CODEX-007](../user/adapters/codex.md#codex-007), [GEMINI-011](../user/adapters/gemini.md#gemini-011), [OPENCODE-012](../user/adapters/opencode.md#opencode-012), [KIMI-009](../user/adapters/kimi.md#kimi-009)

Where each adapter-specific effort value is supplied, when the adapter maps a run, the observable provider controls shall match this table and the cited adapter item:

| Adapter     | Observable mapping                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | SDK `effort` plus explicit `settings.ultracode`; `ultracode` maps to `xhigh` and `true`                                                  |
| Codex       | `minimal` through `xhigh` use thread `modelReasoningEffort`; `max` and `ultra` use constructor `config.model_reasoning_effort` unchanged |
| Gemini      | portable values create documented aliases only for matching concrete model IDs                                                           |
| OpenCode    | portable values select the documented top-level prompt `variant` by provider                                                             |
| Kimi        | `off` and `on` select the ACP `thinking` option exactly; `on` uses the chosen model's native default effort                              |

When effort is omitted, no adapter shall set an effort, orchestration, settings-alias, or variant override.
Where Claude `ultracode` or Codex `ultra` is supplied alongside permission options, when the adapter maps the run, its permission-related provider controls shall equal the controls derived from the same permission input without the provider-native effort value.
Where a provider-specific value belongs to another built-in adapter or is an arbitrary unknown string, the adapter shall reject it before invoking the backend with an error naming the adapter and the same allowed values exposed by [ENG-024](../user/engine.md#eng-024).

### TADAPT-026

Verifies: [ENG-024](../user/engine.md#eng-024), [CLAUDE-008](../user/adapters/claude-code.md#claude-008), [CODEX-007](../user/adapters/codex.md#codex-007), [GEMINI-011](../user/adapters/gemini.md#gemini-011), [OPENCODE-012](../user/adapters/opencode.md#opencode-012), [KIMI-009](../user/adapters/kimi.md#kimi-009)

Where an effort value is valid for a built-in adapter but unavailable to the selected model, account, or installed runtime, when the backend rejects the run, the adapter stream shall expose that upstream failure through its normal error path without substituting another effort.

## Resume Token

### TADAPT-010

Verifies: [CLAUDE-007](../user/adapters/claude-code.md#claude-007)

The Claude Code adapter shall set `DonePayload.resumeToken` to the session identifier from the SDK result per [CLAUDE-007](../user/adapters/claude-code.md#claude-007).

### TADAPT-011

Verifies: [CODEX-006](../user/adapters/codex.md#codex-006)

The Codex adapter shall set `DonePayload.resumeToken` to the thread identifier per [CODEX-006](../user/adapters/codex.md#codex-006).

### TADAPT-012

Verifies: [OPENCODE-011](../user/adapters/opencode.md#opencode-011)

The OpenCode adapter shall set `DonePayload.resumeToken` to the session identifier per [OPENCODE-011](../user/adapters/opencode.md#opencode-011).
Given a caller-supplied resume identifier that OpenCode rejects during
pre-prompt lineage discovery, the error `done` shall omit `resumeToken`, and a
subsequent `Cligent.run()` shall create a fresh session rather than retrying the
stale identifier.

### TADAPT-013

Verifies: [GEMINI-009](../user/adapters/gemini.md#gemini-009)

Given a Gemini stream that provides a session identifier, the adapter shall set `DonePayload.resumeToken` to that value. Given a stream with no session identifier (e.g., early error), the adapter shall omit `resumeToken` per [GEMINI-009](../user/adapters/gemini.md#gemini-009).

### TADAPT-020

Verifies: [CLAUDE-007](../user/adapters/claude-code.md#claude-007), [CODEX-006](../user/adapters/codex.md#codex-006), [GEMINI-009](../user/adapters/gemini.md#gemini-009), [OPENCODE-011](../user/adapters/opencode.md#opencode-011), [KIMI-012](../user/adapters/kimi.md#kimi-012)

Given each adapter has observed a backend session or thread identifier during a run, when that run is aborted and yields terminal `done` with `status: 'interrupted'`, the adapter shall set `DonePayload.resumeToken` to the observed backend identifier.
Given each adapter is run with a non-empty `AgentOptions.resume` value and no backend session or thread identifier is observed before abort, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall set `DonePayload.resumeToken` to the inbound `resume` value.
Given the Claude Code adapter starts a run without `AgentOptions.resume` and no SDK activity beyond the initial `system` message is observed before abort, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall have passed a generated SDK `sessionId` and shall omit `DonePayload.resumeToken`.
Given the Claude Code adapter starts a run without `AgentOptions.resume` and SDK activity beyond the initial `system` message is observed before abort, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall set `DonePayload.resumeToken` to the SDK-provided or generated SDK `sessionId`.
Given a Codex, Gemini, OpenCode, or Kimi adapter observes no backend session or thread identifier and has no non-empty inbound `resume` value before abort, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall omit `resumeToken`.

### TADAPT-016

Verifies: [GEMINI-010](../user/adapters/gemini.md#gemini-010)

The Gemini adapter shall set `GEMINI_CLI_TRUST_WORKSPACE=true` by default in the spawned process environment and preserve an existing parent environment value per [GEMINI-010](../user/adapters/gemini.md#gemini-010).

## Concurrency

### TADAPT-014

Verifies: [ENG-018](../user/engine.md#eng-018)

Where an adapter does not document an environmental constraint, concurrent `run()` calls on the same adapter instance shall emit no cross-stream event leakage (events from one call shall not appear in another), maintain per-call options isolation, and retain no cross-run state except the cumulative-accounting baseline and ordering queue permitted by [ENG-018](../user/engine.md#eng-018).

## Codex Resume

### TADAPT-015

Verifies: [CODEX-005](../user/adapters/codex.md#codex-005), [CODEX-015](../user/adapters/codex.md#codex-015)

When `resume` is a non-empty string, the Codex adapter shall continue the previous thread per [CODEX-005](../user/adapters/codex.md#codex-005). When `resume` is absent or empty, it shall start a fresh thread whose events carry a non-empty correlation identifier and whose first cumulative usage snapshot is treated as fresh-turn accounting.

## Kimi

### TADAPT-030

Verifies: [KIMI-001](../user/adapters/kimi.md#kimi-001), [KIMI-002](../user/adapters/kimi.md#kimi-002), [KIMI-003](../user/adapters/kimi.md#kimi-003), [KIMI-004](../user/adapters/kimi.md#kimi-004), [KIMI-005](../user/adapters/kimi.md#kimi-005), [KIMI-006](../user/adapters/kimi.md#kimi-006), [KIMI-007](../user/adapters/kimi.md#kimi-007), [KIMI-008](../user/adapters/kimi.md#kimi-008), [KIMI-009](../user/adapters/kimi.md#kimi-009), [KIMI-010](../user/adapters/kimi.md#kimi-010), [KIMI-011](../user/adapters/kimi.md#kimi-011), [KIMI-012](../user/adapters/kimi.md#kimi-012)

Given a fake ACP subprocess with protocol traffic split across arbitrary stdio chunks, when Kimi runs fresh and resumed prompts, it shall initialize with empty client capabilities, select `session/new` or `session/resume`, apply model before thinking and mode configuration, emit `init` before normalized text, tool, plan, and permission events, reject reverse permission requests, suppress raw thought chunks, map every prompt stop reason, preserve the correct resume token, and terminate the per-run child exactly once.
The adapter identity shall be `kimi`, and availability probing shall invoke `kimi --version` without starting ACP or authentication.
Where abort occurs before and after session setup, the adapter shall cancel or terminate as appropriate and emit exactly one interrupted `done` without state leakage.
Where authentication, protocol, or child-process failure occurs, the stream shall emit an actionable error and error `done` without starting login.
Where permissions, tool lists, turn or budget limits, or effort values are unsupported, validation shall fail before the spawn seam is invoked.

### TADAPT-033

Verifies: [ENG-019](../user/engine.md#eng-019), [ENG-027](../user/engine.md#eng-027), [CODEX-003](../user/adapters/codex.md#codex-003), [GEMINI-004](../user/adapters/gemini.md#gemini-004), [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [KIMI-005](../user/adapters/kimi.md#kimi-005)

_Superseded for usage shape by [TADAPT-040](#tadapt-040)._

Given each built-in adapter receives complete finite non-negative integer token counters, including explicit zeroes, when it emits terminal `done`, `usage.tokenAvailability` shall be `'reported'`, its input count shall preserve a provider-inclusive base or fold cache-read and cache-write counters into a cache-exclusive base exactly once, and, where reasoning or thinking is supplied disjoint from the output base, its output count shall add that component exactly once.
Given OpenCode supplies canonical step-finish accounting, its visible output and disjoint reasoning counters shall be summed exactly once.
Given Gemini supplies canonical `StreamStats`, its cache-inclusive `input_tokens` shall remain unchanged, its `cached` and uncached `input` details shall be validated without being added again, and valid `tool_calls` shall contribute to the independently known tool-use count; where `total_tokens` differs from `input_tokens + output_tokens`, accounting shall be unavailable rather than assigning the unpartitioned residual to output.
Given a required token or cache counter is absent or any present mapped counter is negative, fractional, non-finite, or non-numeric, when the adapter emits terminal `done`, `usage.tokenAvailability` shall be `'unavailable'`; an absent optional cache counter alone shall retain zero contribution without invalidating otherwise complete accounting.
Given a Kimi prompt has a valid stop reason but malformed optional usage, when the adapter emits terminal `done`, the stop reason shall still determine status, token accounting shall be unavailable, and accumulated result text and tool use shall remain intact; an unconsumed malformed thought detail or null optional cache detail shall not poison otherwise complete accounting.
Given upstream omits complete token accounting or an adapter synthesizes an errored, interrupted, exhausted, or other terminal path, when the adapter emits terminal `done`, `usage.tokenAvailability` shall be `'unavailable'` and no token estimate shall be introduced.
Where tool calls were observed or validly provider-reported on either path, `usage.toolUses` shall preserve the greatest independently known count even when token accounting is unavailable.

### TADAPT-038

Verifies: [ENG-028](../user/engine.md#eng-028), [CLAUDE-003](../user/adapters/claude-code.md#claude-003), [CODEX-015](../user/adapters/codex.md#codex-015), [CODEX-016](../user/adapters/codex.md#codex-016), [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [KIMI-005](../user/adapters/kimi.md#kimi-005)

_Superseded by [TADAPT-040](#tadapt-040)._

Given each built-in adapter emits a terminal `done` with complete upstream accounting, when a caller reads `usage.breakdown`, OpenCode shall publish both sides from its five step counters, Claude Code shall publish the input side alone, Codex shall publish both sides derived by subtraction from its inclusive counters, and Kimi shall publish none.
Given a runtime omits a cache or reasoning counter, the corresponding component shall be absent while the remaining members of a published side still sum to their aggregate, and where the omitted counter is the reasoning counter the whole output side shall be absent.
Given a component subtraction would be negative, the affected side shall be absent while the unaffected side is still published.
Given Codex reports its thread-cumulative snapshot on successive turns of one thread, the second turn's `done` shall report that turn's difference rather than the thread total; given a resumed thread for which the adapter holds no baseline, the `done` shall report `'unavailable'`; and given a snapshot smaller than the retained baseline, the `done` shall report `'unavailable'` while the following turn recovers.

### TADAPT-039

Verifies: [ENG-030](../user/engine.md#eng-030), [CLAUDE-011](../user/adapters/claude-code.md#claude-011), [CODEX-014](../user/adapters/codex.md#codex-014), [OPENCODE-005](../user/adapters/opencode.md#opencode-005)

_Superseded by [TADAPT-040](#tadapt-040)._

Given each built-in adapter emits a terminal `done` with complete upstream accounting, when a caller reads `usage.records`, Claude Code shall publish one record per model in its per-model accounting keyed by the canonical model identifier, OpenCode shall publish one record per step part carrying `requests: 1`, and Codex shall publish one record covering the turn with no request count.
Given a run pinned no model and its runtime named none, Codex shall publish no records, and an OpenCode step whose message named no model shall yield a record without one; in neither case shall a placeholder identifier appear.
Given a runtime reports a group's own cost, its record shall carry that cost, and the costs of a run's records shall not exceed the run's reported total.
Given upstream accounting is incomplete, absent, or fails the partition identities, the adapter shall publish no records on that terminal.

### TADAPT-040

Verifies: [ENG-031](../user/engine.md#eng-031), [CLAUDE-012](../user/adapters/claude-code.md#claude-012), [CODEX-017](../user/adapters/codex.md#codex-017), [GEMINI-017](../user/adapters/gemini.md#gemini-017), [KIMI-013](../user/adapters/kimi.md#kimi-013), [OPENCODE-021](../user/adapters/opencode.md#opencode-021)

Given authentic zero or nonzero accounting from a built-in adapter, terminal `usage.tokens` shall carry inclusive input and output totals, exact reported cache/reasoning subsets, and no removed flat fields or availability placeholder; malformed or absent accounting shall omit `tokens` while preserving independently observed `toolUses`.
Claude Code shall publish complete whole-agent-tree totals and one record per model from `modelUsage`, including inclusive output, and shall preserve valid whole-run and per-model cost as `agent-estimate`; malformed or absent `modelUsage` shall not promote main-loop usage.
Codex shall publish a partial root-thread report from the exact non-negative delta of its cumulative snapshot, omit an unseen resumed or decreasing delta, discard a stale baseline after a malformed snapshot, omit a transition where optional-counter presence changes, recover only after a new baseline or shape stabilizes, and shall not label a record with a merely requested model.
Concurrent Codex runs carrying the same resume identifier shall start their backend prompts serially and attribute each cumulative delta exactly once, while different resumed sessions and fresh runs remain concurrent.
Gemini shall publish a complete per-response report only from a prompt-free run-owned telemetry file whose root and descendant records carry a non-empty authentication rate-card identity, reconcile to terminal StreamStats, and contain neither an API-error event nor an unmatched zero-token routed model; exact duplicate exporter records shall be deduplicated, while a missing, malformed, unidentifiable duplicate, conflicting duplicate, contaminated, or mismatched file shall yield no token report. Tool-use-prompt tokens shall contribute to inclusive input and its uncached subset while StreamStats reconciliation shall preserve its raw prompt and candidate counters. A run with either failed-request signal shall retain exact reconciled successful-response records as partial, and run-owned telemetry cleanup shall run after success, error, and abort.
Kimi shall publish no token or cost report for the pinned ACP runtime, including when a synthetic unstable usage extension appears, while retaining tool calls and prompt status.
OpenCode shall include canonical causal child and grandchild steps without emitting child conversation, exclude foreign or pre-existing background work, deduplicate and replace repeated part snapshots by session and part identifier, preserve billed completed steps across removal, and publish complete coverage only when its causal ledger is valid and settled.
Fresh and default-title root sessions shall suppress and verify OpenCode's hidden title request, while a meaningful resumed title shall remain unchanged; inability to prove suppression shall retain exact records as partial.
The wrapper shall query the live server's global health before dispatch and shall permit complete accounting only for a healthy response naming the exact tested OpenCode version; a missing, failed, timed-out, unhealthy, malformed, or different-version response shall preserve exact records as partial without blocking the run.
Canonical compaction summaries and marked continuations shall extend the ledger only from their immediate causal boundary; overflow replay, unmarked or unlinked internal prompts, a causal or uncorrelatable retry, an accepted prompt without an assistant, or an unknown post-activation assistant step shall keep only the exact subset as partial, while an explicit foreign-assistant retry shall remain excluded.
Repeated internal-prompt snapshots shall preserve their first identity and every overflow or error signal; conflicting identities or evidence that becomes less severe shall retain only the original exact subset as partial.
Command continuations shall accept the canonical task-only assistant without inventing a model step, while background continuations shall correlate one-to-one with a causal child and shall remain partial when the child identity, result, or post-work settlement is unproved.
Task parts that reuse an existing `task_id` shall retain exact parent records as partial and shall exclude ambiguous child-session prompts and steps.
Repeated task-part snapshots shall enrich a missing child identity at most once, while a conflicting non-empty parent or child identity shall preserve only the first exact subset and force partial coverage.
Malformed task identity and descendant idle observed before later causal child accounting shall never support complete coverage.
Where Claude Code or OpenCode supplies cost, the emitted whole-run and record values shall be finite, non-negative, USD `agent-estimate` objects; measured zero shall remain present and a missing cost shall remain absent.
OpenCode shall submit its prompt with no message identifier and shall resolve the causal boundary from the prompt text it submitted, which an assistant repeating that text verbatim shall not displace.
Before prompt dispatch, the OpenCode adapter shall subscribe to the live event stream; no event published after subscription, including the first, shall be lost, and absence of a streamed connection event shall not defer prompt dispatch indefinitely.
A background task's injected result, and a concurrent caller's prompt that streams first, shall neither resolve the boundary nor bill their work to the run.
A run that created its root session, including a call whose resume value is absent or empty, may fall back to the first sighting it does not recognize as a background result; a run carrying a non-empty resume value shall not, and where no boundary resolves the terminal `usage.tokens` shall be absent rather than carry totals the run cannot attribute.

## Real-run Acceptance

Items in this section verify behavior end-to-end against the real coding-agent SDKs and CLIs (not mocks or canned events). They live under `src/adapters/*.acceptance.test.ts` and run via `npm run test:acceptance`. The SDK packages the adapters load (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`) are cligent `devDependencies`, while the ACP SDK used by Kimi is a runtime dependency, so any checkout able to run this suite has installed them via `npm install`; their absence is therefore not a skip condition. An item shall self-skip per adapter when an _external_ CLI the adapter spawns is absent from `PATH` — the `gemini` CLI for Gemini, the `opencode` CLI for OpenCode's managed server, or the `kimi` CLI for Kimi — or when that adapter's credential is absent from the environment; a missing dependency for one adapter shall not skip the others. Under `CI` the items shall instead hard-fail on a missing dependency so a misconfigured runner is not silently green. Exact credential-free Kimi ACP initialization remains an additional mandatory CI conformance check.

### TADAPT-019

Verifies: [CLAUDE-004](../user/adapters/claude-code.md#claude-004), [CLAUDE-005](../user/adapters/claude-code.md#claude-005), [CODEX-004](../user/adapters/codex.md#codex-004), [GEMINI-006](../user/adapters/gemini.md#gemini-006), [OPENCODE-007](../user/adapters/opencode.md#opencode-007), [KIMI-007](../user/adapters/kimi.md#kimi-007)

Where a `Cligent` is constructed on each adapter with
`CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first
to create and then to update a temporary file in a throwaway working
directory, the adapter's auto-mode SDK knobs per
[DR-005](../decisions/005-per-adapter-permission-configuration.md) and
[ENG-021](../user/engine.md#eng-021) shall let both non-destructive writes
proceed without interactive approval. The file shall exist with the expected
contents after each phase; neither stream shall contain `permission_request`,
a denied tool result, or an error; and each shall terminate with successful
`done`. Filesystem state shall be the ground-truth assertion because adapters
normalize file edits differently. The harness shall retry the complete fresh
probe after, and only after, an explicit upstream-overload, rate-limit,
service-unavailable, or Gemini upstream invalid-stream failure. It shall make
at most two retries; any other failure and the third consecutive named
transient failure shall remain fatal.

Where the host cannot initialize an adapter's OS-level sandbox, that adapter's leg shall self-skip with a logged reason, including under `CI`. Codex's `mode: 'auto'` maps to the `:workspace` profile, which runs commands inside a sandbox that some hosts cannot initialize; only the real-run create/update leg shall skip for that detected limitation, while mapping remains covered by [TADAPT-004](#tadapt-004).

Kimi Code `0.31.1` admits a prior interactive OAuth `kimi login`, a configured default model resolving to a provider with non-OAuth credentials, or the `KIMI_MODEL_NAME` plus `KIMI_MODEL_API_KEY` environment overlay; `MOONSHOT_API_KEY` alone satisfies none of them.
The acceptance harness exercises the OAuth route exclusively, so its credential probe shall run with the `KIMI_MODEL_*` overlay removed exactly as the live legs do; inheriting it would let an environment-configured model report a spent OAuth credential as usable, after which those legs fail instead of self-skipping.
Because Kimi rotates its refresh token on every refresh and persists the replacement into the refreshing home, a credential restored from an immutable CI secret is single-use.
The harness shall therefore probe credential usability once, before any Kimi leg runs and against the same shared clone the suite will use, and shall distinguish two conditions: an absent fixture or CLI remains a hard failure under `CI`, while a present-but-spent credential shall self-skip every live Kimi leg — the composite fanout included — with a precise reason, under `CI` as well, because no runner configuration can supply a fresh token and a failure there would not indicate a defect in this repository.
The credential-free ACP initialization conformance check shall remain mandatory in `CI` regardless, so a protocol-surface regression still fails the build. Locally, the Kimi source home shall resolve in order from `CLIGENT_KIMI_ACCEPTANCE_HOME`, an absolute `KIMI_CODE_HOME`, or the documented `~/.kimi-code` default. The Kimi CLI shall resolve from PATH or that source home's managed `bin` directory. Under `CI`, `CLIGENT_KIMI_ACCEPTANCE_HOME` shall name an absolute, dedicated source home containing regular files at `config.toml` and `credentials/kimi-code.json`; missing or invalid Kimi credentials or CLI shall fail like every other adapter dependency. The harness shall dereference and copy only the source config and credentials into one temporary `KIMI_CODE_HOME`, harden the copied config, credential files, and directories to owner-only permissions, share that clone across the complete acceptance suite including bounded retries and fanout, restore the caller's environment and PATH around each consumer, and remove the temporary home after the suite. It shall not mutate the source. Acceptance files shall run serially so the shared clone has one writer. An absent or invalid automatically discovered local source shall self-skip with a precise reason. A dedicated CI source is disposable, and a local source may require `kimi login` again, because an OAuth refresh against the clone may leave its prior token stale.

### TADAPT-023

Verifies: [CODEX-004](../user/adapters/codex.md#codex-004), [CODEX-010](../dev/adapters/codex.md#codex-010), [ENG-022](../user/engine.md#eng-022), [ENG-023](../user/engine.md#eng-023)

Given the Codex CLI can initialize its native sandbox, a credential-free Codex sandbox probe shall show that the built-in `:workspace` profile cannot write inside `.git`, while cligent's generated extra-writes profile delivery grants `write` for `.git` without creating or modifying repository `.codex/config.toml` or user-level Codex `config.toml`. Mapping tests shall prove that managed writable mappings encode active-project trust as a top-level `projects={<path>={trust_level="trusted"}}` inline table rather than a quoted dotted path, perform Codex-compatible Windows device-prefix simplification, and resolve linked worktrees to Codex's main-repository trust root; read-only mappings and mappings without a non-empty caller `cwd` shall not inject project trust. Given `CligentOptions.permissions = { mode: 'auto', writablePaths: ['.git'] }` and Codex credentials, a real Codex SDK run in a throwaway git repository shall complete a git metadata write without `permission_request`, denied tool results, or error events, and without creating or modifying repository or user-level Codex config files, including persisted `projects.<path>.trust_level` entries for the throwaway workspace. As in [TADAPT-019](#tadapt-019), the Codex leg shall self-skip with a logged reason when the host cannot initialize Codex's native sandbox, and shall hard-fail under `CI` for missing Codex dependencies or credentials.

### TADAPT-024

Verifies: [CODEX-004](../user/adapters/codex.md#codex-004)

Given Codex credentials and a throwaway `CODEX_HOME` whose `config.toml` grants broader user-level Codex access with legacy `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`, when a no-policy Codex `Cligent` is invoked to write a file outside its throwaway working directory, the file shall exist on disk after the run, the event stream shall contain no `permission_request` event, no `tool_result` with `status: 'denied'`, and no `error` event, and the terminal `done` status shall be `success`.
With the same `CODEX_HOME`, when a Codex `Cligent` constructed with `CligentOptions.permissions = { mode: 'auto' }` is invoked to write a different file outside its throwaway working directory, the file shall not exist on disk after the run, the event stream shall contain no `error` event, and the terminal `done` status shall be `success`.
The probe shall restore the caller's `CODEX_HOME` after the run and shall use the same Codex sandbox-init skip / CI hard-fail rules as [TADAPT-019](#tadapt-019).
This item is the real-run counterpart to [TADAPT-004](#tadapt-004)'s mapping check for `exec --ignore-user-config`: the no-policy control proves runs without `permissions` inherit Codex user config, and the permission-managed leg proves that config no longer overrides Cligent's managed `:workspace` profile.

### TADAPT-032

Verifies: [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [OPENCODE-016](../user/adapters/opencode.md#opencode-016)

Where OpenCode acceptance dependencies are present per this section's gating,
when a real managed-mode OpenCode run with auto-approved permissions is
prompted to create a file through its tools and the file exists with the
expected content afterwards, the collected stream shall contain no two
`tool_use` events sharing a `toolUseId`, at least one `tool_use` carrying
non-empty `input`, exactly one terminal `tool_result` for each emitted
`tool_use` `toolUseId` and none for any other id, no `permission_request` or
denied `tool_result`, and a successful `done` whose `usage.toolUses` equals
the `tool_use` count. The probe shall retry only on the explicit transient
upstream failures named in [TADAPT-019](#tadapt-019), with the same attempt
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
This item is the real-run counterpart to [TADAPT-031](#tadapt-031)'s
canned-event lifecycle check: the canned fixtures encode the wire schema this
release was written against, so only a live run can catch a later OpenCode
release changing the `ToolPart` lifecycle shape the way the pre-1.18
normalization drifted.

### TADAPT-041

Verifies: [GEMINI-017](../user/adapters/gemini.md#gemini-017)

Where the exact Gemini CLI conformance target and API-key credentials are
available, when the real auto-mode adapter leg completes its headless create
and update requests, each terminal shall carry a non-empty token report whose
inclusive totals are positive and whose per-response records name a non-empty
model, a non-empty authentication rate-card family, and exactly one request.
An absent or unreconciled run-owned telemetry file shall fail this acceptance
leg rather than pass on the successful coding-agent result alone.
