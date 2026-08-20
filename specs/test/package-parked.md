<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TPKG: Parked Package Test Clauses

## Intent

This component holds the clauses of the package acceptance checks that verify tmux-play behavior, awaiting that package; the package behaviors themselves moved to [packages/package.md](../packages/package.md).

### TPKG-006
Verifies: [TMUX-010](../user/tmux-play.md#tmux-010), [TMUX-011](../user/tmux-play.md#tmux-011), [TMUX-089](../user/tmux-play.md#tmux-089)

Where the packed tarball alone is installed into a global-style prefix holding no agent SDK peer, and the search path reaches no agent CLI, when the installed `tmux-play` executable runs its documented launcher command against an isolated configuration home, the invocation shall fail, shall name the install command for every supported adapter, shall create no config file, and shall issue no tmux command.
The prefix shall be supplied out of band, so that a repair command npm would not resolve back to it fails this test rather than passing on the harness's own knowledge of the prefix.
Where the Codex SDK is then installed by executing the repair command that failure printed — verbatim, as argv, with no scope or target argument the user was not shown — the SDK shall land in the `node_modules` root the same failure reported, the same launcher command shall succeed, the created config shall name `codex` as its only adapter, the stdout notice shall name the adapter the roster was built from, and a tmux session shall be created.
Composing an install command in the test instead of running the printed one shall not satisfy this item: it is the substitution that would let a command scoped to the wrong tree pass.
