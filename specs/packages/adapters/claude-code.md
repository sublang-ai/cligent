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

The adapter module shall be importable without the SDK installed so consumers can register the adapter unconditionally.
The SDK shall only be required at call time: `isAvailable()` shall return `false` and `run()` shall throw when the SDK is absent.

### Event Normalization

### claude-code-3

The adapter shall normalize SDK messages to `AgentEvent` types:

| SDK Message | AgentEvent |
| --- | --- |
| `system` with `subtype: 'init'` | `init` (model, cwd, tools); every other `system` notice emits nothing |
| `assistant` with text content | `text` |
| `assistant` with tool_use content | `tool_use` |
| Stream events (text deltas) | `text_delta` |
| `result` | `done` (usage, status), except an internal no-op `result` per [[claude-code-10](#claude-code-10)] |
| Errors | `error` (recoverable flag) |

The adapter shall emit `init` exactly once per run, from the `system` message whose `subtype` is `init` — the only variant carrying the tool surface — identifying it by that subtype rather than by its position in the stream.
Claude Code emits `system` messages throughout a run for hook lifecycle, compaction boundaries, retries, thinking-token and status notices, and similar events, and those notices arrive both before and after the handshake: a run with a `SessionStart` hook configured emits the hook's own notices first.
Emitting `init` from a notice would announce an empty tool list, and doing so before the handshake would leave that empty list as the run's established capabilities.
A `system` message that carries no subtype shall be treated as the handshake, no runtime notice being unlabelled.

_The following released flat-accounting behavior is superseded by [[claude-code-12](#claude-code-12)]._

Where the `result` message supplies complete usage, the adapter shall publish the [[ENG-028](../../user/engine.md#eng-028)] input side by mapping `input_tokens` to `input`, `cache_read_input_tokens` to `cacheRead`, and `cache_creation_input_tokens` to `cacheWrite`, omitting a cache member the message did not carry, because Anthropic's base input counter already excludes both cache tiers and the three therefore partition the input aggregate exactly.
The adapter shall publish no output side, because Claude Code bills thinking tokens inside `output_tokens` and does not expose them separately, so no measured visible-output component exists to state.

### claude-code-10

Where the run was invoked with a non-empty `AgentOptions.resume`, while the adapter has yielded no `text`, `text_delta`, `thinking`, `tool_use`, or `tool_result` event in the current run, when the SDK stream yields a `result` message that classifies as `success` while carrying no non-empty `result` string and, in the main-loop accounting rather than the whole-run per-model totals [[claude-code-11](#claude-code-11)] reports, zero input-token, output-token, and tool-use counts — the shape of the CLI-internal continuation-repair no-op turn that Claude Code runs before the submitted turn when resuming a session whose previous turn ended with a dangling tool call — the adapter shall not emit terminal `done` for that message and shall continue consuming the stream so the submitted turn's messages, including its own `result`, normalize per [[claude-code-3](#claude-code-3)]; the skip shall apply to every `result` message of that shape for as long as both conditions above hold, there being nothing that distinguishes a second one from the first; where the stream then ends without a further `result` message that terminated the run — including a stream whose every `result` carried that shape — and the run was not aborted, the adapter shall yield its no-result outcome (`error` then terminal `done` with `status: 'error'`); an aborted run keeps its interrupted outcome per [[claude-code-7](#claude-code-7)]; in neither case shall the adapter yield a `success` `done` without a result.
When the run was invoked without `AgentOptions.resume`, or when any `text`, `text_delta`, `thinking`, `tool_use`, or `tool_result` event has already been yielded in the current run, a `result` message of that same shape shall normalize as terminal `done` per [[claude-code-3](#claude-code-3)] — `status: 'success'` with no `result` value and zero usage — and the adapter shall stop consuming the stream, so an empty fresh-run success and a silent termination after real turn activity are reported as the terminals they are rather than skipped.

### Permission Mapping

### claude-code-4

The adapter shall map `PermissionPolicy` to Claude Code permission modes per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md):

- All three capabilities `'allow'` → `permissionMode: 'bypassPermissions'`
- Only `fileWrite: 'allow'` (others `'ask'`) → `permissionMode: 'acceptEdits'`
- No capability set to `'allow'` or `'deny'` — every capability `'ask'`, which includes a missing `permissions` field — → `permissionMode: 'default'` with **no** `canUseTool` callback. Per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) a missing policy is no override, so the SDK's own `default`-mode handling governs and the adapter synthesizes nothing.
- Any capability `'allow'` or `'deny'` present (mixed with `'ask'`) → `permissionMode: 'default'` with a `canUseTool` callback that enforces the explicit categories

When `PermissionPolicy.writablePaths` is non-empty per [[ENG-022](../../user/engine.md#eng-022)] and Claude Code sandboxing is not independently active through a supported adapter surface, the adapter shall accept valid entries, expose `WritablePathsPermissionMapping` per [[ENG-023](../../user/engine.md#eng-023)] with `enforcement: 'ambient'` and canonical `paths`, and keep the existing permission-mode / `canUseTool` mapping unchanged.

### claude-code-5

The `canUseTool` callback shall conform to the Claude Agent SDK `CanUseTool` contract: the SDK invokes it as `(toolName, input, options)` and validates the resolved value against `PermissionResult`, so the callback shall resolve to `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }` — a bare boolean or `undefined` fails the SDK's schema validation and raises a `ZodError` on every tool call.
It shall match tool categories to UPM capabilities — `Write`/`Edit` → `fileWrite`, `Bash` → `shellExecute`, `WebFetch` → `networkAccess` — and resolve each call as: capability `'allow'` → `allow`; capability `'deny'` → `deny`; capability `'ask'` → `deny` (interactive approval is unavailable to a headless adapter run; the deny `message` shall name the capability); a tool matching no category → `allow`, since it is not a permission-gated capability.

### Options Mapping

### claude-code-6

The adapter shall map `AgentOptions` fields to SDK query options: `cwd` → SDK `cwd`, `model` → SDK `model`, `maxTurns` → SDK `maxTurns`, `maxBudgetUsd` → SDK `maxBudgetUsd`, non-empty `resume` → SDK `resume`.

### claude-code-9

Where `AgentOptions.allowedTools` is provided, the adapter shall pass the effective list to the Claude Agent SDK `tools` option so only those built-in tools are available, shall pass the list to SDK `allowedTools` to preserve automatic permission approval for the selected names, and shall set `strictMcpConfig: true` so ambient MCP configuration cannot add tools outside the explicit list.
An explicit empty list shall map to `tools: []` and `allowedTools: []`, disabling every built-in tool rather than restoring SDK defaults; it shall additionally map to `settingSources: []` so the SDK loads no user, project, or local filesystem settings or `CLAUDE.md`.
These fields isolate only the ambient sources covered by their documented SDK controls and shall not be represented as removing provider context outside those surfaces.
Where `disallowedTools` is also provided, the adapter shall pass it through so those exact identifiers remain unavailable and take precedence over the allowlist per [[ENG-017](../../user/engine.md#eng-017)].
Where `allowedTools` is omitted, the adapter shall omit SDK `tools`, `settingSources`, and `strictMcpConfig` and preserve the SDK's native available-tool, MCP, and settings behavior.

### claude-code-8

Per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), the adapter shall accept the Claude-specific `AgentOptions.effort` vocabulary from [[ENG-020](../../user/engine.md#eng-020)] and map each value to the Claude Agent SDK query options per [[1]] and [[2]]:

| `AgentOptions.effort` | SDK `effort` | SDK `settings.ultracode` |
| --- | --- | --- |
| `minimal` | `low` | `false` |
| `low` | `low` | `false` |
| `medium` | `medium` | `false` |
| `high` | `high` | `false` |
| `xhigh` | `xhigh` | `false` |
| `max` | `max` | `false` |
| `ultracode` | `xhigh` | `true` |

The minimum compatible Claude Agent SDK declares model effort as `'low' | 'medium' | 'high' | 'xhigh' | 'max'`, so `minimal` shall collapse to its lowest tier and `ultracode` shall use `xhigh` plus the provider's orchestration setting.
Every explicit portable effort shall set `settings.ultracode: false` so a per-run downgrade overrides inherited ultracode configuration.
When effort is omitted, the adapter shall set neither SDK field and shall preserve SDK and user-configuration defaults.
Where effort is outside the Claude-specific accepted vocabulary, including the Codex-specific value `ultra`, the adapter shall reject it before invoking the SDK with an error naming the Claude adapter and allowed values.
Mapping `ultracode` shall leave independently mapped permission controls unchanged, although the provider's delegated workflow may increase token use, latency, cost, concurrency, and tool activity per [[2]].

### Resume Token

### claude-code-7

When a Claude Code run starts without `AgentOptions.resume`, the adapter shall pass a generated UUID as SDK `sessionId` so the run has a stable session identifier once Claude persists the conversation.
When the Claude Code SDK provides a session identifier before terminal `done`, the adapter shall set `DonePayload.resumeToken` to that identifier, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md).
When an abort causes terminal `done` with `status: 'interrupted'`, the adapter shall preserve continuity by setting `DonePayload.resumeToken` to the first available value in this order: a session identifier observed on SDK activity beyond the initial `system` message, or the adapter-assigned session identifier after such activity; otherwise the non-empty `AgentOptions.resume` value passed into the run; otherwise no `resumeToken`.

### Token Accounting

### claude-code-11

_Superseded by [[claude-code-12](#claude-code-12)]; retained for the unreleased first billable-record design._

Claude Code reports two accountings on its terminal `result` message: `usage`, which counts the main conversation loop only, and `modelUsage`, which counts every model request the run made — including subagents and internal inference — partitioned per model into input, cache-read, cache-creation, and output counters.
The adapter shall derive `DonePayload.usage` from the per-model accounting by summing those counters across models, so the reported totals cover the whole run and share the scope of the runtime's own cost figure.
Where the per-model accounting is absent, or any counter it supplies is not a finite non-negative integer, the adapter shall fall back to the main-loop counters; in that case the reported totals cover the main conversation loop only and may understate a run that spawned subagents.
The adapter shall publish the per-model entries as the run's [[ENG-030](../../user/engine.md#eng-030)] billable records, keyed by the canonical model identifier Claude Code prices against rather than the raw map key, carrying the provider and the runtime-computed per-model cost where present, and carrying the input side alone because the runtime reports no per-model output split.
The adapter shall determine the [[claude-code-10](#claude-code-10)] no-op repair signature from the main-loop counters rather than the whole-run totals, because the repair turn reports zero main-loop tokens while the run as a whole may already have spent some.

### claude-code-12

The adapter shall publish [[ENG-031](../../user/engine.md#eng-031)] complete token coverage only from the terminal `modelUsage` map, because that surface includes every model request made by the main loop, subagents, and internal inference [[3]].
Each per-model record shall carry inclusive input and output totals, exact uncached, cache-read, and cache-write input details, the canonical model and provider where supplied, the runtime's non-negative per-model cost as `agent-estimate`, and a `web_search_request` priced unit where the runtime reports one.
The records shall sum to the report totals.
Reasoning detail shall remain absent because Claude Code includes it in output but does not expose the subset.
Where `modelUsage` is absent or malformed, the adapter shall omit token accounting rather than promote the main-loop-only `usage` object to an invocation report; that narrow object shall remain usable only for [[claude-code-10](#claude-code-10)]'s internal repair signature.
The terminal `total_cost_usd`, where finite and non-negative, shall be exposed independently as a whole-invocation `agent-estimate` even when tokens are absent.

## Verification

### claude-code-201

Given canned native Claude Code SDK messages, when the adapter runs, the yielded `AgentEvent` types shall match its normalization table [[claude-code-3](#claude-code-3)].

### claude-code-202

Where the Claude Agent SDK is not installed, `isAvailable()` shall return `false` and `run()` shall throw [[claude-code-2](#claude-code-2)].

### claude-code-204

Given all `PermissionLevel` combinations, the adapter shall map `PermissionPolicy` to the correct vendor-specific controls [[claude-code-4](#claude-code-4)], [[claude-code-5](#claude-code-5)].

### claude-code-210

The adapter shall set `DonePayload.resumeToken` to the session identifier from the SDK result [[claude-code-7](#claude-code-7)].

### claude-code-218

Where each Claude-specific effort value is supplied, when the adapter maps a run, the observable provider controls shall be SDK `effort` plus an explicit `settings.ultracode`, `ultracode` mapping to `xhigh` and `true` [[claude-code-8](#claude-code-8)]:

- when effort is omitted, the adapter shall set no effort, orchestration, or settings-alias override;
- where `ultracode` is supplied alongside permission options, the adapter's permission-related provider controls shall equal the controls derived from the same permission input without the provider-native effort value;
- where the supplied value belongs to another built-in adapter or is an arbitrary unknown string, the adapter shall reject it before invoking the backend with an error naming the adapter and its allowed values.

### claude-code-219

Where a `Cligent` is constructed on the adapter with `CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first to create and then to update a temporary file in a throwaway working directory, the adapter's auto-mode SDK knobs per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) shall let both non-destructive writes proceed without interactive approval [[claude-code-4](#claude-code-4)], [[claude-code-5](#claude-code-5)]:

- the file shall exist with the expected contents after each phase;
- neither stream shall contain `permission_request`, a denied tool result, or an error;
- each stream shall terminate with successful `done`;
- filesystem state shall be the ground-truth assertion, because adapters normalize file edits differently;
- the harness shall retry the complete fresh probe after, and only after, an explicit upstream-overload, rate-limit, or service-unavailable failure, shall make at most two retries, and shall treat any other failure and the third consecutive named transient failure as fatal;
- the leg shall run against the real SDK, which any checkout able to run this suite has installed as a `devDependency`, so SDK absence shall not be a skip condition; the leg shall self-skip when the adapter's credential is absent from the environment, shall hard-fail instead under `CI`, and a missing dependency for one adapter shall never skip another's leg.

### claude-code-220

Given the adapter has been aborted, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall report the resume token each observed state requires [[claude-code-7](#claude-code-7)]:

| Observed before abort | `DonePayload.resumeToken` |
| --- | --- |
| a backend session identifier observed during the run | the observed backend identifier |
| no backend identifier and a non-empty `AgentOptions.resume` value | the inbound `resume` value |
| no `AgentOptions.resume` and no SDK activity beyond the initial `system` message | omitted, a generated SDK `sessionId` having been passed |
| no `AgentOptions.resume` and SDK activity beyond the initial `system` message | the SDK-provided or generated SDK `sessionId` |

### claude-code-222

Given a `PermissionPolicy` whose `writablePaths` contains valid entries and no independently active filesystem-sandbox write-grant surface, the adapter's permission mapping shall expose canonical `WritablePathsPermissionMapping` paths with `enforcement: 'ambient'` and shall preserve the existing permission-mode and `canUseTool` mapping [[claude-code-4](#claude-code-4)].

### claude-code-226

Where an effort value is valid for the adapter but unavailable to the selected model, account, or installed runtime, when the backend rejects the run, the adapter stream shall expose that upstream failure through its normal error path without substituting another effort [[claude-code-8](#claude-code-8)].

### claude-code-229

Where either tool-list field is explicitly provided, when the adapter runs, it shall close the provider tool surface to the effective list [[claude-code-9](#claude-code-9)]:

| Supplied tool lists | Observable SDK options |
| --- | --- |
| an explicit empty `allowedTools` | `tools: []`, `allowedTools: []`, `settingSources: []`, and `strictMcpConfig: true` |
| a non-empty allowlist with disallowed identifiers | the provider tool registry closed to the effective allowlist, deny precedence preserved, and ambient MCP additions rejected |

### claude-code-238

_Superseded by [[claude-code-240](#claude-code-240)]._

Given the adapter emits a terminal `done` with complete upstream accounting, when a caller reads `usage.breakdown`, the adapter shall publish the input side alone, a cache component the runtime omitted being absent while the remaining members of the published side still sum to their aggregate [[claude-code-3](#claude-code-3)].

### claude-code-239

_Superseded by [[claude-code-240](#claude-code-240)]._

Given the adapter emits a terminal `done` with complete upstream accounting, when a caller reads `usage.records`, the adapter shall publish one record per model in its per-model accounting [[claude-code-11](#claude-code-11)]:

- each record is keyed by the canonical model identifier;
- a record carries the group's own cost where the runtime reports one, and the costs of a run's records shall not exceed the run's reported total.

### claude-code-240

Given authentic zero or nonzero accounting from the adapter, when a caller reads terminal `usage.tokens`, the report shall carry inclusive input and output totals, exact reported cache/reasoning subsets, and no removed flat fields or availability placeholder [[claude-code-12](#claude-code-12)]:

- the report shall publish complete whole-agent-tree totals and one record per model from `modelUsage`, including inclusive output;
- valid whole-run and per-model cost shall be preserved as `agent-estimate`, the emitted whole-run and record values being finite, non-negative USD objects, a measured zero remaining present and a missing cost remaining absent;
- malformed or absent `modelUsage` shall omit `tokens` while preserving independently observed `toolUses`, and shall not promote main-loop usage.

## References

[1]: https://platform.claude.com/docs/en/build-with-claude/effort "Claude effort parameter"
[2]: https://code.claude.com/docs/en/workflows#let-claude-decide-with-ultracode "Claude Code workflows: let Claude decide with ultracode"
[3]: https://code.claude.com/docs/en/agent-sdk/cost-tracking "Claude Code cost and usage tracking"
