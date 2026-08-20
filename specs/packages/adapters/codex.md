<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# codex: Codex Adapter

## Intent

This package lets a consumer of the agent-adapter contract run Codex through the `@openai/codex-sdk`, per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md).
It owns how a portable request becomes a Codex thread, how a portable permission policy becomes a Codex permission profile, and how that thread's stream becomes unified events, thread continuity, and token accounting, together with the per-run configuration delivery and executable resolution those mappings require, not what a caller does with them and not the SDK's own behavior.
Its requirements are stated in this project's `AgentAdapter`, `AgentEvent`, `AgentOptions`, `PermissionPolicy`, `DonePayload`, and `Cligent` vocabulary, which the engine defines and without which this adapter's behavior cannot be stated.
Further project-specific references are essential to that intent and appear nowhere else: the distributable whose installed tree anchors executable resolution, the generated extra-writes profile this adapter names and delivers, and the launcher whose snapshotted work directory motivates the git-repo gate.

## External Behavior

### Adapter Identity

### codex-1

The adapter shall implement `AgentAdapter` with `agent: 'codex'`.

### SDK Loading

### codex-2

The adapter module shall be importable without the SDK installed so consumers can register the adapter unconditionally.
The SDK shall only be required at call time: `isAvailable()` shall return `false` and `run()` shall throw when the SDK is absent.

### Event Normalization

### codex-3

The adapter shall normalize Codex events to `AgentEvent` types:

| Codex Event                                                                     | AgentEvent                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------- |
| `item.completed` (text content)                                                 | `text`                                         |
| First observed lifecycle event of a `command_execution` or `mcp_tool_call` item | `tool_use`                                     |
| `item.completed` of a `command_execution` or `mcp_tool_call` item               | `tool_result`                                  |
| File change events                                                              | `codex:file_change` (extension)                |
| `turn.completed`                                                                | `done` (usage)                                 |
| `turn.failed`                                                                   | `error` followed by `done` (`status: 'error'`) |
| Errors                                                                          | `error`                                        |

The SDK represents shell commands and MCP tool invocations as `command_execution` and `mcp_tool_call` thread items that evolve across `item.started`, `item.updated`, and `item.completed` events and correlate by item `id` [[1]].
For each such item `id`, the adapter shall emit exactly one `tool_use`, on the first lifecycle event observed for the `id`, and at most one terminal `tool_result`, on the item's `item.completed` event, whether the item completed or failed.
When `item.completed` arrives for an `id` whose earlier lifecycle events were not observed, the adapter shall synthesize the missing `tool_use` immediately before the `tool_result`.
An `item.updated` event for an already-announced `id` shall produce no additional unified lifecycle event.
Both unified events shall carry the native item `id` as `toolUseId` so concurrent items remain correlated.

The `tool_use` payload shall name the tool `command_execution` with the native command string as input for command items, and the MCP server-qualified tool name (`<server>.<tool>`) with the native arguments as input for MCP items.
The `tool_result` payload shall map native status `failed` to `status: 'error'` and any other terminal status to `status: 'success'`, and shall preserve the native `aggregated_output` and, when present, `exit_code` for command items, and the native result or error details for MCP items.

Where an `item.completed` item instead carries legacy alias tool shapes — `tool_call`, `function_call`, or `tool_use` calls and `tool_result`, `function_call_result`, or `tool_output` results, at item top level or among content blocks — the adapter shall normalize them to the same `tool_use` and `tool_result` events as a compatibility fallback, preserving their native status (including `denied`) and duration detail, with their identifiers counted through the same unique-`toolUseId` rule below.

Because the SDK usage object carries token counts but no tool-count metric, the adapter shall report `DonePayload.usage.toolUses` on every terminal `done` event as the number of unique `toolUseId` values observed during the run — for canonical SDK streams, the unique `command_execution` and `mcp_tool_call` item `id`s — independent of token-usage fields.

_The following released flat-accounting behavior is superseded by [[codex-17](#codex-17)]._

Where the SDK supplies canonical `Usage`, the adapter shall preserve cache-inclusive `input_tokens` as `DonePayload.usage.inputTokens`, shall recognize and validate `cached_input_tokens`, `cache_write_input_tokens`, and `reasoning_output_tokens`, and shall not add those detail counters to the inclusive input or output total a second time [[6]][[7]].

When Codex emits `turn.failed`, the adapter shall yield a structured `error` event carrying the failure's `message` and `code`, then yield a terminal `done` event with `status: 'error'`, and stop iterating the SDK stream.
This ensures the actual failure reason (e.g., model rejection, server-side error) reaches the caller before the SDK's exec wrapper otherwise raises a generic non-zero-exit exception.

When Codex supplies an error message as a JSON-encoded object string, the adapter shall present the human-readable `detail`, `message`, or `error_description` content as the `error.message` while preserving a structured `code` when available.
The adapter may further unwrap nested `error` envelopes to reach those human-readable fields.

### Permission Mapping

### codex-4

The adapter shall map `PermissionPolicy` to Codex controls per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md) and [[ENG-021](../../user/engine.md#eng-021)], using Codex's modern permission-profile model [[3]][[4]].
The adapter shall express the local-access surface through the `CodexOptions.config` override `default_permissions` and shall not set `ThreadOptions.sandboxMode` or `ThreadOptions.networkAccessEnabled`, because a present legacy `sandbox_mode` makes Codex ignore `default_permissions` [[4]].

When the resolved `AgentOptions` carries no `permissions` policy, the adapter shall set none of `default_permissions`, `approvals_reviewer`, or `ThreadOptions.approvalPolicy`, leaving Codex's own default posture in effect per [DR-005](../../decisions/005-per-adapter-permission-configuration.md)'s no-project-wide-default rule.
The mappings below apply only to a provided `PermissionPolicy`; within a provided policy an omitted capability field is treated as unset, which is distinct from an absent policy.

When the resolved `AgentOptions` carries a `permissions` policy, the adapter shall invoke Codex `exec` with `--ignore-user-config` while preserving the normal `CODEX_HOME` auth and session state.
This prevents a user-level legacy `sandbox_mode` or stale `default_permissions` entry from overriding the adapter-selected permission profile for the run.
Runs with no `permissions` policy shall continue to inherit Codex's own config.

The `default_permissions` profile shall be selected as follows:

- `PermissionPolicy.mode: 'bypass'` → `:danger-full-access`.
- Otherwise, derived from the per-capability levels: all of `fileWrite` / `shellExecute` / `networkAccess` set to `'allow'` → `:danger-full-access`; `fileWrite` or `shellExecute` set to `'deny'` → `:read-only`; otherwise, including all unset → `:workspace`. `networkAccess` alone shall never select `:read-only`: both `:workspace` and `:read-only` grant no network, so denying network shall not remove workspace write access. This is lossy for network: a `networkAccess: 'allow'` not accompanied by `fileWrite` and `shellExecute` both `'allow'` rounds to `:workspace`, which grants no network, because no built-in profile expresses workspace-write with network.

`ThreadOptions.approvalPolicy` and the reviewer shall be selected as follows:

- `PermissionPolicy.mode: 'auto'` → `approvalPolicy: 'on-request'` and the `CodexOptions.config` override `approvals_reviewer: 'auto_review'` per Codex auto-review semantics [[2]].
- `PermissionPolicy.mode: 'bypass'` → `approvalPolicy: 'never'` and no `approvals_reviewer`.
- `PermissionPolicy.mode` unset → `approvalPolicy` from the per-capability levels (all `'allow'` → `'never'`; any `'ask'` → `'untrusted'`; otherwise → `'on-request'`) and no `approvals_reviewer`.

When `PermissionPolicy.writablePaths` is non-empty per [[ENG-022](../../user/engine.md#eng-022)] and the resolved `default_permissions` profile would otherwise be `:workspace`, the adapter shall select a generated `cligent-workspace-extra-writes` permission profile whose definition extends `:workspace` and grants `write` for each canonicalized path under `:workspace_roots`.
The adapter shall expose `WritablePathsPermissionMapping` per [[ENG-023](../../user/engine.md#eng-023)] with `enforcement: 'profile'` and the canonical `paths`.
The generated profile may be delivered through any Codex route that satisfies [DR-006](../../decisions/006-workspace-writable-paths.md)'s config-delivery constraints.
When non-empty `writablePaths` resolves alongside `:read-only`, the adapter shall reject the policy before starting a Codex thread.
When the resolved `default_permissions` profile is `:danger-full-access`, `writablePaths` shall not narrow that broader posture, no extra-writes profile shall be generated, and the adapter shall report the canonical paths with `enforcement: 'ambient'` per [[ENG-023](../../user/engine.md#eng-023)].

### Thread Resumption

### codex-5

When `resume` is a non-empty string, the adapter shall continue the previous thread identified by the token.
When `resume` is absent or empty, the adapter shall start a fresh thread with a non-empty correlation identifier.

### codex-6

When Codex provides a thread identifier before terminal `done`, the adapter shall set `DonePayload.resumeToken` to that identifier, enabling `Cligent` auto-resume across steps per [DR-003](../../decisions/003-role-scoped-session-management.md).
When an abort causes terminal `done` with `status: 'interrupted'`, the adapter shall preserve continuity by setting `DonePayload.resumeToken` to the first available value in this order: the Codex-provided thread identifier observed before the abort; otherwise the non-empty `AgentOptions.resume` value passed into the run; otherwise no `resumeToken`.

### Working Directory

### codex-9

The adapter shall set `skipGitRepoCheck: true` on the Codex SDK `ThreadOptions` so the CLI's interactive-user git-repo gate does not refuse programmatic invocations.
The `workingDirectory` is selected deliberately by the caller (per [[TMUX-034](../../user/tmux-play.md#tmux-034)] the tmux-play launcher targets a snapshotted work dir, and library consumers pass `AgentOptions.cwd` explicitly); the gate was designed to catch surprise CLI use, not these paths.

### Options Mapping

### codex-7

Per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), the adapter shall accept the Codex-specific `AgentOptions.effort` vocabulary from [[ENG-020](../../user/engine.md#eng-020)] and preserve the following native values through the documented effort and configuration surfaces per [[1]], [[3]], and [[5]]:

| `AgentOptions.effort` | Transport                                         | Native value |
| --------------------- | ------------------------------------------------- | ------------ |
| `minimal`             | SDK `ThreadOptions.modelReasoningEffort`          | `minimal`    |
| `low`                 | SDK `ThreadOptions.modelReasoningEffort`          | `low`        |
| `medium`              | SDK `ThreadOptions.modelReasoningEffort`          | `medium`     |
| `high`                | SDK `ThreadOptions.modelReasoningEffort`          | `high`       |
| `xhigh`               | SDK `ThreadOptions.modelReasoningEffort`          | `xhigh`      |
| `max`                 | Codex constructor `config.model_reasoning_effort` | `max`        |
| `ultra`               | Codex constructor `config.model_reasoning_effort` | `ultra`      |

The minimum compatible Codex SDK thread option supports `minimal` through `xhigh`; for `max` and `ultra`, the adapter shall use the constructor configuration pass-through so the installed SDK spawns Codex with `--config model_reasoning_effort="<value>"`, and shall leave the thread `modelReasoningEffort` field unset per [[3]] and [[5]].
When effort is omitted, the adapter shall set neither effort transport and shall leave [[codex-4](#codex-4)]'s independently selected configuration-isolation behavior unchanged, preserving only defaults applicable to that run.
Where effort is outside the Codex-specific accepted vocabulary, including the Claude-specific value `ultracode`, the adapter shall reject it before starting a thread with an error naming the Codex adapter and allowed values.
Mapping `ultra` shall leave independently mapped permission-profile, approval, sandbox, writable-path, and network controls unchanged, although provider delegation may increase token use, latency, cost, concurrency, and tool activity per [[5]].

### codex-11

Where `AgentOptions.allowedTools` or `AgentOptions.disallowedTools` is provided, including an empty array, the adapter shall reject before loading or invoking the Codex SDK with an error that states the installed Codex integration cannot enforce explicit tool restrictions.
Where both fields are omitted, the adapter shall preserve Codex's native available-tool set.

### Token Accounting

### codex-15

The usage attached to `turn.completed` is the thread's cumulative total rather than the completed turn's, so the adapter shall report the difference between that snapshot and the snapshot it last observed for the same thread.
Where the adapter has observed no earlier snapshot for a thread that this run resumed, it shall omit token accounting per [[ENG-031](../../user/engine.md#eng-031)], because the thread's accumulated total includes turns this run did not perform.
Where the run created the thread, the absent baseline shall be treated as zero, since the thread's first snapshot is that turn's usage.
Where any counter in the new snapshot is smaller than the corresponding baseline counter, the thread's accounting has restarted and the adapter shall omit token accounting rather than attribute an unexplained decrease to the turn.
For every valid snapshot the adapter shall retain the newest value as the baseline, so a thread whose turn could not be attributed recovers on its next turn.
Where a known thread's cumulative snapshot is malformed, the adapter shall discard its prior baseline; the next valid resumed snapshot shall establish a new baseline without reporting a delta, and only a later stable snapshot may recover attribution.
The retained snapshot shall preserve which optional cache and reasoning counters were present; where that presence shape changes from the preceding snapshot, the adapter shall omit the transition's tokens because a newly appearing cumulative counter may include older turns and a disappearing counter cannot be differenced, then retain the new shape so the next stable turn can recover.
The baseline shall be retained per backend thread identifier under [[ENG-018](../../user/engine.md#eng-018)], and concurrent runs carrying the same resume identifier shall be serialized for the full backend turn so their snapshots cannot race; different sessions and fresh runs shall remain concurrent.

### codex-16

Codex reports `cached_input_tokens` and `cache_write_input_tokens` as subsets of `input_tokens`, and `reasoning_output_tokens` as a subset of `output_tokens`, so the adapter shall obtain each exclusive detail of [[ENG-031](../../user/engine.md#eng-031)] by subtracting the reported subsets from their inclusive base rather than by adding them.
Where a cache counter is absent, the adapter shall omit that detail and shall omit `uncached` unless every cache subset needed for exact subtraction is present, while preserving the authentic inclusive input total.
Where the reasoning counter is absent, the adapter shall preserve the authentic inclusive output total while omitting both `visible` and `reasoning` details.
Where a reported subset exceeds its inclusive total or an exact subtraction would be negative, the adapter shall omit token accounting per [[ENG-031](../../user/engine.md#eng-031)] rather than clamp it.
Both sides shall be derived from the per-turn delta of [[codex-15](#codex-15)], never from the thread's cumulative snapshot.

### codex-14

_Superseded by [[codex-17](#codex-17)]; retained for the unreleased first billable-record design._

Codex reports usage once per turn rather than once per request, so the turn is a single billable group: the adapter shall publish one [[ENG-030](../../user/engine.md#eng-030)] record covering the turn's whole breakdown, omitting the request count because the turn covers an unreported number of requests, and omitting cost because Codex reports none.
The record's rate-card key shall be `AgentOptions.model` where the run pinned one, and otherwise a model reported by the run's own events; where neither names a model, the adapter shall publish no records, a single unidentified group being the breakdown restated.

### codex-17

The adapter shall expose an exact [[ENG-031](../../user/engine.md#eng-031)] token report only after differencing the current root thread's cumulative snapshot per [[codex-15](#codex-15)].
The report shall use partial coverage because the pinned exec surface does not aggregate descendant Codex threads.
Where the stream reports the effective model, one record shall carry the report's inclusive input and output totals plus any reported cache-read, cache-write, and reasoning subsets; visible output and uncached input shall be obtained by exact non-negative subtraction where their subsets are present.
Where the stream reports no effective model, `records` shall be absent because an unidentified record would merely restate the totals without selecting a rate card.
The adapter shall never label a record with `AgentOptions.model`, because a requested model is not evidence of the effective model or a reroute.
Where a resumed thread has no retained baseline, a snapshot decreases, a mapped counter is malformed, or an exact subset exceeds its inclusive total, the adapter shall omit tokens rather than emit a cumulative total, placeholder, or estimate.
Where optional counter presence changes or another run on the same resumed session is active, the adapter shall apply [[codex-15](#codex-15)]'s provenance and serialization rules before publishing a delta.
Codex exec reports no cost, so the adapter shall publish none.

## Internal Behavior

### Workspace Writable Paths

### codex-10

Where a non-empty `PermissionPolicy.writablePaths` policy resolves to Codex profile enforcement per [[codex-4](#codex-4)], when the adapter starts a run, the adapter shall make the generated permission profile definition available to that run through Codex's normal configuration loading without writing repository `.codex/config.toml`, without writing user-level Codex config, and without replacing the user's Codex home, authentication, or session configuration.
Where a run carries a `PermissionPolicy` whose mapped permission profile can
cause Codex to auto-persist project trust, when the adapter starts the run, the
adapter shall resolve the caller-selected workspace to the project root used by
Codex and supply its trust decision as a per-run CLI configuration override so
Codex does not persist a `projects.<path>.trust_level` entry.
The resolver shall preserve Codex's lexical absolute-path identity after its
native Windows device-prefix simplification instead of independently
realpath-canonicalizing symlink aliases.
For a linked worktree, this shall be the main repository root resolved from the
worktree's `.git` file, matching Codex's active-project trust lookup.
The trust override shall encode the complete top-level `projects` inline table,
not a dotted key containing a quoted path segment, so Codex's CLI override
parser materializes the absolute path as the project-table key.
The override shall not create a project or user configuration file.
When the caller omits `cwd` or supplies an empty value that the SDK does not
forward as `--cd`, the adapter shall not inject project trust because Codex's
project auto-trust path is not active for that run.
Mappings that resolve to `:read-only` shall not inject project trust because
Codex does not auto-persist trust for those mappings, and trusting them would
unnecessarily enable project-local configuration and executable policy.

### Codex Executable Resolution

### codex-12

`@openai/codex` is a dependency of the optional `@openai/codex-sdk` peer
([[package-4](../package.md#package-4)]), not of the Cligent package, so install
layouts that do not hoist it — npm global prefixes and nested-strategy
consumers — place it only inside the SDK's own tree.
When a run requires the Codex CLI entry `@openai/codex/bin/codex.js` for the
per-run configuration wrapper of [[codex-10](#codex-10)] and
[[codex-4](#codex-4)], the adapter shall resolve
the entry anchored inside the installed `@openai/codex-sdk` package tree,
attempting first the ESM loader's own SDK resolution (`import.meta.resolve`)
[[8]] where the runtime provides it, then the first `@openai/codex-sdk`
package manifest found on the adapter's module search paths, and shall fall
back to the adapter's own module resolution context only when no SDK-anchored
resolution succeeds.
Where an earlier anchor is unavailable or yields no entry — the loader
surface absent, its result not a file location, or its anchored tree missing
the entry — resolution shall continue with the remaining anchors rather than
fail.
Where the install layout reaches `@openai/codex-sdk` through symbolic links,
each anchor shall be canonicalized to the SDK's physical location so
resolution returns the entry nested in that physical tree.
Where the install layout nests `@openai/codex` inside `@openai/codex-sdk`
without a copy visible from the adapter's own resolution context, resolution
shall return the SDK-owned entry.
Where both an SDK-owned copy and an independently installed `@openai/codex`
are visible, resolution shall return the SDK-owned copy so the wrapped
executable matches the SDK's exactly pinned dependency.
Where the Node runtime provides no ESM loader resolution surface, as on the
[[package-2](../package.md#package-2)] runtime floor, the search-path anchor shall
produce the same SDK-owned result.

### codex-13

When every resolution route for `@openai/codex/bin/codex.js` fails, the
adapter shall raise an error that names the attempted entry specifier,
identifies each attempted resolution anchor, states that `@openai/codex` is
provided by `@openai/codex-sdk`, and directs the caller to install
`@openai/codex-sdk` where the Cligent package can resolve it as the repair.
The raised error shall carry the `MODULE_NOT_FOUND` code so callers that
degrade on a missing optional CLI by inspecting the error code keep matching.
Where the failure occurs while starting a run, the adapter shall release that
run's abort registration before the error propagates, so a caller repeating
failed runs against one long-lived `AgentOptions.abortSignal` accumulates no
listeners on it.

## Verification

### codex-201

Given canned native Codex events shaped as the SDK's canonical exported event types rather than invented aliases, including the multi-phase `command_execution` and `mcp_tool_call` item lifecycles, when the adapter runs, the yielded `AgentEvent` types shall match its normalization table [[codex-3](#codex-3)].

### codex-202

Where the Codex SDK is not installed, `isAvailable()` shall return `false` and `run()` shall throw [[codex-2](#codex-2)].

### codex-204

Given all `PermissionLevel` combinations, the adapter shall map `PermissionPolicy` to the correct vendor-specific controls [[codex-4](#codex-4)].

### codex-205

Where the packed tarball and the exact Codex SDK target are installed both into a global-style prefix whose package trees are independent and into a nested-strategy consumer, each leaving no `@openai/codex` at the install root, when the installed adapter resolves the executable entry, generates a per-run configuration wrapper, and runs a real permission-managed aborted invocation, resolution shall return the SDK-owned executable in both layouts [[codex-12](#codex-12)]:

- the nested consumer shall resolve it on the Node 18.3.0 runtime floor without an ESM loader resolution surface;
- the wrapper shall embed that executable path, and the aborted invocation shall terminate without a module resolution failure;
- where the installed consumer resolves no `@openai/codex` from any route, the raised error shall name the attempted entry and anchors and direct installing `@openai/codex-sdk` as the repair [[codex-13](#codex-13)].

### codex-206

When Codex reports file changes, the adapter shall emit `codex:file_change` extension events [[codex-3](#codex-3)].

### codex-211

When Codex provides a thread identifier, the adapter shall set `DonePayload.resumeToken` to that identifier [[codex-6](#codex-6)].

### codex-215

Given a run whose `AgentOptions.resume` selects its thread, when the adapter starts that run, it shall reach the thread its resume value names [[codex-5](#codex-5)]:

- a non-empty `resume` string shall continue the previous thread it identifies;
- an absent or empty `resume` shall start a fresh thread whose events carry a non-empty correlation identifier and whose first cumulative usage snapshot is treated as fresh-turn accounting [[codex-15](#codex-15)].

### codex-217

Given Codex emits an error whose message is a JSON-encoded object string, the adapter shall expose the human-readable detail or message content in the normalized `error.message`, may unwrap nested error envelopes to reach that content, and shall not pass the raw JSON string through to pane-facing consumers [[codex-3](#codex-3)].

### codex-218

Where each Codex-specific effort value is supplied, when the adapter maps a run, the observable provider controls shall be thread `modelReasoningEffort` for `minimal` through `xhigh` and an unchanged constructor `config.model_reasoning_effort` for `max` and `ultra` [[codex-7](#codex-7)]:

- when effort is omitted, the adapter shall set neither effort transport;
- where `ultra` is supplied alongside permission options, the adapter's permission-related provider controls shall equal the controls derived from the same permission input without the provider-native effort value;
- where the supplied value belongs to another built-in adapter or is an arbitrary unknown string, the adapter shall reject it before invoking the backend with an error naming the adapter and its allowed values.

### codex-219

Where a `Cligent` is constructed on the adapter with `CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first to create and then to update a temporary file in a throwaway working directory, the adapter's auto-mode Codex knobs per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) shall let both non-destructive writes proceed without interactive approval [[codex-4](#codex-4)]:

- the file shall exist with the expected contents after each phase;
- neither stream shall contain `permission_request`, a denied tool result, or an error;
- each stream shall terminate with successful `done`;
- filesystem state shall be the ground-truth assertion, because adapters normalize file edits differently;
- the harness shall retry the complete fresh probe after, and only after, an explicit upstream-overload, rate-limit, or service-unavailable failure, shall make at most two retries, and shall treat any other failure and the third consecutive named transient failure as fatal;
- the leg shall run against the real SDK, which any checkout able to run this suite has installed as a `devDependency`, so SDK absence shall not be a skip condition; the leg shall self-skip when the adapter's credential is absent from the environment, shall hard-fail instead under `CI`, and a missing dependency for one adapter shall never skip another's leg;
- because `mode: 'auto'` resolves to the `:workspace` profile, which runs commands inside a sandbox some hosts cannot initialize, only this real-run leg shall self-skip with a logged reason for that detected limitation, including under `CI`, the mapping itself remaining covered by [[codex-204](#codex-204)].

### codex-220

Given the adapter has been aborted, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall report the resume token each observed state requires [[codex-6](#codex-6)]:

| Observed before abort | `DonePayload.resumeToken` |
| --- | --- |
| a backend thread identifier observed during the run | the observed backend identifier |
| no backend identifier and a non-empty `AgentOptions.resume` value | the inbound `resume` value |
| no backend identifier and no non-empty inbound `resume` value | omitted |

### codex-221

Given a `PermissionPolicy` whose local access resolves to `:workspace` and whose `writablePaths` contains valid entries, the permission mapping shall expose canonical `WritablePathsPermissionMapping` paths with `enforcement: 'profile'` [[codex-4](#codex-4)]:

- the mapping shall select a generated extra-writes permission profile that extends `:workspace` and represent `write` grants under `:workspace_roots` for each canonical path;
- given non-empty `writablePaths` with local access resolved to `:read-only`, the mapping shall reject the policy;
- given non-empty `writablePaths` with local access resolved to `:danger-full-access`, the mapping shall report the canonical paths with `enforcement: 'ambient'`, shall not generate an extra-writes profile, and shall not narrow the broader posture.

### codex-223

Given the Codex CLI can initialize its native sandbox, when a credential-free sandbox probe, the permission mapping, and a real `CligentOptions.permissions = { mode: 'auto', writablePaths: ['.git'] }` run in a throwaway git repository are exercised, the generated extra-writes profile shall reach Codex without mutating repository or user-level Codex configuration [[codex-10](#codex-10)]:

- the built-in `:workspace` profile shall not write inside `.git`, while the generated extra-writes profile delivery shall grant `write` for `.git` [[codex-4](#codex-4)];
- managed writable mappings shall encode active-project trust as a top-level `projects={<path>={trust_level="trusted"}}` inline table rather than a quoted dotted path, shall perform Codex-compatible Windows device-prefix simplification, and shall resolve linked worktrees to Codex's main-repository trust root;
- read-only mappings and mappings without a non-empty caller `cwd` shall not inject project trust;
- the real run shall complete a git metadata write without `permission_request`, denied tool results, or error events, and without creating or modifying repository or user-level Codex config files, including persisted `projects.<path>.trust_level` entries for the throwaway workspace;
- the leg shall self-skip with a logged reason when the host cannot initialize Codex's native sandbox and shall hard-fail under `CI` for missing Codex dependencies or credentials, as in [[codex-219](#codex-219)].

### codex-224

Given Codex credentials and a throwaway `CODEX_HOME` whose `config.toml` grants broader user-level access with legacy `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`, when a no-policy `Cligent` and then a `mode: 'auto'` `Cligent` is invoked to write a file outside its throwaway working directory, `exec --ignore-user-config` shall isolate the permission-managed run alone [[codex-4](#codex-4)]:

- the no-policy run's file shall exist on disk afterwards, its stream shall contain no `permission_request`, no `tool_result` with `status: 'denied'`, and no `error`, and its terminal `done` status shall be `success`;
- the permission-managed run's file shall not exist on disk afterwards, its stream shall contain no `error`, and its terminal `done` status shall be `success`;
- the probe shall restore the caller's `CODEX_HOME` after the run and shall use the same sandbox-initialization skip and `CI` hard-fail rules as [[codex-219](#codex-219)].

### codex-226

Where an effort value is valid for the adapter but unavailable to the selected model, account, or installed runtime, when the backend rejects the run, the adapter stream shall expose that upstream failure through its normal error path without substituting another effort [[codex-7](#codex-7)].

### codex-229

Where either tool-list field is explicitly provided, including an empty array, when the adapter runs, it shall reject before its SDK loader or client is invoked [[codex-11](#codex-11)].

### codex-233

_Superseded for usage shape by [[codex-240](#codex-240)]._

Given the adapter receives complete finite non-negative integer token counters, including explicit zeroes, when it emits terminal `done`, `usage.tokenAvailability` shall be `'reported'` and its input count shall preserve the provider-inclusive base [[codex-3](#codex-3)]:

- given a required token or cache counter is absent, or any present mapped counter is negative, fractional, non-finite, or non-numeric, `usage.tokenAvailability` shall be `'unavailable'`, while an absent optional cache counter alone retains zero contribution without invalidating otherwise complete accounting;
- given upstream omits complete token accounting, or the adapter synthesizes an errored, interrupted, exhausted, or other terminal path, `usage.tokenAvailability` shall be `'unavailable'` and no token estimate shall be introduced;
- where tool calls were observed or validly provider-reported on either path, `usage.toolUses` shall preserve the greatest independently known count even when token accounting is unavailable.

### codex-238

_Superseded by [[codex-240](#codex-240)]._

Given the adapter emits a terminal `done` with complete upstream accounting, when a caller reads `usage.breakdown`, the adapter shall publish both sides derived by subtraction from its inclusive counters [[codex-16](#codex-16)]:

- given the runtime omits a cache or reasoning counter, the corresponding component shall be absent while the remaining members of a published side still sum to their aggregate, and where the omitted counter is the reasoning counter the whole output side shall be absent;
- given a component subtraction would be negative, the affected side shall be absent while the unaffected side is still published;
- given the thread-cumulative snapshot is reported on successive turns of one thread, the second turn's `done` shall report that turn's difference rather than the thread total [[codex-15](#codex-15)];
- given a resumed thread for which the adapter holds no baseline the `done` shall report `'unavailable'`, and given a snapshot smaller than the retained baseline the `done` shall report `'unavailable'` while the following turn recovers [[codex-15](#codex-15)].

### codex-239

_Superseded by [[codex-240](#codex-240)]._

Given the adapter emits a terminal `done` with complete upstream accounting, when a caller reads `usage.records`, the adapter shall publish one record covering the turn with no request count [[codex-14](#codex-14)]:

- given a run pinned no model and its runtime named none, the adapter shall publish no records, and no placeholder identifier shall appear;
- given the runtime reports the group's own cost, its record shall carry that cost, and the costs of a run's records shall not exceed the run's reported total;
- given upstream accounting is incomplete, absent, or fails the partition identities, the adapter shall publish no records on that terminal.

### codex-240

Given authentic zero or nonzero accounting from the adapter, when a caller reads terminal `usage.tokens`, the report shall carry inclusive input and output totals, exact reported cache/reasoning subsets, and no removed flat fields or availability placeholder [[codex-17](#codex-17)]:

- the report shall be the partial root-thread report taken from the exact non-negative delta of the cumulative snapshot, and no record shall be labelled with a merely requested model;
- an unseen resumed or decreasing delta shall be omitted, a stale baseline shall be discarded after a malformed snapshot, a transition whose optional-counter presence changes shall be omitted, and attribution shall recover only after a new baseline or shape stabilizes [[codex-15](#codex-15)];
- concurrent runs carrying the same resume identifier shall start their backend prompts serially and attribute each cumulative delta exactly once, while different resumed sessions and fresh runs remain concurrent [[codex-15](#codex-15)];
- malformed or absent accounting shall omit `tokens` while preserving independently observed `toolUses`.

## References

[1]: https://github.com/openai/codex/blob/main/sdk/typescript/README.md 'Codex TypeScript SDK'
[2]: https://developers.openai.com/codex/concepts/sandboxing/auto-review 'Codex: Auto-review'
[3]: https://developers.openai.com/codex/config-reference 'Codex: Configuration Reference'
[4]: https://developers.openai.com/codex/permissions 'Codex: Permission profiles and sandbox settings'
[5]: https://openai.com/index/gpt-5-6/ 'Introducing GPT-5.6'
[6]: https://github.com/openai/codex/blob/rust-v0.146.0/sdk/typescript/src/events.ts#L20-L36 'Codex SDK 0.146.0 turn usage'
[7]: https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/protocol/src/protocol.rs#L2215-L2230 'Codex 0.146.0 token-usage protocol'
[8]: https://nodejs.org/api/esm.html#importmetaresolvespecifier "Node.js import.meta.resolve"
