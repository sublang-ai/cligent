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

The package's runtime `dependencies` shall be limited to single-purpose, zero-transitive-dep packages required by the bundled CLI; build-time and test-time packages shall be `devDependencies`.

### PKG-004

Agent SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`) shall be listed as optional peer dependencies.

### PKG-009

The agent SDK optional-peer-dependency ranges shall declare the lowest SDK version the adapter code supports at runtime. This floor may be lower than the exact `devDependencies` version pinned for local development and CI, and shall be raised only when adapter code begins to depend on a newer SDK surface.

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

The SDK versions used for local and CI conformance shall be exact
`devDependencies`, without range operators. CI-installed Gemini and OpenCode
CLIs shall likewise use exact versions and shall have their reported versions
checked before acceptance runs. Repository verification shall compile the
adapter's consumed SDK surfaces against the installed declarations. Where an
adapter's conformance target consists of both an SDK client and a CLI server,
their exact target versions shall match.

Exact conformance targets are independent of optional peer floors. Per
[PKG-009](#pkg-009), a peer floor shall name the lowest supported runtime
surface rather than automatically following the exact development pin.

### PKG-013

Where a release candidate is evaluated for readiness, both the production
dependency graph and the complete development dependency graph shall report no
known vulnerabilities. Remediation shall retain the runtime floor in
[PKG-002](#pkg-002) and shall not rely on an ignored audit finding or an
unsupported dependency override.

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

## Verification

### PKG-008

The project shall include type-level tests verifying discriminated union narrowing and interface assignability for [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md) types.

## References

[1]: https://nodejs.org/api/util.html#utilparseargsconfig "Node.js util.parseArgs"
[2]: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-4.html#the-noinfer-utility-type "TypeScript 5.4 NoInfer"
