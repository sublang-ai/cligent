<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CODEX: Codex Adapter Implementation

## Intent

This component defines Codex adapter implementation requirements that are needed to preserve the public Codex adapter contract in [CODEX](../../user/adapters/codex.md).

## Workspace Writable Paths

### CODEX-010

Where a non-empty `PermissionPolicy.writablePaths` policy resolves to Codex profile enforcement per [CODEX-004](../../user/adapters/codex.md#codex-004), when the adapter starts a run, the adapter shall make the generated permission profile definition available to that run through Codex's normal configuration loading without writing repository `.codex/config.toml`, without writing user-level Codex config, and without replacing the user's Codex home, authentication, or session configuration.
