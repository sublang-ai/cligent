<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-055: Runtime-Reported Model Identity

## Status

Completed (2026-09-28).

## Intent

Implement [DR-026](../decisions/026-runtime-reported-model-identity.md): report each discovered model's runtime description and human name, Kimi's resolved models, the model an unconfigured run selects, and the model a call's runtime names at initialization.

## Deliverables

- [x] Specify [[engine-86](../packages/engine.md#engine-86)], [[engine-87](../packages/engine.md#engine-87)], [[engine-19](../packages/engine.md#engine-19)], [[engine-27](../packages/engine.md#engine-27)] and [[engine-28](../packages/engine.md#engine-28)], and each adapter's init selection.
- [x] Discovery reports `description`, human names, Kimi `resolvedModel`, and [[engine-19](../packages/engine.md#engine-19)]'s `defaultModel`.
- [x] Every built-in adapter sets [[engine-27](../packages/engine.md#engine-27)]'s `InitPayload.reportedModel` only from runtime evidence.
- [x] README, guide and changelog describe the additions.

## Tasks

1. Record DR-026 and amend the engine and adapter specs.
2. Report descriptions, names, resolved Kimi models and default models from discovery.
3. Report the runtime-named model on `init` for every built-in adapter.

## Verification

- `npm test`: 1,423 of 1,424 tests pass; the one failure, `supplies managed runs with non-persisted project trust`, predates this intent and occurs only in a linked worktree, whose checkout the Codex adapter maps to the main repository root.
- `npm run lint`, `npm run typecheck`, `npm run smoke:release` and `spex lint` pass.
- Real runtimes, without a paid model call: Claude Agent SDK 0.3.283 and 0.3.251 report descriptions and the user-configured `opus[1m]` through the installed settings resolver; Codex 0.158.0 reports its configured `gpt-5.6-sol` over its flagged `gpt-6-astra`, a trusted project's model for a `cwd`, and the flagged model under an empty configuration, as does 0.151.0; OpenCode 1.18.25 reports human names; Kimi Code 0.39.1 reports display names, resolved models and its configured or `KIMI_MODEL_NAME` default from a fixture home, and its ACP session reports the selected alias on `init` with and without a requested model.
