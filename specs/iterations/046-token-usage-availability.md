<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-046: Token Usage Availability

## Goal

Distinguish reported token totals, including measured zero, from unavailable
accounting on every terminal `done` path, while preserving independent tool
counts and existing provider cache folding
([issue #35](https://github.com/sublang-ai/cligent/issues/35)).

## Status

Complete

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
   Amend DR-002, [ENG-013](../user/engine.md#eng-013),
   [ENG-019](../user/engine.md#eng-019),
   [ENG-027](../user/engine.md#eng-027), and
   [KIMI-005](../user/adapters/kimi.md#kimi-005); add
   [TENG-019](../test/engine.md#teng-019) and
   [TADAPT-033](../test/adapters.md#tadapt-033).
2. [x] **Normalize every terminal producer.**
   Update all built-in adapter success, failure, interruption, exhaustion, and
   missing-accounting paths plus shared engine synthesis.
3. [x] **Migrate rendering, declarations, and verification.**
   Export the public types, render unavailable and legacy payloads honestly,
   cover the model at runtime and compile time, and record compatibility
   guidance in the changelog.

## Acceptance criteria

- Complete finite non-negative integer upstream input and output counters set
  `'reported'`, including when both counters are zero; every present mapped
  cache counter must have the same form.
- Missing or incomplete upstream counters and every synthesized terminal path
  set `'unavailable'`; no adapter estimates tokens.
- Cache-read and cache-write counters are folded exactly once for providers
  whose base excludes them and are not double-added where the base is
  inclusive.
- Independently known tool calls, whether observed or validly provider-reported,
  remain available in `toolUses` when tokens are not.
- Formatter output distinguishes unavailable accounting from numeric zero.
- New TypeScript producers must set `tokenAvailability`; consumers of stored
  pre-discriminator events treat an absent field as unavailable.
