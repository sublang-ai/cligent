<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-012: Runtime-Derived tmux-play Defaults

## Status

Accepted

## Context

The documented onboarding path is `npm install -g @sublang/cligent` followed by `tmux-play`.
That path installed cleanly and then failed at the first Boss turn, because the generated default config named the `claude` and `codex` adapters while the agent SDKs those adapters import are optional peers ([PKG-004](../dev/package.md#pkg-004)) that a global install does not bring along.

Two properties of the code made the failure late and opaque.
Adapter construction never touches an SDK — each adapter imports its own lazily inside `run()` — so building the roster succeeded and only the first prompt failed.
By then the report was inside a tmux pane, behind an alternate screen the user could not act on.

The package cannot resolve this by acquiring the runtimes.
Promoting the SDKs to installed dependencies would push two vendor runtimes and their platform binaries onto every library consumer, and it cannot help `gemini` or `kimi` at all, whose runtimes are executables on `PATH` rather than npm peers.

## Decision

Optional peers stay optional; cligent checks for agent runtimes and never installs them.

- A first run generates its default roster from the adapters whose runtimes are installed, in the canonical adapter order, capped at two ([TMUX-011](../user/tmux-play.md#tmux-011)).
  With none installed it writes no file and fails with the install command for every supported adapter, because a config naming absent runtimes is the defect being removed ([TMUX-010](../user/tmux-play.md#tmux-010)).
- Launcher mode verifies every configured role's adapter runtime after resolving the config and before creating anything, and fails naming each unmet adapter, its roles, its install commands, and the config path ([TMUX-089](../user/tmux-play.md#tmux-089)).
  This covers hand-written configs, `--config` files, copied configs, and a host that drifts after generation, which roster generation alone cannot.
- Readiness is each adapter's own `isAvailable()`, so the gate and the load it protects can never disagree.
- Repair commands are scoped to the tree the running package resolves from: a peer SDK follows cligent's own install scope, an external CLI is always global, and the reported tree is the `node_modules` root itself so a layout no canned command repairs stays diagnosable ([PKG-015](../dev/package.md#pkg-015)).
  "Scoped" has to mean the command lands there when run as printed, and where a bare `npm install [-g]` lands is a property of the shell the command is pasted into — its npm environment, which npm rewrites for every lifecycle child, and its working directory, whose nearest enclosing project captures a bare project install — which the launching process can never witness.
  So the tree is classified **structurally** — a project install root carries the manifest that made it one, a global prefix's `lib` does not — rather than by whether the working directory happens to sit inside it, which misreports a project install invoked from anywhere else as global.
  And every peer-SDK command names the tree with `--prefix`, because npm's command line outranks both its environment and its project discovery, so the pinned form lands in the named tree in every context where the bare form would only sometimes.
  `--prefix` is only safe against a real project root: npm treats a manifest-less directory as a project to prune, which against a global prefix's `lib` would uninstall cligent itself — so the global case uses `-g --prefix <prefix>`, never a bare `--prefix <lib>`.
  External CLIs stay unpinned by design; they are found through `PATH`, so they belong in whatever global prefix the user's shell already reads.

This decision supersedes only [DR-004](004-tmux-play-captain-architecture.md)'s fixed two-player first-run roster; its remaining architecture stays in force.

## Consequences

A user with credentials for one provider reaches a working session after installing one runtime, instead of being told to install two.
The same command can now produce different configs on different hosts; the generated file is user-owned afterward, and the first-run notice names the adapters the roster was built from so the roster is never a silent function of host state.
A host that gains a provider later keeps its original roster: re-deriving a user-owned file would be destructive, and [TMUX-010](../user/tmux-play.md#tmux-010)'s migration deliberately adds no roles.

The gate is fatal rather than advisory.
A warning would be written immediately before tmux takes the terminal, so it would be invisible for the whole session — reporting in name only.
The cost is that a config whose players are partly unavailable no longer launches degraded; the error names the config path, and editing it is the deliberate act that starting a knowingly broken roster should require.

Readiness means installed, not authenticated.
Vendor credentials remain the provider's own concern and still surface as a run-time error; cligent stores no credentials and starts no authentication flow, so it gates only on what an install command repairs.
An escape hatch for a false negative was considered and rejected: the probe is the same call the adapter itself would fail on, so disabling it could only restore the original defect.
Per-adapter model and effort pins stay limited to the adapters this project pins, since a portable `effort` is not valid for every adapter.
