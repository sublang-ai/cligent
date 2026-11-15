<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-047: Provider-aware model defaults and Codex fork history

## Status

Accepted (2026-11-14).
Amends [DR-046](046-primary-and-subagent-defaults.md) for the provider scope of generated defaults and [DR-044](044-codex-subagent-tuning.md) for task-selected fork history.
Amends [DR-028](028-subagent-model.md) and [DR-029](029-subagent-effort.md) for Claude runs whose tool controls exclude delegation.

## Context

Cligent owns the runtime floors on which the shipped parent and child model pairs are supported.
A cloud deployment or custom gateway can use different model identifiers.
Native loopback runs across the collaboration and legacy Codex spawn profiles demonstrate that fresh and full-history children can use either the configured defaults or explicit model and effort selections.

## Decision

Consumers generating new role configurations use Cligent’s provider-aware default pairs under [[engine-137](../packages/engine.md#engine-137)].
Existing user choices remain authoritative.
Local configuration generation reads the authorized user-level Claude or Codex settings.
A server may identify a trusted seat-owned Codex home explicitly.
Project-local and managed routing outside that scope remains the responsibility of the host that knows it.
Consumers adopt this public contract when they adopt Cligent 0.39.0.

Codex delegation guidance lets the parent choose history independently of the requested tuning and respect its advertised spawn options under [[codex-88](../packages/adapters/codex.md#codex-88)].
Deliver the selection on each tuned turn, including resumes where the earlier selection may be absent or obsolete.
Preserve unrelated native developer instructions.
Claude omits child tuning when the Agent tool is excluded.
Callers that enforce tool-free Codex runs in their own prompts omit child tuning at admission.

## Consequences

The direct services get the requested models in configurations generated with Cligent 0.39.0.
When the supplied environment or authorized user or seat settings identify a cloud or custom route, the resolver leaves both models to that provider.
Fresh and full-history spawns retain the native precedence for explicit and role-defined overrides under [[codex-90](../packages/adapters/codex.md#codex-90)].
