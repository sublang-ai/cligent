<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-040: Runtime Compatibility and Consented Provisioning

## Goal

Make cligent the single authority for which agent-runtime versions work,
per [DR-013](../decisions/013-cligent-owned-runtime-compatibility.md), and
then let the readiness layer run the repair it renders on an explicit consent
from a user at a terminal, per DR-014.
Phase one ships the runtime descriptor, the load-time version gate, and the
structured readiness verdict, so a consumer inherits the compatibility policy
by upgrading cligent alone.
Phase two provisions against the version phase one declares.
Unattended, continuous-integration, declined, and unreachable-tree
invocations keep today's printed remedy and exit code unchanged.

## Status

Planned

## Scope

The capability covers only an adapter whose runtime includes a peer SDK
resolved from cligent's own tree — `claude`, `codex`, and `opencode`.
An adapter whose runtime is an external CLI found through `PATH` — `gemini`,
`kimi`, and `opencode`'s CLI half — keeps its unpinned printed command
unchanged, because the tree such a command lands in is the paste-time shell's
own global prefix, which this process cannot witness and must not redirect.
Phase one covers every runtime an adapter requires, including the external
CLIs and the paired OpenCode SDK and CLI, because a version the adapter
selects is a version cligent verifies; only the consented install of phase two
is restricted to peer SDKs.
`@sublang/playbook`, `@sublang/slc`, and `@sublang/spex` are sibling projects
outside this repository; they are the consumers the exported surface exists
for, and no item here depends on their contents.

## Deliverables

- [x] A decision record states that cligent owns runtime compatibility: one
      shipped descriptor per runtime declaring identity, tested version,
      supported range, and repair; the supported range's upper bound enforced
      at load and never published in `peerDependencies`; and a structured
      verdict distinguishing missing from incompatible.
- [x] The descriptor ships through the exports map, and repository
      verification asserts each declared version equals the manifest's peer
      range and exact development pin, so the two cannot drift.
- [x] Every adapter reads its runtime's version through the resolution it
      loads with, refuses a version below the floor with an error naming the
      installed and required versions, the resolved tree, and the repair, and
      loads unchanged when the version cannot be read.
- [x] The readiness verdict is structured and exported, so a consumer stops
      translating a boolean into "not installed" for a runtime that is
      installed but incompatible.
- [ ] A decision record states that cligent may acquire an optional peer SDK
      only on an explicit affirmative response from a user attached to a
      terminal, running the exact argv it displayed into the tree it named,
      and supersedes DR-012's never-installs clause in part.
- [ ] Canonical items define the consent offer, the interactivity predicate —
      which refuses under continuous integration even where a terminal is
      attached — the refusal for an unreachable or npm-exec cache tree, and
      the serialization that keeps one target tree safe under concurrent
      provisioning by several cligent-based tools.
- [ ] The install-target classification recognizes an npm exec cache tree and
      offers no command for it, replacing today's misreport of that tree as a
      project install.
- [ ] A provisioning module owns the sequence probe, lock, probe again,
      install, probe again — where every probe is the adapter's own
      `isAvailable()`, so the module and the load it protects can never
      disagree — and is unreachable from any code path that has not opted in.
- [ ] The launcher offers the install at the readiness gate and on the
      first-run path where no runtime is installed, in one consent line
      naming each package, the target tree, and the approximate download
      size, and streams the child's output as it is produced.
- [ ] No terminal and a refused tree reproduce today's message and exit code
      byte for byte; a decline reproduces the same remedy text and exit code,
      with the offer and the answer the only added bytes.
- [ ] The generic half of the readiness surface is exported for cligent-based
      tools, with the prefix-pinned peer-SDK command shape as its
      compatibility contract, and the packaging items name the new surface.
- [ ] The release rules classify an exports-map subpath or named-export
      addition as MINOR and its removal or narrowing as MAJOR, and state
      whether the rendered command text sits inside that contract.
- [ ] Distributable verification installs a peer SDK from a packed tarball
      into throwaway prefixes and asserts it lands as its own top-level root
      in the reported `node_modules`, never nested under cligent or a
      consumer, with one run satisfying a second tool sharing that prefix.
- [ ] README, tmux-play documentation, and the unreleased changelog state the
      consented-install behavior, replacing the installs-nothing claim.

## Tasks

Each task is one commit and keeps build, typecheck, lint, unit, and smoke
checks green at its boundary.

1. [x] **Record the compatibility decision and its canonical items.**
       Record DR-013; amend PKG-009 for the no-upper-bound rule and the
       conditions under which a floor moves, and PKG-012 for the
       tested-versus-supported distinction; add PKG-016 for the shipped
       descriptor; add ENG-025 for the load-time gate and ENG-026 for the
       structured verdict; add TENG-018; amend TMUX-089 so an incompatible
       runtime is reported distinctly from an absent one; add the DR-013 row
       and refresh the PKG and ENG summaries in the spec map.
2. [x] **Ship the runtime descriptor.**
       Add the descriptor module and its exports-map subpath; invert
       ownership of the conformance literals so the repository verifier
       imports them instead of declaring its own; add the assertion that each
       descriptor version equals the manifest's peer range and development
       pin; raise the peer floors the descriptor now declares.
3. [x] **Gate the runtime at load.**
       Read each peer SDK's version through the resolution its loader already
       uses — for Codex, through the anchor that selects the executable, so
       the version checked is the version spawned — and each CLI's version
       from the probe that already runs it and discards the output; refuse
       below the floor with the named error; leave `isAvailable()` boolean and
       unchanged in shape so it inherits the check.
4. [x] **Export the structured verdict.**
       Add the readiness verdict, distinguishing satisfied, missing,
       unsupported, untested, and unknown, carrying installed and required
       versions, the resolved tree, and the repair commands; render it in the
       launcher gate so a stale runtime reports its versions; export it for
       consumers.
5. [x] **Document the compatibility contract.**
       State in README and the guide which declaration form a consumer should
       use so a cligent upgrade carries the runtime forward, replacing the
       bare install commands that currently write a freezing caret into a
       consumer manifest, and record the change in the unreleased changelog.
6. [ ] **Record the consent decision and the tmux-play items.**
       Record DR-014 and amend DR-012's Context premise, Decision opener,
       no-runtime bullet, and fatal-gate consequences, adding a
       superseded-in-part note; amend TMUX-010 and TMUX-089 so today's text
       becomes the no-consent branch, splitting the print-nothing-on-stdout
       clause away from the declined-at-a-terminal case, and settle whether
       TMUX-002's launcher-mode step sequence gains the branch or inherits it
       through its TMUX-089 citation; add TMUX-090 for the offer and TMUX-091
       for the npm-exec cache tree; amend TTMUX-092 and TTMUX-093 with the
       same preconditions and add TTMUX-094 and TTMUX-095 as their
       integration counterparts; add the DR-014 row to the spec map and
       refresh the DR-012 and TMUX summaries there.
7. [ ] **Specify the install-placement contract.**
       Amend PKG-015 to scope its prohibition to the distributable's own
       installation and to grant the consented install; add PKG-016 for the
       top-level-root placement outcome; amend TPKG-003 for the absent
       install lifecycle script, which nothing verifies today, and TPKG-006
       for the unattached-terminal contract its harness currently satisfies
       only by accident of piping; add TPKG-007; refresh the PKG summaries in
       the spec map.
8. [ ] **Specify the exported provisioning surface.**
       Amend PKG-014 and TPKG-002 for the documented surface the export lands
       on, state what a library caller may and may not do with the install
       capability PKG-015 grants the executable, add RELEASE-011 under the
       versioning section beside RELEASE-001, and refresh the RELEASE and
       PKG summaries in the spec map.
9. [ ] **Classify npm exec cache trees.**
       Give `InstallTarget` an inhabitant for a tree created by `npm exec`,
       detected structurally from the resolved module path and the
       install-root manifest rather than from inherited npm environment
       variables, which a grandchild process inherits from an unrelated
       ancestor; print no install command and offer no install for it, and
       stop reporting it as a project install.
10. [ ] **Execute every printed peer repair command.**
       Distributable verification asserts the Claude SDK repair command only
       as a substring while it executes the Codex one, so a peer command that
       renders correctly but installs elsewhere passes today; run each
       printed peer-SDK command as argv and assert its landing tree, leaving
       external-CLI commands asserted as rendered text because their target
       is the paste-time shell's own prefix.
11. [ ] **Separate the provisioning surface from the tmux-play copy.**
       Split target resolution, command rendering, and the adapter probe from
       the tmux-play-worded formatters, moving the importers rather than
       re-exporting through the old module; decide where the adapter-name
       vocabulary the split half types against lives, and which side the
       combined probe-and-report helper lands on, so the exported surface is
       not named after the app it was extracted from.
12. [ ] **Add the guarded provisioning core.**
       Add the module, wired to no call site: an injected streaming spawner
       mirroring the existing tmux runner's error shape, a lock keyed by the
       target tree under a user-writable path outside a possibly unwritable
       prefix, the adapter's own `isAvailable()` repeated inside the lock, a
       post-install probe that decides the outcome because npm can exit zero
       having installed nothing, a bounded wait that degrades to the printed
       remedy, and refusal for an unreachable or npm-exec target.
13. [ ] **Offer the install at the readiness gate.**
       Wire the core into the launcher gate and the first-run roster path
       behind an option that defaults to off, so a library consumer calling
       the exported config loader never prompts or installs; print one
       consent line naming each package, the target tree, and the approximate
       download size; stream npm live; re-probe and continue. Decline, no
       terminal, continuous integration, a caller-declared machine-readable
       mode, and refusal fall through to today's message and exit code.
14. [ ] **Verify consented provisioning from packed tarballs.**
       Extend distributable verification with a terminal-attached affirmative
       run that installs into a throwaway prefix supplied out of band and
       asserts the peer lands as its own top-level root there, a declined run
       reproducing the refusal, a concurrent pair against one tree producing
       one install and no broken tree, and a second consumer sharing that
       prefix installing nothing; raise the launcher-invocation timeout,
       which today bounds a run at less than a cold install of the largest
       peer.
15. [ ] **Export the provisioning surface.**
        Export the generic half and the provisioning entry on the surface
        task 3 specified, leaving the tmux-play-worded formatters internal,
        extend the packed-consumer fixtures that enumerate imports by hand,
        and have a packed consumer provision through the exported entry.
16. [ ] **Document consented runtime provisioning.**
        Replace the installs-nothing claims in README and tmux-play
        documentation, state what a consented install does and how to avoid
        it, and record the change in the unreleased changelog.

## Acceptance criteria

- Where every configured adapter's runtime already resolves from the target
  tree, no consent line is printed, nothing is read from stdin, no npm child
  is spawned, and the launch proceeds unchanged.
- With no agent runtime installed and no terminal attached, the documented
  launcher command produces byte-identical stdout, stderr, and exit code to
  the current release, creates no config, issues no tmux command, and reads
  nothing from stdin.
- With a terminal attached and continuous integration signalled, the command
  makes no offer, reads nothing from stdin, installs nothing, and reproduces
  the same remedy and exit code.
- Where the caller declares machine-readable output, the same holds, so a
  consumer's own `--json` mode never blocks on a prompt.
- With a terminal attached and consent declined, the command reproduces the
  same remedy text and exit code, and installs nothing; the offer and the
  answer are the only bytes added to the stream that carries the offer.
- With a terminal attached and consent given, the offer is a single line
  naming each package, the `node_modules` tree it will land in, and an
  approximate download size; the command then runs the argv it displayed,
  the child's first output bytes appear before that child exits, and the
  config and the tmux session are created in the same invocation.
- A peer SDK provisioned into a global prefix lands as its own top-level root
  in the `node_modules` the failure reported — `<prefix>/lib/node_modules` on
  POSIX — with no copy nested under `@sublang/cligent` or under any consumer
  package, verified from a packed tarball installed into a throwaway prefix
  supplied out of band rather than from an in-repo tree, where a nested
  install would hoist flat and pass regardless.
- A second cligent-based tool sharing that prefix finds the peer already
  satisfied and installs nothing.
- Two concurrent provisioning runs against one target tree produce one
  install, and neither leaves a tree the adapter probe reports as installed
  while it is incomplete.
- A run that cannot take the target tree's lock within the bound installs
  nothing, falls through to today's printed remedy and exit code, and leaves
  no lock state that permanently blocks a later run.
- A provisioning run whose npm child exits zero without installing the
  package is reported as still missing, because the outcome is decided by the
  probe rather than by the exit status.
- Where the install target is an npm exec cache tree or a tree no npm
  invocation reaches, no install command is printed and no offer is made, and
  the existing guidance names the package and the tree instead.
- A packed consumer that imports the exported provisioning entry provisions a
  peer into the same prefix-pinned tree the launcher would, landing it as its
  own top-level root, with no bare `npm install -g` for a peer SDK anywhere
  in the path it executes.
- Build, lint, typecheck, unit, smoke, package, and distributable checks
  pass.

## Open questions

These change item wording in tasks 1 to 3 and are cheapest to settle before
any of them lands.

1. **The consent line's text, its affirmative tokens, its default, and its
   stream.** The remedy goes to stderr and the first-run notice to stdout, so
   the prompt has no home today. TMUX-010's `print nothing on stdout` clause
   binds the first-run branch only; TMUX-089's gate imposes no such
   prohibition, so the two offer sites may or may not share a stream.
2. **Where the exported surface lives.** The existing `./tmux-play` subpath
   needs no manifest change but names package-level facts after an app; the
   root entry point is where cross-cutting APIs already live; a new subpath
   is the clearest name and the most surface to amend.
3. **How a caller declares machine-readable output.** `--json` exists in
   neither this CLI nor any item; the consumers own that flag. Either the
   exported entry takes the caller's decision as an explicit parameter and
   cligent derives its own from the terminal, or a real `--json` is added as
   its own item and task pair.
4. **Whether continuous integration alone suffices to refuse.** The
   stdin-and-stdout half already has a launcher-mode precedent in TMUX-047's
   flavor probe, which the new predicate can reuse or restate; `CI` has none
   in production code. A `--yes` flag would reintroduce the unattended
   acquisition PKG-015 forbids.
5. **The approximate download size and the installed version.** A per-adapter
   constant is offline but goes stale; a registry query puts network access
   before consent. Running the printed command verbatim installs the latest,
   which can diverge from the conformance pin, and pinning it changes the
   printed command.
6. **Whether the first-run offer covers one adapter or the roster cap.** With
   nothing installed the failure names all five adapters, three of which have
   an acquirable peer and the roster caps at two.
7. **Stale-lock policy.** A crashed holder blocks; liveness checks are
   unreliable across containers; a timed unlink reintroduces the race.
   Failing to the printed remedy after a bounded wait matches how the module
   already prefers naming a tree over printing a command that lands
   elsewhere.
8. **Which peer the terminal-attached verification installs.** The invariant
   is structural and any scoped peer proves it; the largest peer is the one
   the intent names and the slowest to install cold.
9. **How the harness attaches a terminal.** `script(1)` gives a real
   pseudo-terminal with no new dependency; an affirmative mechanism a pipe
   can drive is the unattended path the specification forbids.
