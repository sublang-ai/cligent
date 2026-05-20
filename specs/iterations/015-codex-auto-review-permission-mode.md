<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-015: Codex Auto-Review Permission Mode

## Goal

Complete the Codex portion of [DR-005](../decisions/005-per-adapter-permission-configuration.md) after Codex CLI introduced `approvals_reviewer = "auto_review"`.
`PermissionPolicy.mode: 'auto'` shall keep the existing Codex sandbox posture (`approvalPolicy: 'on-request'`, `sandboxMode: 'workspace-write'`, `networkAccessEnabled: false`) and additionally route eligible approval prompts through the Codex auto-reviewer by passing `{ approvals_reviewer: 'auto_review' }` through the Codex SDK `CodexOptions.config` constructor passthrough.

## Status

Proposed

## Scope

In scope:

- Widen the Codex adapter's mapped option shape to carry both `ThreadOptions` and SDK constructor config overrides.
- Add local Codex SDK constructor option/config types, widen `CodexSdk['Codex']` from a zero-argument constructor to one accepting those options, and keep `loadCodexSdk()`'s cast aligned with that local seam.
- Construct the SDK `Codex` client with the mapped config overrides before starting or resuming a thread.
- Update Codex mapping tests to assert both thread options and constructor config for `mode: 'auto'`.
- Update tmux-play acceptance coverage for [TTMUX-053](../test/tmux-play.md#ttmux-053) so the Codex case verifies the reviewer config path, not only the Claude case.

Out of scope:

- A YAML escape hatch for arbitrary Codex config keys.
- Changing `PermissionPolicy` beyond the existing `'auto' | 'bypass'` mode.
- Broadening Codex sandbox, filesystem, or network permissions.

## Deliverables

- [x] `src/adapters/codex.ts` — local Codex SDK constructor/config types are widened; `mapPermissionsToCodexOptions` / `mapAgentOptionsToCodexOptions` return Codex SDK constructor config overrides for `mode: 'auto'`; `run()` passes those overrides to `new sdk.Codex(...)`.
- [ ] `src/__tests__/codex-adapter.test.ts` — mapping and adapter tests assert `config: { approvals_reviewer: 'auto_review' }` reaches `new Codex(...)` and bypass mode does not set it.
- [ ] `src/app/tmux-play/launcher.acceptance.test.ts` — TTMUX-053 probe includes a Codex role path that verifies the auto-review config surface.

## Tasks

1. [x] **Codex adapter mapping** — add local Codex constructor config types, widen `CodexSdk['Codex']` and `loadCodexSdk()`'s cast, extend mapped Codex options with `codexOptions.config.approvals_reviewer` for `mode: 'auto'`, pass it to `new sdk.Codex(...)`, and preserve the existing thread options and bypass mapping.
2. [ ] **Codex tests** — update unit tests so `mode: 'auto'` fails unless the constructor config includes `approvals_reviewer: 'auto_review'`, and so `mode: 'bypass'` keeps the reviewer unset.
3. [ ] **tmux-play seam test** — add or extend an acceptance probe proving YAML `permissions.mode: auto` reaches the Codex adapter's reviewer config path through `AgentOptions.permissions`.

## Acceptance criteria

- `npm run build`, `npm run lint`, `npm test`, and `npm run test:smoke` pass at every task boundary.
- `npm test -- src/__tests__/codex-adapter.test.ts` and the updated tmux-play acceptance probe pass while developing the targeted Codex changes.
- After Task 3, `npm run test:acceptance` passes with the updated TTMUX-053 Codex reviewer-config probe.
- A Codex `mode: 'auto'` mapping produces thread options `{ approvalPolicy: 'on-request', sandboxMode: 'workspace-write', networkAccessEnabled: false }` plus SDK constructor config `{ approvals_reviewer: 'auto_review' }`.
- A Codex `mode: 'bypass'` mapping produces thread options `{ approvalPolicy: 'never', sandboxMode: 'danger-full-access', networkAccessEnabled: true }` and no reviewer config.
