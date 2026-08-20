<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-041: OpenCode Tool Lifecycle Correlation

## Goal

Normalize OpenCode `ToolPart` lifecycle snapshots into one correlated
`tool_use`/`tool_result` pair per `callID`, ending the duplicate empty
`tool_use` stream and missing terminal results observed in dogfooding
([issue #33](https://github.com/sublang-ai/cligent/issues/33)).

## Status

Complete

## Deliverables

- [x] OPENCODE user items describe `callID` correlation, single `tool_use` with
      `state.input`, terminal `tool_result` mapping, denial precedence, and
      per-call usage counting.
- [x] The adapter tracks tool calls per `callID`, defers emission past
      `pending` snapshots, emits one terminal result from `state.output` /
      `state.error`, and suppresses duplicates after permission denial.
- [x] Canned-event tests cover the canonical lifecycle fixtures, terminal-first
      arrival, parallel calls, `part.id` ≠ `callID`, denial precedence, and
      usage counting, alongside the preserved legacy-shape behavior.
- [x] A live acceptance leg proves the lifecycle invariants against a real
      managed-mode OpenCode run, so later wire-schema drift fails acceptance
      instead of shipping.

## Tasks

Each task is one commit and keeps build, typecheck, lint, unit, and smoke
checks green at its boundary.

1. [x] **Specify the OpenCode tool lifecycle contract.**
   Add [[opencode-16](../packages/adapters/opencode.md#opencode-16)], amend the
   [[opencode-5](../packages/adapters/opencode.md#opencode-5)] normalization
   table, and add [[opencode-231](../packages/adapters/opencode.md#opencode-231)].
2. [x] **Correlate tool lifecycle snapshots by `callID`.**
   Rework the adapter's tool-part and permission-reply normalization with
   per-call tracking, and add the lifecycle tests.
3. [x] **Add the live lifecycle acceptance leg.**
   Add [[opencode-232](../packages/adapters/opencode.md#opencode-232)] and the real-run probe
   asserting per-`callID` pairing, non-empty input, and usage parity, gated
   and retried like the existing acceptance items.

## Acceptance criteria

- Canonical pending → running → completed and pending → running → error
  sequences each produce exactly one correlated `tool_use`/`tool_result` pair
  carrying `state.input`, the terminal `state.output` or `state.error`, and the
  state-supplied duration.
- Repeated running or terminal snapshots duplicate no events and no
  `done.usage.toolUses` counts; each correlated call counts once.
- Correlation uses `part.callID` where `part.id` carries a different value.
- Interleaved snapshots for parallel calls stay isolated per `callID`.
- A terminal snapshot without earlier snapshots still produces a correlated
  pair, and a permission denial followed by tool-state updates produces exactly
  one terminal `tool_result`.
- Legacy stateless tool parts and the `opencode:*` extension events keep their
  existing normalization.
- A real managed-mode run that creates a file through tools yields unique
  `tool_use` ids, one terminal result per id, and `usage.toolUses` parity,
  self-skipping per the acceptance gating.
