<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-047: Provider-aware model defaults and Codex fork history

## Status

Accepted (2026-11-14). Amends [DR-046](046-primary-and-subagent-defaults.md) and [DR-044](044-codex-subagent-tuning.md).

## Context

Cligent owns the runtime floors on which the shipped parent and child model pairs are supported. A cloud deployment or custom gateway can use different model identifiers. Native loopback runs across the collaboration and legacy Codex spawn profiles demonstrate that fresh and full-history children can use either the configured defaults or explicit model and effort selections.

## Decision

Consumers generating new role configurations use Cligent’s provider-aware default pairs under [[engine-137](../packages/engine.md#engine-137)]. Existing user choices remain authoritative. A consumer running an older Cligent without this contract can leave implicit pins to the provider.

Codex delegation guidance lets the parent choose history independently of the requested tuning and respect its advertised spawn options under [[codex-88](../packages/adapters/codex.md#codex-88)]. Deliver the selection on each tuned turn, including resumes where the earlier selection may be absent or obsolete. Preserve unrelated native developer instructions. Calls that exclude delegation should omit child tuning.

## Consequences

The direct services get the requested models as soon as the installed Cligent supports them. Cloud and custom routes retain their model selection. Fresh and full-history spawns retain the native precedence for explicit and role-defined overrides under [[codex-90](../packages/adapters/codex.md#codex-90)].
