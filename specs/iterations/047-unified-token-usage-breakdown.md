<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-047: Unified Token-Usage Breakdown

## Goal

Publish the finest-grained token accounting each runtime actually measures, normalized into one disjoint
component vocabulary per [DR-014](../decisions/014-unified-token-usage-breakdown.md), and correct the two
runtimes whose aggregates are currently wrong or unreachable.

## Status

Superseded; complete except task 8, which was deferred and never shipped

This record preserves the first additive breakdown implementation.
The current [DR-014](../decisions/014-unified-token-usage-breakdown.md) replaces that unreleased shape with
inclusive nested totals and completes Gemini through run-owned telemetry.

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
Spec work lands in the same commit as the code it governs, except tasks 1 and 2, which are contract-only and
precede every code change.

1. [x] **Record the decision.**
   Add DR-014 and this record; amend [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md)
   `Key payloads` with the optional field and a pointer; index both in `map.md`.
2. [x] **Specify the engine contract.**
   Amend [ENG-019](../user/engine.md#eng-019) and [ENG-027](../user/engine.md#eng-027); add
   [ENG-028](../user/engine.md#eng-028) for presence semantics and
   [ENG-029](../user/engine.md#eng-029) for the fidelity-source rule; amend
   [KIMI-005](../user/adapters/kimi.md#kimi-005) to record that ACP reports no usage today and that the
   cache-exclusive fold is an assumption about the agent.
3. [x] **Add the type and the shared builder.**
   Add `TokenBreakdown` and the optional `DonePayload.usage.breakdown`; add a shared builder that enforces
   the partition and side-atomicity rules and drops any side it cannot satisfy; keep every synthesized
   terminal breakdown-free; render present components in the internal event formatter; extend the
   declaration test. No adapter behavior changes.
4. [x] **Publish the OpenCode breakdown.**
   Accumulate the five step-finish counters separately and publish both sides; amend
   [OPENCODE-005](../user/adapters/opencode.md#opencode-005).
5. [x] **Publish the Claude Code input side.**
   Publish `input` / `cacheRead` / `cacheWrite` and withhold the output side; amend
   [[claude-code-3](../packages/adapters/claude-code.md#claude-code-3)] and add
   [[claude-code-11](../packages/adapters/claude-code.md#claude-code-11)] for the cost-versus-token scope mismatch.
6. [x] **Correct Codex per-turn accounting.**
   Subtract a per-thread baseline from the cumulative snapshot, guard non-monotonic snapshots, and fail
   closed with no baseline; add [[codex-15](../packages/adapters/codex.md#codex-15)] and amend ENG-018 with the
   baseline carve-out.
7. [x] **Publish the Codex breakdown.**
   Derive both sides by guarded subtraction from the per-turn delta; add
   [[codex-16](../packages/adapters/codex.md#codex-16)].
   The optional cost passthrough is retained rather than removed: it cannot produce a wrong number, since an
   absent field stays absent, and dropping it would forfeit forward compatibility for no gain.
8. [ ] **Supplement Gemini accounting from its transcript.** *Deferred.*
   Read the run's own transcript after the terminal result, reconcile it against the streamed statistics,
   correct `outputTokens`, publish both sides, and fall back to today's behavior on any mismatch; amend
   [GEMINI-004](../user/adapters/gemini.md#gemini-004) and add
   [GEMINI-017](../user/adapters/gemini.md#gemini-017).
   Blocked on evidence, not design: the streamed statistics provably cannot partition the residual, because
   `convertToStreamStats` forwards only five of the seven per-model counters and drops `thoughts` and `tool`,
   while the transcript records all six per message. The transcript's format is confirmed on disk, but no
   transcript written by a headless run of the conformance-target release was available to confirm that
   `tokens` records are produced outside interactive sessions. Landing the reader on that uncertainty would
   ship machinery whose value cannot be demonstrated, so the task waits on one credentialed Gemini run.
   Until then Gemini keeps its current, correct fail-closed behavior.
9. [x] **Pin acceptance coverage.**
   Add [TENG-020](../test/engine.md#teng-020) and [TADAPT-038](../test/adapters.md#tadapt-038) with their
   `Verifies:` lines, plus the integration coverage they name.
10. [x] **Document the feature.**
    Add a token-usage section to the user guide with the per-agent coverage table, point to it from the
    README, and record the additive change in the changelog.

## Acceptance criteria

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
