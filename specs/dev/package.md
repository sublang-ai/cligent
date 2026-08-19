<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PKG: Package Configuration

## Intent

This component defines packaging, TypeScript configuration, and dependency constraints per [DR-001](../decisions/001-unified-cli-agent-interface-architecture.md) and [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md).

## Module System

### PKG-001

The package shall set `"type": "module"` for native ESM.

### PKG-002

The package shall require Node >= 18.3.0 via
`"engines": { "node": ">=18.3.0" }`, the first Node 18 release providing the
`node:util.parseArgs` runtime surface used by the bundled CLI [[1]].

## Dependencies

### PKG-003

The package's runtime `dependencies` shall be limited to single-purpose, zero-transitive-dependency packages required by the bundled CLI or a built-in transport implementation.
An official generic protocol SDK and its zero-transitive-dependency schema peer may be runtime dependencies when a built-in adapter imports them directly.
Build-time and test-time packages shall be `devDependencies`.

### PKG-004

Agent SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`) shall be listed as optional peer dependencies.

### PKG-009

The agent SDK optional-peer-dependency ranges shall declare the lowest SDK version the adapter supports at runtime, and shall declare no upper bound. This floor may be lower than the exact `devDependencies` version pinned for local development and CI. The floor shall be raised when adapter code begins to depend on a newer SDK surface, and may be raised when a version below the new floor can no longer serve the adapter's users — including a vendor runtime that the SDK bundles and that the adapter therefore selects. A floor shall be raised only in a release that is MINOR or greater per [[release-1](../packages/release.md#release-1)], because a raised floor refuses a version that previously loaded.

The upper bound of the supported range shall live in the runtime descriptor of [PKG-016](#pkg-016) and shall be enforced when the runtime loads, never in `peerDependencies`. A published upper bound on an optional peer is intersected into version selection by npm and silently resolves an older SDK without an error, which defeats the floor it accompanies.

### PKG-010

The repository `build` script shall remove `dist/` before TypeScript emits,
and package creation shall run that clean build. The repository-local
`tmux-play-dev` launcher shall likewise build from clean output before its
outer invocation starts the CLI. A package tarball shall therefore contain
only artifacts produced from the current source tree, never orphaned output
from deleted or renamed source files.

### PKG-011

The emitted declaration files shall support TypeScript >= 5.4 because the
public generic effort API uses the `NoInfer` utility type introduced in that
release [[2]]. User-facing package documentation shall state this
declaration-consumer floor.

### PKG-012

The agent SDK versions used for local and CI conformance shall be exact `devDependencies`, without range operators.
An imported production protocol SDK shall likewise use an exact runtime dependency when its wire schema must match an external CLI target.
CI-installed Gemini, OpenCode, and Kimi CLIs shall use exact versions and shall have their reported versions checked before acceptance runs.
Repository verification shall compile the adapter's consumed SDK or protocol surfaces against the installed declarations.
Where an adapter's conformance target consists of both an SDK client and a CLI server, their exact target versions shall match.
The Kimi conformance target shall pair `@agentclientprotocol/sdk` `1.3.0` with the `@moonshot-ai/kimi-code` CLI `0.31.1` and verify the `kimi acp` command surface.

The exact conformance target is the tested version and the optional peer floor is the lowest supported version; the two are distinct and neither shall be derived from the other automatically. Per [PKG-009](#pkg-009), a floor names the lowest version the adapter supports, which may sit below the tested version and moves only for the reasons that item states. Both versions shall be declared once, in the runtime descriptor of [PKG-016](#pkg-016), which repository verification asserts equal to the manifest.

### PKG-013

Where a release candidate is evaluated for readiness, both the production
dependency graph and the complete development dependency graph shall report no
known vulnerabilities. Remediation shall retain the runtime floor in
[PKG-002](#pkg-002) and shall not rely on an ignored audit finding or an
unsupported dependency override.

### PKG-016

The distributable shall publish a runtime descriptor declaring, for each built-in adapter, the identity of every runtime it requires — an npm package resolved from the installed `@sublang/cligent` tree, an executable found through `PATH`, or both — together with that runtime's exact tested version, its supported version range, and the repair that installs it.
Where a runtime is a package the adapter resolves and a vendor executable that package selects, the descriptor shall name the version the adapter's own resolution reaches, so the declared version is the one that runs.
The descriptor shall be reachable through the exports map as a documented module, because the package manifest is not.
Repository verification shall assert that every descriptor version equals the corresponding `peerDependencies` range and exact `devDependencies` pin, and shall fail when they diverge.

## TypeScript

### PKG-005

The TypeScript configuration shall enable `strict: true`, `declaration: true`, `declarationMap: true`, target `ES2022`, module `Node16`, module resolution `Node16`, and output to `dist/`.

## Exports

### PKG-006

The package shall expose a root entry point via the `"exports"` map with `import` and `types` conditions.

### PKG-007

Each adapter shall have a sub-path export in the `"exports"` map (e.g., `"./adapters/claude-code"`).

### PKG-014

The package shall expose its documented `./tmux-play` and
`./captains/fanout` subpaths and the `tmux-play` executable. Where the packed
tarball is installed in an isolated consumer, the root and every documented
subpath shall load and the executable's `--help` command shall exit
successfully.

### PKG-015

The distributable shall neither install nor bundle the optional agent SDKs of [PKG-004](#pkg-004), and shall not acquire them through a lifecycle script.
It shall resolve them from the tree the package itself is installed in, which for a global installation is the prefix `node_modules` root `npm install -g` writes to.
Where a documented executable would need an agent runtime that does not resolve from that tree, it shall report the commands that install that runtime, scoped to that tree, before performing any side effect, rather than proceeding to a failure at first use.
User-facing package documentation shall state this dependency contract, naming what a documented first run requires beyond the package itself.

## Verification

### PKG-008

The project shall include type-level tests verifying discriminated union narrowing and interface assignability for [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md) types.

## References

[1]: https://nodejs.org/api/util.html#utilparseargsconfig "Node.js util.parseArgs"
[2]: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-4.html#the-noinfer-utility-type "TypeScript 5.4 NoInfer"
