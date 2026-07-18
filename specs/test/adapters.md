<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TADAPT: Adapter Tests

## Intent

Verification criteria for all adapters. Shared patterns apply to each adapter; per-adapter sections cover unique behaviors.

## Shared

### TADAPT-001
Verifies: [CLAUDE-003](../user/adapters/claude-code.md#claude-003), [CODEX-003](../user/adapters/codex.md#codex-003), [GEMINI-004](../user/adapters/gemini.md#gemini-004), [GEMINI-005](../user/adapters/gemini.md#gemini-005), [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [KIMI-005](../user/adapters/kimi.md#kimi-005), [KIMI-006](../user/adapters/kimi.md#kimi-006)

Given canned native events for each adapter, when running the adapter, the yielded `AgentEvent` types shall match the normalization table for that adapter.

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

Given partial lines, malformed JSON, and empty lines, `parseNDJSON()` shall produce the correct `NDJSONParseResult` values. Given process exit codes 0, 1, 42, and 53, the Gemini adapter shall yield the corresponding `done` status.

### TADAPT-025
Verifies: [GEMINI-003](../user/adapters/gemini.md#gemini-003), [GEMINI-006](../user/adapters/gemini.md#gemini-006), [GEMINI-007](../user/adapters/gemini.md#gemini-007), [GEMINI-011](../user/adapters/gemini.md#gemini-011), [GEMINI-012](../user/adapters/gemini.md#gemini-012), [GEMINI-013](../user/adapters/gemini.md#gemini-013), [GEMINI-014](../user/adapters/gemini.md#gemini-014)

Given a fake Gemini CLI implementing the 0.50 argument and Policy Engine surfaces while capturing argv and temporary files, when the adapter runs, arbitrary prompts, model values, and resume tokens shall arrive through joined option tokens; unsupported turn-limit and deprecated tool controls shall be absent; generated policy rules, precedence, serialization, native-default omission, configuration authority, and cleanup shall match the cited Gemini items.

## OpenCode

### TADAPT-008
Verifies: [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [OPENCODE-006](../user/adapters/opencode.md#opencode-006), [OPENCODE-008](../user/adapters/opencode.md#opencode-008), [OPENCODE-009](../user/adapters/opencode.md#opencode-009), [OPENCODE-010](../user/adapters/opencode.md#opencode-010)

The OpenCode adapter shall filter events by `sessionId`, pass through events with no session or thread identifier per [OPENCODE-006](../user/adapters/opencode.md#opencode-006), emit `opencode:file_part` and `opencode:image_part` extension events, manage the server lifecycle in managed mode, and yield `error` (`code: 'OPENCODE_SERVER_EXIT'`) followed by `done` (`status: 'error'`) on server crash.

### TADAPT-027
Verifies: [OPENCODE-007](../user/adapters/opencode.md#opencode-007), [OPENCODE-013](../user/adapters/opencode.md#opencode-013)

Where no `PermissionPolicy` is supplied, when OpenCode starts fresh and resumed
runs through each supported SDK path, fresh-session creation and prompt calls
shall omit permission data and a resumed run shall issue no permission-bearing
session update. Independent tool-list restrictions shall still reach the
prompt. Where an empty policy is supplied instead, fresh and resumed runs
shall carry `ask` rules for `edit`, `bash`, and `webfetch`.

### TADAPT-028
Verifies: [OPENCODE-008](../user/adapters/opencode.md#opencode-008), [PKG-012](../dev/package.md#pkg-012)

Where the exact OpenCode CLI conformance target is installed, when its version
and `serve --help` output are inspected, the reported version shall equal the
exact CI target and the managed-server help shall expose `--hostname` and
`--port`.

## Tool Filtering

### TADAPT-009
Verifies: [ENG-017](../user/engine.md#eng-017)

Given `allowedTools` and `disallowedTools` options, each adapter shall enforce whitelist and precedence semantics or reject before backend invocation when it has no compatible restriction surface, per [ENG-017](../user/engine.md#eng-017).

### TADAPT-029
Verifies: [ENG-017](../user/engine.md#eng-017), [CLAUDE-009](../user/adapters/claude-code.md#claude-009), [CODEX-011](../user/adapters/codex.md#codex-011), [GEMINI-006](../user/adapters/gemini.md#gemini-006), [GEMINI-016](../user/adapters/gemini.md#gemini-016), [OPENCODE-015](../user/adapters/opencode.md#opencode-015), [KIMI-010](../user/adapters/kimi.md#kimi-010)

Where `allowedTools` is an explicit empty list, when the built-in adapters run, the adapters shall enforce the closed empty set: Claude Code receives SDK `tools: []`, `allowedTools: []`, `settingSources: []`, and `strictMcpConfig: true`; Gemini emits only its applicable deny rules including the catch-all deny and reports a configured known empty set; and OpenCode receives the prompt tool map `{ "*": false }` and reports a configured known empty set.
Where a non-empty allowlist and disallowed identifiers are provided, when Claude Code, Gemini, and OpenCode run, each adapter shall close its provider tool registry to the effective allowlist and preserve deny precedence, while Claude Code shall also reject ambient MCP additions.
Where an OpenCode tool-list entry contains `*`, when the adapter runs, it shall reject before prompting instead of interpreting the entry as a provider wildcard.
Where either tool-list field is explicitly provided to Codex, including an empty array, when the adapter runs, it shall reject before its SDK loader or client is invoked.
Where either tool-list field is explicitly provided to Kimi, including an empty array, when the adapter runs, it shall reject before spawning `kimi acp`.

## Effort

### TADAPT-018
Verifies: [ENG-020](../user/engine.md#eng-020), [ENG-024](../user/engine.md#eng-024), [CLAUDE-008](../user/adapters/claude-code.md#claude-008), [CODEX-007](../user/adapters/codex.md#codex-007), [GEMINI-011](../user/adapters/gemini.md#gemini-011), [OPENCODE-012](../user/adapters/opencode.md#opencode-012), [KIMI-009](../user/adapters/kimi.md#kimi-009)

Where each adapter-specific effort value is supplied, when the adapter maps a run, the observable provider controls shall match this table and the cited adapter item:

| Adapter | Observable mapping |
| --- | --- |
| Claude Code | SDK `effort` plus explicit `settings.ultracode`; `ultracode` maps to `xhigh` and `true` |
| Codex | `minimal` through `xhigh` use thread `modelReasoningEffort`; `max` and `ultra` use constructor `config.model_reasoning_effort` unchanged |
| Gemini | portable values create documented aliases only for matching concrete model IDs |
| OpenCode | portable values select the documented top-level prompt `variant` by provider |
| Kimi | `off` and `on` select the ACP `thinking` option exactly; `on` uses the chosen model's native default effort |

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

Where an adapter does not document an environmental constraint, concurrent `run()` calls on the same adapter instance shall emit no cross-stream event leakage (events from one call shall not appear in another), maintain per-call options isolation, and not mutate adapter instance state per [ENG-018](../user/engine.md#eng-018).

## Codex Resume

### TADAPT-015
Verifies: [CODEX-005](../user/adapters/codex.md#codex-005)

When `resume` is provided, the Codex adapter shall continue the previous thread per [CODEX-005](../user/adapters/codex.md#codex-005).

## Kimi

### TADAPT-030
Verifies: [KIMI-001](../user/adapters/kimi.md#kimi-001), [KIMI-002](../user/adapters/kimi.md#kimi-002), [KIMI-003](../user/adapters/kimi.md#kimi-003), [KIMI-004](../user/adapters/kimi.md#kimi-004), [KIMI-005](../user/adapters/kimi.md#kimi-005), [KIMI-006](../user/adapters/kimi.md#kimi-006), [KIMI-007](../user/adapters/kimi.md#kimi-007), [KIMI-008](../user/adapters/kimi.md#kimi-008), [KIMI-009](../user/adapters/kimi.md#kimi-009), [KIMI-010](../user/adapters/kimi.md#kimi-010), [KIMI-011](../user/adapters/kimi.md#kimi-011), [KIMI-012](../user/adapters/kimi.md#kimi-012)

Given a fake ACP subprocess with protocol traffic split across arbitrary stdio chunks, when Kimi runs fresh and resumed prompts, it shall initialize with empty client capabilities, select `session/new` or `session/resume`, apply model before thinking and mode configuration, emit `init` before normalized text, tool, plan, and permission events, reject reverse permission requests, suppress raw thought chunks, map every prompt stop reason, preserve the correct resume token, and terminate the per-run child exactly once.
The adapter identity shall be `kimi`, and availability probing shall invoke `kimi --version` without starting ACP or authentication.
Where abort occurs before and after session setup, the adapter shall cancel or terminate as appropriate and emit exactly one interrupted `done` without state leakage.
Where authentication, protocol, or child-process failure occurs, the stream shall emit an actionable error and error `done` without starting login.
Where permissions, tool lists, turn or budget limits, or effort values are unsupported, validation shall fail before the spawn seam is invoked.

## Real-run Acceptance

Items in this section verify behavior end-to-end against the real coding-agent SDKs and CLIs (not mocks or canned events). They live under `src/adapters/*.acceptance.test.ts` and run via `npm run test:acceptance`. The SDK packages the adapters load (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`) are cligent `devDependencies`, while the ACP SDK used by Kimi is a runtime dependency, so any checkout able to run this suite has installed them via `npm install`; their absence is therefore not a skip condition. An item shall self-skip per adapter when an *external* CLI the adapter spawns is absent from `PATH` — the `gemini` CLI for Gemini, the `opencode` CLI for OpenCode's managed server, or the `kimi` CLI for Kimi — or when that adapter's credential is absent from the environment; a missing dependency for one adapter shall not skip the others. Under `CI` the items shall instead hard-fail on a missing dependency so a misconfigured runner is not silently green. Exact credential-free Kimi ACP initialization remains an additional mandatory CI conformance check.

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

Kimi Code `0.27.0` requires a prior interactive OAuth `kimi login` for ACP session creation; `MOONSHOT_API_KEY` or an API-key provider configuration alone does not satisfy that gate. Locally, the Kimi source home shall resolve in order from `CLIGENT_KIMI_ACCEPTANCE_HOME`, an absolute `KIMI_CODE_HOME`, or the documented `~/.kimi-code` default. The Kimi CLI shall resolve from PATH or that source home's managed `bin` directory. Under `CI`, `CLIGENT_KIMI_ACCEPTANCE_HOME` shall name an absolute, dedicated source home containing `config.toml` and the OAuth `credentials/` directory; missing or invalid Kimi credentials or CLI shall fail like every other adapter dependency. The harness shall dereference and copy only the source config and credentials into a temporary `KIMI_CODE_HOME`, harden the copied config, credential files, and directories to owner-only permissions, retain the same clone across the complete bounded retry sequence, restore the caller's environment and PATH, and remove the temporary home. It shall not mutate the source. Acceptance files that consume the source shall run serially so independent clones cannot race OAuth refresh-token rotation. An absent or invalid automatically discovered local source shall self-skip with a precise reason. A dedicated CI source is disposable, and a local source may require `kimi login` again, because an OAuth refresh against the clone may leave its prior token stale.

### TADAPT-023
Verifies: [CODEX-004](../user/adapters/codex.md#codex-004), [CODEX-010](../dev/adapters/codex.md#codex-010), [ENG-022](../user/engine.md#eng-022), [ENG-023](../user/engine.md#eng-023)

Given the Codex CLI can initialize its native sandbox, a credential-free Codex sandbox probe shall show that the built-in `:workspace` profile cannot write inside `.git`, while cligent's generated extra-writes profile delivery grants `write` for `.git` without creating or modifying repository `.codex/config.toml` or user-level Codex `config.toml`. Mapping tests shall prove that managed writable mappings encode active-project trust as a top-level `projects={<path>={trust_level="trusted"}}` inline table rather than a quoted dotted path, perform Codex-compatible Windows device-prefix simplification, and resolve linked worktrees to Codex's main-repository trust root; read-only mappings and mappings without a non-empty caller `cwd` shall not inject project trust. Given `CligentOptions.permissions = { mode: 'auto', writablePaths: ['.git'] }` and Codex credentials, a real Codex SDK run in a throwaway git repository shall complete a git metadata write without `permission_request`, denied tool results, or error events, and without creating or modifying repository or user-level Codex config files, including persisted `projects.<path>.trust_level` entries for the throwaway workspace. As in [TADAPT-019](#tadapt-019), the Codex leg shall self-skip with a logged reason when the host cannot initialize Codex's native sandbox, and shall hard-fail under `CI` for missing Codex dependencies or credentials.

### TADAPT-024
Verifies: [CODEX-004](../user/adapters/codex.md#codex-004)

Given Codex credentials and a throwaway `CODEX_HOME` whose `config.toml` grants broader user-level Codex access with legacy `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`, when a no-policy Codex `Cligent` is invoked to write a file outside its throwaway working directory, the file shall exist on disk after the run, the event stream shall contain no `permission_request` event, no `tool_result` with `status: 'denied'`, and no `error` event, and the terminal `done` status shall be `success`.
With the same `CODEX_HOME`, when a Codex `Cligent` constructed with `CligentOptions.permissions = { mode: 'auto' }` is invoked to write a different file outside its throwaway working directory, the file shall not exist on disk after the run, the event stream shall contain no `error` event, and the terminal `done` status shall be `success`.
The probe shall restore the caller's `CODEX_HOME` after the run and shall use the same Codex sandbox-init skip / CI hard-fail rules as [TADAPT-019](#tadapt-019).
This item is the real-run counterpart to [TADAPT-004](#tadapt-004)'s mapping check for `exec --ignore-user-config`: the no-policy control proves runs without `permissions` inherit Codex user config, and the permission-managed leg proves that config no longer overrides Cligent's managed `:workspace` profile.
