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
- [x] The repair command targets the tree cligent actually resolves from: the
      install is classified by the manifest at its root rather than by the
      working directory, every peer-SDK command names the tree with
      `--prefix` — the launching process cannot witness the paste-time
      shell's npm environment or working directory — with prefix paths
      shell-quoted, and a tree no command reaches carrying a named manual
      placement instead of one.
- [x] First-run config generation follows the installed runtimes and refuses,
      writing nothing, when none is installed.
- [x] Launcher mode fails before creating a work directory, snapshot, or tmux
      session when a configured role's runtime is missing.
- [x] Distributable verification drives the installed executable in a global
      prefix with no agent runtime reachable, then with one installed by
      running the printed repair command verbatim, so a command scoped to the
      wrong tree fails the gate rather than passing beside it.
- [x] README, tmux-play, and guide documentation state the same dependency
      contract the launcher enforces, and the unreleased changelog records the
      fix.

## Tasks

Each task is one commit and keeps build, typecheck, lint, unit, and smoke
checks green at its boundary.

1. [x] **Specify the runtime-derived defaults and the launcher gate.**
       Record DR-012, amend tmux-play-2, tmux-play-10, tmux-play-11, tmux-play-61, and
       tmux-play-101, add tmux-play-89, tmux-play-192, tmux-play-193,
       package-15, package-32, package-33, and tmux-play-201,
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
5. [x] **Print only provable repair commands.**
       Ask npm for its effective global prefix instead of matching a set of
       plausible roots, pin a project tree whenever a nearer manifest or
       `node_modules` directory would capture a bare install, quote prefix
       paths a shell would split, and replace the peer install command with a
       named manual placement for trees no npm invocation reaches.
6. [x] **Treat an unconsultable npm as unconfirmed.**
       Report no global root when `npm prefix -g` errors, times out, or
       prints nothing, instead of substituting an environment or Node-derived
       guess whose coincidental match would license a bare `npm install -g`
       that npm's real configuration sends elsewhere; nothing confirmed keeps
       the explicit `--prefix`.
7. [x] **Always pin peer repairs.**
       Where a bare install lands is a property of the paste-time shell: npm
       injects transient prefix configuration into every lifecycle child's
       environment, so even a successful `npm prefix -g` inside the
       launching process can confirm a prefix that shell does not have, and
       the launching working directory need not be the pasting one, whose
       nearest enclosing project captures a bare project install. Drop the
       probe and the invoking-directory walk; name the tree with `--prefix`
       on every peer-SDK command — npm's command line outranks its
       environment and its project discovery, so the pinned form holds in
       every context.
8. [x] **Pin install scope with the tree.**
       An inherited `npm_config_global=true` — or `npm_config_location=global`,
       since npm's global mode is the disjunction of the two configurations —
       diverts a prefix-pinned project install into `<prefix>/lib/node_modules`,
       outside the reported project tree. Project peer commands set both
       operands to their non-global values (`--global=false
       --location=project`); `-g` alone settles the global case, a true
       operand winning the disjunction.

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
- Repair commands carry `-g` for a global installation and explicit
  non-global scope settings for a project installation, external CLI packages
  carry `-g` in both, and the reported tree is the `node_modules` root the
  adapters resolve from. Every peer-SDK command carries `--prefix`; prefix
  paths are shell-quoted; and an unreachable tree names a manual placement
  instead of an install command.
- The agent SDKs remain optional peer dependencies and no lifecycle script
  installs them.
- Build, lint, typecheck, unit, smoke, package, and distributable checks pass.
