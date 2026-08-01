<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CODEX: Codex Adapter Implementation

## Intent

This component defines Codex adapter implementation requirements that are needed to preserve the public Codex adapter contract in [CODEX](../../user/adapters/codex.md).

## Workspace Writable Paths

### CODEX-010

Where a non-empty `PermissionPolicy.writablePaths` policy resolves to Codex profile enforcement per [CODEX-004](../../user/adapters/codex.md#codex-004), when the adapter starts a run, the adapter shall make the generated permission profile definition available to that run through Codex's normal configuration loading without writing repository `.codex/config.toml`, without writing user-level Codex config, and without replacing the user's Codex home, authentication, or session configuration.
Where a run carries a `PermissionPolicy` whose mapped permission profile can
cause Codex to auto-persist project trust, when the adapter starts the run, the
adapter shall resolve the caller-selected workspace to the project root used by
Codex and supply its trust decision as a per-run CLI configuration override so
Codex does not persist a `projects.<path>.trust_level` entry.
The resolver shall preserve Codex's lexical absolute-path identity after its
native Windows device-prefix simplification instead of independently
realpath-canonicalizing symlink aliases.
For a linked worktree, this shall be the main repository root resolved from the
worktree's `.git` file, matching Codex's active-project trust lookup.
The trust override shall encode the complete top-level `projects` inline table,
not a dotted key containing a quoted path segment, so Codex's CLI override
parser materializes the absolute path as the project-table key.
The override shall not create a project or user configuration file.
When the caller omits `cwd` or supplies an empty value that the SDK does not
forward as `--cd`, the adapter shall not inject project trust because Codex's
project auto-trust path is not active for that run.
Mappings that resolve to `:read-only` shall not inject project trust because
Codex does not auto-persist trust for those mappings, and trusting them would
unnecessarily enable project-local configuration and executable policy.

## Codex Executable Resolution

### CODEX-012

`@openai/codex` is a dependency of the optional `@openai/codex-sdk` peer
([PKG-004](../package.md#pkg-004)), not of the Cligent package, so install
layouts that do not hoist it — npm global prefixes and nested-strategy
consumers — place it only inside the SDK's own tree.
When a run requires the Codex CLI entry `@openai/codex/bin/codex.js` for the
per-run configuration wrapper of [CODEX-010](#codex-010) and
[CODEX-004](../../user/adapters/codex.md#codex-004), the adapter shall resolve
the entry anchored inside the installed `@openai/codex-sdk` package tree,
attempting first the ESM loader's own SDK resolution (`import.meta.resolve`)
[[1]] where the runtime provides it, then the first `@openai/codex-sdk`
package manifest found on the adapter's module search paths, and shall fall
back to the adapter's own module resolution context only when no SDK-anchored
resolution succeeds.
Where an earlier anchor is unavailable or yields no entry — the loader
surface absent, its result not a file location, or its anchored tree missing
the entry — resolution shall continue with the remaining anchors rather than
fail.
Where the install layout reaches `@openai/codex-sdk` through symbolic links,
each anchor shall be canonicalized to the SDK's physical location so
resolution returns the entry nested in that physical tree.
Where the install layout nests `@openai/codex` inside `@openai/codex-sdk`
without a copy visible from the adapter's own resolution context, resolution
shall return the SDK-owned entry.
Where both an SDK-owned copy and an independently installed `@openai/codex`
are visible, resolution shall return the SDK-owned copy so the wrapped
executable matches the SDK's exactly pinned dependency.
Where the Node runtime provides no ESM loader resolution surface, as on the
[PKG-002](../package.md#pkg-002) runtime floor, the search-path anchor shall
produce the same SDK-owned result.

### CODEX-013

When every resolution route for `@openai/codex/bin/codex.js` fails, the
adapter shall raise an error that names the attempted entry specifier,
identifies each attempted resolution anchor, states that `@openai/codex` is
provided by `@openai/codex-sdk`, and directs the caller to install
`@openai/codex-sdk` where the Cligent package can resolve it as the repair.
The raised error shall carry the `MODULE_NOT_FOUND` code so callers that
degrade on a missing optional CLI by inspecting the error code keep matching.
Where the failure occurs while starting a run, the adapter shall release that
run's abort registration before the error propagates, so a caller repeating
failed runs against one long-lived `AgentOptions.abortSignal` accumulates no
listeners on it.

## References

[1]: https://nodejs.org/api/esm.html#importmetaresolvespecifier "Node.js import.meta.resolve"
