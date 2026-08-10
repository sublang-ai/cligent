<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-044: OpenCode Message Role Correlation

## Goal

Correlate OpenCode content parts with their message roles so the adapter emits
assistant output without replaying user prompts as assistant text
([issue #41](https://github.com/sublang-ai/cligent/issues/41)).

## Status

Complete

## Deliverables

- [x] The OpenCode contract defines role-aware normalization for conversational
      content and fail-closed handling while role metadata is pending.
- [x] The adapter tracks message roles per run, buffers parts that precede their
      role, suppresses user content, and releases assistant content in order.
- [x] Canned-event tests cover both event orderings, all conversational event
      kinds, equal prompt/assistant bytes, unresolved roles, and foreign
      sessions.

## Tasks

Each task is one commit and keeps build, typecheck, lint, and unit checks green
at its boundary.

1. [x] **Specify message-role normalization.** Add
   [OPENCODE-017](../user/adapters/opencode.md#opencode-017) and
   [TADAPT-034](../test/adapters.md#tadapt-034), and refine the normalization
   table to identify assistant content.
2. [x] **Correlate message roles.** Retain role metadata by message id, hold
   early parts until their role resolves, and suppress user-owned content.
3. [x] **Pin ordering and attribution behavior.** Cover role-before-part,
   part-before-role, multiple content kinds, prompt-equal assistant output,
   unresolved roles, and cross-session isolation.

## Acceptance criteria

- User text, text deltas, and reasoning produce no normalized conversational
  events whether role metadata arrives before or after their parts.
- Assistant content is emitted in original stream order after its role is
  known across interleaved message identifiers, including output whose bytes
  equal the prompt.
- Identifier-bearing content remains pending until its role resolves and is
  not emitted if the run terminates first; later known assistant content still
  flushes in order before terminal `done`.
- Role correlation is per run and occurs only after session filtering.
- Legacy content without a message identifier retains its prior behavior.
