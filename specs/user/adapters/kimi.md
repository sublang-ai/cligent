<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# KIMI: Kimi Code Adapter

## Intent

This component defines the Kimi Code adapter over the CLI's ACP stdio mode per [DR-011](../../decisions/011-kimi-code-acp-integration.md).

## Adapter Identity

### KIMI-001

The adapter shall expose `KimiAdapter`, implement `AgentAdapter<KimiEffort>`, and use `agent: 'kimi'` for the maintained Kimi Code product [[1]].

## Availability

### KIMI-002

`isAvailable()` shall probe the documented `kimi --version` command on PATH with a timeout [[3]].
It shall not start ACP, authenticate, or mutate Kimi configuration.
A successful zero exit shall return `true`; a missing executable, nonzero exit, or timeout shall return `false`.

## ACP Lifecycle

### KIMI-003

Each `run()` call shall create fresh local state and spawn exactly one `kimi acp` child with `shell: false`, the effective working directory, inherited environment, piped stdin/stdout, and drained stderr.
The adapter shall initialize ACP protocol version 1 with empty client capabilities and shall not advertise filesystem or terminal reverse-RPC support per [[2]][[6]].
The adapter shall use the official `@agentclientprotocol/sdk` version compatible with the exact Kimi Code conformance target.

### KIMI-004

After initialization, a fresh run shall call `session/new` with the absolute effective cwd and no client-supplied MCP servers.
A run with a non-empty `AgentOptions.resume` shall call `session/resume` with that token and cwd; it shall not call `session/load` or replay prior history.
After session setup and supported configuration overrides, the adapter shall emit `init` first and call `session/prompt` with one text content block.
The `init` event shall carry the Kimi session identifier, effective cwd, requested or ACP-reported model, an unknown tool surface represented by `tools: []`, and capabilities that distinguish unknown tools from a configured empty set.

## Event Normalization

### KIMI-005

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
Kimi Code's ACP 0.23 surface exposes no stable per-turn usage totals, so absent usage fields shall normalize to zero input and output tokens while tool uses shall equal the emitted tool calls.

### KIMI-006

ACP stop reason `end_turn` shall map to `done.status: 'success'`; `cancelled` shall map to `'interrupted'`; `max_tokens` and `max_turn_requests` shall map to `'max_turns'`; and `refusal` shall emit a non-recoverable error followed by `done.status: 'error'`.
Structured JSON-RPC errors, malformed protocol traffic, premature or nonzero child exits, and missing authentication shall emit an actionable non-recoverable error followed by `done.status: 'error'`.
Kimi Code `0.27.0` ACP session creation requires the OAuth credential written by `kimi login`; a configured API-key provider does not independently satisfy that ACP authentication gate [[8]].
Authentication guidance shall name `kimi login`; the adapter shall never launch login itself.

## Permission Mapping

### KIMI-007

Where `PermissionPolicy` is absent, the adapter shall set no ACP mode and preserve Kimi's native permission configuration.
Where `PermissionPolicy.mode` is `'auto'`, the adapter shall set ACP config option `mode` to `auto`; per-capability fields in the same policy are superseded by the whole-mode selection per [ENG-021](../engine.md#eng-021).
Where mode is `'bypass'`, the adapter shall reject before spawn because Kimi's `yolo` mode is not an unchecked bypass per [DR-011](../../decisions/011-kimi-code-acp-integration.md).
Where a policy is provided with mode omitted, including an empty policy, the adapter shall reject before spawn because ACP cannot deterministically impose Cligent's default-ask capability policy over Kimi's earlier native rule decisions.
This limitation follows Kimi's configured permission-rule evaluation, which may decide operations before an ACP permission request is exposed [[4]].
Any permission request that still reaches the headless ACP client shall emit `permission_request` and select a reject option; if no reject option exists or the run is aborted, it shall return a cancelled outcome.
Where Kimi plan review exposes both `Revise` and `Reject and Exit` as reject-once choices, the adapter shall select the terminal `Reject and Exit` choice [[7]].

### KIMI-008

Where a supported `mode: 'auto'` policy contains non-empty `writablePaths`, the adapter shall validate and canonicalize them per [ENG-022](../engine.md#eng-022), report `WritablePathsPermissionMapping` with `enforcement: 'ambient'`, and shall not advertise a filesystem sandbox or ACP filesystem capabilities.
Invalid paths shall fail before spawn.

## Options Mapping

### KIMI-009

The adapter shall apply a provided `AgentOptions.model` through ACP config option `model` after session setup and before the thinking option.
`KimiEffort` shall be the provider-native union `'off' | 'on'` per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md).
The adapter shall map it exactly through ACP config option `thinking`; `on` selects the chosen model's native default thinking effort rather than a Cligent portable tier per [[5]].
When effort is omitted, the adapter shall set no thinking override.
Where a dynamic caller supplies any other effort value, the adapter shall reject it before spawn with the metadata-backed allowed-values error from [ENG-024](../engine.md#eng-024).

### KIMI-010

Where `allowedTools` or `disallowedTools` is explicitly provided, including an empty array, the adapter shall reject before spawn because the ACP surface exposes no exact tool-registry restriction.
Where `maxTurns` or `maxBudgetUsd` is explicitly provided, the adapter shall reject before spawn because Kimi ACP exposes no compatible per-run control.

## Abort and Cleanup

### KIMI-011

When `AbortSignal` fires after session setup, the adapter shall send `session/cancel`, continue draining the prompt response and queued updates when possible, and yield exactly one `done` with `status: 'interrupted'` before terminating the child.
When abort occurs before session setup completes, the adapter shall terminate the child and still yield exactly one interrupted `done`.
Cleanup shall remove abort listeners, close protocol resources, drain or terminate the per-run process, and shall not retain mutable session state on the adapter instance.
After a terminal prompt response, adapter-initiated `SIGTERM` following a bounded stdin-close grace shall not change an otherwise successful run to an error; cleanup that requires `SIGKILL` shall remain an error.

## Resume Token

### KIMI-012

The adapter shall use the backend session identifier returned by `session/new` or the resumed identifier as every event's `sessionId` once known and as `DonePayload.resumeToken`.
When abort or failure occurs before a backend identifier is observed, it shall preserve a non-empty inbound `AgentOptions.resume` token and shall otherwise omit `resumeToken`; a locally generated correlation identifier shall never be exposed as resumable.

## References

[1]: https://github.com/MoonshotAI/kimi-code "MoonshotAI Kimi Code"
[2]: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html "Kimi Code ACP reference"
[3]: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command "Kimi Code command reference"
[4]: https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files "Kimi Code configuration"
[5]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/config-options.ts "Kimi Code ACP configuration options"
[6]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/kaos-acp.ts "Kimi Code ACP filesystem bridge"
[7]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/approval.ts "Kimi Code ACP permission options"
[8]: https://github.com/MoonshotAI/kimi-code/blob/5cc194956f6f9752d172aa4994385d2d2e7a066f/packages/acp-adapter/src/server.ts#L107-L116 "Kimi Code 0.27 ACP authentication gate"
