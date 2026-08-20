<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# gemini: Gemini CLI Adapter

## Intent

This package lets a consumer of the agent-adapter contract run Gemini CLI as a spawned child process whose NDJSON stream becomes unified events, per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md).
It owns how a portable request becomes a Gemini CLI invocation and how that invocation's stream, exit code, policy files, and telemetry become unified events, permission rules, resume continuity, and token accounting, not what a caller does with them and not the CLI's own behavior.
Its requirements are stated in this project's `AgentAdapter`, `AgentEvent`, `AgentOptions`, `PermissionPolicy`, `DonePayload`, and `Cligent` vocabulary, which the engine defines and without which this adapter's behavior cannot be stated.

## External Behavior

### Adapter Identity

### gemini-1

The adapter shall implement `AgentAdapter` with `agent: 'gemini'`; it has no SDK dependency.

### Availability

### gemini-2

`isAvailable()` shall probe for the `gemini` CLI on PATH via a spawn-based check with a timeout.

### Process Lifecycle

### gemini-3

`run()` shall spawn Gemini CLI in non-interactive mode with `gemini --output-format stream-json --prompt=<prompt>` and pipe stdout through `parseNDJSON()` per [[ndjson-1](../ndjson.md#ndjson-1)] and [[4]].
The adapter shall keep the option and arbitrary prompt in one argv token so Gemini CLI 0.50 treats the value as a headless prompt and does not reparse a leading-dash prompt as an option.
When the child process reports an asynchronous launch error, the adapter shall emit a non-recoverable `error` event followed by terminal `done` with `status: 'error'` rather than letting the process error escape the event stream.

### Environment

### gemini-10

The adapter shall set `GEMINI_CLI_TRUST_WORKSPACE=true` in the spawned Gemini CLI environment by default for headless runs.
When `process.env.GEMINI_CLI_TRUST_WORKSPACE` is already set, the adapter shall pass that value through unchanged.

### Event Normalization

### gemini-4

The adapter shall normalize NDJSON objects to `AgentEvent` types:

| NDJSON Event  | AgentEvent                 |
| ------------- | -------------------------- |
| `init`        | `init` (model, cwd, tools) |
| `message`     | `text`                     |
| `tool_use`    | `tool_use`                 |
| `tool_result` | `tool_result`              |
| `error`       | `error`                    |
| `result`      | `done` (usage, status)     |

When `parseNDJSON()` yields `{ ok: false }`, the adapter shall emit an `error` event with `recoverable: true`.

_The following released stream-only accounting behavior is superseded by [[gemini-17](#gemini-17)]._

Where a Gemini CLI 0.53.1 result supplies canonical `StreamStats`, the adapter shall preserve cache-inclusive `input_tokens` as `DonePayload.usage.inputTokens`, shall recognize and validate the `total_tokens`, `cached`, and uncached `input` details without adding either input detail to the inclusive total a second time, and shall map valid `tool_calls` to `toolUses` while retaining any greater independently observed tool-call count [[5]][[6]].
Canonical `output_tokens` contains candidates but omits separately tracked thinking and tool-use-prompt tokens; where `total_tokens` does not equal `input_tokens + output_tokens`, the omitted residual is not partitioned well enough to normalize without estimation, so token accounting shall be `'unavailable'` rather than reporting the candidate count as complete or assigning the residual to output [[6]][[7]].
Where any supplied canonical token or cache detail is absent, negative, fractional, non-finite, or non-numeric, token accounting shall likewise be `'unavailable'` per [[ENG-027](../../user/engine.md#eng-027)].

### gemini-5

The adapter shall map process exit codes to `done` status:

| Exit Code | Done Status   |
| --------- | ------------- |
| `0`       | `'success'`   |
| `1`       | `'error'`     |
| `42`      | `'error'`     |
| `53`      | `'max_turns'` |

### Permission Mapping

### gemini-6

Where `PermissionPolicy` is provided with `mode` omitted, or `allowedTools` or `disallowedTools` is provided, the adapter shall map the supplied capability and tool-list restrictions to non-interactive User-tier Gemini Policy Engine rules per [[3]] and the following table:

| Input                                                | Policy outcome                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| capability `allow`                                   | `decision = "allow"` for that capability's current built-in tools                                                             |
| capability `ask` or omitted inside a provided policy | `decision = "ask_user"`, which denies in headless mode                                                                        |
| capability `deny`                                    | `decision = "deny"`                                                                                                           |
| explicit `allowedTools`                              | priority-999 allows for effective listed tools plus a priority-998 catch-all deny, including when the effective list is empty |
| explicit `disallowedTools`                           | deny rules that take precedence over allows                                                                                   |

The capability tools shall be file writes `replace` and `write_file`, shell execution `run_shell_command`, and network access `google_web_search` and `web_fetch`.
Capability-level allows shall not widen an explicit allowlist.
When `PermissionPolicy.mode` is `'auto'` or `'bypass'`, the existing approval-mode mapping shall take precedence over per-capability fields per [[ENG-021](../../user/engine.md#eng-021)]; independently supplied tool lists may still generate policy rules.
Where mapping generates at least one rule, the adapter shall write a per-run User-tier policy file and pass it through `--policy`; otherwise it shall generate no policy file or flag.
The adapter runtime shall emit neither deprecated `--allowed-tools` nor deprecated `tools.exclude`; compatibility-only exported settings helpers may retain their historical return shape but shall not drive `run()`.
When `PermissionPolicy.writablePaths` is non-empty per [[ENG-022](../../user/engine.md#eng-022)] and Gemini sandboxing is not independently active through a selected adapter surface, the adapter shall accept valid entries, expose `WritablePathsPermissionMapping` per [[ENG-023](../../user/engine.md#eng-023)] with `enforcement: 'ambient'` and canonical `paths`, and keep the existing tool-control and approval-mode mapping unchanged.

### gemini-12

Where `PermissionPolicy`, `allowedTools`, and `disallowedTools` are all absent, the adapter shall generate no policy and pass no `--policy`, leaving Gemini's native defaults and discovered user policies in effect.
A provided empty `PermissionPolicy` shall remain distinct and shall generate `ask_user` rules for its omitted default-ask capabilities.

### gemini-13

Where a user-provided tool name is empty, contains Gemini Policy Engine wildcard syntax `*`, or contains an unpaired Unicode surrogate, the adapter shall reject it before spawn with an error naming the offending option index.
For other accepted names, the adapter shall serialize a valid TOML basic string, including escaping DEL (`U+007F`).

### gemini-14

Where the adapter generates a policy file, every rule shall carry `interactive = false`, the file shall be removed after the run, and installed Admin-tier policies shall retain authority.
Permission mapping shall not redirect Gemini's system settings or system-defaults paths.

### Options Mapping

### gemini-7

The adapter shall map `AgentOptions.model` to `--model=<model>` and a non-empty `AgentOptions.resume` to `--resume=<token>`, keeping each value in the same argv token as its option so leading dashes are not reinterpreted.
When `AgentOptions.resume` is absent or empty, the adapter shall start a fresh run with the same generated non-empty correlation identifier until the backend supplies its own session identifier.
Where Gemini CLI exposes no compatible turn-limit flag, the adapter shall ignore `AgentOptions.maxTurns` and shall not pass the unsupported `--max-session-turns` flag.

### gemini-11

Per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), where a portable `AgentOptions.effort` is provided, the adapter shall select its per-run Gemini settings behavior from this model-condition table per [[1]] and [[2]]:

| Model condition                                                                                                       | Outcome                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| concrete ID matching `^gemini-3`                                                                                      | unique self-contained alias with the original model and mapped `thinkingLevel`      |
| concrete ID matching `^gemini-2\.5`                                                                                   | unique self-contained alias with the original model and mapped `thinkingBudget`     |
| model unset, a CLI alias such as `auto`, `pro`, `flash`, `flash-lite`, or `chat-base*`, or another non-matching value | no effort alias; preserve ordinary model forwarding and ignore effort for that call |

The generated alias shall be merged into a temporary copy of configured system defaults selected through `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, preserving pre-existing defaults and leaving `GEMINI_CLI_SYSTEM_SETTINGS_PATH` unchanged so system overrides, Admin policy, user settings, and project settings retain authority.
The temporary defaults file shall be removed after the run.

Gemini 3 mapping:

| `AgentOptions.effort` | `thinkingLevel` |
| --------------------- | --------------- |
| `minimal`             | `MINIMAL`       |
| `low`                 | `LOW`           |
| `medium`              | `MEDIUM`        |
| `high`                | `HIGH`          |
| `xhigh`               | `HIGH`          |
| `max`                 | `HIGH`          |

Gemini 3 exposes four thinking levels; `xhigh` and `max` collapse to `HIGH` per [[ENG-020](../../user/engine.md#eng-020)]'s nearest-neighbour rule.

Gemini 2.5 mapping:

| `AgentOptions.effort` | `thinkingBudget`                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `minimal`             | `1024`                                                                                      |
| `low`                 | `4096`                                                                                      |
| `medium`              | `8192`                                                                                      |
| `high`                | `16384`                                                                                     |
| `xhigh`               | `24576`                                                                                     |
| `max`                 | `32768` for `gemini-2.5-pro*`; `24576` for `gemini-2.5-flash*` and `gemini-2.5-flash-lite*` |

The Gemini 2.5 ladder shall stay within each supported model family's documented bounds: Pro `128..32768`, Flash `0..24576`, and Flash Lite `512..24576` per [[1]].
`max` maps to the model family's upper bound rather than Google's dynamic-thinking sentinel because [[ENG-020](../../user/engine.md#eng-020)] defines `max` as the greatest reasoning depth.
For Flash and Flash Lite, `xhigh` and `max` both map to `24576`, the nearest supported ceiling.

### gemini-15

When effort is omitted, the adapter shall create no effort-specific alias and shall preserve Gemini CLI and user-configuration defaults.
Where effort is outside the Gemini portable vocabulary, including `ultracode` or `ultra`, the adapter shall reject it before spawning Gemini with the metadata-backed allowed-values error from [[ENG-024](../../user/engine.md#eng-024)].

### gemini-16

Where `AgentOptions.allowedTools` is provided, the adapter's `init` event shall report the effective allowlist as a configured, known tool set even when that list is empty.
The configured allowlist shall take precedence over a broader tool list reported by the Gemini stream because [[gemini-6](#gemini-6)]'s catch-all deny makes unlisted tools unavailable.
Where `allowedTools` is omitted, the adapter shall continue to report the stream tool list when available and otherwise report tool availability as unknown.

### Token Accounting

### gemini-17

For each run, the adapter shall enable Gemini CLI's supported local telemetry exporter to a unique prompt-free file, disable prompt and trace logging, and parse the file only after the child process closes [[8]].
It shall accept one `gemini_cli.api_response` record per successful model response, deduplicate exact exporter records, and reject conflicting or unidentifiable duplicates.
Gemini's pinned `UsageMetadata` defines `totalTokenCount` as prompt, candidate, tool-use-prompt, and thinking tokens, with tool-use-prompt content supplied back to the model as input [[9]].
The adapter shall therefore add tool-use-prompt tokens to inclusive input and its uncached subset, retain thinking in inclusive output, and preserve exact cache-read, visible-output, and thinking subsets.
The adapter shall publish one `requests: 1` record per response with the actual model and non-empty telemetry `auth_type` as its rate-card family, and shall include root and descendant-agent responses without emitting their hidden conversation [[8]].
It shall sum those records and cross-validate raw prompt, candidate, cached, and overall total counters against the ordinary terminal StreamStats; any missing file, parse defect, invalid counter, duplicate conflict, or mismatch shall make tokens absent rather than estimated.
A reconciled report shall have complete coverage only when the run-owned file contains no `gemini_cli.api_error` and StreamStats identifies no unmatched zero-token routed model; either condition proves a failed request without token counters, so the adapter shall retain the exact reconciled successful-response records with partial coverage [[8]].
Telemetry configuration shall be applied after inherited settings so user telemetry cannot redirect or contaminate the run-owned ledger, and cleanup shall remove the temporary file after success, error, and abort.
Gemini CLI reports no direct dollar cost on this surface, so the adapter shall publish none; callers shall distinguish API-key, Vertex, account/subscription, and gateway records by `provider` rather than assuming one Google price table.

### Abort Handling

### gemini-8

When `AbortSignal` fires, the adapter shall send `SIGTERM` to the spawned process.
When the process exits after SIGTERM, the adapter shall yield `done` (`status: 'interrupted'`).

### Resume Token

### gemini-9

When the Gemini CLI stream provides a session identifier before terminal `done`, the adapter shall set `DonePayload.resumeToken` to that value, enabling `Cligent` auto-resume via `--resume` per [DR-003](../../decisions/003-role-scoped-session-management.md).
When an abort causes terminal `done` with `status: 'interrupted'`, the adapter shall preserve continuity by setting `DonePayload.resumeToken` to the first available value in this order: the Gemini-provided session identifier observed before the abort; otherwise the non-empty `AgentOptions.resume` value passed into the run; otherwise no `resumeToken`.
When terminal `done` is not interrupted and no session identifier was received, the adapter shall omit `resumeToken`.

## Verification

### gemini-201

Given canned native Gemini NDJSON events, when the adapter runs, the yielded `AgentEvent` types shall match its normalization table [[gemini-4](#gemini-4)].

### gemini-203

When `AbortSignal` fires during the adapter's `run()`, the adapter shall yield `done` with `status: 'interrupted'` [[gemini-8](#gemini-8)].

### gemini-204

Given all `PermissionLevel` combinations, the adapter shall map `PermissionPolicy` to the correct vendor-specific controls [[gemini-6](#gemini-6)].

### gemini-207

Given the spawned process terminates, when the adapter yields its terminal events, it shall report the outcome each process condition requires [[gemini-3](#gemini-3)]:

- exit codes 0, 1, 42, and 53 shall each yield the corresponding `done` status [[gemini-5](#gemini-5)];
- an asynchronous launch error reported by the child process shall emit a non-recoverable `error` followed by terminal `done` with `status: 'error'`.

### gemini-213

Given a stream whose session identity varies, when the adapter emits terminal `done`, it shall set or omit `DonePayload.resumeToken` as that identity requires [[gemini-9](#gemini-9)]:

- a stream that provides a session identifier shall set `resumeToken` to that value;
- a stream with no session identifier, an early error among them, shall omit `resumeToken`.

### gemini-216

When the adapter spawns Gemini CLI, the spawned process environment shall carry `GEMINI_CLI_TRUST_WORKSPACE=true` by default and shall preserve an existing parent environment value [[gemini-10](#gemini-10)].

### gemini-218

Where each portable effort value is supplied, when the adapter maps a run, the observable provider controls shall be documented aliases created only for matching concrete model IDs [[gemini-11](#gemini-11)]:

- when effort is omitted, the adapter shall set no effort, orchestration, or settings-alias override [[gemini-15](#gemini-15)];
- where the supplied value belongs to another built-in adapter or is an arbitrary unknown string, the adapter shall reject it before invoking the backend with an error naming the adapter and its allowed values [[gemini-15](#gemini-15)].

### gemini-219

Where a `Cligent` is constructed on the adapter with `CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first to create and then to update a temporary file in a throwaway working directory, the adapter's auto-mode Policy Engine knobs per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) shall let both non-destructive writes proceed without interactive approval [[gemini-6](#gemini-6)]:

- the file shall exist with the expected contents after each phase;
- neither stream shall contain `permission_request`, a denied tool result, or an error;
- each stream shall terminate with successful `done`;
- filesystem state shall be the ground-truth assertion, because adapters normalize file edits differently;
- the harness shall retry the complete fresh probe after, and only after, an explicit upstream-overload, rate-limit, service-unavailable, or upstream invalid-stream failure, shall make at most two retries, and shall treat any other failure and the third consecutive named transient failure as fatal;
- the leg shall self-skip when the `gemini` CLI the adapter spawns is absent from `PATH` or the adapter's credential is absent from the environment, shall hard-fail instead under `CI`, and a missing dependency for one adapter shall never skip another's leg;
- where the host cannot initialize the adapter's OS-level sandbox, the leg shall self-skip with a logged reason, including under `CI`.

### gemini-220

Given the adapter has been aborted, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall report the resume token each observed state requires [[gemini-9](#gemini-9)]:

| Observed before abort | `DonePayload.resumeToken` |
| --- | --- |
| a backend session identifier observed during the run | the observed backend identifier |
| no backend identifier and a non-empty `AgentOptions.resume` value | the inbound `resume` value |
| no backend identifier and no non-empty inbound `resume` value | omitted |

### gemini-222

Given a `PermissionPolicy` whose `writablePaths` contains valid entries and no independently active filesystem-sandbox write-grant surface, the adapter's permission mapping shall expose canonical `WritablePathsPermissionMapping` paths with `enforcement: 'ambient'` and shall preserve the existing tool-control and approval-mode mapping [[gemini-6](#gemini-6)].

### gemini-225

Given a fake Gemini CLI implementing the 0.50 argument and Policy Engine surfaces while capturing argv and temporary files, when the adapter runs, the captured argv and generated files shall match every mapped surface:

- arbitrary prompts shall arrive through joined option tokens [[gemini-3](#gemini-3)];
- model values and non-empty resume tokens shall arrive through joined option tokens, an absent or empty resume shall create a fresh run whose pre-backend events share a generated non-empty correlation identifier, and the unsupported turn-limit flag shall be absent [[gemini-7](#gemini-7)];
- generated policy rules and their precedence shall match the mapping table, and the deprecated tool controls shall be absent [[gemini-6](#gemini-6)];
- absent policy and tool-list options shall generate no policy file or flag, while a provided empty policy shall still generate its default-ask rules [[gemini-12](#gemini-12)];
- rejected tool names shall be refused before spawn and accepted ones serialized as valid TOML basic strings [[gemini-13](#gemini-13)];
- a generated policy file shall carry non-interactive rules, leave installed Admin-tier authority intact, and be removed after the run [[gemini-14](#gemini-14)];
- the effort alias shall be generated into the temporary defaults copy and removed after the run [[gemini-11](#gemini-11)].

### gemini-226

Where an effort value is valid for the adapter but unavailable to the selected model, account, or installed runtime, when the backend rejects the run, the adapter stream shall expose that upstream failure through its normal error path without substituting another effort [[gemini-11](#gemini-11)].

### gemini-229

Where either tool-list field is explicitly provided, when the adapter runs, it shall close the provider tool surface to the effective list [[gemini-6](#gemini-6)]:

| Supplied tool lists | Observable outcome |
| --- | --- |
| an explicit empty `allowedTools` | only the applicable deny rules including the catch-all deny, and an `init` event reporting a configured known empty set [[gemini-16](#gemini-16)] |
| a non-empty allowlist with disallowed identifiers | the provider tool registry closed to the effective allowlist, with deny precedence preserved |

### gemini-233

_Superseded for usage shape by [[gemini-240](#gemini-240)]._

Given the adapter receives canonical `StreamStats`, when it emits terminal `done`, `usage.tokenAvailability` shall be `'reported'` and its cache-inclusive `input_tokens` shall remain unchanged [[gemini-4](#gemini-4)]:

- the `cached` and uncached `input` details shall be validated without being added to the inclusive total again, and valid `tool_calls` shall contribute to the independently known tool-use count;
- where `total_tokens` differs from `input_tokens + output_tokens`, accounting shall be `'unavailable'` rather than assigning the unpartitioned residual to output;
- given a required token or cache counter is absent, or any present mapped counter is negative, fractional, non-finite, or non-numeric, accounting shall be `'unavailable'`, while an absent optional cache counter alone retains zero contribution without invalidating otherwise complete accounting;
- given upstream omits complete accounting, or the adapter synthesizes an errored, interrupted, exhausted, or other terminal path, accounting shall be `'unavailable'` and no token estimate shall be introduced, `usage.toolUses` still preserving the greatest independently known count.

### gemini-240

Given authentic zero or nonzero accounting from the adapter, when a caller reads terminal `usage.tokens`, the report shall carry inclusive input and output totals, exact reported cache/reasoning subsets, and no removed flat fields or availability placeholder [[gemini-17](#gemini-17)]:

- complete coverage shall be published only from a prompt-free run-owned telemetry file whose root and descendant records carry a non-empty authentication rate-card identity, reconcile to terminal StreamStats, and contain neither an API-error event nor an unmatched zero-token routed model;
- exact duplicate exporter records shall be deduplicated, while a missing, malformed, unidentifiable duplicate, conflicting duplicate, contaminated, or mismatched file shall yield no token report;
- tool-use-prompt tokens shall contribute to inclusive input and its uncached subset, while StreamStats reconciliation shall preserve its raw prompt and candidate counters;
- a run with either failed-request signal shall retain the exact reconciled successful-response records as partial;
- run-owned telemetry cleanup shall run after success, error, and abort;
- malformed or absent accounting shall omit `tokens` while preserving independently observed `toolUses`.

### gemini-241

Where the exact Gemini CLI conformance target and API-key credentials are available, when the real auto-mode adapter leg completes its headless create and update requests, each terminal shall carry a non-empty token report whose inclusive totals are positive and whose per-response records name a non-empty model, a non-empty authentication rate-card family, and exactly one request [[gemini-17](#gemini-17)]:

- an absent or unreconciled run-owned telemetry file shall fail this acceptance leg rather than pass on the successful coding-agent result alone.

## References

[1]: https://ai.google.dev/gemini-api/docs/thinking 'Gemini API: Thinking'
[2]: https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md 'Google Gemini CLI: Configuration reference'
[3]: https://geminicli.com/docs/reference/policy-engine/ 'Gemini CLI: Policy engine'
[4]: https://geminicli.com/docs/cli/cli-reference/ 'Gemini CLI: CLI reference'
[5]: https://github.com/google-gemini/gemini-cli/blob/v0.53.1/packages/core/src/output/types.ts#L81-L109 'Gemini CLI 0.53.1 stream output types'
[6]: https://github.com/google-gemini/gemini-cli/blob/v0.53.1/packages/core/src/output/stream-json-formatter.ts#L37-L86 'Gemini CLI 0.53.1 StreamStats construction'
[7]: https://ai.google.dev/api/generate-content#UsageMetadata 'Gemini API UsageMetadata'
[8]: https://geminicli.com/docs/cli/telemetry/ 'Gemini CLI telemetry'
[9]: https://github.com/googleapis/js-genai/blob/38cac5bbf4941ec5fa760238bd423c0ecc2c6f04/src/types.ts#L2607-L2628 'Google Gen AI SDK 1.30.0 UsageMetadata'
