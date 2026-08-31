<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# package: Package Configuration

## Intent

This package fixes how the distributable is configured, packaged, and depended upon, per [DR-001](../decisions/001-unified-cli-agent-interface-architecture.md) and [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md): its module system, dependency placement, TypeScript settings, exports, and the runtime descriptor a consumer reads.
It owns the manifest's shape and constraints, not the behavior of any adapter it ships.
It is project-local: the distributable it configures is `@sublang/cligent`.

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

The package manifest shall place dependencies according to their role:

- runtime `dependencies` contain only single-purpose, zero-transitive-dependency packages required by the bundled CLI or a built-in transport implementation;
- an official generic protocol SDK and its zero-transitive-dependency schema peer may be runtime dependencies where a built-in adapter imports them directly; and
- build-time and test-time packages are `devDependencies`.

### package-4

Agent SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`) shall be listed as optional peer dependencies.

### package-9

Each agent SDK optional-peer-dependency range shall have this shape:

- its floor is the lowest SDK version the adapter supports at runtime;
- every higher version is admitted without an upper bound; and
- the floor may be lower than the exact `devDependencies` version pinned for local development and CI.

### package-17

When an agent-runtime supported floor in the descriptor under [[package-16](#package-16)] is selected or reviewed, maintainers shall apply this compatibility-floor policy:

- select the lowest published version that serves every provider model or route on which this release's declared adapter behavior depends and supplies every runtime surface the adapter drives;
- record beside the descriptor target the concrete capability and adjacent published-version evidence establishing that floor;
- dependence on a newer runtime surface raises the floor to the first version carrying that surface;
- a version that can no longer serve the adapter's users, including a vendor runtime the SDK bundles and selects, permits the floor to rise past that version; and
- every rise ships only in a release that is MINOR or greater per [[release-1](release.md#release-1)], because the new floor refuses a version that previously loaded.

### package-10

When the repository `build` script runs, it shall remove `dist/` before TypeScript emits.

### package-18

When package creation runs, it shall invoke the clean repository build in [[package-10](#package-10)].

### package-19

When the repository-local `tmux-play-dev` launcher's outer invocation runs, it shall invoke the clean repository build in [[package-10](#package-10)] before starting the CLI.

### package-20

A package tarball shall contain only artifacts produced from the current source tree, never orphaned output from deleted or renamed source files.

### package-11

The emitted declaration files shall support TypeScript >= 5.4 because the public generic effort API uses the `NoInfer` utility type introduced in that release [[2]].

### package-21

User-facing package documentation shall state the TypeScript 5.4 declaration-consumer floor in [[package-11](#package-11)].

### package-12

The repository shall pin every conformance target at an exact version in the dependency location matching its role:

- an agent SDK used for local and CI conformance is an exact `devDependencies` entry without a range operator;
- an imported production protocol SDK whose wire schema must match an external CLI target is an exact runtime dependency; and
- a Gemini, OpenCode, or Kimi CLI installed by CI uses an exact install version.

### package-22

When repository conformance prepares an acceptance run, it shall check that every installed Gemini, OpenCode, and Kimi CLI reports its exact target version.

### package-34

Repository verification shall compile every SDK or protocol surface consumed by an adapter against the installed declarations.

### package-23

Where an adapter's conformance target consists of an SDK client and a CLI server, the repository shall keep their exact target versions paired:

- the OpenCode SDK and CLI versions match; and
- `@agentclientprotocol/sdk` `1.4.0` pairs with the `@moonshot-ai/kimi-code` CLI `0.39.1` for Kimi.

### package-24

When the Kimi conformance target in [[package-23](#package-23)] is checked, repository verification shall confirm that the installed Kimi CLI exposes and initializes the `kimi acp` command surface.

### package-25

For every runtime record in [[package-16](#package-16)], the exact conformance target and supported floor shall remain independently declared compatibility values, with the target naming the tested version and the floor naming the lowest supported version, neither derived from the other automatically.

### package-26

Repository verification shall obtain each agent runtime's expected exact tested version and supported floor from the runtime descriptor in [[package-16](#package-16)] rather than declaring either expected value independently.

### package-27

Where the runtime descriptor and repository manifest declare the same agent runtime, when repository verification compares them, it shall enforce descriptor-to-manifest alignment:

- the descriptor's supported floor equals the optional `peerDependencies` lower bound;
- the descriptor's tested version equals the exact `devDependencies` pin; and
- any divergence fails verification.

### package-13

Where a release candidate is evaluated for readiness, its dependency audit shall report no known vulnerabilities in both the production dependency graph and the complete development dependency graph.

### package-28

When a known vulnerability is remediated, the remediation shall retain the Node runtime floor in [[package-2](#package-2)] and use neither an ignored audit finding nor an unsupported dependency override.

### package-16

The distributable shall publish a runtime descriptor containing one complete target record for every runtime each built-in adapter requires:

- the record identifies one compatibility and readiness authority: an npm package resolved from the installed `@sublang/cligent` tree, an executable found through `PATH`, or a vendor package selected through a resolved SDK's own resolution path;
- the record declares that authority's exact tested version and supported version range;
- the record's installation repair consists of a package specifier pinned to that exact tested version and zero or more exact follow-up steps;
- where the descriptor names an SDK-selected vendor package as the authority, its readiness version lookup requires the SDK manifest to declare that dependency and the exact version reached through the SDK's physical resolution path to match the declaration [[engine-25](engine.md#engine-25)]; and
- where a version-tied SDK remains the authority and its own metadata describes the executable it selects, repository conformance reports only what that metadata exposes, requires two exposed versions to agree before reporting consistency as `'verified'`, and reports an absent identity, version, or cross-source consistency check as `'unreported'` rather than inferring one from another package, `PATH`, or an independent literal.

### package-29

The runtime descriptor in [[package-16](#package-16)] shall be reachable through the package exports map at the documented `@sublang/cligent/runtime-targets` module.

### package-30

User-facing package documentation shall identify the runtime-descriptor module in [[package-29](#package-29)] and explain its supported and tested version fields.

### TypeScript

### package-5

The TypeScript configuration shall enable `strict: true`, `declaration: true`, `declarationMap: true`, target `ES2022`, module `Node16`, module resolution `Node16`, and output to `dist/`.

### Exports

### package-6

The package shall expose a root entry point via the `"exports"` map with `import` and `types` conditions.

### package-7

Each adapter shall have a sub-path export in the `"exports"` map (e.g., `"./adapters/claude-code"`).

### package-14

The package manifest shall expose the documented `./tmux-play` and `./captains/fanout` subpaths and the `tmux-play` executable.

### package-31

Where the packed tarball is installed in an isolated consumer, its installed surfaces shall remain usable:

- the root and every documented subpath load; and
- the `tmux-play` executable's `--help` command exits successfully.

### package-15

The distributable shall not acquire the optional agent SDKs in [[package-4](#package-4)] through any package-delivery path:

- they are not installed as runtime or optional dependencies;
- they are not bundled; and
- no lifecycle script acquires them.

### package-32

The distributable shall resolve an optional agent SDK from the dependency tree in which `@sublang/cligent` itself is installed, which for a global installation is the prefix `node_modules` root written by `npm install -g`.

### package-33

User-facing package documentation shall state the optional-agent-runtime dependency contract, naming what each documented first run requires beyond the package itself.

## Internal Behavior

### TypeScript Contract Tests

### package-8

The project shall include type-level tests verifying discriminated-union narrowing and interface assignability for [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md) types.

## Verification

### package-101

Where stale and current files exist under `dist/` and the package documentation is available, when the repository package-output verification runs the direct build, repository-local development launcher, and package-creation paths, the verification shall assert the package-output contract:

- the direct build removes stale output before emitting current output [[package-10](#package-10)];
- package creation invokes that clean build [[package-18](#package-18)] and its tarball contains only current output [[package-20](#package-20)];
- the development launcher invokes that clean build before starting the CLI [[package-19](#package-19)];
- the manifest declares the Node floor [[package-2](#package-2)]; and
- the documentation states the declaration-consumer floor [[package-21](#package-21)], identifies the runtime descriptor and its version fields [[package-30](#package-30)], and states the optional-agent-runtime dependency contract [[package-33](#package-33)].

### package-102

Where the tarball is installed in isolated consumers using Node 18.3.0 and TypeScript 5.4, when runtime consumers import every documented surface and run the installed launcher's help and a type consumer exercises adapter-scoped effort declarations, the verification shall assert the installed-package contract:

- the root entry point loads [[package-6](#package-6)];
- every adapter subpath loads [[package-7](#package-7)];
- the tmux-play and captain subpaths and executable declared in [[package-14](#package-14)] load or report help successfully [[package-31](#package-31)];
- the runtime descriptor loads through its documented export [[package-29](#package-29)], completing the documented-subpath assertion in [[package-31](#package-31)];
- the Node 18.3.0 runtime is admitted [[package-2](#package-2)]; and
- strict compilation passes against the emitted declarations on TypeScript 5.4 [[package-11](#package-11)].

### package-103

Where the release dependency graph and optional agent peers are resolved, when production and full dependency audits run and the tarball manifest is inspected, the verification shall assert the dependency contract:

- both audits report no known vulnerabilities [[package-13](#package-13)];
- dependency placement follows the runtime, protocol, and development-role matrix [[package-3](#package-3)];
- agent SDKs are optional peers [[package-4](#package-4)] whose ranges declare a floor without an upper bound [[package-9](#package-9)];
- the tarball neither installs nor bundles an optional agent SDK and declares no lifecycle acquisition path [[package-15](#package-15)]; and
- the Node floor and audit configuration satisfy the remediation safeguards [[package-28](#package-28)].

### package-104

Where repository conformance runs with installed SDK, protocol, and CLI dependencies, when package metadata, CLI-reported versions, declarations, command help, runtime descriptors, the manifest, and floor-change history are checked, the verification shall assert the conformance-target contract:

- resolved SDK and protocol versions and reported CLI versions equal their exact targets in the required dependency locations [[package-12](#package-12)];
- CLI versions are checked before acceptance [[package-22](#package-22)];
- consumed SDK and protocol surfaces compile against the installed declarations [[package-34](#package-34)];
- Claude compatibility and readiness use the Claude Agent SDK's identity and version; selected-binary identity comes only from one unambiguous value in the current platform and architecture's SDK manifest entries, selected-binary version derives from SDK package and manifest metadata, disagreement fails, consistency reports `'verified'` only where both versions exist and otherwise `'unreported'`, and each absent identity or version reports `'unreported'` [[package-16](#package-16)];
- a descriptor-named Codex vendor package's readiness version is declared by the installed Codex SDK, resolved through its physical dependency path rather than from an unrelated package in cligent's dependency roots, and equals the exact version the SDK declares [[package-16](#package-16)];
- the OpenCode targets match and the exact Kimi SDK and CLI targets are paired [[package-23](#package-23)];
- the `kimi acp` command initializes successfully [[package-24](#package-24)];
- every declared floor carries the concrete adjacent-version evidence in [[package-17](#package-17)], every floor selection or change follows its selection, rise, and release policy, and tested versions remain independent of supported floors [[package-25](#package-25)];
- the descriptor carries every required runtime identity, version, range, and repair, with every installation-repair package specifier naming its runtime package at its exact tested version [[package-16](#package-16)], and supplies repository verification's expected tested versions and floors [[package-26](#package-26)]; and
- every descriptor version agrees with the corresponding peer range and exact development pin, with a forced divergence failing verification [[package-27](#package-27)].

### package-105

Where the packed tarball and each exact optional agent SDK target are installed in turn both into a global-style prefix whose package trees are independent and into a nested-strategy consumer, with unrelated selected-executable packages visible outside the Claude and Codex SDK trees and neither Codex layout leaving its selected `@openai/codex` package at the install root, when each installed adapter loads, resolves its optional peer, and reads runtime identity and version, the verification shall assert this own-tree-resolution matrix [[package-16](#package-16)], [[package-32](#package-32)]:

| Adapter     | Optional peer resolved in both layouts | Runtime authority and isolation                                                                             |
| ----------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Claude Code | `@anthropic-ai/claude-agent-sdk`       | the SDK's identity and version, unaffected by an unrelated executable package outside its tree              |
| Codex       | `@openai/codex-sdk`                    | the SDK-owned `@openai/codex` identity and version, unaffected by an unrelated package outside the SDK tree |
| OpenCode    | `@opencode-ai/sdk`                     | the SDK's identity and version                                                                              |

- in every nested case, the adapter loads through its subpath export [[package-7](#package-7)]; and
- every nested case runs on the Node 18.3.0 runtime floor [[package-2](#package-2)] without an ESM loader resolution surface.

### package-201

Where an adapter's runtime is installed at a version the shipped descriptor classifies, when the adapter loads it and the readiness verdict is computed, the verification shall assert that the verdict follows the descriptor's declared range [[package-16](#package-16)] and the distinction between supported floors and tested versions [[package-25](#package-25)]:

- at or above the floor and at or below the tested version, the load shall succeed and the verdict shall report `'satisfied'`;
- above the tested version, the load shall succeed and the verdict shall report `'untested'`;
- where the version cannot be read, the load shall succeed and the verdict shall report `'unknown'`.

### package-228

Where the exact OpenCode CLI conformance target is installed, when its reported version is inspected before acceptance, the verification shall assert that the version equals the exact CI target [[package-12](#package-12)], [[package-22](#package-22)].

## References

[1]: https://nodejs.org/api/util.html#utilparseargsconfig "Node.js util.parseArgs"
[2]: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-4.html#the-noinfer-utility-type "TypeScript 5.4 NoInfer"
