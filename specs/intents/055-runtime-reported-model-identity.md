<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-055: Runtime-Reported Model Identity

## Status

In progress.

## Intent

Implement [DR-026](../decisions/026-runtime-reported-model-identity.md): report each discovered model's runtime description and human name, Kimi's resolved models, the model an unconfigured run selects, and the model a call's runtime names at initialization.

## Deliverables

- [x] Specify [[engine-86](../packages/engine.md#engine-86)] through [[engine-90](../packages/engine.md#engine-90)] and each adapter's init selection.
- [x] Discovery reports `description`, human names, Kimi `resolvedModel`, and [[engine-88](../packages/engine.md#engine-88)]'s `defaultModel`.
- [ ] Every built-in adapter sets [[engine-89](../packages/engine.md#engine-89)]'s `InitPayload.reportedModel` only from runtime evidence.
- [ ] README, guide and changelog describe the additions.

## Tasks

1. Record DR-026 and amend the engine and adapter specs.
2. Report descriptions, names, resolved Kimi models and default models from discovery.
3. Report the runtime-named model on `init` for every built-in adapter.

## Verification

- Pending.
