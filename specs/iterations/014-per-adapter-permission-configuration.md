<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-014: Per-Adapter Permission Configuration

## Goal

Implement the initial [DR-005](../decisions/005-per-adapter-permission-configuration.md) permission-mode work: a tmux-play YAML user can write `permissions: { mode: 'auto' }` on a role or on the captain and have the chosen adapter pick its safer auto-mode SDK knob (classifier-backed for claude, sandbox-protected for codex, yolo for gemini, permission rules for opencode) through the existing `CligentOptions` / `AgentOptions` channel — no new YAML escape hatch into adapter-private knobs.
Codex auto-review was added after this iteration and is tracked separately by a later iteration.

Key design choices (DR-005 leaves these IR-level):

- `PermissionPolicy` gains a `mode?: 'auto' | 'bypass'` field. Existing callers without `mode` map as today; with `mode` set, the field takes precedence over per-capability levels at the SDK-knob selection step.
- YAML carries `permissions?: PermissionPolicy` as a typed `RoleConfig` / captain field; the loader forwards it to the role / captain `Cligent` constructor as `CligentOptions.permissions` per [DR-003](../decisions/003-role-scoped-session-management.md).
- Each adapter's `mapPermissionsToXxxOptions` learns the new `mode` value at a top-of-function early return so per-capability levels stay subordinate. claude widens its existing `ClaudePermissionMode` enum with `'auto'`. codex's existing `sandboxMode` / `approvalPolicy` derivation gains a mode branch. gemini gains a new `approvalMode` adapter option + `--approval-mode` CLI arg (no such surface existed). opencode keeps its existing `permission: { edit, bash, webfetch }` SDK body and gains a top-of-function mode branch (auto → all-`'allow'`, bypass → rejected because the cligent opencode adapter drives `opencode serve` via the SDK, not the `opencode run` CLI that the bypass flag attaches to).
- Invalid `mode` values abort the launcher with stderr + nonzero exit before the runtime exists, per DR-005's failure-surfacing rule.

## Status

Completed

## Scope

In scope:

- `PermissionPolicy.mode?: 'auto' | 'bypass'` in `src/types.ts`. New ENG item.
- Per-adapter mapping additions:
  - `claude`: add `'auto'` to `ClaudePermissionMode`; emit `permissionMode: 'auto'` for `mode: 'auto'`, `permissionMode: 'bypassPermissions'` for `mode: 'bypass'`.
  - `codex`: emit `approvalPolicy: 'on-request' + sandboxMode: 'workspace-write'` for `mode: 'auto'`, `approvalPolicy: 'never' + sandboxMode: 'danger-full-access'` for `mode: 'bypass'`.
  - `gemini`: add an `approvalMode` constructor option + CLI arg; emit `--approval-mode yolo` for both `mode: 'auto'` and `mode: 'bypass'` (gemini exposes no distinct bypass tier beyond yolo, so both map to the same SDK setting). The per-capability allow / deny path is short-circuited when `mode` is set so the precedence rule holds.
  - `opencode`: extend `mapPermissionsToOpenCodeOptions` with the same top-of-function mode handling pattern as claude / codex / gemini. The cligent opencode adapter spawns `opencode serve` and drives it via the SDK; it does not invoke the `opencode run` CLI, so `--dangerously-skip-permissions` has no place to attach. Emit `permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' }` for `mode: 'auto'` (the SDK equivalent of opencode.json's `"permission": "allow"`). `mode: 'bypass'` shall be rejected by the mapping with an error naming the SDK/server architecture. Because `mapPermissionsToOpenCodeOptions` runs inside `OpenCodeAdapter.run()` rather than at adapter construction, the throw surfaces at the first `Cligent.run()` call as a `role_finished` / `captain_finished` `status: 'error'` record per DR-005's first-run failure-surfacing rule, rendered through the presenter per [TMUX-039](../user/tmux-play.md#tmux-039) — not as a launcher-startup abort.
- `RoleConfig.permissions?: PermissionPolicy` and captain `permissions?: PermissionPolicy` accepted by the YAML loader (typed, malformed fields rejected per [TMUX-008](../user/tmux-play.md#tmux-008)); forwarded into `CligentOptions.permissions` at role / captain construction in `session.ts`.
- New TMUX items for the YAML `permissions` field on roles and captain.
- TTMUX items covering YAML → `CligentOptions.permissions` reach, per-adapter SDK-knob emission for `mode`, and the launcher startup-error path for invalid `mode`.
- `docs/tmux-play.md` Config section documents `permissions` with a `mode: 'auto'` example.
- `specs/map.md` TMUX summary mentions permission configuration.

Out of scope (per DR-005):

- Per-adapter knob escape hatches in YAML.
- Per-tool ACL rules in YAML distinct from `PermissionPolicy`.
- Runtime per-call permission overrides above the YAML default.
- Default permission posture imposed by cligent.

Deferred to a later iteration:

- Codex `approvals_reviewer = auto_review`; this belongs to a later iteration.

## Deliverables

- [x] `src/types.ts` — `PermissionPolicy.mode?: 'auto' | 'bypass'`.
- [x] `src/__tests__/types.test.ts` — narrowing + assignability for the new field.
- [x] `src/adapters/claude-code.ts` — `'auto'` in `ClaudePermissionMode`; mapping branch for `mode`.
- [x] `src/__tests__/claude-code-adapter.test.ts` — mapping unit tests.
- [x] `src/adapters/codex.ts` — mapping branch for `mode`.
- [x] `src/__tests__/codex-adapter.test.ts` — mapping unit tests.
- [x] `src/adapters/gemini.ts` — `approvalMode` option, CLI arg, mapping branch.
- [x] `src/adapters/opencode.ts` — mapping branch for `mode` (auto / bypass-reject).
- [x] `src/__tests__/opencode-adapter.test.ts` — mapping unit tests.
- [x] `src/app/tmux-play/roles.ts` — `RoleConfig.permissions?`, forwarded into the role `Cligent` constructor via `CreateRoleCligentOptions.permissions`.
- [x] `src/app/tmux-play/config.ts` — YAML loader accepts and validates `permissions` on captain and roles per [TMUX-052](../user/tmux-play.md#tmux-052).
- [x] `src/app/tmux-play/config.test.ts` — loader accepts valid, rejects malformed.
- [x] `src/app/tmux-play/contract.ts` + `src/app/tmux-play/runtime.ts` + `src/app/tmux-play/session.ts` — captain `permissions` reach the captain `Cligent` constructor; role `permissions` reach `resolveRoles` via `RuntimeRoleConfig`.
- [x] `src/app/tmux-play/launcher.acceptance.test.ts` — end-to-end probe (a): YAML `mode: 'auto'` reaches `AgentOptions.permissions` at the role adapter seam, and the adapter's exported mapping function emits the spec-defined SDK knob.
- [x] `src/app/tmux-play/cli.smoke.test.ts` — end-to-end probe (b): invalid YAML `mode` exits the built CLI nonzero with stderr naming the offending path; no `runtime_error` record, no tmux session.
- [x] `specs/user/engine.md` — new ENG-021 for `PermissionPolicy.mode`.
- [x] `specs/user/tmux-play.md` — new [TMUX-052](../user/tmux-play.md#tmux-052) for YAML `permissions` on roles and captain; TMUX-006, TMUX-007, and TMUX-029 updated to include the optional field.
- [x] `specs/test/tmux-play.md` — new TTMUX-052, TTMUX-053, TTMUX-054 for YAML acceptance/rejection, adapter seam, and CLI-abort behavior.
- [x] `docs/tmux-play.md` — Config section documents `permissions` with `mode: 'auto'` example.
- [x] `specs/map.md` — TMUX summary updated.

## Tasks

Each task is one commit.

1. [x] **PermissionPolicy extension** — add `mode?: 'auto' | 'bypass'` to `PermissionPolicy` in `src/types.ts`; type tests cover narrowing. New ENG item documenting the field semantics (mode takes precedence over per-capability levels at SDK-knob selection; unset = today's behavior).
2. [x] **Adapter mappings — claude, codex, gemini** — each adapter's `mapPermissionsToXxxOptions` learns the new `mode` value; claude adds `'auto'` to `ClaudePermissionMode`; gemini adds an `approvalMode` constructor option and CLI arg. Per-adapter unit tests cover `mode: 'auto'` and `mode: 'bypass'` (where the SDK supports the latter).
3. [x] **Adapter mapping — opencode** — extend `mapPermissionsToOpenCodeOptions` with top-of-function mode handling matching claude / codex / gemini. `mode: 'auto'` emits `permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' }` (the SDK equivalent of opencode.json's `"permission": "allow"`). `mode: 'bypass'` is rejected by the mapping with an error naming the SDK/server architecture — the cligent opencode adapter drives an `opencode serve` SDK session, so the `--dangerously-skip-permissions` CLI flag has no place to attach. Per-adapter unit tests.
4. [x] **YAML schema + loader + session wiring** — extend `RoleConfig` and the captain config with `permissions?: PermissionPolicy`; YAML loader accepts the typed shape and rejects malformed sub-fields per TMUX-008; `session.ts` forwards the value into `CligentOptions.permissions` at role / captain construction. New TMUX items for the YAML field; loader tests for accept + reject.
5. [x] **Docs and acceptance** — `docs/tmux-play.md` Config section documents `permissions` with a `mode: 'auto'` example; new TTMUX-052/053/054 items; end-to-end probes in `launcher.acceptance.test.ts` and `cli.smoke.test.ts` assert (a) YAML `mode: 'auto'` reaches the role adapter's `AgentOptions.permissions` and the adapter's exported mapping function emits the spec-defined SDK knob (no live API call), and (b) an invalid `mode` value aborts the launcher with stderr + nonzero exit — not a `runtime_error` record. `specs/map.md` TMUX summary updated.

## Acceptance criteria

- `npm run build`, `npm run lint`, `npm test`, and `npm run test:smoke` pass at every task boundary.
- After Task 1, `PermissionPolicy` includes `mode?: 'auto' | 'bypass'`; type tests assert narrowing.
- After Task 2, claude / codex / gemini mapping unit tests show `mode: 'auto'` emits the IR-014 SDK option (`permissionMode: 'auto'` for claude, `approvalPolicy: 'on-request' + sandboxMode: 'workspace-write'` for codex, `approvalMode: 'yolo'` for gemini), and `mode: 'bypass'` emits the unchecked variant where the SDK supports it.
- After Task 3, opencode mapping unit tests show `mode: 'auto'` produces the documented SDK permission shape, and `mode: 'bypass'` is rejected with an error naming the SDK/server architecture.
- After Task 4, the YAML loader accepts `permissions: { mode: 'auto' }` on roles and on the captain, rejects unknown sub-fields with an error naming the offending path, and the resulting `Cligent` carries the value as `CligentOptions.permissions`.
- After Task 5, `npm run test:acceptance` passes including (a) a probe that a YAML `mode: 'auto'` config reaches the chosen adapter's IR-014 SDK auto-mode knob and (b) a probe that an invalid `mode` value aborts the launcher with stderr + nonzero exit, without emitting a `runtime_error` record.
