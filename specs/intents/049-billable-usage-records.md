<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-049: Billable Usage Records

## Status

Complete

This record preserves the first billable-record implementation.
The current [DR-014](../decisions/014-unified-token-usage-breakdown.md) nests those records under authentic inclusive totals, adds coverage and cost provenance, and removes the unreleased aggregate/decomposition identity it originally targeted.

## Intent

Make the reported accounting sufficient to price a run against a published rate card, per the billable decomposition added to [DR-014](../decisions/014-unified-token-usage-breakdown.md).
A component partition alone still cannot be priced because a rate is selected per model and per request, and on Claude Code the earlier totals did not even cover the whole run.

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

1. [x] **Emit `init` once per run, from the handshake.**
   Identify the handshake by `subtype: 'init'` and emit nothing for any other `system` notice; amend
   [[claude-code-15](../packages/adapters/claude-code.md#claude-code-15)].
   Measured 36 `init` events on one live run before the fix, each after the first carrying an empty tool
   list that replaced the real capabilities.
   The first attempt guarded on a first-message flag instead, which a review then showed to be wrong in the
   opposite direction: a run with a `SessionStart` hook puts four `system` notices ahead of the handshake,
   observed live, so the flag latched onto an empty-tool notice and suppressed the real capabilities
   permanently. Position cannot identify the handshake; the subtype can.
2. [x] **Account for the whole run.**
   Derive Claude aggregates from `result.modelUsage` rather than `result.usage`, falling back to the
   main-loop counters when the per-model map is absent or malformed; rewrite
   the then-current Claude aggregate-source item, which previously asserted — falsely — that no runtime
   surface partitions the additional spend. [[claude-code-12](../packages/adapters/claude-code.md#claude-code-12)]
   now carries the surviving authenticity rule.
   Keep the [[claude-code-28](../packages/adapters/claude-code.md#claude-code-28)] no-op signature on the main-loop
   counters, since the repair turn reports zero there while the run may already have spent tokens.
   Measured under-reporting on one subagent run: input 50%, output 63%.
3. [x] **Pass the runtime's cost through.**
   Read `total_cost_usd` from the result message.
4. [x] **Add the record structure.**
   Add `UsageRecord` and `DoneUsage.records`, the summing builder, and
   the then-current billable-record item; amend [DR-014](../decisions/014-unified-token-usage-breakdown.md)
   to promote per-model attribution off its deferral list; publish Claude's per-model records.
   [[engine-59](../packages/engine.md#engine-59)] now carries record reconciliation.
5. [x] **Record OpenCode per request.**
   One record per step-finish part with `requests: 1`, its own cost, and the model and provider of the
   owning assistant message; amend the then-current OpenCode accounting item.
   [[opencode-21](../packages/adapters/opencode.md#opencode-21)] now carries the causal report.
6. [x] **Record the Codex turn.**
   One record for the turn with the pinned model and no request count; add
   the then-current Codex record item. [[codex-17](../packages/adapters/codex.md#codex-17)]
   now carries runtime-observed attribution.
7. [x] **Pin acceptance coverage.**
   Add the then-current engine and cross-adapter record checks with their
   `Verifies:` lines; [[engine-70](../packages/engine.md#engine-70)] and
   [[engine-240](../packages/engine.md#engine-240)] now carry that coverage.
8. [x] **Document the decomposition.**
   Extend the guide's token-usage section with the record fields and per-agent granularity, and record the
   additive change in the changelog.

## Verification

- A run's records sum to its `breakdown` component by component, or no records are published.
- No record names a model the runtime did not name; a placeholder never appears.
- A record covering exactly one request says so, and one covering an unreported number omits the count.
- Claude Code emits exactly one `init` per run, and its aggregates and cost cover subagent work.
- Records are absent wherever `tokenAvailability` is `'unavailable'`.
- Cligent publishes no rate card and derives no cost of its own.

- Claude Code: live API runs confirm one `init`, whole-run aggregates, a populated cost, and one record per
  model summing to the breakdown.
- OpenCode: a live run confirms one record per step with model, provider, and cost, summing to both the
  breakdown and the run's total cost.
- Codex: fixtures only. The account was over its usage limit through 2026-08-17, and the limit path itself
  degrades correctly to unavailable accounting with no breakdown and no records.
- Gemini and Kimi publish no breakdown, so they publish no records; both remain
  unchanged from the earlier component-accounting implementation.
