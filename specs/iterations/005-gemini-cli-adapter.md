<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-005: Gemini CLI Adapter

## Goal

Implement the Gemini CLI adapter by spawning the `gemini` CLI process and parsing its NDJSON stream output, normalizing events to the Unified Event Stream and mapping UPM capabilities to Gemini CLI tool controls — per [DR-001](../decisions/001-unified-cli-agent-interface-architecture.md#gemini-via-stream-parser) and [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md).

## Status

Done

## Deliverables

- [x] `src/adapters/gemini.ts` — `GeminiAdapter` implementing `AgentAdapter`
- [x] `src/adapters/ndjson.ts` — reusable `parseNDJSON()` async generator utility
- [x] Sub-path export: `cligent/adapters/gemini`
- [x] Unit tests with mocked child process

## Tasks

1. **Implement `parseNDJSON()` utility** (`src/adapters/ndjson.ts`)
   - Async generator that accepts a `Readable` stream
   - Handles line buffering (partial lines across chunks)
   - Parses each newline-delimited JSON line
   - Yields parsed objects; malformed lines yield a `{ ok: false, error: string, raw: string }` discriminated result (valid lines yield `{ ok: true, data: unknown }`) so the consumer can handle parse errors without a side channel

2. **Implement `GeminiAdapter`** (`src/adapters/gemini.ts`)
   - Implements `AgentAdapter` with `agent: 'gemini'`
   - `isAvailable()` — checks if `gemini` CLI is on PATH via spawn-based probe (e.g., `execFile('gemini', ['--version'])`)
   - `run()` — spawns `gemini --output-format stream-json <prompt>`, pipes stdout through `parseNDJSON()`, yields normalized events

3. **Gemini NDJSON → AgentEvent normalization**
   - `init` NDJSON event → `init` event (model, cwd, tools)
   - `message` event → `text` event
   - `tool_use` event → `tool_use` event
   - `tool_result` event → `tool_result` event
   - `error` event → `error` event
   - `result` event → `done` event with usage stats
   - `parseNDJSON()` `{ ok: false }` result → `error` event with `recoverable: true` and `message` containing the parse error and raw line; stream continues

4. **Exit code mapping**
   - `0` → `done` with status `'success'`
   - `1` → `done` with status `'error'`
   - `42` → `done` with status `'error'` (input error)
   - `53` → `done` with status `'max_turns'`

5. **UPM → Gemini CLI tool controls mapping**
   - Map `PermissionPolicy` per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm):
     - `'allow'` capabilities → `--allowed-tools` flag for auto-approval (deprecated; prefer `--policy` with TOML rules when available)
     - `'deny'` capabilities → `tools.exclude` via settings or `--policy` rules with `decision = "deny"` for corresponding tool categories
   - Map `allowedTools`/`disallowedTools` to `tools.core`/`tools.exclude` settings or Policy Engine TOML rules

6. **AbortSignal → process termination**
   - `abortSignal` listener sends `SIGTERM` to the spawned process
   - On process exit after SIGTERM, yield `done` event with `status: 'interrupted'`
   - Clean up: handle process exit and stream close

7. **Configure sub-path export**
   - Add `"./adapters/gemini"` to package.json `"exports"` map

8. **Write unit tests**
   - Mock `child_process.spawn` with canned NDJSON output
   - Test `parseNDJSON()` with complete lines, partial lines, and malformed JSON
   - Verify each Gemini NDJSON event type maps to the correct AgentEvent type
   - Verify malformed NDJSON lines produce `error` events with `recoverable: true`
   - Verify exit code → done status mapping
   - Verify UPM → CLI flag mapping
   - Verify AbortSignal sends SIGTERM and yields appropriate done event
   - Verify `isAvailable()` behavior

## Verification

- `tsc --noEmit` passes
- `vitest run` passes all unit tests
- `import('cligent/adapters/gemini')` resolves the adapter
- `parseNDJSON()` handles edge cases (partial lines, malformed JSON, empty lines)
