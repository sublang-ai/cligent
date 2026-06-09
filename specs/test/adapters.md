<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TADAPT: Adapter Tests

## Intent

Verification criteria for all adapters. Shared patterns apply to each adapter; per-adapter sections cover unique behaviors.

## Shared

### TADAPT-001
Verifies: [CLAUDE-003](../user/adapters/claude-code.md#claude-003), [CODEX-003](../user/adapters/codex.md#codex-003), [GEMINI-004](../user/adapters/gemini.md#gemini-004), [GEMINI-005](../user/adapters/gemini.md#gemini-005), [OPENCODE-005](../user/adapters/opencode.md#opencode-005)

Given canned native events for each adapter, when running the adapter, the yielded `AgentEvent` types shall match the normalization table for that adapter.

### TADAPT-002
Verifies: [CLAUDE-002](../user/adapters/claude-code.md#claude-002), [CODEX-002](../user/adapters/codex.md#codex-002), [OPENCODE-002](../user/adapters/opencode.md#opencode-002), [OPENCODE-003](../user/adapters/opencode.md#opencode-003)

Where the adapter uses an SDK (Claude Code, Codex, OpenCode), when the SDK is not installed, `isAvailable()` shall return `false` and `run()` shall throw.

### TADAPT-003
Verifies: [ENG-009](../user/engine.md#eng-009), [GEMINI-008](../user/adapters/gemini.md#gemini-008)

When `AbortSignal` fires during an adapter's `run()`, the adapter shall yield `done` (`status: 'interrupted'`).

### TADAPT-004
Verifies: [CLAUDE-004](../user/adapters/claude-code.md#claude-004), [CLAUDE-005](../user/adapters/claude-code.md#claude-005), [CODEX-004](../user/adapters/codex.md#codex-004), [GEMINI-006](../user/adapters/gemini.md#gemini-006), [OPENCODE-007](../user/adapters/opencode.md#opencode-007)

Given all `PermissionLevel` combinations, each adapter shall map `PermissionPolicy` to the correct vendor-specific controls.

### TADAPT-022
Verifies: [CLAUDE-004](../user/adapters/claude-code.md#claude-004), [GEMINI-006](../user/adapters/gemini.md#gemini-006), [OPENCODE-007](../user/adapters/opencode.md#opencode-007), [ENG-022](../user/engine.md#eng-022), [ENG-023](../user/engine.md#eng-023)

Given a Claude Code, Gemini, or OpenCode `PermissionPolicy` whose `writablePaths` contains valid entries and no independently active filesystem-sandbox write-grant surface, the adapter's permission mapping shall expose canonical `WritablePathsPermissionMapping` paths with `enforcement: 'ambient'` and shall preserve the existing adapter-specific permission/tool mapping. Given invalid `writablePaths`, the mapping shall reject the policy.

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

## OpenCode

### TADAPT-008
Verifies: [OPENCODE-005](../user/adapters/opencode.md#opencode-005), [OPENCODE-006](../user/adapters/opencode.md#opencode-006), [OPENCODE-008](../user/adapters/opencode.md#opencode-008), [OPENCODE-009](../user/adapters/opencode.md#opencode-009), [OPENCODE-010](../user/adapters/opencode.md#opencode-010)

The OpenCode adapter shall filter events by `sessionId`, pass through events with no session or thread identifier per [OPENCODE-006](../user/adapters/opencode.md#opencode-006), emit `opencode:file_part` and `opencode:image_part` extension events, manage the server lifecycle in managed mode, and yield `error` (`code: 'OPENCODE_SERVER_EXIT'`) followed by `done` (`status: 'error'`) on server crash.

## Tool Filtering

### TADAPT-009
Verifies: [ENG-017](../user/engine.md#eng-017)

Given `allowedTools` and `disallowedTools` options, each adapter shall restrict tools according to whitelist and precedence semantics per [ENG-017](../user/engine.md#eng-017).

## Reasoning Effort

### TADAPT-018
Verifies: [ENG-020](../user/engine.md#eng-020), [CLAUDE-008](../user/adapters/claude-code.md#claude-008), [CODEX-007](../user/adapters/codex.md#codex-007), [GEMINI-011](../user/adapters/gemini.md#gemini-011), [OPENCODE-012](../user/adapters/opencode.md#opencode-012)

Given each `ReasoningEffort` value in `AgentOptions.reasoningEffort`, the Claude Code adapter shall forward the SDK `effort` value from the [CLAUDE-008](../user/adapters/claude-code.md#claude-008) table and the Codex adapter shall forward the SDK `modelReasoningEffort` value from the [CODEX-007](../user/adapters/codex.md#codex-007) table. Given the same input with Gemini concrete model IDs matching `^gemini-3` or `^gemini-2\.5`, the Gemini adapter shall write the per-run settings alias and `thinkingLevel` / `thinkingBudget` values required by [GEMINI-011](../user/adapters/gemini.md#gemini-011), target that alias with `--model`, and preserve the documented no-alias skip behavior for unset, CLI-alias, and non-matching model values. Given the same input with OpenCode provider/model prefixes, the OpenCode adapter shall set the v2 prompt-body top-level `variant` values required by [OPENCODE-012](../user/adapters/opencode.md#opencode-012) and leave `variant` unset for unrecognised providers. Given `reasoningEffort` is omitted, no adapter shall set the corresponding SDK/CLI field, settings alias, or prompt-body variant.

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
Verifies: [CLAUDE-007](../user/adapters/claude-code.md#claude-007), [CODEX-006](../user/adapters/codex.md#codex-006), [GEMINI-009](../user/adapters/gemini.md#gemini-009), [OPENCODE-011](../user/adapters/opencode.md#opencode-011)

Given each adapter has observed a backend session or thread identifier during a run, when that run is aborted and yields terminal `done` with `status: 'interrupted'`, the adapter shall set `DonePayload.resumeToken` to the observed backend identifier.
Given each adapter is run with a non-empty `AgentOptions.resume` value and no backend session or thread identifier is observed before abort, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall set `DonePayload.resumeToken` to the inbound `resume` value.
Given the Claude Code adapter starts a run without `AgentOptions.resume` and no SDK activity beyond the initial `system` message is observed before abort, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall have passed a generated SDK `sessionId` and shall omit `DonePayload.resumeToken`.
Given the Claude Code adapter starts a run without `AgentOptions.resume` and SDK activity beyond the initial `system` message is observed before abort, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall set `DonePayload.resumeToken` to the SDK-provided or generated SDK `sessionId`.
Given a Codex, Gemini, or OpenCode adapter observes no backend session or thread identifier and has no non-empty inbound `resume` value before abort, when the run yields terminal `done` with `status: 'interrupted'`, the adapter shall omit `resumeToken`.

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

## Real-run Acceptance

Items in this section verify behavior end-to-end against the real coding-agent SDKs and CLIs (not mocks or canned events). They live under `src/adapters/*.acceptance.test.ts` and run via `npm run test:acceptance`. The SDK packages the adapters load (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`) are cligent `devDependencies`, so any checkout able to run this suite has installed them via `npm install`; their absence is therefore not a skip condition. An item shall self-skip per adapter when an *external* CLI the adapter spawns is absent from `PATH` — the `gemini` CLI for Gemini, the `opencode` CLI for OpenCode's managed server — or when that adapter's credential is absent from the environment; a missing dependency for one adapter shall not skip the others. Under `CI` the items shall instead hard-fail on a missing dependency so a misconfigured runner is not silently green.

### TADAPT-019
Verifies: [CLAUDE-004](../user/adapters/claude-code.md#claude-004), [CLAUDE-005](../user/adapters/claude-code.md#claude-005), [CODEX-004](../user/adapters/codex.md#codex-004), [GEMINI-006](../user/adapters/gemini.md#gemini-006), [OPENCODE-007](../user/adapters/opencode.md#opencode-007)

Given a `Cligent` constructed on each adapter with `CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first to create and then to delete a temporary file in a throwaway working directory, the adapter's auto-mode SDK knobs per [DR-005](../decisions/005-per-adapter-permission-configuration.md) and [ENG-021](../user/engine.md#eng-021) shall let both the file write and the file deletion proceed without an interactive approval. After the create run the file shall exist on disk; after the delete run it shall be gone. Neither run's event stream shall contain a `permission_request` event, a `tool_result` with `status: 'denied'`, or an `error` event, and each run shall terminate in a `done` with `status: 'success'`. Filesystem state is the ground-truth check for the write and the delete: adapters normalize file edits differently (e.g., Codex emits `codex:file_change`, OpenCode `opencode:file_part`), so a `tool_use`-count assertion would be adapter-specific. The probe exercises each adapter against its real SDK/CLI; transient upstream-overload failures shall be retried before the assertion. This item is the real-run counterpart to [TADAPT-004](#tadapt-004), which verifies the `PermissionPolicy`-to-SDK-knob mapping in isolation but never confirms the mapped knobs actually suppress approval prompts at the SDK.

Where the host cannot initialize an adapter's OS-level sandbox, that adapter's leg shall self-skip with a logged reason, including under `CI`. Codex's `mode: 'auto'` maps to the `:workspace` profile, which runs commands inside a bubblewrap sandbox that some CI runners cannot start; this is distinct from a missing dependency, since the SDK and credential are present and the environment simply cannot host the sandbox under test. The `mode: 'auto'` → SDK-knob mapping stays verified by [TADAPT-004](#tadapt-004); only the real-run write/delete leg is skipped, and only where the sandbox cannot start.
