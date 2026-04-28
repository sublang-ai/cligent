<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TADAPT: Adapter Tests

Verification criteria for all adapters. Shared patterns apply to each adapter; per-adapter sections cover unique behaviors.

## Shared

### TADAPT-001

Given canned native events for each adapter, when running the adapter, the yielded `AgentEvent` types shall match the normalization table for that adapter.

### TADAPT-002

Where the adapter uses an SDK (Claude Code, Codex, OpenCode), when the SDK is not installed, `isAvailable()` shall return `false` and `run()` shall throw.

### TADAPT-003

When `AbortSignal` fires during an adapter's `run()`, the adapter shall yield `done` (`status: 'interrupted'`).

### TADAPT-004

Given all `PermissionLevel` combinations, each adapter shall map `PermissionPolicy` to the correct vendor-specific controls.

## Claude Code

### TADAPT-005

Given `PermissionPolicy` combinations, the Claude Code adapter shall produce the correct `permissionMode` and `canUseTool` callback behavior for all permission-mode branches (bypass, acceptEdits, default with allow, default with deny).

## Codex

### TADAPT-006

The Codex adapter shall emit `codex:file_change` extension events for file changes.

## Gemini

### TADAPT-007

Given partial lines, malformed JSON, and empty lines, `parseNDJSON()` shall produce the correct `NDJSONParseResult` values. Given process exit codes 0, 1, 42, and 53, the Gemini adapter shall yield the corresponding `done` status.

## OpenCode

### TADAPT-008

The OpenCode adapter shall filter events by `sessionId`, pass through events with no session or thread identifier per [OPENCODE-006](../user/adapters/opencode.md#opencode-006), emit `opencode:file_part` and `opencode:image_part` extension events, manage the server lifecycle in managed mode, and yield `error` (`code: 'OPENCODE_SERVER_EXIT'`) followed by `done` (`status: 'error'`) on server crash.

## Tool Filtering

### TADAPT-009

Given `allowedTools` and `disallowedTools` options, each adapter shall restrict tools according to whitelist and precedence semantics per [ENG-017](../user/engine.md#eng-017).

## Resume Token

### TADAPT-010

The Claude Code adapter shall set `DonePayload.resumeToken` to the session identifier from the SDK result per [CLAUDE-007](../user/adapters/claude-code.md#claude-007).

### TADAPT-011

The Codex adapter shall set `DonePayload.resumeToken` to the thread identifier per [CODEX-006](../user/adapters/codex.md#codex-006).

### TADAPT-012

The OpenCode adapter shall set `DonePayload.resumeToken` to the session identifier per [OPENCODE-011](../user/adapters/opencode.md#opencode-011).

### TADAPT-013

Given a Gemini stream that provides a session identifier, the adapter shall set `DonePayload.resumeToken` to that value. Given a stream with no session identifier (e.g., early error), the adapter shall omit `resumeToken` per [GEMINI-009](../user/adapters/gemini.md#gemini-009).

### TADAPT-016

The Gemini adapter shall set `GEMINI_CLI_TRUST_WORKSPACE=true` by default in the spawned process environment per [GEMINI-010](../user/adapters/gemini.md#gemini-010).

## Concurrency

### TADAPT-014

Where an adapter does not document an environmental constraint, concurrent `run()` calls on the same adapter instance shall emit no cross-stream event leakage (events from one call shall not appear in another), maintain per-call options isolation, and not mutate adapter instance state per [ENG-018](../user/engine.md#eng-018).

## Codex Resume

### TADAPT-015

When `resume` is provided, the Codex adapter shall continue the previous thread per [CODEX-005](../user/adapters/codex.md#codex-005).
