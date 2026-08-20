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
Each adapter reads its runtime's version through the same resolution it will actually use, inside the loader `isAvailable()` and `run()` share.
The gate and the load therefore cannot disagree, and a consumer that already calls `isAvailable()` inherits the check without changing a line.
A version that cannot be read is *unknown* and never blocks, because vendored, bundled, and archived layouts are legitimate.

**Readiness is structured, not boolean.**
The exported verdict distinguishes satisfied, missing, too old, untested, and unknown, and carries the installed version, the required range, the resolved tree, and the repair command.
A consumer renders it; it does not recompute it.

**Cligent states the declaration form, and cannot enforce it.**
Whether a consumer's manifest tracks cligent's range is the consumer's decision, recorded in the consumer's own specification.
Cligent's obligation ends at making the required version knowable, the verdict unambiguous, and the remedy exact.

## Consequences

Compatibility knowledge lives in one place and reaches every consumer through a cligent upgrade alone.
A stale runtime fails at the gate, before an agent call, naming what is installed, what is required, and the command that fixes it, instead of surfacing as a vendor error mid-turn.
Consumers delete their own adapter-to-SDK maps and their own version literals.

The promise has a boundary worth stating plainly, because the opposite is easy to assume: upgrading cligent makes the requirement *known and enforced*, not *satisfied*.
A committed lockfile, a `npm ci` install, and a global installation each pin a runtime that no library upgrade re-resolves.
Those installs now fail loudly with a remedy rather than silently producing a wrong answer, which is the whole of what a library can do from inside the process.

Raising a supported floor makes an older runtime that still worked refuse to load.
The floor therefore moves only on a cligent MINOR release, and the release notes name it.

This decision supersedes no earlier decision.
It constrains [DR-012](012-runtime-derived-tmux-play-defaults.md)'s readiness gate, whose verdict becomes structured, and supplies the version [IR-040](../iterations/040-consented-runtime-provisioning.md)'s consented install must acquire.
