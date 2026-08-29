<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-047: Unified Token-Usage Breakdown

## Status

Superseded; complete except task 8, which was deferred and never shipped

This record preserves the first additive breakdown implementation.
The current [DR-014](../decisions/014-unified-token-usage-breakdown.md) replaces that unreleased shape with inclusive nested totals and completes Gemini through run-owned telemetry.

## Intent

Publish the finest-grained token accounting each runtime actually measures, normalized into one disjoint component vocabulary per [DR-014](../decisions/014-unified-token-usage-breakdown.md), and correct the two runtimes whose aggregates are currently wrong or unreachable.

## Deliverables

- [x] [DR-014](../decisions/014-unified-token-usage-breakdown.md) records the component frame, the
      absence model, the publication constraints, and the fidelity-source policy.
- [x] `DonePayload.usage.breakdown` carries an optional five-component partition whose published sides sum
      exactly to the existing aggregates, which keep their values.
- [x] Codex reports per-turn usage instead of the thread-cumulative total it reports today.
- [ ] Gemini reports token accounting instead of failing a reconciliation that no thinking run can satisfy.
      Deferred with task 8.
- [x] Each adapter publishes exactly the components its runtime measures, and no others, for every runtime
      except Gemini.
- [x] Users can discover the feature and its per-agent coverage from the shipped documentation.

## Tasks

Each task is one commit and keeps build, typecheck, lint, and unit checks green at its boundary.
Spec work lands in the same commit as the code it governs, except tasks 1 and 2, which are contract-only and precede every code change.

1. [x] **Record the decision.**
   Add DR-014 and this record; amend [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md)
   `Key payloads` with the optional field and a pointer; index both in `map.md`.
2. [x] **Specify the engine contract.**
   Amend the then-current flat usage contract, add presence semantics and the
   fidelity-source rule, and record that ACP reports no usage today.
   [DR-019](../decisions/019-superseded-item-retirements.md) records the old
   items' retirement; [[engine-31](../packages/engine.md#engine-31)],
   [[engine-57](../packages/engine.md#engine-57)], [[engine-64](../packages/engine.md#engine-64)],
   and [[kimi-13](../packages/adapters/kimi.md#kimi-13)] carry the surviving concerns.
3. [x] **Add the type and the shared builder.**
   Add `TokenBreakdown` and the optional `DonePayload.usage.breakdown`; add a shared builder that enforces
   the partition and side-atomicity rules and drops any side it cannot satisfy; keep every synthesized
   terminal breakdown-free; render present components in the internal event formatter; extend the
   declaration test. No adapter behavior changes.
4. [x] **Publish the OpenCode breakdown.**
   Accumulate the five step-finish counters separately and publish both sides; amend
   the then-current OpenCode accounting item, whose causal successor is
   [[opencode-21](../packages/adapters/opencode.md#opencode-21)].
5. [x] **Publish the Claude Code input side.**
   Publish `input` / `cacheRead` / `cacheWrite` and withhold the output side;
   the current carriers are [[claude-code-12](../packages/adapters/claude-code.md#claude-code-12)],
   [[claude-code-29](../packages/adapters/claude-code.md#claude-code-29)], and
   [[claude-code-30](../packages/adapters/claude-code.md#claude-code-30)].
6. [x] **Correct Codex per-turn accounting.**
   Subtract a per-thread baseline from the cumulative snapshot, guard non-monotonic snapshots, and fail
   closed with no baseline; add [[codex-15](../packages/adapters/codex.md#codex-15)] and amend [[engine-37](../packages/engine.md#engine-37)] and [[engine-38](../packages/engine.md#engine-38)] with the
   baseline carve-out.
7. [x] **Publish the Codex breakdown.**
   Derive both sides by guarded subtraction from the per-turn delta; add
   [[codex-16](../packages/adapters/codex.md#codex-16)].
   The optional cost passthrough is retained rather than removed: it cannot produce a wrong number, since an
   absent field stays absent, and dropping it would forfeit forward compatibility for no gain.
8. [ ] **Supplement Gemini accounting from its transcript.** *Deferred.*
   This historical transcript proposal was never implemented and shall not be
   executed from this superseded record. The current [DR-014](../decisions/014-unified-token-usage-breakdown.md)
   design instead uses run-owned telemetry through [[gemini-17](../packages/adapters/gemini.md#gemini-17)],
   [[gemini-37](../packages/adapters/gemini.md#gemini-37)],
   [[gemini-39](../packages/adapters/gemini.md#gemini-39)], and
   [[gemini-40](../packages/adapters/gemini.md#gemini-40)];
   [DR-019](../decisions/019-superseded-item-retirements.md) retires the old
   stream-only carrier.
   Blocked on evidence, not design: the streamed statistics provably cannot partition the residual, because
   `convertToStreamStats` forwards only five of the seven per-model counters and drops `thoughts` and `tool`,
   while the transcript records all six per message. The transcript's format is confirmed on disk, but no
   transcript written by a headless run of the conformance-target release was available to confirm that
   `tokens` records are produced outside interactive sessions. Landing the reader on that uncertainty would
   ship machinery whose value cannot be demonstrated, so the task waits on one credentialed Gemini run.
   Until then Gemini keeps its current, correct fail-closed behavior.
9. [x] **Pin acceptance coverage.**
   Add the then-current engine and cross-adapter breakdown checks with their
   `Verifies:` lines; [[engine-70](../packages/engine.md#engine-70)] and
   [[engine-240](../packages/engine.md#engine-240)] now carry that coverage.
10. [x] **Document the feature.**
    Add a token-usage section to the user guide with the per-agent coverage table, point to it from the
    README, and record the additive change in the changelog.

## Verification

- Where a side is published, its components are finite non-negative integers summing exactly to the
  corresponding aggregate; where that identity cannot hold, the side is absent rather than approximate.
- An absent component is distinguishable from a measured zero, and no terminal marked `'unavailable'`
  carries a breakdown.
- Codex reports the tokens of the turn it terminates, not the accumulated tokens of its thread, and reports
  `'unavailable'` rather than a cumulative figure when it holds no baseline for a resumed thread.
- Gemini reports token accounting on an ordinary thinking run, with `outputTokens` including thinking
  tokens, and returns to its previous unavailable behavior whenever its transcript is missing, unreadable,
  or inconsistent with the streamed statistics. *Not met; deferred with task 8.*
- Claude Code publishes an input side that sums to its existing input total and publishes no output side.
- OpenCode publishes both sides; Kimi publishes none.
- The existing aggregates are unchanged for every runtime except the two whose accounting is corrected.
- A reader of the shipped documentation can tell which components each agent reports without reading specs.
