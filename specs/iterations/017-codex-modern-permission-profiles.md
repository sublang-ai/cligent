<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-017: Codex Modern Permission Profiles

## Goal

Move the Codex adapter to Codex's modern permission-profile model per the [DR-005](../decisions/005-per-adapter-permission-configuration.md) *Codex — modern permission-profile model* amendment.
`mapPermissionsToCodexOptions` shall express the local-access surface through `CodexOptions.config.default_permissions` and shall stop setting `ThreadOptions.sandboxMode` / `networkAccessEnabled`, so `mode: 'auto'` composes Codex auto-review with a `default_permissions` profile instead of pinning the legacy sandbox model (which suppresses `default_permissions`).

## Status

In progress

## Scope

In scope:

- The DR-005, [ENG-021](../user/engine.md#eng-021), [CODEX-004](../user/adapters/codex.md#codex-004), [TTMUX-053](../test/tmux-play.md#ttmux-053), and [TMUX-011](../user/tmux-play.md#tmux-011) amendments (Task 1).
- Rewriting the Codex adapter mapping: `default_permissions` profile derivation, the `approvalPolicy` + `approvals_reviewer` axis, and removal of `sandboxMode` / `networkAccessEnabled`.
- Widening the local Codex SDK `config` type to carry `default_permissions`.
- Updating the Codex mapping unit tests and the auto-mode / tmux-play acceptance probes.

Out of scope:

- Synthesizing granular `[permissions]` profiles for partial capability combinations; the workspace-write-with-network gap stays lossy per [CODEX-004](../user/adapters/codex.md#codex-004).
- An opt-in to inherit the user's machine-level Codex permission config.
- Any change to `PermissionPolicy`, the YAML schema, or the claude / gemini / opencode adapters.

## Deliverables

- [x] `specs/` — DR-005, ENG-021, CODEX-004, TTMUX-053, and TMUX-011 amended; the Codex permissions doc added as a reference; `map.md` indexes this IR.
- [ ] `src/adapters/codex.ts` — `mapPermissionsToCodexOptions` / `mapAgentOptionsToCodexOptions` emit `CodexOptions.config.default_permissions` and no `sandboxMode` / `networkAccessEnabled`; the local Codex `config` type is widened.
- [ ] `src/__tests__/codex-adapter.test.ts` — mapping tests assert the modern knobs.
- [ ] `src/adapters/auto-mode.acceptance.test.ts` / `src/app/tmux-play/launcher.acceptance.test.ts` — the TADAPT-019 and TTMUX-053 Codex probes assert the modern knobs.

## Tasks

1. [x] **Spec** — amend DR-005 (Codex modern permission-profile model, determinism caveat, inherit deferred), ENG-021 (orthogonal automation-posture / local-access-surface axis composition), CODEX-004 (the new mapping), TTMUX-053, and TMUX-011; add the Codex permissions doc reference; index this IR in `map.md`.
2. [ ] **Codex adapter mapping** — rewrite the Codex mapping to derive `CodexOptions.config.default_permissions` (`:danger-full-access` for `mode: 'bypass'` and for all-`'allow'` capabilities; `:read-only` when `fileWrite` or `shellExecute` is `'deny'`; `:workspace` otherwise, so a network-only `'deny'` stays `:workspace`), set `approvalPolicy` + `approvals_reviewer` per the approval/reviewer axis, and stop emitting `ThreadOptions.sandboxMode` / `networkAccessEnabled`; widen the local Codex `config` type with `default_permissions`.
3. [ ] **Codex unit tests** — update `codex-adapter.test.ts` so the `mode: 'auto'`, `mode: 'bypass'`, per-capability (including a network-only `'deny'`), and absent-policy cases assert the `default_permissions` profile, the `approvalPolicy`, and the absence of `sandboxMode` / `networkAccessEnabled`.
4. [ ] **Acceptance tests** — update the TADAPT-019 Codex auto-mode probe and the TTMUX-053 Codex seam probe to the modern knobs, confirm the `:workspace` profile still lets the temp-file write and delete proceed, and run `npm run test:acceptance`.

## Acceptance criteria

- `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run test:smoke` pass at every task boundary.
- A Codex `mode: 'auto'` mapping produces `ThreadOptions.approvalPolicy: 'on-request'` plus `CodexOptions.config` `{ approvals_reviewer: 'auto_review', default_permissions: ':workspace' }` for a policy with no per-capability levels, and `default_permissions: ':danger-full-access'` when `fileWrite` / `shellExecute` / `networkAccess` are all `'allow'`.
- A Codex `mode: 'bypass'` mapping produces `approvalPolicy: 'never'`, `CodexOptions.config.default_permissions: ':danger-full-access'`, and no `approvals_reviewer`.
- A Codex policy `{ fileWrite: 'allow', shellExecute: 'allow', networkAccess: 'deny' }` maps to `default_permissions: ':workspace'`; a denied `networkAccess` alone never selects `:read-only`.
- Given a resolved `AgentOptions` with no `permissions` policy, no Codex mapping path sets `default_permissions`, `approvals_reviewer`, or `ThreadOptions.approvalPolicy`.
- No Codex mapping path sets `ThreadOptions.sandboxMode` or `ThreadOptions.networkAccessEnabled`.
- After Task 4, `npm run test:acceptance` passes with the Codex auto-mode and TTMUX-053 probes asserting the modern knobs.
