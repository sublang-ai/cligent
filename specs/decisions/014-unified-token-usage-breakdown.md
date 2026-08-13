<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-014: Unified Token-Usage Breakdown

## Status

Accepted

## Context

[DR-002](002-unified-event-stream-and-adapter-interface.md#key-payloads) publishes token accounting as two
scalars, `inputTokens` and `outputTokens`, plus the `tokenAvailability` discriminator.
Callers that price a run, budget a session, or attribute spend cannot use two scalars: cache reads, cache
writes, and reasoning are billed at different rates, so a single input total and a single output total cannot
be converted to cost.

Every supported runtime measures more than cligent publishes, and each measures it in a different frame.

| Runtime | Base input | Reasoning | Aggregate surface |
| --- | --- | --- | --- |
| Claude Code | cache-exclusive | billed inside the output total, not separately exposed | complete |
| Codex | cache-inclusive | subset of the output total | thread-cumulative, not per-turn |
| Gemini CLI | cache-inclusive | disjoint, and omitted from the streamed statistics | incomplete |
| OpenCode | cache-exclusive | disjoint | complete |
| Kimi Code | cache-exclusive | not reported | absent |

Three consequences follow, and they are the reason this record exists rather than a payload edit.

Adopting any one runtime's frame silently corrupts the others, because a counter that is a subset in one
frame is an addend in another.
A single availability flag cannot describe a runtime that measures three of five components, which is the
common case rather than the exception.
Two runtimes can only reach full fidelity by reading state the runtime writes outside the protocol stream
cligent consumes, which is a question about the adapter boundary that no existing record answers.

## Decision

### Frame

Token components are a **disjoint partition**: every token is counted by exactly one component.

| Component | Meaning |
| --- | --- |
| `input` | input tokens that were neither read from nor written to the prompt cache |
| `cacheRead` | input tokens served from the prompt cache |
| `cacheWrite` | input tokens written into the prompt cache |
| `output` | model output tokens excluding reasoning |
| `reasoning` | reasoning or thinking tokens |

A runtime whose base input counter is cache-inclusive is normalized into this frame by subtraction, never by
clamping, so that the partition cannot exceed the aggregate it partitions.

### Shape

The breakdown is **additive and optional**.
`inputTokens` and `outputTokens` keep their current definitions and values, so no shipped consumer changes.
Components are grouped in one nested optional field rather than flattened beside the aggregates, because a
flat `input` adjacent to `inputTokens` differs from it by the cache tokens that dominate real runs, and that
adjacency is the shape most likely to be misread.

### Absence

Component absence is expressed by omission, not by a second discriminator and not by per-component wrappers.

- An **absent** component means the runtime does not report that quantity.
- A **present** `0` means the runtime measured zero.

This preserves [ENG-027](../user/engine.md#eng-027)'s rule that a numeric zero is never ambiguous.
`tokenAvailability` exists only because DR-002 froze `inputTokens` and `outputTokens` as required fields, so
their absence had to be lifted into a sibling flag; new optional fields express absence directly and need no
flag.

A second discriminator was rejected because it is all-or-nothing while no runtime is: the discriminator could
not say that one component is structurally absent while the others are measured.
Per-component `{ value, availability }` wrappers were rejected as encoding the same fact with more
indirection at every call site.

### Constraints

- **Side atomicity.** The input components and the output components form two sides. A side is published in
  full or omitted in full, and a breakdown carrying neither side is omitted rather than emitted empty.
- **Exact partition.** Where a side is published, its components sum exactly to the corresponding aggregate.
  An adapter that cannot satisfy this omits the side rather than publishing an inexact one.
- **Structurally absent versus unmeasured.** A component may be omitted from a published side only when the
  runtime's accounting model has no such counter. Where a runtime is known to bill a quantity it does not
  expose, the whole side is omitted, because publishing the remainder under a component name would assert a
  meaning that quantity does not have.
- **Suppression.** Where token accounting is unavailable, no breakdown is published. A partially populated
  breakdown beside an unavailable aggregate would create a third state DR-002 does not define, in which a
  consumer could sum components into a number that is not the run's usage.

### Billable decomposition

A partition of the whole run is not enough to price it, because a rate is selected per model and per request,
not per turn.
The run therefore also carries an optional list of **usage records**, each one billable group's share of the
run: its rate-card key, its components in the frame above, how many requests it covers, and the cost the
runtime computed for it where it computes one.

- A record's `requests` count is what tells a caller whether a context-length pricing tier is determinable.
  One request means the tier follows from the record's own tokens; more means it does not, because tiers are
  selected per request and the counts are a sum.
- Where a runtime does not name the model that ran, the record omits the field rather than naming a
  placeholder, because a placeholder selects a wrong rate as readily as a right one.
- The records sum to the breakdown, or they are omitted. A decomposition that describes work the aggregates
  do not is worse than none.

This supersedes the deferral of per-model attribution recorded when this decision was first accepted.
That deferral rested on partial runtime coverage, but partial coverage is what the absence model already
expresses, and without a rate-card key the component partition cannot serve the purpose this record exists
for.

### Fidelity sources

An adapter may derive token accounting from a source other than the protocol stream it already consumes —
including state the runtime writes to disk — only under all of the following.

- The derived totals are **cross-validated** against the aggregates the protocol stream itself reported, and
  any mismatch, absence, parse failure, or unreadable source falls back to the protocol result.
- The fallback is the runtime's existing behavior, including `'unavailable'` where the protocol result is
  incomplete, so a supplementary source can only add fidelity and can never subtract correctness.
- The source does not cross a protocol boundary an earlier record established. In particular
  [DR-011](011-kimi-code-acp-integration.md) confines the Kimi adapter to ACP, so Kimi accounting stays
  whatever ACP reports.

Cross-validation is what makes this safe: an undocumented on-disk format that changes shape stops matching
the protocol aggregates and is therefore discarded, rather than silently producing wrong numbers.
[DR-013](013-cligent-owned-runtime-compatibility.md)'s pinned runtime targets bound the exposure further, by
forcing re-verification whenever a runtime moves.

## Consequences

- Callers can compute cost, because the components a provider prices differently are now separable.
- Gemini token accounting can become reportable instead of structurally unavailable, by reading one
  runtime-owned transcript file under cross-validation. Its streamed statistics provably cannot partition the
  residual, so no cheaper source exists.
- Codex per-turn accounting requires retaining a per-thread baseline across calls, which
  [ENG-018](../user/engine.md#eng-018) otherwise forbids; the carve-out is narrow and fails closed when no
  baseline is held.
- Claude Code publishes an input side only. Its reasoning tokens are billed inside the output total and the
  runtime does not expose them, so the output side is withheld rather than mislabeled.
- Kimi Code publishes no breakdown, and its existing cache-exclusive folding stays an assumption about the
  agent rather than a guarantee ACP makes.
- A runtime that reports one component as a constant zero is indistinguishable from one that measured zero,
  where the reporting surface does not identify the provider. Adapter items record the affected cases.

Recognized and deferred, each being a separate unified-shape question with its own coverage gaps: server-side
tool request counts and cache time-to-live tiers.
Both are measured against one vendor only, and neither changes which rate applies, unlike the model identity
promoted above.
Cache storage billed per unit time is structurally absent for every runtime as cligent drives them, and is
recorded here as a finding rather than an omission.
