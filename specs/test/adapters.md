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

## Claude Code

### TADAPT-005
Verifies: [CLAUDE-004](../user/adapters/claude-code.md#claude-004), [CLAUDE-005](../user/adapters/claude-code.md#claude-005)

Given `PermissionPolicy` combinations, the Claude Code adapter shall produce the correct `permissionMode` and `canUseTool` callback behavior for all permission-mode branches (bypass, acceptEdits, default with allow, default with deny).

## Codex

### TADAPT-006
Verifies: [CODEX-003](../user/adapters/codex.md#codex-003)

The Codex adapter shall emit `codex:file_change` extension events for file changes.

### TADAPT-017
Verifies: [CODEX-003](../user/adapters/codex.md#codex-003)

Given Codex emits an error whose message is a JSON-encoded object string, the Codex adapter shall expose the human-readable detail/message content in the normalized `error.message`, may unwrap nested error envelopes to reach that content, and shall not pass the raw JSON string through to pane-facing consumers.

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
