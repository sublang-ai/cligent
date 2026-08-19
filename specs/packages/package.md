<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# package: Package Configuration

## Intent

This package fixes how the distributable is configured, packaged, and depended upon, per [DR-001](../decisions/001-unified-cli-agent-interface-architecture.md) and [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md): its module system, dependency placement, TypeScript settings, exports, and the runtime descriptor a consumer reads.
It owns the manifest's shape and constraints, not the behavior of any adapter it ships.
It is project-local.

## External Behavior

### Module System

### package-1

The package shall set `"type": "module"` for native ESM.

### package-2

The package shall require Node >= 18.3.0 via
`"engines": { "node": ">=18.3.0" }`, the first Node 18 release providing the
`node:util.parseArgs` runtime surface used by the bundled CLI [[1]].

### Dependencies

### package-3

The package's runtime `dependencies` shall be limited to single-purpose, zero-transitive-dependency packages required by the bundled CLI or a built-in transport implementation.
An official generic protocol SDK and its zero-transitive-dependency schema peer may be runtime dependencies when a built-in adapter imports them directly.
Build-time and test-time packages shall be `devDependencies`.

### package-4

Agent SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`) shall be listed as optional peer dependencies.

### package-9

The agent SDK optional-peer-dependency ranges shall declare the lowest SDK version the adapter supports at runtime, and shall declare no upper bound. This floor may be lower than the exact `devDependencies` version pinned for local development and CI. The floor shall be raised when adapter code begins to depend on a newer SDK surface, and may be raised when a version below the new floor can no longer serve the adapter's users — including a vendor runtime that the SDK bundles and that the adapter therefore selects. A floor shall be raised only in a release that is MINOR or greater per [[release-1](release.md#release-1)], because a raised floor refuses a version that previously loaded.

The upper bound of the supported range shall live in the runtime descriptor of [[package-16](#package-16)] and shall be enforced when the runtime loads, never in `peerDependencies`. A published upper bound on an optional peer is intersected into version selection by npm and silently resolves an older SDK without an error, which defeats the floor it accompanies.

### package-10

The repository `build` script shall remove `dist/` before TypeScript emits,
and package creation shall run that clean build. The repository-local
`tmux-play-dev` launcher shall likewise build from clean output before its
outer invocation starts the CLI. A package tarball shall therefore contain
only artifacts produced from the current source tree, never orphaned output
from deleted or renamed source files.

### package-11

The emitted declaration files shall support TypeScript >= 5.4 because the
public generic effort API uses the `NoInfer` utility type introduced in that
release [[2]]. User-facing package documentation shall state this
declaration-consumer floor.

### package-12

The agent SDK versions used for local and CI conformance shall be exact `devDependencies`, without range operators.
An imported production protocol SDK shall likewise use an exact runtime dependency when its wire schema must match an external CLI target.
CI-installed Gemini, OpenCode, and Kimi CLIs shall use exact versions and shall have their reported versions checked before acceptance runs.
Repository verification shall compile the adapter's consumed SDK or protocol surfaces against the installed declarations.
Where an adapter's conformance target consists of both an SDK client and a CLI server, their exact target versions shall match.
The Kimi conformance target shall pair `@agentclientprotocol/sdk` `1.3.0` with the `@moonshot-ai/kimi-code` CLI `0.31.1` and verify the `kimi acp` command surface.

The exact conformance target is the tested version and the optional peer floor is the lowest supported version; the two are distinct and neither shall be derived from the other automatically. Per [[package-9](#package-9)], a floor names the lowest version the adapter supports, which may sit below the tested version and moves only for the reasons that item states. Both versions shall be declared once, in the runtime descriptor of [[package-16](#package-16)], which repository verification asserts equal to the manifest.

### package-13

Where a release candidate is evaluated for readiness, both the production
dependency graph and the complete development dependency graph shall report no
known vulnerabilities. Remediation shall retain the runtime floor in
[[package-2](#package-2)] and shall not rely on an ignored audit finding or an
unsupported dependency override.

### package-16

The distributable shall publish a runtime descriptor declaring, for each built-in adapter, the identity of every runtime it requires — an npm package resolved from the installed `@sublang/cligent` tree, an executable found through `PATH`, or both — together with that runtime's exact tested version, its supported version range, and the repair that installs it.
Where a runtime is a package the adapter resolves and a vendor executable that package selects, the descriptor shall name the version the adapter's own resolution reaches, so the declared version is the one that runs.
The descriptor shall be reachable through the exports map as a documented module, because the package manifest is not.
Repository verification shall assert that every descriptor version equals the corresponding `peerDependencies` range and exact `devDependencies` pin, and shall fail when they diverge.

### TypeScript

### package-8

The project shall include type-level tests verifying discriminated union narrowing and interface assignability for [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md) types.

### package-5

The TypeScript configuration shall enable `strict: true`, `declaration: true`, `declarationMap: true`, target `ES2022`, module `Node16`, module resolution `Node16`, and output to `dist/`.

### Exports

### package-6

The package shall expose a root entry point via the `"exports"` map with `import` and `types` conditions.

### package-7

Each adapter shall have a sub-path export in the `"exports"` map (e.g., `"./adapters/claude-code"`).

### package-14

The package shall expose its documented `./tmux-play` and
`./captains/fanout` subpaths and the `tmux-play` executable. Where the packed
tarball is installed in an isolated consumer, the root and every documented
subpath shall load and the executable's `--help` command shall exit
successfully.

### package-15

The distributable shall neither install nor bundle the optional agent SDKs of [[package-4](#package-4)], and shall not acquire them through a lifecycle script.
It shall resolve them from the tree the package itself is installed in, which for a global installation is the prefix `node_modules` root `npm install -g` writes to.
Where a documented executable would need an agent runtime that does not resolve from that tree, it shall report the commands that install that runtime, scoped to that tree, before performing any side effect, rather than proceeding to a failure at first use.
User-facing package documentation shall state this dependency contract, naming what a documented first run requires beyond the package itself.

## Verification

### package-101

Where stale and current files exist under `dist/`, when the repository build, the repository-local development launcher, and package creation run, the verification shall assert that only outputs emitted from the current source tree remain [[package-10](#package-10)] and that the package declares the required Node floor [[package-2](#package-2)].

### package-102

Where the tarball is installed in isolated consumers using Node 18.3.0 and TypeScript 5.4, when the runtime consumer imports the root, every adapter export, and the tmux-play and captain subpaths before running the installed launcher's help, and the type consumer exercises adapter-scoped effort declarations, the verification shall assert that the root entry point loads [[package-6](#package-6)], that every adapter sub-path export loads [[package-7](#package-7)], that the documented tmux-play and captain subpaths load and the executable's help exits successfully [[package-14](#package-14)], that the declared Node floor admits the 18.3.0 runtime [[package-2](#package-2)], and that strict compilation passes against the emitted declarations on TypeScript 5.4 [[package-11](#package-11)].

### package-103

Where the release dependency graph and optional agent peers are resolved, when production and full dependency audits run and the tarball manifest is inspected, the verification shall assert that both audits report no known vulnerabilities [[package-13](#package-13)], that the ACP protocol SDK and its schema peer are production dependencies [[package-3](#package-3)], and that agent-SDK placement and optional-peer declarations match the package requirements [[package-4](#package-4)].

### package-104

Where repository conformance runs with installed SDK, protocol, and CLI dependencies, when installed package metadata, CLI-reported versions, declarations, and command help are checked, the verification shall assert that the resolved SDK and reported CLI versions equal the exact repository and CI targets, that consumed type surfaces remain available, that the OpenCode SDK and CLI versions match, and that the ACP SDK `1.3.0` pairs with the Kimi Code CLI `0.31.1` whose `kimi acp` command initializes successfully [[package-12](#package-12)].

### package-105

Where the packed tarball and the exact Codex SDK target are installed into a global-style prefix whose package trees are independent and into a nested-strategy consumer, neither leaving `@openai/codex` at the install root, when the installed adapter is loaded and resolves that optional peer, the verification shall assert that the nested consumer loads the adapter through its sub-path export [[package-7](#package-7)], that both layouts resolve the optional peer from the tree the package itself is installed in [[package-15](#package-15)], and that the nested consumer does so on the Node 18.3.0 runtime floor [[package-2](#package-2)] without an ESM loader resolution surface.

### package-106

Where the packed tarball alone is installed into a global-style prefix holding no agent SDK peer, supplied out of band, and the search path reaches no agent CLI, when the installed `tmux-play` executable runs its documented launcher command, the verification shall assert that the invocation fails before any side effect, naming the install command for every supported adapter, and that executing that printed command verbatim as argv lands the SDK in the `node_modules` root the failure reported and lets the same launcher command succeed [[package-15](#package-15)].

### package-228

Where the exact OpenCode CLI conformance target is installed, when its reported version is inspected, the verification shall assert that the version equals the exact CI target [[package-12](#package-12)].

## References

[1]: https://nodejs.org/api/util.html#utilparseargsconfig "Node.js util.parseArgs"
[2]: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-4.html#the-noinfer-utility-type "TypeScript 5.4 NoInfer"
