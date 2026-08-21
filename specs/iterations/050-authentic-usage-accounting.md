<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-050: Authentic Usage Accounting

## Goal

Replace the released flat token placeholders and the unreleased disjoint breakdown with authentic,
coverage-aware, rate-card-oriented usage reports, then use the strongest supported source each coding agent
actually exposes.

## Status

Done

## Deliverables

- [x] [DR-014](../decisions/014-unified-token-usage-breakdown.md) defines inclusive nested totals, exact
      subsets, coverage, billable records, cost provenance, and supplementary-source safety.
- [x] The public `DoneUsage` type removes flat token, availability, and cost fields while retaining accurate
      tool counts and optional token/cost reports.
- [x] Claude Code, Codex, Gemini, OpenCode, and Kimi follow their authenticated runtime boundaries.
- [x] Specs, guide, changelog, declarations, and unit/acceptance coverage describe the breaking migration.

## Tasks

1. [x] **Replace the public contract.**
   Amend [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md),
   [DR-014](../decisions/014-unified-token-usage-breakdown.md), [[engine-31](../packages/engine.md#engine-31)], and
   [[engine-122](../packages/engine.md#engine-122)]; replace the declarations and shared validators.
2. [x] **Publish whole-tree Claude accounting and scoped Codex deltas.**
   Implement [[claude-code-12](../packages/adapters/claude-code.md#claude-code-12)] and
   [[codex-17](../packages/adapters/codex.md#codex-17)], including estimate provenance and exact omission.
3. [x] **Collect Gemini response telemetry.**
   Implement [[gemini-17](../packages/adapters/gemini.md#gemini-17)] with one run-owned local telemetry file
   [[gemini-42](../packages/adapters/gemini.md#gemini-42)], per-response records
   [[gemini-38](../packages/adapters/gemini.md#gemini-38)], stream cross-validation
   [[gemini-39](../packages/adapters/gemini.md#gemini-39)], and cleanup
   [[gemini-35](../packages/adapters/gemini.md#gemini-35)].
4. [x] **Make OpenCode accounting causal and idempotent.**
   Implement [[opencode-21](../packages/adapters/opencode.md#opencode-21)], [[opencode-44](../packages/adapters/opencode.md#opencode-44)], [[opencode-45](../packages/adapters/opencode.md#opencode-45)], [[opencode-46](../packages/adapters/opencode.md#opencode-46)], [[opencode-47](../packages/adapters/opencode.md#opencode-47)], [[opencode-48](../packages/adapters/opencode.md#opencode-48)], [[opencode-49](../packages/adapters/opencode.md#opencode-49)], [[opencode-50](../packages/adapters/opencode.md#opencode-50)], and [[opencode-51](../packages/adapters/opencode.md#opencode-51)] across the root/task tree without widening conversational output or charging unrelated background sessions.
5. [x] **Keep Kimi honest.**
   Implement [[kimi-13](../packages/adapters/kimi.md#kimi-13)]: omit accounting the pinned ACP runtime does not
   expose while preserving stop status, result, and tool count.
6. [x] **Migrate callers and documentation.**
   Update internal formatters, fixtures, [[engine-240](../packages/engine.md#engine-240)], the guide, map, and
   changelog; document which agents remain insufficient for exact price calculation.
7. [x] **Verify the release surface.**
   Run focused adapter suites, type tests, typecheck, lint, build, full unit tests, package checks, and the
   feasible real-agent acceptance legs.
8. [x] **Prove Gemini telemetry against the real CLI.**
   Add [[gemini-241](../packages/adapters/gemini.md#gemini-241)] and require the existing credentialed Gemini acceptance
   leg to emit non-empty per-response usage after strict stream reconciliation.

## Acceptance criteria

- No emitted or declared `DoneUsage` contains `tokenAvailability`, `inputTokens`, `outputTokens`,
  `totalCostUsd`, or `breakdown`.
- Missing token accounting is omission, while an authentic zero remains a present zero.
- Every token report states complete or partial causal coverage and every record reconciles to its totals.
- Claude Code and OpenCode pass through agent-estimated cost with explicit provenance; no adapter applies a
  Cligent price table.
- Gemini records include thinking, cache, model, request, and descendant activity only after stream
  reconciliation.
- Codex reports an exact partial root-thread delta; Kimi reports no tokens on the pinned ACP target.
- Synthesized terminals preserve tool counts and contain no token or cost placeholder.
