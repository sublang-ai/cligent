<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-005: Per-Adapter Permission Configuration

## Status

Accepted

## Context

[DR-002](002-unified-event-stream-and-adapter-interface.md) defines the unified event stream and adapter contract.
[DR-003](003-role-scoped-session-management.md) defines `Cligent`'s constructor option merge.
[DR-004](004-tmux-play-captain-architecture.md) defines tmux-play role and captain configuration shapes.

Each coding-agent SDK ships its own permission/approval model that the cligent adapter constructor accepts as options:

| Adapter | Permission knob | "Eliminate prompts" value |
| --- | --- | --- |
| `claude` | `permissionMode` [[1]] | `'auto'` (classifier-backed), `'bypassPermissions'` (no checks) |
| `codex` | `sandboxMode`, `approvalPolicy` [[2]] | `--full-auto` = `on-request` + `workspace-write` |
| `gemini` | `--approval-mode` / `--yolo` [[3]] | `yolo` |
| `opencode` | per-tool `allow` / `ask` / `deny` rules [[4]] | `-p` flag or explicit rules |

Today's gap: `RoleConfig` in `src/app/tmux-play/roles.ts` is `{ id, adapter, model?, instruction? }` — no `options` field.
`captain.options` exists but is forwarded to the Captain factory per DR-004, not to the adapter.
So a YAML user has no way to set `permissionMode: auto` on a role; programmatic `runTmuxPlay` users can construct `Cligent`s directly but bypass the YAML entirely.

Cligent's claude adapter additionally caps `ClaudePermissionMode` at `'bypassPermissions' | 'acceptEdits' | 'default'` — the safe `'auto'` mode is not in the union.
The gemini adapter exposes only `allowedTools` / `disallowedTools` (whitelist / blacklist), not the `yolo` / `approval-mode` toggle.
The opencode adapter exposes no permission knobs at all.

## Decision

### Per-adapter options passthrough

`RoleConfig` shall gain an opaque `options: Record<string, unknown>` field forwarded verbatim to the adapter constructor.
The captain config shall gain a parallel `adapterOptions: Record<string, unknown>` field with the same semantics.
The existing `captain.options` field shall continue to forward to the Captain factory per [DR-004](004-tmux-play-captain-architecture.md), preserving the Captain extension contract.

### Schema shape

`options` is `Record<string, unknown>` (opaque, untyped).
Validation happens at the adapter constructor; invalid options surface as construction errors at session-mode startup, routed through the existing `runtime_error` path per [DR-004](004-tmux-play-captain-architecture.md).

Rationale:

- Adapter SDKs evolve their option shapes independently of cligent; a typed-per-adapter union would couple cligent's release cadence to N upstream SDKs.
- Forward-compatible: SDK upgrades expose new options without a spec change.
- Consistent with the existing `captain.options` precedent (already opaque).

### Default policy

Cligent shall NOT impose a project-wide default permission posture.
Each adapter's SDK default applies unless `options` is provided.
Permission-mode opt-in is per-config; cligent never silently widens permissions for the user.

Documentation and example configs SHOULD recommend the classifier- or sandbox-protected modes (`claude`'s `auto`, `codex`'s `--full-auto`) over the unchecked bypass modes (`claude`'s `bypassPermissions`, `codex`'s `--dangerously-bypass-approvals-and-sandbox`).
That guidance is editorial, not enforcement.

### Per-adapter coverage gaps

Adapters shall expose every permission knob their SDK supports through the adapter's TypeScript constructor options.
Current gaps that block YAML auto-mode configuration:

- `claude`: add `'auto'` to `ClaudePermissionMode` (matching the SDK's enum).
- `gemini`: add an `approvalMode` / `yolo` constructor option distinct from `allowedTools` / `disallowedTools`.
- `opencode`: add per-tool permission options matching the SDK's permission schema.
- `codex`: already exposes `sandboxMode` and `approvalPolicy`; no gap.

### Out of scope

- Per-tool ACL rules in YAML (e.g., a `permissions.allow` / `deny` map distinct from the adapter's native knobs). Future DR if needed.
- Runtime per-call permission overrides above the YAML default.
- Automatic permission-mode escalation or down-shift based on context.

## Consequences

- `captain.options` (Captain factory) and `captain.adapterOptions` (adapter constructor) are distinct YAML fields with disjoint forwarding paths; this preserves [DR-004](004-tmux-play-captain-architecture.md)'s Captain extension contract while enabling adapter options on the captain.
- `RoleConfig.options` is opaque; the YAML loader does not validate it. Adapter constructors are the validation boundary.
- Adapter SDK upgrades that add new options work without a spec or adapter change, provided the YAML passes them through.
- Cligent ships no default permission posture. Users who want auto-mode opt in via config; users who don't get the SDK default.
- Subsequent IRs implement the schema extension, the per-adapter additions named above, and per-adapter tests that an `options` value reaches the SDK constructor.

## References

[1]: https://code.claude.com/docs/en/permission-modes "Claude Code: Choose a permission mode"
[2]: https://developers.openai.com/codex/agent-approvals-security "Codex: Agent approvals & security"
[3]: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md "Gemini CLI configuration"
[4]: https://opencode.ai/docs/permissions/ "OpenCode permissions"
