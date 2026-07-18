<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-005: Per-Adapter Permission Configuration

## Status

Accepted

## Context

[DR-002](002-unified-event-stream-and-adapter-interface.md) defines `run(prompt, options?: AgentOptions)` as the option boundary into adapters and pins `AgentOptions.permissions: PermissionPolicy` as the typed channel for permission intent.
[DR-003](003-role-scoped-session-management.md) makes adapter constructors stateless (DI deps only) and routes instance-level defaults through `CligentOptions`, merged with per-call `RunOptions` at `Cligent.run()`.
[DR-004](004-tmux-play-captain-architecture.md) defines the tmux-play YAML player and captain configs.

Each coding-agent SDK ships its own permission/approval model:

| Adapter | SDK / CLI surface | Prompt-reduction mode |
| --- | --- | --- |
| `claude` | `permissionMode` [[1]] | `'auto'` (classifier-backed, still blocks high-risk actions and falls back to prompts after consecutive/total denies); `'bypassPermissions'` (no checks) |
| `codex` | `ThreadOptions.approvalPolicy`; `CodexOptions.config.default_permissions` (modern permission profile) and `CodexOptions.config.approvals_reviewer` [[2]][[6]][[7]][[8]] | `approval_policy = on-request` + `approvals_reviewer = auto_review` + a `default_permissions` profile (eligible approval requests route to a reviewer agent without broadening the profile's filesystem/network limits). The legacy `sandbox_mode` knob is not used: per [[8]] a present `sandbox_mode` makes Codex ignore `default_permissions`. |
| `gemini` | `--approval-mode` / `--yolo` [[3]] | `yolo` (no further prompts) |
| `kimi` | ACP session mode plus `session/request_permission` reverse requests [[9]][[10]] | `auto` is native protected automation; `yolo` retains higher-priority rules and is not an unchecked bypass |
| `opencode` | per-tool `allow` / `ask` / `deny` rules in `opencode.json` [[4]] | `--dangerously-skip-permissions` on `opencode run` [[5]], or `"permission": "allow"` in `opencode.json` [[4]] |

Claude's `'auto'` runs its classifier on a separate classifier model — Sonnet 5 by default, with model-dependent fallbacks (an Opus model for Fable 5 sessions) and a server-side override, none user-configurable — and fails closed:
while the classifier model is unavailable, non-read-only tool calls outside allow rules and working-directory edits are denied outright naming that model, and repeated blocks abort a non-interactive session because the prompt fallback needs a user [[1]].
Permission allow rules resolve before the classifier and keep working when it cannot run; on entering auto mode, broad code-execution allow rules are dropped while narrow rules carry over [[1]].

Cligent already provides a typed abstraction surface, `PermissionPolicy = { fileWrite, shellExecute, networkAccess }` of `'allow' | 'ask' | 'deny'`.
Each adapter has a `mapPermissionsToXxxOptions` that translates `PermissionPolicy` to its SDK knobs inside the adapter (see e.g., `src/adapters/codex.ts` `mapPermissionsToCodexOptions`, `src/adapters/claude-code.ts` `mapPermissionsToClaudeOptions`).

Today's gap is two-layered:

- **YAML reachability**: tmux-play's `PlayerConfig` is `{ id, adapter, model?, instruction? }` — no `permissions` field. `captain.options` exists but forwards to the Captain factory per DR-004. Nothing in the YAML reaches `CligentOptions.permissions`.
- **Auto-mode vocabulary**: `PermissionPolicy` cannot express auto-mode intent (classifier-, sandbox-, or reviewer-protected `auto` vs unchecked `bypass`). The existing mapping in `mapPermissionsToClaudeOptions` collapses any all-`allow` policy to `bypassPermissions`; there is no path to claude's safer `'auto'`. The same gap applies to codex's reviewer-protected `on-request + auto_review` mode versus its `--dangerously-bypass-approvals-and-sandbox`, and to gemini's `yolo`.

## Decision

### Channel — through CligentOptions, not adapter constructors

YAML carries permissions through fields that forward to `CligentOptions`, never to adapter constructors.
This preserves DR-003's "constructor = DI deps only" and DR-002's `run(prompt, options)` boundary; the runtime path is unchanged.

Specifically:

- `PlayerConfig` gains `permissions?: PermissionPolicy`, forwarded to the player's `Cligent` constructor as `CligentOptions.permissions`.
- The captain config gains `permissions?: PermissionPolicy`, forwarded to the captain's `Cligent` constructor as `CligentOptions.permissions`.
- The existing `captain.options` field continues to forward to the Captain factory per [DR-004](004-tmux-play-captain-architecture.md); it is *not* repurposed.
- `Cligent.run()` merges instance defaults with per-call `RunOptions` per DR-003's option-merge contract; adapters receive the merged `AgentOptions` at `run()` and map via their existing `mapPermissionsToXxxOptions`.

### Schema — typed, not opaque

YAML uses the existing typed `PermissionPolicy` shape.
No `Record<string, unknown>` escape hatch; no adapter-specific knob is directly settable from YAML.
Adapter-specific knobs (`permissionMode`, Codex `ThreadOptions` fields, Codex `CodexOptions.config` overrides such as `default_permissions` and `approvals_reviewer`, `--yolo`) are derived inside the adapter's mapping function from the abstract `PermissionPolicy`.

Rationale: a typed surface preserves cross-adapter substitutability — a user who switches a player from `claude` to `codex` gets the same `permissions` semantics, mapped to each SDK's knobs by the adapter.

### Auto-mode — expand PermissionPolicy

`PermissionPolicy` shall be extended to express auto-mode intent: classifier-, sandbox-, or reviewer-protected automation distinct from unchecked bypass.
The exact field name and shape is IR-level work; the DR's constraint is that the addition is a typed PermissionPolicy field, not a new top-level YAML escape hatch.

Each adapter's mapping function shall translate the new vocabulary to its SDK's auto-mode value:

| Adapter | Auto-mode mapping | Bypass mapping (already present where applicable) |
| --- | --- | --- |
| `claude` | `permissionMode: 'auto'` (after adding `'auto'` to `ClaudePermissionMode`) | `permissionMode: 'bypassPermissions'` |
| `codex` | `ThreadOptions: { approvalPolicy: 'on-request' }` plus `CodexOptions.config: { approvals_reviewer: 'auto_review', default_permissions: <profile> }` — see *Codex — modern permission-profile model* below | `ThreadOptions: { approvalPolicy: 'never' }` plus `CodexOptions.config: { default_permissions: ':danger-full-access' }` |
| `gemini` | `--approval-mode yolo` (after adding a yolo / approval-mode option to the adapter) | — |
| `kimi` | ACP `session/set_config_option` with `mode = 'auto'` | Reject: ACP `yolo` is not unchecked bypass |
| `opencode` | `permission: 'allow'` config, or `--dangerously-skip-permissions` flag [[5]] (after adding permission options to the adapter) | — |

### Headless auto-mode posture

Cligent runs are headless: the interactive prompt fallback each SDK's protected auto-mode leans on has no user to answer it.
`mode: 'auto'` shall nevertheless map to each SDK's native protected auto-mode exactly, adding no cligent-selected capability grants; headless auto is accepted as semi-equivalent to the interactive CLI — identical automation minus the human fallback, so actions the SDK would refer to a user (including every classifier-band action while Claude's classifier model is unavailable) end in denial rather than approval.
An alternative that widened auto with cligent-chosen network grants — pre-approved Claude `WebFetch` / `WebSearch` / `Bash(curl:*)` allow rules ahead of the classifier, a generated Codex profile extending `:workspace` with `network = { enabled = true }` (grammar validated credential-free via `codex sandbox`), and an opencode `websearch: 'allow'` pin — was implemented and rolled back: a curated grant list is ad hoc, cannot anticipate the next task's tools, and blurs the auto/bypass distinction this DR exists to keep.
Callers that need unattended capabilities beyond the SDK's protected auto shall say so explicitly (`mode: 'bypass'`); a typed opt-in that widens specific capabilities under auto stays open for a future revision.
Known headless hazard, deliberately left to user configuration: opencode's `websearch` is a permission key distinct from `webfetch` [[4]], and a `websearch: 'ask'` in the user's opencode config blocks a headless server run indefinitely — the server waits on a permission reply no client sends.
Kimi's ACP client sees only permission decisions that the Kimi policy engine has already reduced to `ask`; configured allows, denies, native safe-tool decisions, and structural checks may resolve earlier [[10]].
Kimi shall therefore reject a provided no-mode capability policy, emit any remaining ACP permission request for observability, and answer it with a fail-closed rejection per [KIMI-007](../user/adapters/kimi.md#kimi-007).

### Codex — modern permission-profile model

Codex exposes two non-composing permission models [[8]]: the modern `default_permissions` / `[permissions]` profiles, and the legacy `sandbox_mode` / `sandbox_workspace_write` knobs.
If `sandbox_mode` (or `--sandbox`, or a config profile that sets it) is present in any active config layer, Codex ignores `default_permissions` and uses the legacy settings instead.

The Codex adapter shall express the local-access surface only through the modern model.
It shall not set `ThreadOptions.sandboxMode` or `ThreadOptions.networkAccessEnabled`, because both select the legacy model and suppress `default_permissions`.
The approval/reviewer posture and the local-access surface are independent Codex axes:

- **Approval/reviewer axis** — `ThreadOptions.approvalPolicy` plus `CodexOptions.config.approvals_reviewer`. `mode: 'auto'` selects `approvalPolicy: 'on-request'` + `approvals_reviewer: 'auto_review'` (auto-review applies only under interactive approvals [[6]]); `mode: 'bypass'` selects `approvalPolicy: 'never'` and no reviewer.
- **Local-access axis** — `CodexOptions.config.default_permissions`, a built-in profile (`:read-only` / `:workspace` / `:danger-full-access`).

`mode` governs the approval/reviewer axis; the per-capability `fileWrite` / `shellExecute` / `networkAccess` levels govern the local-access axis — the [ENG-021](../user/engine.md#eng-021) orthogonal-axis composition, distinct from the precedence rule that applies where an SDK does not separate the two.
The exact per-capability → profile mapping is [CODEX-004](../user/adapters/codex.md#codex-004).
Built-in profiles cannot express a workspace-write surface with network enabled, so that combination is lossy (it rounds to `:workspace`, granting no network); synthesizing granular `[permissions]` profiles is out of scope.

**Determinism caveat.** `default_permissions` is authoritative only when no legacy `sandbox_mode` exists in the active Codex config layers.
For cligent-managed permission runs, the adapter invokes Codex `exec` with `--ignore-user-config` so the user's `$CODEX_HOME/config.toml` does not silently replace the requested profile; auth and session state still come from `CODEX_HOME`.
Project-local Codex config layers and future managed configuration routes remain subject to Codex's own precedence rules.

**Inheriting the user's Codex config** — letting Codex's own `default_permissions` / CLI/Desktop config be authoritative instead of cligent picking a profile — is deliberately out of scope.
It is non-deterministic and would make `mode: 'auto'` machine-dependent.
If added later it shall be an explicit opt-in, never the default for `mode: 'auto'`.

### Default policy

Cligent shall not impose a project-wide default permission posture.
SDK defaults apply unless `permissions` is provided.
Documentation and example configs may recommend classifier-, sandbox-, or reviewer-protected modes (`claude`'s `auto`, `codex`'s `on-request + auto_review`) over unchecked bypass; that guidance is editorial, not enforcement.

### Failure surfacing

Invalid permission options surface at two distinct phases, neither of which is the runtime's `runtime_error` record path:

- **At launcher startup**, before the runtime exists: `createTmuxPlayRuntime` constructs every player and captain `Cligent` before instantiating `TmuxPlayRuntime`. Adapter-construction or `Cligent`-construction failures at this phase propagate as thrown Promise rejections from `createRuntime`, caught at the launcher session-mode entrypoint, and exit with a stderr error and nonzero status. There are no observers to dispatch records to at this phase.
- **At first `run()` call**, after the runtime exists: an invalid `AgentOptions.permissions` value (e.g., a mapping function that cannot translate the requested mode) surfaces as a `player_finished` or `captain_finished` record with `status: 'error'` per the existing runtime contract, and is rendered through the presenter per [TMUX-039](../user/tmux-play.md#tmux-039).

The DR does not introduce new error machinery; it constrains where errors should appear so future implementations don't assume the wrong path.

### Out of scope

- Per-adapter knob escape hatches in YAML (e.g., setting `default_permissions` directly bypassing `PermissionPolicy`).
- Inheriting the user's machine-level Codex permission config; a `mode: 'auto'` Codex posture is always a cligent-selected profile, never a deferral to `~/.codex/config.toml`.
- Per-tool ACL rules in YAML distinct from `PermissionPolicy`.
- Runtime per-call permission overrides above the YAML default; per-call overrides remain a programmatic-API capability via `RunOptions.permissions`.
- Automatic permission-mode escalation or down-shift based on context.

## Consequences

- DR-002's `run(prompt, options)` boundary is preserved; DR-003's "adapter constructor = DI deps only" is preserved; DR-004's `captain.options` semantics are preserved.
- `PermissionPolicy` gains vocabulary for auto-mode; existing callers without the new field map as before.
- The original four adapters retain their established mappings, while Kimi adds only its reachable native `auto` posture and rejects unsupported no-mode and bypass requests before invocation.
- A YAML-only user cannot reach adapter-private knobs; consistency wins over expressivity. Programmatic API users can still pass `AgentOptions.permissions` directly with the same vocabulary.
- Cligent ships no default permission posture; user choice is explicit per config.
- Startup-phase option failures abort the launcher with a stderr message and nonzero exit; mid-session failures route through `player_finished` / `captain_finished` `status: 'error'`. Implementers shall not introduce a `runtime_error` path for startup option failures.
- Subsequent IRs implement: the `PermissionPolicy` extension, the YAML `permissions` fields, each adapter's mapping update, and per-adapter tests that an `AgentOptions.permissions` value reaches the SDK's chosen knob.
- The Codex adapter abandons the legacy `ThreadOptions.sandboxMode` / `networkAccessEnabled` knobs for the modern `default_permissions` profile model; a subsequent IR implements this mapping, superseding the earlier sandbox-based Codex posture.

## References

[1]: https://code.claude.com/docs/en/permission-modes "Claude Code: Choose a permission mode"
[2]: https://developers.openai.com/codex/agent-approvals-security "Codex: Agent approvals & security"
[3]: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md "Gemini CLI configuration"
[4]: https://opencode.ai/docs/permissions/ "OpenCode permissions"
[5]: https://opencode.ai/docs/cli/ "OpenCode CLI reference"
[6]: https://developers.openai.com/codex/concepts/sandboxing/auto-review "Codex: Auto-review"
[7]: https://developers.openai.com/codex/config-reference "Codex: Configuration Reference"
[8]: https://developers.openai.com/codex/permissions "Codex: Permission profiles and sandbox settings"
[9]: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html "Kimi Code ACP reference"
[10]: https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files "Kimi Code permission rules"
