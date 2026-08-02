<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-038: Runnable First tmux-play Session

## Goal

Make the documented `npm install -g @sublang/cligent` plus `tmux-play` path
reach a session that runs, by generating first-run defaults only from the
adapters whose runtimes are installed and by reporting any unmet runtime with
its install command before a tmux session exists, while the agent SDKs stay
optional peers.

## Status

Done

## Deliverables

- [x] DR-012 records the runtime-derived default and check-never-install
      posture, and canonical items define the first-run roster, the launcher
      gate, and the global-install dependency contract.
- [x] A readiness module owns the per-adapter runtime requirements, the
      install-scope-correct repair commands, and the probe, which is each
      adapter's own availability check.
- [x] First-run config generation follows the installed runtimes and refuses,
      writing nothing, when none is installed.
- [x] Launcher mode fails before creating a work directory, snapshot, or tmux
      session when a configured role's runtime is missing.
- [x] Distributable verification drives the installed executable in a global
      prefix with no agent runtime reachable, then with one installed.
- [x] README, tmux-play, and guide documentation state the same dependency
      contract the launcher enforces, and the unreleased changelog records the
      fix.

## Tasks

Each task is one commit and keeps build, typecheck, lint, unit, and smoke
checks green at its boundary.

1. [x] **Specify the runtime-derived defaults and the launcher gate.**
       Record DR-012, amend TMUX-002, TMUX-010, TMUX-011, TMUX-061, and
       TTMUX-001, add TMUX-089, TTMUX-092, TTMUX-093, PKG-015, and TPKG-006,
       record IR-038, and update the spec map.
2. [x] **Implement readiness-derived defaults and the pre-session gate.**
       Add the readiness module, generate the first-run roster from installed
       runtimes, gate launcher mode on every configured role's runtime, keep
       theme diagnostics free of config creation, and cover all of it with
       unit and launcher tests.
3. [x] **Verify the global install path.**
       Extend distributable verification with a global prefix holding no agent
       runtime and a scrubbed search path, asserting the refusal, the absent
       config, and the absent session, then the generated single-adapter
       roster and the created session once one SDK is installed.
4. [x] **Document the dependency contract.**
       Align README, tmux-play, and guide install guidance with the enforced
       contract and record the fix in the unreleased changelog.

## Acceptance criteria

- In an isolated global prefix holding only the packed tarball, with no agent
  CLI reachable, the documented launcher command fails, names the install
  command for every supported adapter, creates no config, and issues no tmux
  command.
- With one agent SDK installed into that same prefix, the same command creates
  a config naming only that adapter, prints a notice naming it, and creates a
  tmux session.
- A config assigning any role to an adapter whose runtime is not installed
  fails before session construction, naming the adapter, its roles, its
  install commands, and the config path.
- Repair commands carry `-g` for a global installation and no scope flag for a
  project installation, external CLI packages carry `-g` in both, and the
  reported tree is the `node_modules` root the adapters resolve from.
- The agent SDKs remain optional peer dependencies and no lifecycle script
  installs them.
- Build, lint, typecheck, unit, smoke, package, and distributable checks pass.
