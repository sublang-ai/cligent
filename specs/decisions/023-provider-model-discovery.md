<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-023: Provider model discovery

## Status

Accepted.
Amended by [DR-026](026-runtime-reported-model-identity.md): model descriptions, human names, resolved Kimi models, and the runtime's default model.
Amended by [DR-027](027-latest-models-oldest-serving-runtime.md): a newly offered provider model raises the supported floor to the oldest release that serves it.

## Context

Adapter effort vocabularies describe what Cligent can transmit, not what a selected model supports.
Static model lists age independently of runtime versions, accounts and configured providers.

## Decision

Expose on-demand, bounded model discovery from the same installed runtime the adapter uses.
Use provider-owned listing or initialization interfaces without a prompt or durable conversation; return unavailable when that cannot be done.
Preserve model-specific effort and fast-mode facts separately from adapter metadata and runtime readiness.
An absent fact means unknown, and unlisted custom model strings remain valid configuration.

## Consequences

Hosts can offer current model choices without owning a model catalog or invoking agents during configuration validation.
Discovery can fail or reflect a runtime's cached catalog; it proves neither account entitlement nor successful future execution.
Runtime repairs remain [DR-013](013-cligent-owned-runtime-compatibility.md)'s responsibility, and a newer optional model does not raise the general compatibility floor.
