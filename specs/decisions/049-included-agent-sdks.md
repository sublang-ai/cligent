<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-049: Included Claude and Codex SDKs

## Status

Proposed specification; direction approved by the user, detailed contract awaiting review; no implementation authorized in this change.
Amends [DR-013](013-cligent-owned-runtime-compatibility.md) only in installation ownership and dependency placement.

## Context

Optional peers make an otherwise valid global SLC or Playbook installation fail before its first Agent call unless users separately install the SDK in a reachable tree.
Installing SDKs in either consumer cannot reliably serve another consumer's nested Cligent in a global installation.
The approved tradeoff is a larger common installation in exchange for both supported default Agent stacks being present.

## Decision

- Cligent, the adapter owner, supplies Claude Agent SDK and Codex SDK as ordinary dependencies; OpenCode remains an optional peer.
- Compatibility descriptors, native executable selection, supported floors, exact conformance targets, readiness verdicts, and repairs remain Cligent-owned.
- Ordinary SDK ranges retain the open upper bound and reviewed floor policy; exact development targets remain independent, and installed versions above the tested target remain honestly untested.
- Consumers adopt a Cligent release carrying this contract instead of declaring duplicate SDK ranges or arranging sibling global SDK installations.
- Installation does not grant provider access, authenticate the user, or make an unsupported operating system supported.
- Packed production-install acceptance checks SDK loadability and SDK-owned runtime resolution in isolated global and nested layouts, without checkout or unrelated global dependencies.

- Pre-merge validation separates locally built/installed functional candidates from real branch prerelease registry installs, retaining stable publication gates without making a formal stable release a prerequisite.
- The shared compilation dependency/environment contract supports macOS, Linux and native Windows; POSIX-only historical front-end constraints do not exempt the native Windows compiler/library path.

## Consequences

Installing Cligent, or a consumer depending on it, acquires both SDK stacks through the correct dependency owner.
Download size, disk usage, upstream installation requirements, and production audit scope increase for every consumer, including single-vendor users.
The existing runtime-installation readiness gate still diagnoses damaged installs, unsupported native hosts and incompatible runtimes.
Host-specific credential checks and provider authentication remain separate from Cligent SDK installation readiness.
This decision does not introduce a second full-distribution package or change the remaining adapters' installation contracts.
