<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-008: AllSides Acceptance Tests

## Goal

Add end-to-end acceptance tests that exercise the full AllSides pipeline (prompt → response → done) with real API keys while minimizing token spend.

## Status

Todo

## Design

### Test file

`apps/allsides/src/allsides.acceptance.test.ts`

- Creates a temp work dir with log files, a `.allsides-session` marker, and a sentinel file (`SENTINEL_<uuid>.txt`) used to verify output correctness
- Calls `resolveAgents()` with all four agents explicitly to test AllSides wiring
- Runs each agent via `cligent.run()` with `cwd` set to the work dir and run-time `permissions: { shellExecute: 'allow', fileWrite: 'deny', networkAccess: 'deny' }` (Codex overridden to all-allow since it requires that for `approvalPolicy: 'never'`)
- Reads each agent's log file after completion
- Asserts each log contains: boss echo, the sentinel filename in text output, and a `[success | ...]` done line
- 120 s timeout, abort signal, cleanup

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
- Runs `npm run test:acceptance -w apps/allsides`

## Deliverables

- [ ] `apps/allsides/src/allsides.acceptance.test.ts` — acceptance test file
- [ ] `apps/allsides/vitest.config.ts` — update include to exclude `*.acceptance.test.ts`
- [ ] `apps/allsides/vitest.acceptance.config.ts` — vitest config for acceptance tests only
- [ ] `apps/allsides/package.json` — add `test:acceptance` script
- [ ] `.github/workflows/ci.yml` — add `acceptance` job

## Tasks

1. **Update vitest config for test separation**
   - Change `apps/allsides/vitest.config.ts` include to exclude `*.acceptance.test.ts`
   - Create `apps/allsides/vitest.acceptance.config.ts` including only `*.acceptance.test.ts`
   - Add `test:acceptance` script to `apps/allsides/package.json`

2. **Write acceptance test** (`apps/allsides/src/allsides.acceptance.test.ts`)
   - Create temp work dir via `mkdtempSync`
   - Create empty `<agent>.log` files, `.allsides-session` marker, and a sentinel file (`SENTINEL_<uuid>.txt`) in the work dir
   - Call `resolveAgents()` with explicit entries for all four agents to test AllSides wiring
   - For each agent, run `cligent.run("List the files in the current directory", { cwd: workDir, permissions, abortSignal })` where permissions default to `{ shellExecute: 'allow', fileWrite: 'deny', networkAccess: 'deny' }` with Codex overridden to all-allow (required for `approvalPolicy: 'never'`); drain events to the log file using `formatEvent()`
   - Read each agent's log after completion
   - Assert: boss echo present, sentinel filename appears in text output, `[success | ...]` done line
   - 120 s vitest timeout, AbortController with timeout, cleanup in afterAll

3. **Add CI acceptance job**
   - New `acceptance` job in `.github/workflows/ci.yml`
   - Trigger: push to main only (not PRs, to protect secrets)
   - Node 22, ubuntu-latest
   - Install agent SDKs: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`, `@google/gemini-cli` (global)
   - Set API keys from secrets: `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `MOONSHOT_API_KEY`
   - Run `npm run test:acceptance -w apps/allsides`

## Verification

- `npm test` still passes (unit tests only, no acceptance tests included)
- `npm run test:acceptance -w apps/allsides` passes with API keys and SDKs present
- CI acceptance job green on main push
