<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# GEMINI: Gemini CLI Adapter

## Intent

This component defines the Gemini CLI adapter via child process spawn and NDJSON parsing per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md).

## Adapter Identity

### GEMINI-001

The adapter shall implement `AgentAdapter` with `agent: 'gemini'`; it has no SDK dependency.

## Availability

### GEMINI-002

`isAvailable()` shall probe for the `gemini` CLI on PATH via a spawn-based check with a timeout.

## Process Lifecycle

### GEMINI-003

`run()` shall spawn `gemini --output-format stream-json <prompt>` and pipe stdout through `parseNDJSON()` per [NDJSON-001](../ndjson.md#ndjson-001).

## Environment

### GEMINI-010

The adapter shall set `GEMINI_CLI_TRUST_WORKSPACE=true` in the spawned Gemini CLI environment by default for headless runs. When `process.env.GEMINI_CLI_TRUST_WORKSPACE` is already set, the adapter shall pass that value through unchanged.

## Event Normalization

### GEMINI-004

The adapter shall normalize NDJSON objects to `AgentEvent` types:

| NDJSON Event | AgentEvent |
| --- | --- |
| `init` | `init` (model, cwd, tools) |
| `message` | `text` |
| `tool_use` | `tool_use` |
| `tool_result` | `tool_result` |
| `error` | `error` |
| `result` | `done` (usage, status) |

When `parseNDJSON()` yields `{ ok: false }`, the adapter shall emit an `error` event with `recoverable: true`.

### GEMINI-005

The adapter shall map process exit codes to `done` status:

| Exit Code | Done Status |
| --- | --- |
| `0` | `'success'` |
| `1` | `'error'` |
| `42` | `'error'` |
| `53` | `'max_turns'` |

## Permission Mapping

### GEMINI-006

The adapter shall map `PermissionPolicy` to Gemini CLI tool controls per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm): `'allow'` capabilities via `--allowed-tools` flag; `'deny'` capabilities via `tools.exclude` in settings or policy rules. `allowedTools`/`disallowedTools` from options shall map to `tools.core`/`tools.exclude`.
When `PermissionPolicy.writablePaths` is non-empty and Gemini sandboxing is not independently active through a selected adapter surface, the adapter shall accept valid entries, expose `WritablePathsPermissionMapping` with `enforcement: 'ambient'` and canonical `paths`, and keep the existing tool-control and approval-mode mapping unchanged.

## Options Mapping

### GEMINI-007

The adapter shall map `AgentOptions` fields to CLI flags: `model` → `--model`, `maxTurns` → `--max-session-turns`, `resume` → `--resume`.

### GEMINI-011

The adapter shall map `AgentOptions.reasoningEffort` (per [ENG-020](../engine.md#eng-020)) to a per-run Gemini CLI settings override only when `AgentOptions.model` names a concrete Gemini model ID whose thinking surface is known per [[1]] and [[2]].
For `model` values matching `^gemini-3`, the override shall create a self-contained custom alias under `modelConfigs.customAliases.<cligent-alias>.modelConfig` with `model` set to the original `AgentOptions.model` value and `generateContentConfig.thinkingConfig.thinkingLevel` set per the Gemini 3 table below; the spawned CLI shall target that custom alias via `--model`.
For `model` values matching `^gemini-2\.5`, the override shall create the same self-contained alias shape and set `generateContentConfig.thinkingConfig.thinkingBudget` per the Gemini 2.5 table below; the spawned CLI shall target that custom alias via `--model`.
When `AgentOptions.model` is unset, is a Gemini CLI alias such as `pro`, `flash`, `flash-lite`, `auto`, or `chat-base*`, or is any other non-matching value, the adapter shall not write the custom alias and shall preserve its existing model forwarding behavior: pass `--model <AgentOptions.model>` when the field is set, and pass no `--model` flag when it is unset.
In those skip cases, `reasoningEffort` shall be silently ignored for that call.

Gemini 3 mapping:

| `reasoningEffort` | `thinkingLevel` |
| --- | --- |
| `minimal` | `MINIMAL` |
| `low` | `LOW` |
| `medium` | `MEDIUM` |
| `high` | `HIGH` |
| `xhigh` | `HIGH` |
| `max` | `HIGH` |

Gemini 3 exposes four thinking levels; `xhigh` and `max` collapse to `HIGH` per [ENG-020](../engine.md#eng-020)'s nearest-neighbour rule.

Gemini 2.5 mapping:

| `reasoningEffort` | `thinkingBudget` |
| --- | --- |
| `minimal` | `1024` |
| `low` | `4096` |
| `medium` | `8192` |
| `high` | `16384` |
| `xhigh` | `24576` |
| `max` | `32768` for `gemini-2.5-pro*`; `24576` for `gemini-2.5-flash*` and `gemini-2.5-flash-lite*` |

The Gemini 2.5 ladder shall stay within each supported model family's documented bounds: Pro `128..32768`, Flash `0..24576`, and Flash Lite `512..24576` per [[1]].
`max` maps to the model family's upper bound rather than Google's dynamic-thinking sentinel because [ENG-020](../engine.md#eng-020) defines `max` as the greatest reasoning depth.
For Flash and Flash Lite, `xhigh` and `max` both map to `24576`, the nearest supported ceiling.

## Abort Handling

### GEMINI-008

When `AbortSignal` fires, the adapter shall send `SIGTERM` to the spawned process. When the process exits after SIGTERM, the adapter shall yield `done` (`status: 'interrupted'`).

## Resume Token

### GEMINI-009

When the Gemini CLI stream provides a session identifier before terminal `done`, the adapter shall set `DonePayload.resumeToken` to that value, enabling `Cligent` auto-resume via `--resume` per [DR-003](../../decisions/003-role-scoped-session-management.md#session-continuity-via-resume-token).
When an abort causes terminal `done` with `status: 'interrupted'`, the adapter shall preserve continuity by setting `DonePayload.resumeToken` to the first available value in this order: the Gemini-provided session identifier observed before the abort; otherwise the non-empty `AgentOptions.resume` value passed into the run; otherwise no `resumeToken`.
When terminal `done` is not interrupted and no session identifier was received, the adapter shall omit `resumeToken`.

## References

[1]: https://ai.google.dev/gemini-api/docs/thinking "Gemini API: Thinking"
[2]: https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md "Google Gemini CLI: Configuration reference"
