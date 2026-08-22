<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-008: Fanout Acceptance Tests

## Status

Complete

The original direct fanout harness and main-push CI job were delivered, then replaced by the stronger tmux-play runtime harness.
The evolved harness now verifies the complete deterministic fanout acceptance oracle as well as the live four-agent result.

## Intent

Add end-to-end acceptance tests that exercise the full Fanout pipeline (prompt → response → done) with real API keys while minimizing token spend.

## Deliverables

- [x] `src/app/fanout.acceptance.test.ts` — original acceptance test, later
  replaced by `src/app/tmux-play/fanout.acceptance.test.ts`
- [x] `config/vitest.config.ts` — update include to exclude `*.acceptance.test.ts`
- [x] `config/vitest.acceptance.config.ts` — vitest config for acceptance tests only
- [x] `package.json` — add `test:acceptance` script
- [x] `.github/workflows/ci.yml` — add `acceptance` job

## Tasks

1. [x] **Update vitest config for test separation**
   - Change `vitest.config.ts` include to exclude `*.acceptance.test.ts`
   - Create `vitest.acceptance.config.ts` including only `*.acceptance.test.ts`
   - Add `test:acceptance` script to `package.json`

2. [x] **Write acceptance test** (`src/app/fanout.acceptance.test.ts`)
   - Create temp work dir via `mkdtempSync`, run `git init` (required by Codex/OpenCode)
   - Create empty `<agent>.log` files, `.fanout-session` marker, and a sentinel file (`SENTINEL_<short-uuid>.txt`) in the work dir
   - Call `resolveAgents()` with explicit entries for all four agents to test Fanout wiring
   - For each agent, run `cligent.run("List the files in the current directory", { cwd: workDir, permissions, abortSignal, model? })` where permissions default to `{ shellExecute: 'allow', fileWrite: 'deny', networkAccess: 'deny' }` with Codex overridden to all-allow (required for `approvalPolicy: 'never'`); OpenCode uses explicit `model: 'moonshotai-cn/kimi-k2.5'`; drain events to the log file using `formatEvent()`
   - Read each agent's log after completion
   - Assert: boss echo present, sentinel filename appears in text output, `[success | ...]` done line
   - 120 s vitest timeout, AbortController with timeout, cleanup in afterAll

3. [x] **Add CI acceptance job**
   - New `acceptance` job in `.github/workflows/ci.yml`
   - Trigger: push to main only (not PRs, to protect secrets)
   - Node 22, ubuntu-latest
   - Install agent SDKs: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`, `@google/gemini-cli` (global)
   - Set API keys from secrets: `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `MOONSHOT_API_KEY`
   - Run `npm run test:acceptance`

4. [x] **Align the evolved fanout acceptance oracle**
   - Assert the deterministic Captain prompt contains every player's status
     and final text, while the live Captain result retains the sentinel check.
   - Assert all player prompts precede every player completion before Captain
     summarization begins.

## Verification

- `npm test` still passes (unit tests only, no acceptance tests included)
- `npm run test:acceptance` passes with API keys and SDKs present
- CI acceptance job green on main push
