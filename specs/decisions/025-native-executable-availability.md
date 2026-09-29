<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-025: Native Executable Availability

## Status

Accepted (2026-09-28).
Amends [DR-013](013-cligent-owned-runtime-compatibility.md) for native-executable presence as an availability and readiness input, the installed-but-unavailable verdict, the unsupported-host outcome, and the host-facing executable lookup.

## Context

[DR-013](013-cligent-owned-runtime-compatibility.md) made Cligent the single authority for whether an agent runtime is ready, with the verdict produced by the loader from the runtime's version.
Both bundled SDKs, however, spawn a native executable that an optional platform package carries:

| Runtime | Executable carrier | First run without it |
| --- | --- | --- |
| Claude Agent SDK | a `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` package, with musl and Android variants on Linux | executable not found |
| Codex SDK | a `@openai/codex-<platform>-<arch>` package that the `@openai/codex` launcher spawns from | missing optional dependency |

npm drops an optional package that fails to install, or that `--omit=optional` excludes, without failing the install.
The SDK still imports and its version still reads, so availability said yes and readiness said `satisfied` while every run failed mid-turn with a vendor message, the failure DR-013 moved to the gate.
A host that wanted to name the missing piece, such as Spex, had to copy each SDK's platform-package layout, the duplicated adapter knowledge DR-013 retired.
Some hosts, such as FreeBSD or 32-bit Linux, get no executable from either SDK at all, and there a reinstall cannot help.

## Decision

**Native-executable presence is an availability and readiness input.**
An adapter whose SDK spawns a native executable is available only when that executable is found by the SDK's own lookup, mirrored from the SDK's physical location [[claude-code-13](../packages/adapters/claude-code.md#claude-code-13)], [[codex-8](../packages/adapters/codex.md#codex-8)].
A version cannot show this piece, so the executable is checked beside the version rather than inferred from it.

**An installed runtime its adapter cannot load reads `missing`, carrying its version.**
At or above the supported floor no version makes such a runtime usable, so the verdict follows the adapter, including above the tested version [[engine-26](../packages/engine.md#engine-26)].
Below the floor `unsupported` still wins, because the version already explains the refusal and names its repair.

**A run refuses before any SDK call, claiming only the fault the lookup proves** [[claude-code-56](../packages/adapters/claude-code.md#claude-code-56)], [[codex-63](../packages/adapters/codex.md#codex-63)]:

| Lookup outcome | Refusal |
| --- | --- |
| the SDK publishes no executable for the host | says so for `<platform>-<arch>` and advises no reinstall |
| the Codex launcher entry does not resolve | the entry's own diagnostic, never a platform-package claim |
| the platform package is absent | names the package, the host, and the reinstall that keeps optional dependencies |

**An unsupported host is concluded only from positive evidence.**
For Claude, the SDK manifest's optional dependencies name none of the host's candidate packages [[claude-code-57](../packages/adapters/claude-code.md#claude-code-57)]; for Codex, the launcher's target table lacks the host [[codex-64](../packages/adapters/codex.md#codex-64)].
An unreadable manifest, or one declaring no optional dependencies, proves nothing, since vendored layouts are legitimate, so the package reads missing.
An executable found wins over the manifest, because the SDK spawns what it finds rather than what its manifest lists.

**Cligent tells a host where the executable stands.**
`locateAgentExecutable` applies the adapters' own lookup and reports `present`, `missing` with the package, `unsupported`, or `no-sdk` [[engine-88](../packages/engine.md#engine-88)], so a host holds no SDK layout rule and renders the answer without recomputing it.

## Consequences

- An install that dropped a platform package fails at the gate, before any agent call, with the package and a repair that restores it, instead of surfacing as a vendor error mid-turn.
- A host on a platform the SDK does not serve learns so plainly and is not sent into a reinstall loop.
- Hosts delete their copies of SDK layout rules and take the executable's standing from Cligent alone.
- Cligent now tracks each SDK's platform-package rule; an SDK that changes its rule is a conformance change Cligent releases, checked against a real install of both SDKs.
- `missing` no longer implies absence: a consumer that renders it reads the installed version to tell an absent runtime from an installed but unavailable one.
