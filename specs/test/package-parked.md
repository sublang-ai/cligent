<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TPKG: Parked Package Test Clauses

## Intent

This component holds the clauses of the package acceptance checks that verify Codex and tmux-play behavior, awaiting those packages; the package behaviors themselves moved to [packages/package.md](../packages/package.md).

### TPKG-005
Verifies: [CODEX-012](../dev/adapters/codex.md#codex-012), [CODEX-013](../dev/adapters/codex.md#codex-013)

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

### TPKG-006
Verifies: [TMUX-010](../user/tmux-play.md#tmux-010), [TMUX-011](../user/tmux-play.md#tmux-011), [TMUX-089](../user/tmux-play.md#tmux-089)

Where the packed tarball alone is installed into a global-style prefix holding no agent SDK peer, and the search path reaches no agent CLI, when the installed `tmux-play` executable runs its documented launcher command against an isolated configuration home, the invocation shall fail, shall name the install command for every supported adapter, shall create no config file, and shall issue no tmux command.
The prefix shall be supplied out of band, so that a repair command npm would not resolve back to it fails this test rather than passing on the harness's own knowledge of the prefix.
Where the Codex SDK is then installed by executing the repair command that failure printed — verbatim, as argv, with no scope or target argument the user was not shown — the SDK shall land in the `node_modules` root the same failure reported, the same launcher command shall succeed, the created config shall name `codex` as its only adapter, the stdout notice shall name the adapter the roster was built from, and a tmux session shall be created.
Composing an install command in the test instead of running the printed one shall not satisfy this item: it is the substitution that would let a command scoped to the wrong tree pass.
