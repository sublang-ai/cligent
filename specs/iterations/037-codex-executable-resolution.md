<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-037: Codex Executable Resolution Across Install Layouts

## Goal

Make the Codex adapter start from global and non-hoisted installs of the
packed package by resolving `@openai/codex/bin/codex.js` anchored inside the
`@openai/codex-sdk` tree that owns the dependency, keeping the adapter's own
resolution context as a fallback, and failing with an actionable diagnostic
when no route resolves.

## Status

Done

## Deliverables

- [x] Canonical dev and package-test items define the SDK-anchored resolution
      ownership contract and its failure diagnostics.
- [x] The Codex adapter resolves the executable through SDK-anchored routes
      with a self-context fallback and a diagnostic error.
- [x] Unit tests cover anchor precedence, layout shapes, the runtime-floor
      fallback, and failure diagnostics against real on-disk module trees.
- [x] Distributable verification installs the packed tarball plus the exact
      Codex SDK in global-style and nested layouts and reaches a real aborted
      adapter invocation past executable resolution.
- [x] The unreleased changelog documents the fix.

## Tasks

1. [x] **Specify the resolution ownership contract.**
       Add the CODEX dev items and TPKG acceptance item, record IR-037, and
       update the spec map.
2. [x] **Implement SDK-anchored resolution.**
       Replace the adapter's self-context-only resolution with SDK-anchored
       routes, the compatibility fallback, and the diagnostic error, with
       focused unit tests over real temporary module trees.
3. [x] **Verify the distributable layouts.**
       Extend distributable verification with global-prefix and
       nested-strategy consumers, a floor-runtime probe, a real aborted
       adapter invocation, and the missing-peer diagnostic, and document the
       fix in the changelog.

## Acceptance criteria

- The packed tarball plus the exact Codex SDK, installed in a global-style
  prefix and in a nested-strategy consumer with no install-root
  `@openai/codex`, resolve the SDK-owned executable and complete an aborted
  permission-managed `run()` without a module-resolution failure.
- The nested-consumer probe passes on the Node 18.3.0 floor, where the ESM
  loader provides no resolution surface.
- With both an install-root and an SDK-owned `@openai/codex` visible, the
  adapter selects the SDK-owned copy.
- With no resolvable `@openai/codex`, the adapter's error names the attempted
  entry and anchors and directs installing `@openai/codex-sdk`.
- Build, lint, typecheck, unit, package, and distributable checks pass.
