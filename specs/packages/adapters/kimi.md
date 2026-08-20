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

The adapter shall expose `KimiAdapter`, implement `AgentAdapter<KimiEffort>`, and use `agent: 'kimi'` for the maintained Kimi Code product [[1]].

### Availability

### kimi-2

`isAvailable()` shall probe the documented `kimi --version` command on PATH with a timeout [[3]].
It shall not start ACP, authenticate, or mutate Kimi configuration.
A successful zero exit shall return `true`; a missing executable, nonzero exit, or timeout shall return `false`.

### ACP Lifecycle

### kimi-3

Each `run()` call shall create fresh local state and spawn exactly one `kimi acp` child with `shell: false`, the effective working directory, inherited environment, piped stdin/stdout, and drained stderr.
The adapter shall initialize ACP protocol version 1 with empty client capabilities and shall not advertise filesystem or terminal reverse-RPC support per [[2]][[6]].
The adapter shall use the official `@agentclientprotocol/sdk` version compatible with the exact Kimi Code conformance target.

### kimi-4

After initialization, a fresh run shall call `session/new` with the absolute effective cwd and no client-supplied MCP servers.
A run with a non-empty `AgentOptions.resume` shall call `session/resume` with that token and cwd; it shall not call `session/load` or replay prior history.
After session setup and supported configuration overrides, the adapter shall emit `init` first and call `session/prompt` with one text content block.
The `init` event shall carry the Kimi session identifier, effective cwd, requested or ACP-reported model, an unknown tool surface represented by `tools: []`, and capabilities that distinguish unknown tools from a configured empty set.

### Event Normalization

### kimi-5

The adapter shall normalize ACP traffic to `AgentEvent` values:

| ACP traffic | AgentEvent |
| --- | --- |
| `session/update` `agent_message_chunk` text | `text_delta` |
| `session/update` `agent_thought_chunk` | ignored; raw thought is not a safe summary |
| `session/update` `tool_call` plus non-terminal updates | one correlated `tool_use` once canonical input is available |
| terminal `tool_call_update` | one correlated `tool_result` with `success` or `error` |
| `session/update` `plan` | `kimi:plan` extension |
| `session/request_permission` | `permission_request`, followed by a reject response |
| prompt response / ACP failure / child exit | exactly one terminal `done`, with a preceding `error` where applicable |

Tool state shall be keyed by ACP `toolCallId` and shall tolerate a pending lazy-create notification whose parsed `rawInput` arrives in a later update.
The adapter shall use the best structured `rawInput` available and shall not emit duplicate `tool_use` or terminal `tool_result` events for one call.
Assistant text deltas shall be accumulated in order for `DonePayload.result`.

_The following hypothetical ACP-usage behavior is superseded by [[kimi-13](#kimi-13)]._

When the ACP prompt response supplies schema-valid unsigned-integer usage, including explicit zeroes for required `totalTokens`, `inputTokens`, and `outputTokens` and for any present optional cache counter, the adapter shall mark token accounting as `'reported'`, shall fold `cachedReadTokens` and `cachedWriteTokens` into `inputTokens`, and shall preserve `outputTokens`.
Where required usage structure or any consumed token or cache counter is negative, fractional, non-finite, or non-numeric, the adapter shall isolate the optional accounting failure: the prompt's schema-valid `stopReason` shall still determine terminal status, token accounting shall be `'unavailable'`, and accumulated result text and tool use shall remain intact.
Unconsumed usage extension details such as `thoughtTokens` shall not affect availability, and a null optional cache counter shall be treated as absent.
When ACP omits usage, the adapter shall mark token accounting as `'unavailable'` and retain zero-valued compatibility placeholders rather than reporting measured zero or estimating tokens.
In either state, `toolUses` shall equal the emitted tool calls independently of token accounting.
The adapter shall publish no `DoneUsage.breakdown` partition per [[engine-28](../engine.md#engine-28)], because ACP's `Usage` structure is an unstable protocol extension that the conformance-target Kimi Code release does not populate, leaving nothing measured to decompose.
The fold of `cachedReadTokens` and `cachedWriteTokens` into `inputTokens` reflects the agent's own cache-exclusive convention rather than a guarantee ACP makes about the field, so the adapter shall confine that fold to this ACP agent and shall not treat it as a portable ACP rule.

### kimi-6

ACP stop reason `end_turn` shall map to `done.status: 'success'`; `cancelled` shall map to `'interrupted'`; `max_tokens` and `max_turn_requests` shall map to `'max_turns'`; and `refusal` shall emit a non-recoverable error followed by `done.status: 'error'`.
Structured JSON-RPC errors, malformed control protocol traffic outside [[kimi-5](#kimi-5)]'s failure-isolated optional usage, premature or nonzero child exits, and missing authentication shall emit an actionable non-recoverable error followed by `done.status: 'error'`.
Kimi Code `0.31.1` gates ACP session creation on any of three routes: the OAuth credential written by `kimi login`; a configured default model whose alias resolves to a provider holding non-OAuth credentials; or the `KIMI_MODEL_NAME` plus `KIMI_MODEL_API_KEY` environment overlay, which synthesizes a provider and alias in the runtime configuration only and makes it the default model [[8]].
A bare provider key such as `MOONSHOT_API_KEY` or `KIMI_API_KEY` satisfies none of them, because it establishes no default model alias.
Authentication guidance shall name `kimi login`; the adapter shall never launch login itself.

### Permission Mapping

### kimi-7

Where `PermissionPolicy` is absent, the adapter shall set no ACP mode and preserve Kimi's native permission configuration.
Where `PermissionPolicy.mode` is `'auto'`, the adapter shall set ACP config option `mode` to `auto`; per-capability fields in the same policy are superseded by the whole-mode selection per [[engine-21](../engine.md#engine-21)].
Where mode is `'bypass'`, the adapter shall reject before spawn because Kimi's `yolo` mode is not an unchecked bypass per [DR-011](../../decisions/011-kimi-code-acp-integration.md).
Where a policy is provided with mode omitted, including an empty policy, the adapter shall reject before spawn because ACP cannot deterministically impose Cligent's default-ask capability policy over Kimi's earlier native rule decisions.
This limitation follows Kimi's configured permission-rule evaluation, which may decide operations before an ACP permission request is exposed [[4]].
Any permission request that still reaches the headless ACP client shall emit `permission_request` and select a reject option; if no reject option exists or the run is aborted, it shall return a cancelled outcome.
Where Kimi plan review exposes both `Revise` and `Reject and Exit` as reject-once choices, the adapter shall select the terminal `Reject and Exit` choice [[7]].

### kimi-8

Where a supported `mode: 'auto'` policy contains non-empty `writablePaths`, the adapter shall validate and canonicalize them per [[engine-22](../engine.md#engine-22)], report `WritablePathsPermissionMapping` with `enforcement: 'ambient'`, and shall not advertise a filesystem sandbox or ACP filesystem capabilities.
Invalid paths shall fail before spawn.

### Options Mapping

### kimi-9

The adapter shall apply a provided `AgentOptions.model` through ACP config option `model` after session setup and before the thinking option.
`KimiEffort` shall be the provider-native union `'off' | 'on'` per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md).
The adapter shall map it exactly through ACP config option `thinking`; `on` selects the chosen model's native default thinking effort rather than a Cligent portable tier per [[5]].
When effort is omitted, the adapter shall set no thinking override.
Where a dynamic caller supplies any other effort value, the adapter shall reject it before spawn with the metadata-backed allowed-values error from [[engine-24](../engine.md#engine-24)].

### kimi-10

Where `allowedTools` or `disallowedTools` is explicitly provided, including an empty array, the adapter shall reject before spawn because the ACP surface exposes no exact tool-registry restriction.
Where `maxTurns` or `maxBudgetUsd` is explicitly provided, the adapter shall reject before spawn because Kimi ACP exposes no compatible per-run control.

### Abort and Cleanup

### kimi-11

When `AbortSignal` fires after session setup, the adapter shall send `session/cancel`, continue draining the prompt response and queued updates when possible, and yield exactly one `done` with `status: 'interrupted'` before terminating the child.
When abort occurs before session setup completes, the adapter shall terminate the child and still yield exactly one interrupted `done`.
Cleanup shall remove abort listeners, close protocol resources, drain or terminate the per-run process, and shall not retain mutable session state on the adapter instance.
After a terminal prompt response, adapter-initiated `SIGTERM` following a bounded stdin-close grace shall not change an otherwise successful run to an error; cleanup that requires `SIGKILL` shall remain an error.

### Resume Token

### kimi-12

The adapter shall use the backend session identifier returned by `session/new` or the resumed identifier as every event's `sessionId` once known and as `DonePayload.resumeToken`.
When abort or failure occurs before a backend identifier is observed, it shall preserve a non-empty inbound `AgentOptions.resume` token and shall otherwise omit `resumeToken`; a locally generated correlation identifier shall never be exposed as resumable.

### Token Accounting

### kimi-13

The adapter shall publish no [[engine-31](../engine.md#engine-31)] token or cost report for the pinned Kimi Code runtime, because its supported ACP prompt response supplies neither [[9]] and [DR-011](../../decisions/011-kimi-code-acp-integration.md) forbids reading private Kimi session state outside ACP.
An absent report shall replace the former zero-valued availability placeholder and shall not change the prompt stop status, accumulated result, or independently observed `toolUses`.
The adapter may retain schema validation for a future ACP usage extension, but shall not promote that unstable shape to cost-grade public accounting until a supported runtime emits it and its turn/session and cache/reasoning semantics are verified.

## Verification

### kimi-201

Given canned native ACP traffic, when the adapter runs, the yielded `AgentEvent` types shall match its normalization table [[kimi-5](#kimi-5)], its one terminal `done` carrying the status its stop reason maps to [[kimi-6](#kimi-6)].

### kimi-202

Where an application configuration selects a representative effort value for this adapter, when the runtime constructs and invokes the corresponding `Cligent`, the binary ACP thinking setting shall be selected exactly, `on` preserving model forwarding and selecting that model's default thinking effort [[kimi-9](#kimi-9)].

### kimi-203

When `AbortSignal` fires during the adapter's `run()`, the adapter shall yield `done` with `status: 'interrupted'` [[kimi-11](#kimi-11)].

### kimi-204

Given all `PermissionLevel` combinations, the adapter shall map `PermissionPolicy` to the correct vendor-specific controls [[kimi-7](#kimi-7)].

### kimi-218

Where each Kimi-specific effort value is supplied, when the adapter maps a run, the observable provider control shall be the ACP `thinking` option selected exactly, `on` taking the chosen model's native default effort [[kimi-9](#kimi-9)]:

- when effort is omitted, the adapter shall set no thinking override;
- where the supplied value belongs to another built-in adapter or is an arbitrary unknown string, the adapter shall reject it before spawn with an error naming the adapter and its allowed values.

### kimi-219

Where a `Cligent` is constructed on the adapter with `CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first to create and then to update a temporary file in a throwaway working directory, the adapter's auto-mode ACP mode per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) shall let both non-destructive writes proceed without interactive approval [[kimi-7](#kimi-7)]:

- the file shall exist with the expected contents after each phase;
- neither stream shall contain `permission_request`, a denied tool result, or an error;
- each stream shall terminate with successful `done`;
- filesystem state shall be the ground-truth assertion, because adapters normalize file edits differently;
- the harness shall retry the complete fresh probe after, and only after, an explicit upstream-overload, rate-limit, or service-unavailable failure, shall make at most two retries, and shall treat any other failure and the third consecutive named transient failure as fatal;
- the leg shall self-skip when the `kimi` CLI the adapter spawns is absent from `PATH` or its credential is absent, shall hard-fail instead under `CI`, and a missing dependency for one adapter shall never skip another's leg;
- Kimi Code `0.31.1` admits a prior interactive OAuth `kimi login`, a configured default model resolving to a provider with non-OAuth credentials, or the `KIMI_MODEL_NAME` plus `KIMI_MODEL_API_KEY` environment overlay, while a bare `MOONSHOT_API_KEY` satisfies none of them;
- the harness exercises the OAuth route exclusively, so its credential probe shall run with the `KIMI_MODEL_*` overlay removed exactly as the live legs do, inheriting it being what would let an environment-configured model report a spent OAuth credential as usable and make those legs fail instead of self-skipping;
- because Kimi rotates its refresh token on every refresh and persists the replacement into the refreshing home, a credential restored from an immutable CI secret is single-use;
- the harness shall therefore probe credential usability once, before any Kimi leg runs and against the same shared clone the suite will use, and shall distinguish two conditions: an absent fixture or CLI remains a hard failure under `CI`, while a present-but-spent credential shall self-skip every live Kimi leg — the composite fanout included — with a precise reason, under `CI` as well, because no runner configuration can supply a fresh token and a failure there would not indicate a defect in the behavior under test;
- the credential-free ACP initialization conformance check shall remain mandatory in `CI` regardless, so a protocol-surface regression still fails the build;
- locally, the Kimi source home shall resolve in order from `CLIGENT_KIMI_ACCEPTANCE_HOME`, an absolute `KIMI_CODE_HOME`, or the documented `~/.kimi-code` default, and the Kimi CLI shall resolve from `PATH` or that source home's managed `bin` directory;
- under `CI`, `CLIGENT_KIMI_ACCEPTANCE_HOME` shall name an absolute, dedicated source home containing regular files at `config.toml` and `credentials/kimi-code.json`, missing or invalid Kimi credentials or CLI failing like every other adapter dependency;
- the harness shall dereference and copy only the source config and credentials into one temporary `KIMI_CODE_HOME`, harden the copied config, credential files, and directories to owner-only permissions, share that clone across the complete acceptance suite including bounded retries and fanout, restore the caller's environment and PATH around each consumer, and remove the temporary home after the suite, without mutating the source;
- acceptance files shall run serially so the shared clone has one writer, and an absent or invalid automatically discovered local source shall self-skip with a precise reason;
- a dedicated CI source is disposable, and a local source may require `kimi login` again, because an OAuth refresh against the clone may leave its prior token stale.

### kimi-230

Given a fake ACP subprocess with protocol traffic split across arbitrary stdio chunks, when the adapter runs fresh and resumed prompts, every stage of its ACP lifecycle shall behave as its items require [[kimi-3](#kimi-3)], [[kimi-4](#kimi-4)]:

- initialization shall advertise empty client capabilities, and the run shall select `session/new` or `session/resume` and apply model before thinking and mode configuration [[kimi-9](#kimi-9)];
- `init` shall be emitted before normalized text, tool, plan, and permission events, and raw thought chunks shall be suppressed [[kimi-5](#kimi-5)];
- reverse permission requests shall be rejected [[kimi-7](#kimi-7)];
- every prompt stop reason shall map to its terminal status [[kimi-6](#kimi-6)];
- the correct resume token shall be preserved [[kimi-12](#kimi-12)], and the per-run child shall terminate exactly once [[kimi-11](#kimi-11)];
- the adapter identity shall be `kimi`, and availability probing shall invoke `kimi --version` without starting ACP or authentication [[kimi-1](#kimi-1)], [[kimi-2](#kimi-2)];
- where abort occurs before and after session setup, the adapter shall cancel or terminate as appropriate and emit exactly one interrupted `done` without state leakage [[kimi-11](#kimi-11)];
- where authentication, protocol, or child-process failure occurs, the stream shall emit an actionable error and error `done` without starting login [[kimi-6](#kimi-6)];
- where permissions, tool lists, turn or budget limits, or effort values are unsupported, validation shall fail before the spawn seam is invoked [[kimi-7](#kimi-7)], [[kimi-10](#kimi-10)].

### kimi-220

Given the adapter has been aborted, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall report the resume token each observed state requires [[kimi-12](#kimi-12)]:

| Observed before abort | `DonePayload.resumeToken` |
| --- | --- |
| a backend session identifier observed during the run | the observed backend identifier |
| no backend identifier and a non-empty `AgentOptions.resume` value | the inbound `resume` value |
| no backend identifier and no non-empty inbound `resume` value | omitted |

### kimi-222

Given a supported `mode: 'auto'` `PermissionPolicy` whose `writablePaths` contains valid entries and no independently active filesystem-sandbox write-grant surface, the adapter's permission mapping shall expose canonical `WritablePathsPermissionMapping` paths with `enforcement: 'ambient'` and shall preserve the existing permission and tool mapping [[kimi-8](#kimi-8)].

### kimi-226

Where an effort value is valid for the adapter but unavailable to the selected model, account, or installed runtime, when the backend rejects the run, the adapter stream shall expose that upstream failure through its normal error path without substituting another effort [[kimi-9](#kimi-9)].

### kimi-229

Where either tool-list field is explicitly provided, including an empty array, when the adapter runs, it shall reject before spawning `kimi acp` [[kimi-10](#kimi-10)].

### kimi-233

_Superseded for usage shape by [[kimi-240](#kimi-240)]._

Given a prompt with a valid stop reason but malformed optional usage, when the adapter emits terminal `done`, the stop reason shall still determine status while token accounting is `'unavailable'` [[kimi-5](#kimi-5)]:

- accumulated result text and tool use shall remain intact, and an unconsumed malformed thought detail or null optional cache detail shall not poison otherwise complete accounting;
- given a required token or cache counter is absent, or any present mapped counter is negative, fractional, non-finite, or non-numeric, accounting shall be `'unavailable'`, an absent optional cache counter alone retaining zero contribution;
- given upstream omits complete accounting, or the adapter synthesizes an errored, interrupted, exhausted, or other terminal path, accounting shall be `'unavailable'` and no token estimate shall be introduced;
- `usage.toolUses` shall preserve the greatest independently known count even when token accounting is unavailable.

### kimi-238

_Superseded by [[kimi-240](#kimi-240)]._

Given the adapter emits a terminal `done` with complete upstream accounting, when a caller reads `usage.breakdown`, the adapter shall publish none [[kimi-5](#kimi-5)].

### kimi-240

Given authentic accounting is sought from the adapter, when a caller reads terminal `usage.tokens`, the adapter shall publish no token or cost report for the pinned ACP runtime [[kimi-13](#kimi-13)]:

- a synthetic unstable usage extension appearing in the prompt response shall not promote that shape to a report;
- tool calls and the prompt stop status shall be retained regardless.

## References

[1]: https://github.com/MoonshotAI/kimi-code "MoonshotAI Kimi Code"
[2]: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html "Kimi Code ACP reference"
[3]: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command "Kimi Code command reference"
[4]: https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files "Kimi Code configuration"
[5]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/config-options.ts "Kimi Code ACP configuration options"
[6]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/kaos-acp.ts "Kimi Code ACP filesystem bridge"
[7]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/approval.ts "Kimi Code ACP permission options"
[8]: https://github.com/MoonshotAI/kimi-code/blob/5cc194956f6f9752d172aa4994385d2d2e7a066f/packages/acp-adapter/src/server.ts#L107-L116 "Kimi Code ACP authentication gate"
[9]: https://github.com/MoonshotAI/kimi-code/blob/6b56c11697771fe596099b38bafae539820309a4/packages/acp-adapter/src/session.ts#L1228-L1273 "Kimi Code 0.31.1 ACP prompt response"
