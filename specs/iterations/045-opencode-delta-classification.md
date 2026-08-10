<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-045: OpenCode Delta Classification

## Goal

Classify OpenCode deltas by their owning content part so reasoning no longer
appears as output or duplicates settled thinking snapshots
([issue #42](https://github.com/sublang-ai/cligent/issues/42)).

## Status

Complete

## Deliverables

- [x] The OpenCode contract distinguishes canonical v1, explicit v2, and
      generic v2 delta shapes and defines fail-closed unknown handling.
- [x] The adapter correlates generic deltas by part id, preserves assistant
      text deltas, suppresses reasoning and user deltas, and deduplicates
      settled snapshots.
- [x] SDK-typed fixtures cover metadata before and after deltas, interleaved
      content, explicit event types, v1 sibling deltas, unresolved parts,
      duplicate snapshots, and final-output reconstruction.

## Tasks

Each task is one commit and keeps build, typecheck, lint, and unit checks green
at its boundary.

1. [x] **Specify delta classification.** Add
   [OPENCODE-019](../user/adapters/opencode.md#opencode-019) and
   [TADAPT-036](../test/adapters.md#tadapt-036) for every supported wire shape.
2. [x] **Classify and correlate deltas.** Track part types, hold unknown generic
   deltas, suppress reasoning, map text, handle v1 sibling deltas, and
   deduplicate settled snapshots.
3. [x] **Pin mixed-stream reconstruction.** Drive interleaved SDK-typed
   fixtures through role and part ordering permutations and compare joined
   output with final assistant text.

## Acceptance criteria

- No reasoning or user delta produces `text_delta`.
- Assistant output deltas from canonical v1, explicit v2, and generic v2
  shapes produce `text_delta` that reconstructs the final assistant text.
- Generic deltas resolve deterministically when part metadata arrives before
  or after them and remain un-emitted when their type never resolves.
- Interleaved part identifiers retain independent classification.
- Settled reasoning remains available once through `thinking`, while duplicate
  settled text or reasoning snapshots emit at most once.
