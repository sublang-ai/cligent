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

`run()` shall spawn Gemini CLI in non-interactive mode with `gemini --output-format stream-json --prompt=<prompt>` and pipe stdout through `parseNDJSON()` per [NDJSON-001](../ndjson.md#ndjson-001) and [[4]].
The adapter shall keep the option and arbitrary prompt in one argv token so Gemini CLI 0.50 treats the value as a headless prompt and does not reparse a leading-dash prompt as an option.

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

Where `PermissionPolicy` is provided with `mode` omitted, or `allowedTools` or `disallowedTools` is provided, the adapter shall map the supplied capability and tool-list restrictions to non-interactive User-tier Gemini Policy Engine rules per [[3]] and the following table:

| Input | Policy outcome |
| --- | --- |
| capability `allow` | `decision = "allow"` for that capability's current built-in tools |
| capability `ask` or omitted inside a provided policy | `decision = "ask_user"`, which denies in headless mode |
| capability `deny` | `decision = "deny"` |
| explicit `allowedTools` | priority-999 allows for effective listed tools plus a priority-998 catch-all deny, including when the effective list is empty |
| explicit `disallowedTools` | deny rules that take precedence over allows |

The capability tools shall be file writes `replace` and `write_file`, shell execution `run_shell_command`, and network access `google_web_search` and `web_fetch`.
Capability-level allows shall not widen an explicit allowlist.
When `PermissionPolicy.mode` is `'auto'` or `'bypass'`, the existing approval-mode mapping shall take precedence over per-capability fields per [ENG-021](../engine.md#eng-021); independently supplied tool lists may still generate policy rules.
Where mapping generates at least one rule, the adapter shall write a per-run User-tier policy file and pass it through `--policy`; otherwise it shall generate no policy file or flag.
The adapter runtime shall emit neither deprecated `--allowed-tools` nor deprecated `tools.exclude`; compatibility-only exported settings helpers may retain their historical return shape but shall not drive `run()`.
When `PermissionPolicy.writablePaths` is non-empty per [ENG-022](../engine.md#eng-022) and Gemini sandboxing is not independently active through a selected adapter surface, the adapter shall accept valid entries, expose `WritablePathsPermissionMapping` per [ENG-023](../engine.md#eng-023) with `enforcement: 'ambient'` and canonical `paths`, and keep the existing tool-control and approval-mode mapping unchanged.

### GEMINI-012

Where `PermissionPolicy`, `allowedTools`, and `disallowedTools` are all absent, the adapter shall generate no policy and pass no `--policy`, leaving Gemini's native defaults and discovered user policies in effect.
A provided empty `PermissionPolicy` shall remain distinct and shall generate `ask_user` rules for its omitted default-ask capabilities.

### GEMINI-013

Where a user-provided tool name contains Gemini Policy Engine wildcard syntax `*` or an unpaired Unicode surrogate, the adapter shall reject it before spawn with an error naming the offending option index.
For other accepted names, the adapter shall serialize a valid TOML basic string, including escaping DEL (`U+007F`).

### GEMINI-014

Where the adapter generates a policy file, every rule shall carry `interactive = false`, the file shall be removed after the run, and installed Admin-tier policies shall retain authority.
Permission mapping shall not redirect Gemini's system settings or system-defaults paths.

## Options Mapping

### GEMINI-007

The adapter shall map `AgentOptions.model` to `--model=<model>` and a non-empty `AgentOptions.resume` to `--resume=<token>`, keeping each value in the same argv token as its option so leading dashes are not reinterpreted.
Where Gemini CLI exposes no compatible turn-limit flag, the adapter shall ignore `AgentOptions.maxTurns` and shall not pass the unsupported `--max-session-turns` flag.

### GEMINI-011

Per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), where a portable `AgentOptions.effort` is provided, the adapter shall select its per-run Gemini settings behavior from this model-condition table per [[1]] and [[2]]:

| Model condition | Outcome |
| --- | --- |
| concrete ID matching `^gemini-3` | unique self-contained alias with the original model and mapped `thinkingLevel` |
| concrete ID matching `^gemini-2\.5` | unique self-contained alias with the original model and mapped `thinkingBudget` |
| model unset, a CLI alias such as `auto`, `pro`, `flash`, `flash-lite`, or `chat-base*`, or another non-matching value | no effort alias; preserve ordinary model forwarding and ignore effort for that call |

The generated alias shall be merged into a temporary copy of configured system defaults selected through `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, preserving pre-existing defaults and leaving `GEMINI_CLI_SYSTEM_SETTINGS_PATH` unchanged so system overrides, Admin policy, user settings, and project settings retain authority.
The temporary defaults file shall be removed after the run.

Gemini 3 mapping:

| `AgentOptions.effort` | `thinkingLevel` |
| --- | --- |
| `minimal` | `MINIMAL` |
| `low` | `LOW` |
| `medium` | `MEDIUM` |
| `high` | `HIGH` |
| `xhigh` | `HIGH` |
| `max` | `HIGH` |

Gemini 3 exposes four thinking levels; `xhigh` and `max` collapse to `HIGH` per [ENG-020](../engine.md#eng-020)'s nearest-neighbour rule.

Gemini 2.5 mapping:

| `AgentOptions.effort` | `thinkingBudget` |
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

### GEMINI-015

When effort is omitted, the adapter shall create no effort-specific alias and shall preserve Gemini CLI and user-configuration defaults.
Where effort is outside the Gemini portable vocabulary, including `ultracode` or `ultra`, the adapter shall reject it before spawning Gemini with the metadata-backed allowed-values error from [ENG-024](../engine.md#eng-024).

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
[3]: https://geminicli.com/docs/reference/policy-engine/ "Gemini CLI: Policy engine"
[4]: https://geminicli.com/docs/cli/cli-reference/ "Gemini CLI: CLI reference"
