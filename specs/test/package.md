<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TPKG: Package Tests

## Intent

This component defines acceptance checks for the distributable package described by [dev/package.md](../dev/package.md).

### TPKG-001
Verifies: [PKG-002](../dev/package.md#pkg-002), [PKG-010](../dev/package.md#pkg-010)

Where stale and current files exist under `dist/`, when the repository build,
repository-local development launcher, and package creation paths run, only
outputs emitted from the current source tree shall remain and the package shall
declare the required Node floor.

### TPKG-002
Verifies: [PKG-002](../dev/package.md#pkg-002), [PKG-006](../dev/package.md#pkg-006), [PKG-007](../dev/package.md#pkg-007), [PKG-011](../dev/package.md#pkg-011), [PKG-014](../dev/package.md#pkg-014)

Where the tarball is installed in isolated consumers using Node 18.3.0 and
TypeScript 5.4, when the runtime consumer imports the root and every adapter,
tmux-play, and captain export and runs installed launcher help, and the type
consumer exercises adapter-scoped effort declarations, each import and help
command shall succeed and strict compilation shall pass.

### TPKG-003
Verifies: [PKG-003](../dev/package.md#pkg-003), [PKG-004](../dev/package.md#pkg-004), [PKG-013](../dev/package.md#pkg-013)

Where the release dependency graph and optional agent peers are resolved, when production and full dependency audits run and the tarball manifest is inspected, both audits shall report no known vulnerabilities; the ACP protocol SDK and its schema peer shall be production dependencies; and agent-SDK placement and optional-peer declarations shall match the package requirements.

### TPKG-004
Verifies: [PKG-012](../dev/package.md#pkg-012)

Where repository conformance runs with installed SDK, protocol, and CLI dependencies, when installed package metadata, CLI-reported versions, declarations, and command help are checked, the resolved SDK and reported CLI versions shall equal the exact repository and CI targets, consumed type surfaces shall remain available, the OpenCode SDK and CLI versions shall match, and the ACP SDK `0.23.0` shall pair with Kimi Code CLI `0.27.0` whose `kimi acp` command initializes successfully.

### TPKG-005
Verifies: [PKG-004](../dev/package.md#pkg-004), [PKG-007](../dev/package.md#pkg-007), [CODEX-012](../dev/adapters/codex.md#codex-012), [CODEX-013](../dev/adapters/codex.md#codex-013)

Where the packed tarball and the exact Codex SDK target are installed both
into a global-style prefix whose package trees are independent and into a
nested-strategy consumer, each leaving no `@openai/codex` at the install
root, when the installed Codex adapter resolves the executable entry,
generates a per-run configuration wrapper, and runs a real permission-managed
aborted invocation, resolution shall return the SDK-owned executable in both
layouts — in the nested consumer also on the Node 18.3.0 runtime floor
without an ESM loader resolution surface — the wrapper shall embed that
executable path, and the aborted invocation shall terminate without a module
resolution failure.
Where the installed consumer resolves no `@openai/codex` from any route, when
the adapter resolves the executable entry, the raised error shall name the
attempted entry and anchors and direct installing `@openai/codex-sdk` as the
repair.
