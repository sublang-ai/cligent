<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-013: Cligent-Owned Runtime Compatibility

## Status

Accepted

## Context

Each adapter runs against a vendor runtime cligent does not ship: an optional peer SDK resolved from cligent's own tree, an external CLI found through `PATH`, or both.
Which versions of those runtimes work is knowledge cligent holds and verifies — [[package-12](../packages/package.md#package-12)] pins an exact conformance target per runtime and [[package-22](../packages/package.md#package-22)] requires each installed target to be checked before acceptance — but nothing carries that knowledge to the consumers who must act on it.

Consumers therefore rediscover it, badly, and independently:

| Symptom | Observed |
| --- | --- |
| Every consumer declares its own SDK range | `@sublang/playbook`, `@sublang/slc`, `@sublang/spex-core` each pinned `@openai/codex-sdk` separately |
| A caret freezes a `0.MINOR.PATCH` runtime forever | `^0.139.0` desugars to `>=0.139.0 <0.140.0`; all three stayed on `0.139.0` while the target reached `0.146.0` |
| A stale runtime passes the readiness gate | `isAvailable()` tests only that the SDK imports; `0.139.0` imports fine |
| The defect surfaces as a vendor string, mid-turn | `The 'gpt-5.6-sol' model requires a newer version of Codex` |
| A consumer duplicates cligent's adapter knowledge | `playbook` maintains its own adapter-to-SDK map to render remedies |

The gate the failure should have hit is cligent's own, and it passed, because a boolean cannot express *installed but incompatible*.

## Decision

Cligent is the single authority for agent-runtime compatibility.
It owns the versions, the verdict, and the remedy; consumers own only the act of installing.

**One descriptor per runtime, shipped.**
A published module declares, per adapter: the runtime's package or command identity, the exact **tested** version, the **supported range**, and the repair the user must run.
It is a module rather than data read from `package.json`, which the exports map does not expose.
Repository verification asserts the descriptor equals the manifest's declared peer range and exact development pin, so the two cannot drift.

**Tested and supported stay distinct.**
[[package-25](../packages/package.md#package-25)] separates the lowest supported version from the exact development pin: a runtime older than the tested version but inside the supported range is supported, not merely tolerated.
A version above the supported range is *untested*, which is a different verdict from *too old* and shall not be reported as the same thing.

**The published peer range stays open at the top.**
The supported range's upper bound lives in the descriptor and is enforced at load, never in `peerDependencies`.
npm intersects an optional peer range into version selection: a published upper bound silently selects an older SDK, with no error, which is the failure this decision exists to remove.

**The verdict is produced by the loader.**
Each adapter reads a peer runtime's version through the same package resolution it will actually use and reads a CLI runtime's version by spawning the configured command through the same native lookup mechanism its execution path uses.
Peer readiness carries the exact resolved `node_modules` tree, while CLI readiness carries the configured command as its portable identity and does not invent a host-selected absolute path that child-process spawning does not expose.
The `isAvailable()` and `run()` gates apply the same compatibility rule to the identity each native lookup observes, and a consumer that already calls `isAvailable()` inherits the check without changing a line.
A version that cannot be read is *unknown* and never blocks, because vendored, bundled, and archived layouts are legitimate.

**A package-selected executable does not create an independent version domain.**
The version-tied Claude Agent SDK is the sole Claude compatibility and readiness authority: its package identity, `0.3.x` version, supported range, and repair remain coherent, while the Claude Code executable it selects is consistency evidence derived only from SDK-owned package and manifest metadata.
Where that metadata exposes the selected executable's identity or version, repository conformance reports exactly what it exposes; package- and manifest-reported versions must agree for consistency to be *verified*, otherwise consistency and each absent value are *unreported* rather than inferred from `PATH`, a separately installed package, or an independent literal.
Codex remains the distinct case whose descriptor explicitly names the vendor package its SDK selects, because that package is the runtime that rejects unsupported models; the descriptor and readiness version lookup starts from the resolved Codex SDK and accepts only a dependency the SDK manifest declares at the exact version reached through that SDK's physical resolution path, never an unrelated package visible from cligent's own dependency roots.
This version lookup does not remove the adapter's released executable-resolution fallbacks, including a package manager's ordinary hoisting of the SDK-declared dependency.

**Readiness is structured, not boolean.**
The exported verdict distinguishes satisfied, missing, too old, untested, and unknown, and carries the installed version, the required range, the peer's resolved tree or the CLI's configured command identity, and the repair command.
A consumer renders it; it does not recompute it.

**Cligent states the declaration form, and cannot enforce it.**
Whether a consumer's manifest tracks cligent's range is the consumer's decision, recorded in the consumer's own specification.
Cligent's obligation ends at making the required version knowable, the verdict unambiguous, and the remedy exact.

## Consequences

Compatibility knowledge lives in one place and reaches every consumer through a cligent upgrade alone.
A stale runtime fails at the gate, before an agent call, naming what is installed, what is required, and the command that fixes it, instead of surfacing as a vendor error mid-turn.
Consumers delete their own adapter-to-SDK maps and their own version literals.
Claude readiness now names and compares the Claude Agent SDK that the repair installs, while repository conformance still exposes any disagreement in the SDK's own selected-binary metadata without fabricating an absent identity.
Codex retains its selected-executable authority without allowing an unrelated top-level package to shadow or stand in for the readiness version its SDK declares and owns.

The promise has a boundary worth stating plainly, because the opposite is easy to assume: upgrading cligent makes the requirement *known and enforced*, not *satisfied*.
A committed lockfile, a `npm ci` install, and a global installation each pin a runtime that no library upgrade re-resolves.
Those installs now fail loudly with a remedy rather than silently producing a wrong answer, which is the whole of what a library can do from inside the process.

Raising a supported floor makes an older runtime that still worked refuse to load.
The floor therefore moves only on a cligent MINOR release, and the release notes name it.

Any future consented-provisioning decision that amends [DR-012](012-runtime-derived-tmux-play-defaults.md)'s no-install boundary must also settle these compatibility-owned questions:

1. **Export location.** Reusing `./tmux-play` avoids a manifest change but names package-level compatibility facts after an app; the root already carries cross-cutting APIs; a dedicated subpath is clearest but adds the most public surface.
2. **Installed version.** Running an unpinned rendered command can diverge from the conformance target, while pinning it changes the repair command and must remain coherent with the descriptor's tested and supported versions.
3. **Stale-lock policy.** A crashed provisioning holder can block successors; cross-container liveness checks are unreliable, but timed unlink can reintroduce the race.
   Falling back to the exact printed remedy after a bounded wait preserves safety without claiming the target tree changed.
4. **Placement probe.** Any scoped peer can prove the structural installation invariant; using the largest peer additionally exercises the cold-install timeout bound but makes the verification slowest.

This decision supersedes no earlier decision.
It constrains [DR-012](012-runtime-derived-tmux-play-defaults.md)'s readiness gate, whose verdict becomes structured, and supplies the compatibility target and remedy facts that any future consented-install decision must honor without choosing whether its rendered command is pinned.
