<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CODEX: Codex Adapter Implementation

## Intent

This component defines Codex adapter implementation requirements that are needed to preserve the public Codex adapter contract in [CODEX](../../user/adapters/codex.md).

## Workspace Writable Paths

### CODEX-010

Where a non-empty `PermissionPolicy.writablePaths` policy resolves to Codex profile enforcement per [CODEX-004](../../user/adapters/codex.md#codex-004), when the adapter starts a run, the adapter shall make the generated permission profile definition available to that run through Codex's normal configuration loading without writing repository `.codex/config.toml`, without writing user-level Codex config, and without replacing the user's Codex home, authentication, or session configuration.
Where a run carries a `PermissionPolicy` whose mapped permission profile can
cause Codex to auto-persist project trust, when the adapter starts the run, the
adapter shall resolve the caller-selected workspace to the project root used by
Codex and supply its trust decision as a per-run CLI configuration override so
Codex does not persist a `projects.<path>.trust_level` entry.
The resolver shall preserve Codex's lexical absolute-path identity after its
native Windows device-prefix simplification instead of independently
realpath-canonicalizing symlink aliases.
For a linked worktree, this shall be the main repository root resolved from the
worktree's `.git` file, matching Codex's active-project trust lookup.
The trust override shall encode the complete top-level `projects` inline table,
not a dotted key containing a quoted path segment, so Codex's CLI override
parser materializes the absolute path as the project-table key.
The override shall not create a project or user configuration file.
When the caller omits `cwd` or supplies an empty value that the SDK does not
forward as `--cd`, the adapter shall not inject project trust because Codex's
project auto-trust path is not active for that run.
Mappings that resolve to `:read-only` shall not inject project trust because
Codex does not auto-persist trust for those mappings, and trusting them would
unnecessarily enable project-local configuration and executable policy.
