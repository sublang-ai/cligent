<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-026: Workspace Writable Paths

## Goal

Implement [DR-006](../decisions/006-workspace-writable-paths.md): add typed `PermissionPolicy.writablePaths` grants for workspace-relative writable subpaths, validate and canonicalize those paths before adapter mapping, report adapter enforcement strength, and prove Codex profile-enforced `.git` writes under `mode: 'auto'`.

## Status

In Progress

Tasks 1-5 are complete: the public field, shared validation helper, adapter mapping/reporting, and tmux-play YAML validation paths are implemented.
Task 6 remains: prove the real Codex config-delivery route for profile-enforced `.git` writes under `mode: 'auto'`.

## Deliverables

- [x] `src/types.ts` — `PermissionPolicy.writablePaths?: string[]`.
- [x] `src/permissions.ts` — shared writable-path canonicalization and validation helper.
- [x] `src/__tests__/types.test-d.ts` and `src/__tests__/permissions.test.ts` — type and validation coverage.
- [x] `src/__tests__/cligent.test.ts` — merge coverage proving per-call `writablePaths` arrays replace instance defaults when provided.
- [x] Shared `WritablePathsPermissionMapping` contract and helper for canonicalized paths plus enforcement class.
- [x] All adapter mapping results use the shared writable-path contract.
- [x] All adapter-level TADAPT items verify reported `writablePaths` paths and enforcement class.
- [x] Codex generated-profile mapping for non-empty `writablePaths` when local access resolves to `:workspace`.
- [x] Ambient acceptance/reporting for Claude, Gemini, and OpenCode where no independent filesystem sandbox is active.
- [x] tmux-play YAML accepts and validates `permissions.writablePaths`.
- [ ] Codex config-generation tests and real Codex acceptance proving `mode: 'auto'` plus `writablePaths: ['.git']` can write git metadata without mutating user or repository config.

## Tasks

Each task stops for review before the next task begins.

1. [x] **Core field and validation helper** — add `PermissionPolicy.writablePaths?: string[]`; define shared canonicalization/validation for workspace-relative writable paths; cover canonicalization, rejection rules, and `Cligent` merge replacement semantics.
2. [x] **Test-observable mapping contract** — add shared reporting types or mapping payloads so each adapter can expose canonicalized `writablePaths` plus `profile` / `sandbox` / `ambient` enforcement.
3. [x] **Codex profile mapping** — synthesize or deliver a Codex permission profile for `:workspace` plus extra workspace write grants; reject conflicts with `:read-only`; preserve approval/reviewer behavior.
4. [x] **Ambient adapter mappings** — make Claude, Gemini, and OpenCode accept valid `writablePaths` and report ambient enforcement unless an independently active sandbox route is implemented.
5. [x] **tmux-play YAML** — accept `permissions.writablePaths` on captain and players with the same validation and canonicalization rules.
6. [ ] **Codex acceptance** — prove a real Codex run can perform git metadata writes under `mode: 'auto'` with `writablePaths: ['.git']` and no human approval, without mutating machine-level or repository config.

## Acceptance criteria

- `npm run build`, `npm run lint`, `npm test`, and targeted smoke/acceptance tests pass at each completed task boundary.
- Once adapter mapping tasks are complete, invalid or contradictory `writablePaths` policies fail during permission mapping rather than being ignored.
- All adapters accept valid non-empty `writablePaths` and report canonicalized paths with their enforcement class.
- Codex satisfies the non-ambient release bar for `.git` writes under `mode: 'auto'`.
