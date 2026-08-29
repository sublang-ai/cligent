<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-046: Token Usage Availability

## Status

Complete

The discriminator and flat-field deliverables below record the behavior when this iteration completed.
[DR-014](../decisions/014-unified-token-usage-breakdown.md) later supersedes them with optional authentic nested usage reports.

## Intent

Distinguish reported token totals, including measured zero, from unavailable accounting on every terminal `done` path, while preserving independent tool counts and existing provider cache folding ([issue #35](https://github.com/sublang-ai/cligent/issues/35)).

## Deliverables

- [x] The public `DoneUsage` schema carries one required reported/unavailable
      token-accounting discriminator.
- [x] Every built-in adapter and engine-synthesized terminal path sets the
      discriminator without estimating tokens and preserves observed tool
      counts independently.
- [x] The event formatter never renders unavailable compatibility values as
      measured zeroes.
- [x] Unit and declaration tests cover reported nonzero usage, reported zero,
      unavailable accounting, cache folding, tool-count preservation, and the
      producer migration boundary.
- [x] The changelog documents the TypeScript and serialized-event migration.

## Tasks

1. [x] **Specify the availability model.**
   Amend DR-002 and the then-current flat usage contract and add its engine and
   cross-adapter checks. [DR-019](../decisions/019-superseded-item-retirements.md)
   records those items' later retirement; [[engine-31](../packages/engine.md#engine-31)],
   [[engine-58](../packages/engine.md#engine-58)], [[engine-69](../packages/engine.md#engine-69)],
   [[engine-240](../packages/engine.md#engine-240)], and
   [[kimi-13](../packages/adapters/kimi.md#kimi-13)] carry the surviving concerns.
2. [x] **Normalize every terminal producer.**
   Update all built-in adapter success, failure, interruption, exhaustion, and
   missing-accounting paths plus shared engine synthesis.
3. [x] **Migrate rendering, declarations, and verification.**
   Export the public types, render unavailable and legacy payloads honestly,
   cover the model at runtime and compile time, and record compatibility
   guidance in the changelog.
4. [x] **Reconcile provider-native accounting.**
   Fold OpenCode's disjoint reasoning into output, fail closed on Gemini's
   unpartitioned aggregate, and isolate optional Kimi usage from prompt status.
   Amend the affected shared and adapter contracts, ACP decision, provider
   citations, regression coverage, adjacent OpenCode test wording, and
   changelog.

## Verification

- Complete finite non-negative integer upstream input and output counters set
  `'reported'`, including when both counters are zero; output includes
  disjoint reasoning or thinking detail exactly once, and every present mapped
  cache or reasoning counter must have the same form.
- Missing or incomplete upstream counters and every synthesized terminal path
  set `'unavailable'`; an unpartitioned aggregate residual is not assigned by
  estimation.
- Malformed optional Kimi accounting degrades to unavailable usage without
  changing an otherwise valid prompt terminal status.
- Cache-read and cache-write counters are folded exactly once for providers
  whose base excludes them and are not double-added where the base is
  inclusive.
- Independently known tool calls, whether observed or validly provider-reported,
  remain available in `toolUses` when tokens are not.
- Formatter output distinguishes unavailable accounting from numeric zero.
- New TypeScript producers must set `tokenAvailability`; consumers of stored
  pre-discriminator events treat an absent field as unavailable.
