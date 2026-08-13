<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-049: Billable Usage Records

## Goal

Make the reported accounting sufficient to price a run against a published rate card, per the billable
decomposition added to [DR-014](../decisions/014-unified-token-usage-breakdown.md).
[IR-047](047-unified-token-usage-breakdown.md) partitioned the totals by component; a rate is selected per
model and per request, so a component partition alone still cannot be priced, and on Claude Code the totals
did not even cover the whole run.

## Deliverables

- [x] Claude Code reports one `init` per run instead of one per `system` notice.
- [x] Claude Code's aggregates cover every model request the run made, including subagents, and carry the
      cost the runtime computed.
- [x] `DoneUsage.records` decomposes a run into billable groups carrying model, provider, request count, and
      cost, summing exactly to `breakdown` or omitted whole.
- [x] Claude Code, OpenCode, and Codex publish records at the granularity each runtime actually measures.
- [x] Callers can tell from the shipped documentation which record granularity each agent offers and when a
      context-length tier is determinable.

## Tasks

Each task is one commit and keeps build, typecheck, lint, and unit checks green at its boundary.

1. [x] **Emit `init` once per run.**
   Guard the Claude `system` handler on a first-message flag; amend
   [CLAUDE-003](../user/adapters/claude-code.md#claude-003).
   Measured 36 `init` events on one live run before the fix, each after the first carrying an empty tool
   list that replaced the real capabilities.
2. [x] **Account for the whole run.**
   Derive Claude aggregates from `result.modelUsage` rather than `result.usage`, falling back to the
   main-loop counters when the per-model map is absent or malformed; rewrite
   [CLAUDE-011](../user/adapters/claude-code.md#claude-011), which previously asserted — falsely — that no
   runtime surface partitions the additional spend.
   Keep the [CLAUDE-010](../user/adapters/claude-code.md#claude-010) no-op signature on the main-loop
   counters, since the repair turn reports zero there while the run may already have spent tokens.
   Measured under-reporting on one subagent run: input 50%, output 63%.
3. [x] **Pass the runtime's cost through.**
   Read `total_cost_usd` from the result message.
4. [x] **Add the record structure.**
   Add `UsageRecord` and `DoneUsage.records`, the summing builder, and
   [ENG-030](../user/engine.md#eng-030); amend [DR-014](../decisions/014-unified-token-usage-breakdown.md)
   to promote per-model attribution off its deferral list; publish Claude's per-model records.
5. [x] **Record OpenCode per request.**
   One record per step-finish part with `requests: 1`, its own cost, and the model and provider of the
   owning assistant message; amend [OPENCODE-005](../user/adapters/opencode.md#opencode-005).
6. [x] **Record the Codex turn.**
   One record for the turn with the pinned model and no request count; add
   [CODEX-014](../user/adapters/codex.md#codex-014).
7. [x] **Pin acceptance coverage.**
   Add [TENG-021](../test/engine.md#teng-021) and [TADAPT-039](../test/adapters.md#tadapt-039) with their
   `Verifies:` lines, plus the integration coverage they name.
8. [x] **Document the decomposition.**
   Extend the guide's token-usage section with the record fields and per-agent granularity, and record the
   additive change in the changelog.

## Acceptance criteria

- A run's records sum to its `breakdown` component by component, or no records are published.
- No record names a model the runtime did not name; a placeholder never appears.
- A record covering exactly one request says so, and one covering an unreported number omits the count.
- Claude Code emits exactly one `init` per run, and its aggregates and cost cover subagent work.
- Records are absent wherever `tokenAvailability` is `'unavailable'`.
- Cligent publishes no rate card and derives no cost of its own.

## Verification

- Claude Code: live API runs confirm one `init`, whole-run aggregates, a populated cost, and one record per
  model summing to the breakdown.
- OpenCode: a live run confirms one record per step with model, provider, and cost, summing to both the
  breakdown and the run's total cost.
- Codex: fixtures only. The account was over its usage limit through 2026-08-17, and the limit path itself
  degrades correctly to unavailable accounting with no breakdown and no records.
- Gemini and Kimi publish no breakdown, so they publish no records; both remain as
  [IR-047](047-unified-token-usage-breakdown.md) left them.
