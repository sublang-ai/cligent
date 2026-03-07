<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-008: AllSides Acceptance Tests

## Goal

Add end-to-end acceptance tests that exercise the full AllSides pipeline (prompt → response → done) with real API keys while minimizing token spend.

## Status

Complete

## Design

### Test file

`src/app/allsides.acceptance.test.ts`

- Unsets `CLAUDECODE` env var to allow nested Claude Code sessions
- Creates a work dir inside the project tree (`.test-accept/run-<random>/`) so agents with project-scoped security policies can access the files
- Populates sentinel file (`SENTINEL_<uuid>.txt`) with known content (`CANARY_<uuid>`)
- Calls `resolveAgents()` with all four agents explicitly to test AllSides wiring
- Permissions: `{ shellExecute: 'allow', fileWrite: 'deny', networkAccess: 'deny' }` (Codex overridden to all-allow since it requires that for `approvalPolicy: 'never'`)
- Prompts use absolute paths so agents work regardless of their resolved cwd
- 110 s abort timeout per agent, cleanup in `afterAll`

### Output normalization

Adapter outputs may contain ANSI escape codes (`\x1b[7m`, `\x1b[27m`) and line-wrapping that splits UUIDs across lines. Two helpers handle this:

- `normalizeLog(s)` — strips ESC/CSI-prefixed ANSI sequences and collapses newlines to spaces. Used for log assertions (`boss>`, `[success |`).
- `assertContainsText(text, needle)` — strips all non-content characters (`[^a-zA-Z0-9._-]`) before checking `toContain`. Used for sentinel name and canary value assertions where line-wrapping inserts spaces inside UUIDs.

### Helper functions

| Helper | Purpose |
|--------|---------|
| `collectEvents(agent, prompt, options)` | Runs `cligent.run()`, returns `{ events, log, output }` where `output` combines formatted log + `done.payload.result` |
| `permissionsFor(agentName)` | Returns codex-all-allow vs standard permissions |
| `findDoneEvent(events)` | Extracts the single `done` event (throws if missing) |
| `findToolUseEvents(events)` | Extracts all `tool_use` events |

### Test groups

#### Group 1: `sentinel file listing` (existing)

4 `it()` blocks, one per agent. Prompt: `` `List the files in the directory ${workDir}` ``. Asserts: boss echo, sentinel filename in combined output, `[success |` done line.

#### Group 2: `tool use and event lifecycle` (new)

Shared `beforeAll` runs all 4 agents sequentially with prompt `` `Read the file ${join(workDir, sentinelName)} and state its contents` `` (absolute path), caching `RunResult` per agent. 4 `it()` blocks per agent (16 total), all reading from cache (zero extra API calls):

| Test | Assertion |
|------|-----------|
| `produces valid event lifecycle` | Has content events (text/text_delta/init/error); exactly 1 done as last event; `status === 'success'`; non-negative token counts |
| `emits no unknown_tool names in tool_use events` | When `tool_use` events are present, **none** may have `toolName === 'unknown_tool'` — failure includes full raw event JSON for debugging. (Some adapters like Claude Code bundle tools inside the result message and emit no discrete `tool_use` events.) |
| `reads file and returns sentinel content` | `sentinelContent` string (`CANARY_<uuid>`) appears in combined output |
| `captures resumeToken after successful run` | If `done.payload.resumeToken` present, it's a non-empty string matching `agent.cligent.resumeToken` |

The unknown-tool diagnostic (second test) catches adapter tool-name parsing failures that surface as `[tool: unknown_tool]` in logs.

#### Group 3: `auto-detection` (new, zero API cost)

1 `it()` block. Calls `resolveAgents(undefined, workDir)` — only invokes `isAvailable()`, no API tokens. Asserts: at least 1 agent detected; all names in known set; logs which agents detected for CI visibility.

#### Group 4: `abort handling` (new, near-zero API cost)

4 `it()` blocks, one per agent. Pre-aborts the `AbortController` before calling `run()`. Cligent's pre-abort short-circuit (ENG-009) yields a synthetic `done` immediately. Asserts: done event present with `status === 'interrupted'`. 30 s timeout (fast, deterministic, zero tokens).

### Token budget

| Group | API calls | Token spend |
|-------|-----------|-------------|
| 1 (listing) | 4 (1/agent) | Low |
| 2 (tool use) | 4 (1/agent) | Low-medium |
| 3 (auto-detect) | 0 | Zero |
| 4 (abort) | 4 (pre-aborted) | Zero |
| **Total** | **12 calls, 8 real** | **Low** |

### Test separation

- Acceptance tests use `*.acceptance.test.ts` naming
- Separate vitest include pattern so `npm test` runs unit tests only
- New `test:acceptance` script runs acceptance tests

### CI

New `acceptance` job in `.github/workflows/ci.yml`:

- Triggers on main push only (protects secrets)
- Node 22 only
- Installs: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`, `@google/gemini-cli` (global)
- API keys from GitHub secrets: `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `MOONSHOT_API_KEY`
- Runs `npm run test:acceptance`

## Deliverables

- [ ] `src/app/allsides.acceptance.test.ts` — acceptance test file
- [ ] `vitest.config.ts` — update include to exclude `*.acceptance.test.ts`
- [ ] `vitest.acceptance.config.ts` — vitest config for acceptance tests only
- [ ] `package.json` — add `test:acceptance` script
- [ ] `.github/workflows/ci.yml` — add `acceptance` job

## Tasks

1. **Update vitest config for test separation**
   - Change `vitest.config.ts` include to exclude `*.acceptance.test.ts`
   - Create `vitest.acceptance.config.ts` including only `*.acceptance.test.ts`
   - Add `test:acceptance` script to `package.json`

2. **Write acceptance test** (`src/app/allsides.acceptance.test.ts`)
   - Create temp work dir via `mkdtempSync`
   - Create log files, `.allsides-session` marker, and sentinel file with known content (`CANARY_<uuid>`)
   - Call `resolveAgents()` with explicit entries for all four agents
   - **Group 1**: Sentinel file listing — prompt each agent to list files, assert sentinel filename in output
   - **Group 2**: Tool use and event lifecycle — prompt each agent to read sentinel file; assert valid event lifecycle, known tool names (unknown-tool diagnostic), sentinel content in log, resumeToken capture
   - **Group 3**: Auto-detection — call `resolveAgents(undefined, workDir)`, assert at least 1 agent detected with known names
   - **Group 4**: Abort handling — pre-abort AbortController, assert `done` with `status === 'interrupted'`
   - Helper functions: `collectEvents`, `permissionsFor`, `findDoneEvent`, `findToolUseEvents`

3. **Add CI acceptance job**
   - New `acceptance` job in `.github/workflows/ci.yml`
   - Trigger: push to main only (not PRs, to protect secrets)
   - Node 22, ubuntu-latest
   - Install agent SDKs: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`, `@google/gemini-cli` (global)
   - Set API keys from secrets: `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `MOONSHOT_API_KEY`
   - Run `npm run test:acceptance`

## Verification

- `npm test` still passes (unit tests only, no acceptance tests included)
- `npm run test:acceptance` passes with API keys and SDKs present
- CI acceptance job green on main push
