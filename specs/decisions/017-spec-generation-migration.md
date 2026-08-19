<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-017: Spec Generation Migration

## Status

Proposed.
The two approval gates in the Decision are open, and the first is a precondition for the merges that renumber released IDs.

## Context

The specs tree carries two spec generations at once.
The current law arrived with the refreshed [`meta.md`](../meta.md) and [DR-000](000-spec-structure-format.md), while the body that predates it, measured when this record was written, is still in place:

| Legacy body | Size |
| --- | --- |
| item files under `user/`, `dev/`, and `test/` | 18 files, 402 items |
| records under `iterations/` | 51 records |
| item citations inside `specs/` in the pre-generation unbracketed `[ID](path#anchor)` form, record links excluded | 1249 |
| item IDs quoted in comments, test names, and CI annotations | 594, across 69 files |
| item IDs quoted in released `CHANGELOG.md` entries | 244 |

Four points of the current law decide the shape of the move:

- a package is one file holding the behaviors of one shared intent, carrying a fixed section set whose `Verification` section is required [[meta-9](../meta.md#meta-9)], [[meta-13](../meta.md#meta-13)], [[meta-30](../meta.md#meta-30)];
- a test item's behavior citations stay inside its own package [[meta-20](../meta.md#meta-20)];
- an item ID is lowercase `<pack>-<N>`, where `<pack>` is its file's basename [[meta-11](../meta.md#meta-11)];
- a publicly released ID stays bound to the concern it names, and this repository released its legacy IDs across tags v0.1.0 through v0.22.0 [[meta-12](../meta.md#meta-12)].

Two obstacles follow that the legacy body cannot absorb unchanged.
Merging a subject's item files collides numerically: `ENG` and `TENG` share 22 numbers, `TMUX` and `TTMUX` share 86, and `PKG` and `TPKG` share 6.
The cross-adapter test file `test/adapters.md` cannot become a package at all, because it states no behavior of its own and 18 of its 40 items cite two or more foreign packages.

## Decision

### Destination packages

A subject's `user`, `dev`, and `test` sources merge into one package, and the adapter packages stay together in a `packages/adapters/` collection [[meta-31](../meta.md#meta-31)]:

| Destination package | Legacy sources | Item IDs |
| --- | --- | --- |
| `packages/adapters/claude-code.md` | `user/adapters/claude-code.md` | `CLAUDE-<N>` → `claude-code-<N>` |
| `packages/adapters/codex.md` | `user/adapters/codex.md`, `dev/adapters/codex.md` | `CODEX-<N>` → `codex-<N>`, the two ranges being disjoint |
| `packages/adapters/gemini.md` | `user/adapters/gemini.md` | `GEMINI-<N>` → `gemini-<N>` |
| `packages/adapters/kimi.md` | `user/adapters/kimi.md` | `KIMI-<N>` → `kimi-<N>` |
| `packages/adapters/opencode.md` | `user/adapters/opencode.md` | `OPENCODE-<N>` → `opencode-<N>` |
| `packages/engine.md` | `user/engine.md`, `test/engine.md` | `ENG-<N>` → `engine-<N>`; `TENG-<N>` → `engine-<100+N>` |
| `packages/ndjson.md` | `user/ndjson.md` | `NDJSON-<N>` → `ndjson-<N>` |
| `packages/tmux-play.md` | `user/tmux-play.md`, `test/tmux-play.md` | `TMUX-<N>` → `tmux-play-<N>`; `TTMUX-<N>` → `tmux-play-<100+N>` |
| `packages/package.md` | `dev/package.md`, `test/package.md` | `PKG-<N>` → `package-<N>`; `TPKG-<N>` → `package-<100+N>` |
| `packages/release.md` | `dev/release.md` | `RELEASE-<N>` → `release-<N>` |
| `packages/git.md` | `dev/git.md`, reconciled onto the current-generation file | `GIT-001` … `GIT-004` → `git-1` … `git-4` |
| `packages/licensing.md` | `dev/licensing.md`, `test/licensing.md`, reconciled onto the current-generation file | `LIC-1`, `LIC-2`, `LIC-5` → `licensing-1`, `licensing-2`, `licensing-5`; `LIC-3`, `LIC-4`, `LIC-6` → `licensing-3`, `licensing-4`, `licensing-6` |
| the eight packages it verifies | `test/adapters.md`, dissolved | `TADAPT-<N>` → `<destination>-<200+N>`, once per destination |

### Item IDs

- An ID keeps its number and drops its zero padding, so `TMUX-069` becomes `tmux-play-69`.
- A subject's whole test family takes a `+100` block, and the dissolved cross-adapter tests take a `+200` block in each destination.
- A block shifts a number without reassigning it: no destination ID names a concern other than the one its source ID named, and the table above records that binding.
- The blocks are historical rather than reserved ranges, so a later item still takes the lowest free number [[meta-11](../meta.md#meta-11)].
- A test clause that moves to another subject's package leaves its source number behind, that number belonging to a different series, and takes the lowest free number in the destination's `+200` block.
- A legacy item reconciles onto the current-generation item that carries its concern, whatever number that item holds.
- Where the two disagree on a number, the released ID keeps it and the unreleased occupant yields, which [[meta-12](../meta.md#meta-12)] allows: `LIC-6` keeps `licensing-6`, and the scope and detector items the current-generation file added move to `licensing-7` and `licensing-8`, `packages/` appearing in no release tag.
- That reconciliation also adopts what those files add beyond the legacy set: `git-5`, `git-6`, the scope and detector items promoting the legacy `Exclusions` and `License File Detection` subsections, and `git-1`'s widened actor and reporting duty, which bind whoever prepares a commit rather than an AI agent alone.

### Records

- Records move from `iterations/` to `intents/` with their IDs unchanged, and take the current record sections [[meta-5](../meta.md#meta-5)].
- The SPDX-header record is the exception: `intents/` already holds it, so the `iterations/` copy is reconciled into that file and deleted rather than moved onto it.

### Cross-adapter tests

- `test/adapters.md` dissolves into the `Verification` sections of the eight packages whose behavior it verifies: the five adapter packages plus `engine`, `ndjson`, and `package`.
- A criterion verifying several packages is split at its citation boundary and restated once per destination, each copy covering and citing that package's behavior alone [[meta-20](../meta.md#meta-20)].
- No shared adapter-contract package is introduced, because those criteria verify behaviors that the law states per adapter today, and replacing five statements with one would change what the law says rather than where it lives.

### One package per subject

- `tmux-play` stays one package: its 90 behavior items and 93 test items serve the one intent of the tmux-play application contract [[meta-13](../meta.md#meta-13)].
- Splitting a subject across packages is a design change, and this migration relocates content instead of restating it.
- A test clause verifying another package's behavior moves into that package [[meta-20](../meta.md#meta-20)].

### Scope boundary

- Citations and prose IDs elsewhere in `specs/` — the decision records, the moved intent records, and `map.md` — are retargeted with the package that moves.
- Comments, test names, and CI annotations in `src/`, `scripts/`, and `.github/workflows/` are retargeted with the package they cite.
- Released `CHANGELOG.md` entries keep their legacy IDs, because they record what shipped under those IDs.
- `README.md` and `docs/` quote no item ID and need no change.

### Approval gates

1. Re-rendering an ID is not a rename, and this record settles that on the law's own terms rather than leaving it to the gate.
   An item's identity is its file's basename and its number [[meta-11](../meta.md#meta-11)], and moving a file changes no item ID or anchor [[meta-31](../meta.md#meta-31)].
   Every legacy short form is the previous generation's uppercase rendering of that same basename — `ENG` of `engine`, `TMUX` of `tmux-play`, `GIT` of `git` — so `GIT-001` already named `git-1`, and `TMUX-069` already named `tmux-play-69`.
   Renumbering is the genuine conflict, and it arises four ways: merging `ENG` with `TENG`, merging `TMUX` with `TTMUX`, merging `PKG` with `TPKG`, and relocating a released test clause — including every dissolved cross-adapter item — into another subject's package.
   Each moves a released number, which [[meta-12](../meta.md#meta-12)] forbids outright, so amending that law is the precondition for all four, and `meta.md` carries a standing instruction against editing it without human approval.
   Reconciling the two seeded packages needed none of it, having moved no number.
2. Restating a shared criterion once per destination package, rather than introducing a shared adapter-contract package, is the alternative the owner may overturn.

## Consequences

- Every legacy item reaches a destination ID this record maps, so a stale citation can still be resolved by hand.
- A criterion naming all five adapters is stated in five packages, so a later change to it must be applied in each of them.
- Dissolving the 40 cross-adapter items yields 99 per-package test items, because 18 of them fan out.
- `tmux-play` stays one file of roughly 1600 lines once merged.
- Released changelog entries keep IDs that no longer resolve in the tree, and this record's table is the only bridge back to them.
- Numbering is left non-contiguous, with `engine-101` following `engine-31` and the gap between them free for later items.
- The reconciled `git` and `licensing` packages arrive with requirements the legacy files never stated, so the project adopts them by completing this migration.
