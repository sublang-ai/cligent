<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# GEMINI: Gemini CLI Adapter

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

## Options Mapping

### GEMINI-007

The adapter shall map `AgentOptions` fields to CLI flags: `model` → `--model`, `maxTurns` → `--max-session-turns`, `resume` → `--resume`.

### GEMINI-010

The adapter shall set `GEMINI_CLI_TRUST_WORKSPACE=true` in the spawned Gemini CLI environment by default for headless runs, while preserving an explicit caller-provided environment value.

## Abort Handling

### GEMINI-008

When `AbortSignal` fires, the adapter shall send `SIGTERM` to the spawned process. When the process exits after SIGTERM, the adapter shall yield `done` (`status: 'interrupted'`).

## Resume Token

### GEMINI-009

When the Gemini CLI stream provides a session identifier, the adapter shall set `DonePayload.resumeToken` to that value, enabling `Cligent` auto-resume via `--resume` per [DR-003](../../decisions/003-role-scoped-session-management.md#session-continuity-via-resume-token). When no session identifier is received, the adapter shall omit `resumeToken`.
