<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-006: Workspace Writable Paths

## Status

Proposed

## Context

[DR-005](005-per-adapter-permission-configuration.md) routes permission intent through the typed `PermissionPolicy` and rejects adapter-private YAML escape hatches.
It also marks synthesized Codex permission profiles out of scope for the earlier `mode` / `fileWrite` / `shellExecute` / `networkAccess` shape.

The gap is narrower than command approval.
Codex `mode: 'auto'` maps to interactive approvals with `auto_review` and a `:workspace` local-access profile, so eligible approval prompts can be reviewed automatically without unchecked bypass [[3]].
However, Codex permission profiles are still the layer that controls filesystem writes, and default workspace-write protects `.git` recursively as read-only [[9]].
Local git operations such as `git commit` require writes under `.git`; approving a `git commit` command cannot by itself make a read-only `.git` mount writable.

Codex's profile-file model can express this exact filesystem shape with `[permissions.<name>.filesystem.":workspace_roots"]` rules, and nested subpaths under `:workspace_roots` are required to stay inside each workspace root [[1]].
The Codex SDK exposes `--config` passthrough and environment control, but `--config` passthrough is not by itself accepted as proof that quoted nested filesystem profile keys round-trip correctly through the CLI parser [[4]].
Codex configuration can also be loaded from `CODEX_HOME` profile files and trusted project-local `.codex/config.toml` layers, but those routes carry state, auth, trust, or repository-mutation hazards [[10]].

Adapters do not expose the same primitive, so `writablePaths` is a portable write-path requirement with adapter-specific enforcement strength:

| Adapter | Mapping | Enforcement class |
| --- | --- | --- |
| `codex` | Custom permission profile filesystem rules under `:workspace_roots` [[1]][[2]] | Profile-enforced once the adapter proves its config-delivery route |
| `claude` | Claude Code `sandbox.filesystem.allowWrite` settings when sandboxing is independently enabled; otherwise existing tool permission mode plus ambient workspace access [[5]][[11]] | Sandbox-enforced when available, otherwise ambient-satisfied |
| `gemini` | Gemini sandbox allowed-path or mount settings when sandboxing is independently enabled; otherwise ambient workspace access [[6]][[7]] | Sandbox-enforced when available, otherwise ambient-satisfied |
| `opencode` | OpenCode tool permissions do not provide a filesystem sandbox, so workspace writes are ambient while existing `edit` / `bash` permissions still control tool approval [[8]] | Ambient-satisfied |

## Decision

### Field

`PermissionPolicy` gains `writablePaths?: string[]`.
The field is a list of additional workspace-relative filesystem subpaths that the adapter must make writable for local execution.
Where an adapter has a filesystem sandbox, the field is an extra write grant inside that sandbox.
Where an adapter has no filesystem sandbox, the field is satisfied by ambient workspace write access after validation, not rejected.

The field is not:

- a command approval rule
- a tool allowlist
- a network grant
- an adapter-private config escape hatch
- a deny-read or deny-write policy
- an outside-workspace mount mechanism
- a cross-adapter promise of identical sandbox strength

### Validation

Each entry in `writablePaths` shall be canonicalized and validated before adapter mapping.
The adapter shall normalize path separators to `/`, strip leading `./` components, strip trailing slashes, collapse `.` components, and emit only the canonicalized value.
For example, `./.git/` canonicalizes to `.git`.
An implementation shall reject:

- empty strings
- entries that normalize to the workspace root, such as `.`, `./`, or empty-after-normalization values
- absolute paths
- paths containing `..`
- paths containing empty path segments after canonicalization
- paths containing glob metacharacters
- paths containing shell expansion or control characters

Entries such as `.git`, `.git/objects`, and `generated/cache` are valid.
When an entry names a directory, it grants the entire directory subtree.
This is why `writablePaths: ['.git']` is sufficient for git writes under `.git/index`, `.git/objects/`, and `.git/refs/`, and why glob entries such as `.git/**` are neither needed nor accepted.
Root-equivalent entries are invalid because they would grant the entire workspace root and reopen protected carve-outs that `writablePaths` is meant to pierce narrowly where such carve-outs exist.
The field applies only under the run's effective workspace root.
If an adapter cannot keep the canonicalized entries workspace-relative, it shall reject the policy rather than silently widen access.

### Enforcement Reporting

Every adapter shall accept a valid non-empty `writablePaths` list unless it conflicts with an explicit deny in the same `PermissionPolicy`.
Each adapter shall expose, in a test-observable mapping result or `init.capabilities`, the canonicalized paths and an enforcement class:

- `profile` for Codex custom permission profiles.
- `sandbox` for Claude or Gemini sandbox write settings.
- `ambient` for adapters or runs where the workspace is already writable without a filesystem sandbox grant.

`writablePaths` shall not enable or disable an adapter's filesystem sandbox as a side effect.
Sandbox enforcement may be reported only when sandboxing is independently active for the run through adapter configuration, user configuration, or an explicit future sandbox option.
This preserves the rule that `writablePaths` is not a command, network, or execution-posture control.

This makes portability explicit without pretending that `ambient` has the same safety properties as `profile` or `sandbox`.

### Conflict Semantics

`writablePaths` conflicts only with an adapter mapping that would make the same paths unwritable at the filesystem layer.
Tool-level denies continue to apply to their tools, but they are not automatically filesystem-write conflicts.

The current adapter-specific conflict rules are:

- `codex`: non-empty `writablePaths` conflicts with a resolved `:read-only` local-access profile, including policies such as `fileWrite: 'deny'` or `shellExecute: 'deny'` that select `:read-only`.
- `claude`: `fileWrite: 'deny'`, `shellExecute: 'deny'`, and `networkAccess: 'deny'` remain tool/permission-mode constraints; they are not `writablePaths` conflicts unless the implementation also maps them to a filesystem deny for the same canonicalized path.
- `gemini`: denied tool groups remain tool constraints; they are not `writablePaths` conflicts unless the implementation also maps them to a filesystem deny for the same canonicalized path.
- `opencode`: `edit: 'deny'`, `bash: 'deny'`, and `webfetch: 'deny'` remain OpenCode tool permission rules; they do not conflict with ambient `writablePaths`.

### Reporting Scope

The `profile` / `sandbox` / `ambient` enforcement class is local to `writablePaths`.
It does not add a general enforcement-strength reporting system for `fileWrite`, `shellExecute`, or `networkAccess` from DR-005.
A later decision may generalize permission enforcement reporting across the full `PermissionPolicy`; if that happens, this field-local reporting should be folded into the general mechanism rather than duplicated.

### Merge Semantics

`writablePaths` participates in [DR-003](003-role-scoped-session-management.md)'s `permissions` merge as a permission-policy field.
Because it is an array of grants, a per-call `permissions.writablePaths` array replaces the instance default array.
It is not element-wise merged.
For example, an instance default `['.git']` plus a per-call override `['dist']` resolves to `['dist']`, not `['.git', 'dist']`.

### Codex Mapping

Codex is the first supported mapping.
When `writablePaths` is non-empty and the resolved Codex local-access profile would otherwise be `:workspace`, the adapter shall synthesize a custom permission profile that extends `:workspace` and adds a `write` filesystem rule for each validated path under `:workspace_roots` [[1]].
This supersedes DR-005's "synthesizing granular `[permissions]` profiles is out of scope" only for this typed field.

The Codex adapter shall keep the approval/reviewer axis unchanged:

- `mode: 'auto'` still selects `approvalPolicy: 'on-request'` plus `approvals_reviewer: 'auto_review'` [[3]].
- `mode: 'bypass'` still selects unchecked approval bypass and `:danger-full-access`.
- `writablePaths` does not approve shell commands.

If the resolved local-access profile is already `:danger-full-access`, `writablePaths` is redundant and shall not narrow that broader posture.
If the resolved local-access profile is `:read-only` with non-empty `writablePaths`, the policy is contradictory and shall be rejected per the conflict rules above.

The Codex adapter shall not rely on SDK `config` passthrough for the filesystem profile definition until an acceptance test proves that the chosen `--config` key shape survives both the SDK serializer and the Codex CLI parser.
The accepted route is a split delivery: simple scalar settings such as `default_permissions` and `approvals_reviewer` use SDK `config` passthrough, while the generated filesystem profile body is injected as a raw CLI `--config` inline table through a per-run Codex path wrapper.
This route preserves the user's normal Codex home, authentication, and configuration layers, and mutates neither machine-level nor repository Codex config.
If that raw CLI route stops representing the profile definition, the adapter shall use a generated Codex profile file or another explicit Codex CLI route that loads the profile without mutating the user's machine-level Codex config.
The adapter may still use SDK `config` passthrough for simple scalar settings such as `approval_policy`, `approvals_reviewer`, and `default_permissions`.

Candidate config-delivery routes have known hazards and none is accepted without an implementation spike:

- SDK flat dotted `--config`: the SDK can emit scalar keys intact, but its recursive flattening cannot represent the profile filesystem table shape.
- Raw CLI inline-table `--config`: accepted for the generated filesystem profile body once the per-run wrapper and acceptance test prove the Codex CLI parser materializes it into the intended profile table.
- `CODEX_HOME` redirection: Codex stores config, auth, logs, sessions, and related state under `CODEX_HOME`, so a temp-home route must preserve auth and must not merely drop the user's login [[10]].
- Project-local `.codex/config.toml`: this mutates the repository and is trust-layer dependent, so it does not satisfy the generated per-run route unless the user explicitly chose a repo-local config file [[10]].
- User-level `$CODEX_HOME/*.config.toml`: this mutates machine-level Codex config and is out of scope.

For `permissions: { mode: 'auto', writablePaths: ['.git'] }`, the generated intent is:

```toml
default_permissions = "cligent-workspace-extra-writes"
approvals_reviewer = "auto_review"

[permissions.cligent-workspace-extra-writes]
extends = ":workspace"

[permissions.cligent-workspace-extra-writes.filesystem.":workspace_roots"]
".git" = "write"
```

### Other Adapter Mappings

Claude shall accept valid non-empty `writablePaths`.
When Claude Code sandboxing is independently active for the run and the adapter can apply per-path sandbox write grants through the SDK surface cligent uses, it shall map the canonicalized paths to `sandbox.filesystem.allowWrite` and report `sandbox` enforcement [[11]].
When sandboxing is not independently active, or when that sandbox write path is unavailable, it shall report `ambient` enforcement and keep command/tool approval controlled through the existing permission-mode and permission-rule mechanisms.
`writablePaths` shall not turn Claude Code sandboxing on by itself.

Gemini shall accept valid non-empty `writablePaths`.
When Gemini sandboxing is independently active for the run and a selected `tools.sandboxAllowedPaths` or `SANDBOX_MOUNTS` mapping grants the requested workspace-relative writes without widening access outside the workspace, the adapter shall report `sandbox` enforcement [[6]][[7]].
Otherwise it shall report `ambient` enforcement and keep command/tool approval controlled through the existing Gemini approval and tool configuration.
`writablePaths` shall not turn Gemini sandboxing on by itself.

OpenCode shall accept valid non-empty `writablePaths` and report `ambient` enforcement.
Its documented permission rules can allow or deny tool inputs and shell command patterns, but they are not a filesystem sandbox profile equivalent to Codex workspace-root write grants [[8]].
The OpenCode adapter shall keep mapping `fileWrite` / `shellExecute` / `networkAccess` to `edit` / `bash` / `webfetch`; `writablePaths` does not add path-level enforcement for those tools.

Ambient acceptance is deliberate.
It keeps one YAML/API config portable across all supported coding agents, while enforcement reporting preserves the safety distinction a caller needs to audit adapter switches.

### Failure Surfacing

Invalid or contradictory `writablePaths` policies shall fail at the same phase as other invalid `PermissionPolicy` mappings per DR-005.
They shall not be silently ignored.

### Out of Scope

- command-rule configuration for `git`
- automatic selection of `git add`, `git commit`, or other command allowlists
- outside-workspace writable roots
- read-deny rules
- adapter-private YAML fields
- inheriting or mutating user machine-level agent config
- making ambient adapters sandbox-equivalent

## Consequences

Codex is expected to support local git metadata writes under `mode: 'auto'` without requiring `mode: 'bypass'` or `:danger-full-access`, once the adapter's config-delivery route is proven.
The minimum user-facing design is `permissions: { mode: 'auto', writablePaths: ['.git'] }`.

The design keeps filesystem writes separate from command approval.
For the target Codex git case, no separate command allowlist is expected when the git command stays inside the sandbox and writes only granted paths.
The acceptance test shall prove this headless outcome; `auto_review` is not the mechanism for that success path, because no approval request should be needed.

Adapter enforcement becomes intentionally uneven, but adapter acceptance is uniform.
Codex can implement profile enforcement only through a proven config-delivery route; Claude and Gemini can report sandbox enforcement when their sandbox path is active; OpenCode reports ambient enforcement.

Future implementation work must add validation tests for canonicalization, root-equivalent rejection, and adapter-specific conflict semantics.
It must also add adapter mapping tests proving that all four adapters accept valid `writablePaths`, report canonicalized paths, and report the correct enforcement class.
Claude and Gemini tests shall cover both independently sandboxed runs (`sandbox`) and non-sandboxed runs (`ambient`) when the harness can exercise both states.
OpenCode tests shall prove `ambient` reporting and no path-level enforcement.

Future implementation work must add Codex config-generation tests and at least one real Codex acceptance test proving a headless git metadata write succeeds under `mode: 'auto'` with `writablePaths: ['.git']` and no human approval.
The Codex acceptance test shall prove a config-delivery route that mutates neither the user's machine-level Codex config nor the repository, preserves required auth, is not silently ignored, and actually makes `.git` writable through the selected profile.
If production splits profile selection and profile definition across channels, such as `default_permissions` through SDK `config` and the profile body through a generated profile route, the acceptance test shall exercise that same split and prove the profile reference resolves across layers.
If no route satisfies those constraints, Codex shall report no profile-enforced implementation, but other adapters shall still accept valid `writablePaths` with their documented enforcement class.

All-ambient implementation is not sufficient to ship the feature as solving the motivating git-write problem.
The minimum release bar is at least one non-ambient implementation, and for the current use case that means Codex `profile` enforcement for `writablePaths: ['.git']`.
Ambient mappings remain required for portability once the field ships, but they are not by themselves the product value of this DR.

## References

[1]: https://developers.openai.com/codex/permissions "Codex: Permission profiles and sandbox settings"
[2]: https://developers.openai.com/codex/config-reference "Codex: Configuration Reference"
[3]: https://developers.openai.com/codex/concepts/sandboxing/auto-review "Codex: Auto-review"
[4]: https://github.com/openai/codex/blob/main/sdk/typescript/README.md "Codex TypeScript SDK"
[5]: https://code.claude.com/docs/en/settings "Claude Code settings"
[6]: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md "Gemini CLI configuration"
[7]: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md "Gemini CLI sandbox"
[8]: https://opencode.ai/docs/permissions/ "OpenCode permissions"
[9]: https://developers.openai.com/codex/agent-approvals-security "Codex: Agent approvals and security"
[10]: https://developers.openai.com/codex/config-basic "Codex: Config basics"
[11]: https://code.claude.com/docs/en/sandboxing "Claude Code sandboxing"
