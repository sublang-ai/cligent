<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-017: Spec Generation Migration

## Status

Accepted

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
- The framework law's own released IDs move with the rest: the 24 `META-<N>` items the previous generation published reach whatever now carries their concern, where anything still does — usually an item of the current `meta-<N>` set, sometimes a decision record instead.
- The map establishes each of those outcomes rather than assuming it: `META-17`'s concern survives in [DR-000](000-spec-structure-format.md), which still lets DRs and items cite each other, while `META-15`'s minimizing of project references and `META-26`'s observable-outcome drafting rule were found in neither the current law nor a decision record, so only those two counted as law removed.
- The owner closed both, one each way: `META-15`'s concern is restored as `meta-35` and `meta-36`, one requirement each [[meta-29](../meta.md#meta-29)], and `META-26`'s retirement is approved, so its row records a successor no one will write.
- Law found removed closes two ways and no other: a carrier is restored, or the owner approves the retirement and an authorizing decision record admits it, which is the gate the released-ID clause now sets for retiring a concern and which this record passes [[meta-12](../meta.md#meta-12)].
- The per-item resolution of these rules belongs in this record beside the family table, one row per destination where a clause splits, so a released ID stays traceable once the plan that moved it is gone.
- That reconciliation also adopts what those files add beyond the legacy set: `git-5`, `git-6`, the scope and detector items promoting the legacy `Exclusions` and `License File Detection` subsections, and `git-1`'s widened actor and reporting duty, which bind whoever prepares a commit rather than an AI agent alone.

### Per-item map

The rules above resolve to this map, which every later move reads and which outlives the plan that produced it.
It was built carrying 402 released item IDs over 473 rows, and grows a row wherever a task since has split one released concern across two destinations: a behavior item takes one row, in its own package, its citations of peer behavior staying citations [[meta-14](../meta.md#meta-14)], while a test item takes one row per package whose behavior it verifies, wherever in the item that citation sits, because a verification citation follows the behavior into its package [[meta-20](../meta.md#meta-20)].
It is kept true as the tree changes: a task that splits an item [[meta-29](../meta.md#meta-29)], drops a restatement another package already owns [[meta-34](../meta.md#meta-34)], or moves a clause records the added, removed, or retargeted row here in the same commit.

| Released ID | Destination |
| --- | --- |
| `CLAUDE-001` | `claude-code-1` |
| `CLAUDE-002` | `claude-code-2` |
| `CLAUDE-002` | `claude-code-13` |
| `CLAUDE-002` | `claude-code-14` |
| `CLAUDE-003` | `claude-code-3` |
| `CLAUDE-003` | `claude-code-15` |
| `CLAUDE-003` | `claude-code-16` |
| `CLAUDE-003` | `claude-code-17` |
| `CLAUDE-003` | `claude-code-24` |
| `CLAUDE-003` | `claude-code-32` |
| `CLAUDE-003` | `claude-code-42` |
| `CLAUDE-003` | `claude-code-50` |
| `CLAUDE-004` | `claude-code-4` |
| `CLAUDE-004` | `claude-code-19` |
| `CLAUDE-005` | `claude-code-5` |
| `CLAUDE-005` | `claude-code-20` |
| `CLAUDE-005` | `claude-code-21` |
| `CLAUDE-006` | `claude-code-6` |
| `CLAUDE-007` | `claude-code-7` |
| `CLAUDE-007` | `claude-code-25` |
| `CLAUDE-007` | `claude-code-26` |
| `CLAUDE-007` | `claude-code-51` |
| `CLAUDE-008` | `claude-code-8` |
| `CLAUDE-008` | `claude-code-23` |
| `CLAUDE-009` | `claude-code-9` |
| `CLAUDE-009` | `claude-code-22` |
| `CLAUDE-010` | `claude-code-10` |
| `CLAUDE-010` | `claude-code-18` |
| `CLAUDE-010` | `claude-code-28` |
| `CLAUDE-010` | `claude-code-48` |
| `CLAUDE-011` | `claude-code-11` |
| `CLAUDE-011` | `claude-code-27` |
| `CLAUDE-011` | `claude-code-28` |
| `CLAUDE-012` | `claude-code-12` |
| `CLAUDE-012` | `claude-code-28` |
| `CLAUDE-012` | `claude-code-29` |
| `CLAUDE-012` | `claude-code-30` |
| `CLAUDE-012` | `claude-code-31` |
| `CLAUDE-012` | `claude-code-50` |
| `CLAUDE-012` | `engine-31` |
| `CODEX-001` | `codex-1` |
| `CODEX-002` | `codex-2` |
| `CODEX-002` | `codex-8` |
| `CODEX-002` | `codex-18` |
| `CODEX-003` | `codex-3` |
| `CODEX-003` | `codex-19` |
| `CODEX-003` | `codex-20` |
| `CODEX-003` | `codex-21` |
| `CODEX-003` | `codex-22` |
| `CODEX-003` | `codex-23` |
| `CODEX-003` | `codex-24` |
| `CODEX-003` | `codex-25` |
| `CODEX-003` | `codex-26` |
| `CODEX-003` | `codex-27` |
| `CODEX-003` | `codex-28` |
| `CODEX-003` | `codex-29` |
| `CODEX-003` | `codex-30` |
| `CODEX-003` | `codex-53` |
| `CODEX-003` | `codex-54` |
| `CODEX-004` | `codex-4` |
| `CODEX-004` | `codex-31` |
| `CODEX-004` | `codex-32` |
| `CODEX-005` | `codex-5` |
| `CODEX-005` | `codex-34` |
| `CODEX-006` | `codex-6` |
| `CODEX-006` | `codex-33` |
| `CODEX-006` | `codex-34` |
| `CODEX-007` | `codex-7` |
| `CODEX-007` | `codex-35` |
| `CODEX-009` | `codex-9` |
| `CODEX-010` | `codex-10` |
| `CODEX-010` | `codex-37` |
| `CODEX-010` | `codex-38` |
| `CODEX-010` | `codex-39` |
| `CODEX-011` | `codex-11` |
| `CODEX-012` | `codex-12` |
| `CODEX-013` | `codex-13` |
| `CODEX-013` | `codex-40` |
| `CODEX-014` | `codex-14` |
| `CODEX-015` | `codex-15` |
| `CODEX-015` | `engine-18` |
| `CODEX-016` | `codex-16` |
| `CODEX-017` | `codex-17` |
| `CODEX-017` | `codex-36` |
| `CODEX-017` | `codex-53` |
| `CODEX-017` | `engine-31` |
| `GEMINI-001` | `gemini-1` |
| `GEMINI-002` | `gemini-2` |
| `GEMINI-003` | `gemini-3` |
| `GEMINI-004` | `gemini-4` |
| `GEMINI-005` | `gemini-5` |
| `GEMINI-006` | `gemini-6` |
| `GEMINI-007` | `gemini-7` |
| `GEMINI-008` | `gemini-8` |
| `GEMINI-009` | `gemini-9` |
| `GEMINI-010` | `gemini-10` |
| `GEMINI-011` | `gemini-11` |
| `GEMINI-012` | `gemini-12` |
| `GEMINI-013` | `gemini-13` |
| `GEMINI-014` | `gemini-14` |
| `GEMINI-015` | `gemini-15` |
| `GEMINI-016` | `gemini-16` |
| `GEMINI-017` | `gemini-17` |
| `KIMI-001` | `kimi-1` |
| `KIMI-002` | `kimi-2` |
| `KIMI-003` | `kimi-3` |
| `KIMI-004` | `kimi-4` |
| `KIMI-005` | `kimi-5` |
| `KIMI-006` | `kimi-6` |
| `KIMI-007` | `kimi-7` |
| `KIMI-008` | `kimi-8` |
| `KIMI-009` | `kimi-9` |
| `KIMI-010` | `kimi-10` |
| `KIMI-011` | `kimi-11` |
| `KIMI-012` | `kimi-12` |
| `KIMI-013` | `kimi-13` |
| `OPENCODE-001` | `opencode-1` |
| `OPENCODE-002` | `opencode-2` |
| `OPENCODE-003` | `opencode-3` |
| `OPENCODE-004` | `opencode-4` |
| `OPENCODE-005` | `opencode-5` |
| `OPENCODE-006` | `opencode-6` |
| `OPENCODE-007` | `opencode-7` |
| `OPENCODE-008` | `opencode-8` |
| `OPENCODE-009` | `opencode-9` |
| `OPENCODE-010` | `opencode-10` |
| `OPENCODE-011` | `opencode-11` |
| `OPENCODE-012` | `opencode-12` |
| `OPENCODE-013` | `opencode-13` |
| `OPENCODE-014` | `opencode-14` |
| `OPENCODE-015` | `opencode-15` |
| `OPENCODE-016` | `opencode-16` |
| `OPENCODE-017` | `opencode-17` |
| `OPENCODE-018` | `opencode-18` |
| `OPENCODE-019` | `opencode-19` |
| `OPENCODE-020` | `opencode-20` |
| `OPENCODE-021` | `opencode-21` |
| `ENG-001` | `engine-1` |
| `ENG-002` | `engine-2` |
| `ENG-003` | `engine-3` |
| `ENG-004` | `engine-4` |
| `ENG-005` | `engine-5` |
| `ENG-006` | `engine-6` |
| `ENG-007` | `engine-7` |
| `ENG-008` | `engine-8` |
| `ENG-009` | `engine-9` |
| `ENG-010` | `engine-10` |
| `ENG-011` | `engine-11` |
| `ENG-012` | `engine-12` |
| `ENG-013` | `engine-13` |
| `ENG-014` | `engine-14` |
| `ENG-015` | `engine-15` |
| `ENG-016` | `engine-16` |
| `ENG-017` | `engine-17` |
| `ENG-018` | `engine-18` |
| `ENG-019` | `engine-19` |
| `ENG-020` | `engine-20` |
| `ENG-021` | `engine-21` |
| `ENG-022` | `engine-22` |
| `ENG-023` | `engine-23` |
| `ENG-024` | `engine-24` |
| `ENG-025` | `engine-25` |
| `ENG-026` | `engine-26` |
| `ENG-027` | `engine-27` |
| `ENG-028` | `engine-28` |
| `ENG-029` | `engine-29` |
| `ENG-030` | `engine-30` |
| `ENG-031` | `engine-31` |
| `TENG-001` | `engine-101` |
| `TENG-002` | `engine-102` |
| `TENG-003` | `engine-103` |
| `TENG-004` | `engine-104` |
| `TENG-005` | `engine-105` |
| `TENG-006` | `engine-106` |
| `TENG-007` | `engine-107` |
| `TENG-008` | `engine-108` |
| `TENG-009` | `engine-109` |
| `TENG-010` | `engine-110` |
| `TENG-011` | `engine-111` |
| `TENG-012` | `engine-112` |
| `TENG-013` | `engine-113` |
| `TENG-014` | `engine-114` |
| `TENG-015` | `engine-115` |
| `TENG-016` | `engine-116` |
| `TENG-017` | `engine-117` |
| `TENG-018` | `engine-118` |
| `TENG-018` | `package-201` |
| `TENG-019` | `engine-119` |
| `TENG-020` | `engine-120` |
| `TENG-021` | `engine-121` |
| `TENG-022` | `engine-122` |
| `NDJSON-001` | `ndjson-1` |
| `NDJSON-002` | `ndjson-2` |
| `NDJSON-003` | `ndjson-3` |
| `NDJSON-004` | `ndjson-4` |
| `NDJSON-005` | `ndjson-5` |
| `NDJSON-005` | `ndjson-6` |
| `TMUX-001` | `tmux-play-1` |
| `TMUX-002` | `tmux-play-2` |
| `TMUX-003` | `tmux-play-3` |
| `TMUX-004` | `tmux-play-4` |
| `TMUX-005` | `tmux-play-5` |
| `TMUX-006` | `tmux-play-6` |
| `TMUX-007` | `tmux-play-7` |
| `TMUX-008` | `tmux-play-8` |
| `TMUX-009` | `tmux-play-9` |
| `TMUX-010` | `tmux-play-10` |
| `TMUX-011` | `tmux-play-11` |
| `TMUX-012` | `tmux-play-12` |
| `TMUX-013` | `tmux-play-13` |
| `TMUX-014` | `tmux-play-14` |
| `TMUX-015` | `tmux-play-15` |
| `TMUX-016` | `tmux-play-16` |
| `TMUX-017` | `tmux-play-17` |
| `TMUX-018` | `tmux-play-18` |
| `TMUX-019` | `tmux-play-19` |
| `TMUX-020` | `tmux-play-20` |
| `TMUX-021` | `tmux-play-21` |
| `TMUX-022` | `tmux-play-22` |
| `TMUX-023` | `tmux-play-23` |
| `TMUX-024` | `tmux-play-24` |
| `TMUX-025` | `tmux-play-25` |
| `TMUX-026` | `tmux-play-26` |
| `TMUX-027` | `tmux-play-27` |
| `TMUX-028` | `tmux-play-28` |
| `TMUX-029` | `tmux-play-29` |
| `TMUX-030` | `tmux-play-30` |
| `TMUX-031` | `tmux-play-31` |
| `TMUX-032` | `tmux-play-32` |
| `TMUX-033` | `tmux-play-33` |
| `TMUX-034` | `tmux-play-34` |
| `TMUX-035` | `tmux-play-35` |
| `TMUX-036` | `tmux-play-36` |
| `TMUX-037` | `tmux-play-37` |
| `TMUX-038` | `tmux-play-38` |
| `TMUX-039` | `tmux-play-39` |
| `TMUX-040` | `tmux-play-40` |
| `TMUX-041` | `tmux-play-41` |
| `TMUX-042` | `tmux-play-42` |
| `TMUX-043` | `tmux-play-43` |
| `TMUX-044` | `tmux-play-44` |
| `TMUX-045` | `tmux-play-45` |
| `TMUX-046` | `tmux-play-46` |
| `TMUX-047` | `tmux-play-47` |
| `TMUX-048` | `tmux-play-48` |
| `TMUX-049` | `tmux-play-49` |
| `TMUX-050` | `tmux-play-50` |
| `TMUX-051` | `tmux-play-51` |
| `TMUX-052` | `tmux-play-52` |
| `TMUX-053` | `tmux-play-53` |
| `TMUX-054` | `tmux-play-54` |
| `TMUX-055` | `tmux-play-55` |
| `TMUX-056` | `tmux-play-56` |
| `TMUX-057` | `tmux-play-57` |
| `TMUX-058` | `tmux-play-58` |
| `TMUX-060` | `tmux-play-60` |
| `TMUX-061` | `tmux-play-61` |
| `TMUX-062` | `tmux-play-62` |
| `TMUX-063` | `tmux-play-63` |
| `TMUX-064` | `tmux-play-64` |
| `TMUX-065` | `tmux-play-65` |
| `TMUX-066` | `tmux-play-66` |
| `TMUX-067` | `tmux-play-67` |
| `TMUX-068` | `tmux-play-68` |
| `TMUX-069` | `tmux-play-69` |
| `TMUX-070` | `tmux-play-70` |
| `TMUX-071` | `tmux-play-71` |
| `TMUX-072` | `tmux-play-72` |
| `TMUX-074` | `tmux-play-74` |
| `TMUX-075` | `tmux-play-75` |
| `TMUX-076` | `tmux-play-76` |
| `TMUX-077` | `tmux-play-77` |
| `TMUX-079` | `tmux-play-79` |
| `TMUX-080` | `tmux-play-80` |
| `TMUX-081` | `tmux-play-81` |
| `TMUX-082` | `tmux-play-82` |
| `TMUX-083` | `tmux-play-83` |
| `TMUX-084` | `tmux-play-84` |
| `TMUX-085` | `tmux-play-85` |
| `TMUX-086` | `tmux-play-86` |
| `TMUX-087` | `tmux-play-87` |
| `TMUX-088` | `tmux-play-88` |
| `TMUX-089` | `tmux-play-89` |
| `TMUX-092` | `tmux-play-92` |
| `TMUX-093` | `tmux-play-93` |
| `TMUX-094` | `tmux-play-94` |
| `TMUX-096` | `tmux-play-96` |
| `TTMUX-001` | `tmux-play-101` |
| `TTMUX-002` | `tmux-play-102` |
| `TTMUX-003` | `tmux-play-103` |
| `TTMUX-004` | `tmux-play-104` |
| `TTMUX-005` | `tmux-play-105` |
| `TTMUX-006` | `tmux-play-106` |
| `TTMUX-007` | `tmux-play-107` |
| `TTMUX-008` | `tmux-play-108` |
| `TTMUX-009` | `tmux-play-109` |
| `TTMUX-010` | `tmux-play-110` |
| `TTMUX-011` | `tmux-play-111` |
| `TTMUX-012` | `tmux-play-112` |
| `TTMUX-013` | `tmux-play-113` |
| `TTMUX-014` | `tmux-play-114` |
| `TTMUX-015` | `tmux-play-115` |
| `TTMUX-016` | `tmux-play-116` |
| `TTMUX-017` | `tmux-play-117` |
| `TTMUX-018` | `tmux-play-118` |
| `TTMUX-019` | `tmux-play-119` |
| `TTMUX-020` | `tmux-play-120` |
| `TTMUX-021` | `tmux-play-121` |
| `TTMUX-022` | `tmux-play-122` |
| `TTMUX-023` | `tmux-play-123` |
| `TTMUX-024` | `tmux-play-124` |
| `TTMUX-025` | `tmux-play-125` |
| `TTMUX-026` | `tmux-play-126` |
| `TTMUX-027` | `tmux-play-127` |
| `TTMUX-028` | `tmux-play-128` |
| `TTMUX-029` | `tmux-play-129` |
| `TTMUX-030` | `tmux-play-130` |
| `TTMUX-031` | `tmux-play-131` |
| `TTMUX-032` | `tmux-play-132` |
| `TTMUX-033` | `tmux-play-133` |
| `TTMUX-034` | `tmux-play-134` |
| `TTMUX-035` | `tmux-play-135` |
| `TTMUX-036` | `tmux-play-136` |
| `TTMUX-037` | `tmux-play-137` |
| `TTMUX-038` | `tmux-play-138` |
| `TTMUX-039` | `tmux-play-139` |
| `TTMUX-040` | `tmux-play-140` |
| `TTMUX-041` | `tmux-play-141` |
| `TTMUX-042` | `tmux-play-142` |
| `TTMUX-043` | `tmux-play-143` |
| `TTMUX-044` | `tmux-play-144` |
| `TTMUX-045` | `tmux-play-145` |
| `TTMUX-046` | `tmux-play-146` |
| `TTMUX-047` | `tmux-play-147` |
| `TTMUX-048` | `tmux-play-148` |
| `TTMUX-049` | `tmux-play-149` |
| `TTMUX-050` | `tmux-play-150` |
| `TTMUX-051` | `tmux-play-151` |
| `TTMUX-052` | `engine-201` |
| `TTMUX-052` | `tmux-play-152` |
| `TTMUX-053` | `engine-202` |
| `TTMUX-053` | `tmux-play-153` |
| `TTMUX-054` | `tmux-play-154` |
| `TTMUX-055` | `tmux-play-155` |
| `TTMUX-056` | `tmux-play-156` |
| `TTMUX-057` | `claude-code-203` |
| `TTMUX-057` | `codex-203` |
| `TTMUX-057` | `engine-204` |
| `TTMUX-057` | `gemini-202` |
| `TTMUX-057` | `kimi-202` |
| `TTMUX-057` | `opencode-203` |
| `TTMUX-057` | `tmux-play-157` |
| `TTMUX-058` | `tmux-play-158` |
| `TTMUX-059` | `tmux-play-159` |
| `TTMUX-060` | `tmux-play-160` |
| `TTMUX-061` | `tmux-play-161` |
| `TTMUX-062` | `tmux-play-162` |
| `TTMUX-063` | `tmux-play-163` |
| `TTMUX-064` | `tmux-play-164` |
| `TTMUX-065` | `tmux-play-165` |
| `TTMUX-066` | `tmux-play-166` |
| `TTMUX-067` | `tmux-play-167` |
| `TTMUX-068` | `tmux-play-168` |
| `TTMUX-069` | `tmux-play-169` |
| `TTMUX-070` | `tmux-play-170` |
| `TTMUX-071` | `tmux-play-171` |
| `TTMUX-073` | `tmux-play-173` |
| `TTMUX-074` | `tmux-play-174` |
| `TTMUX-075` | `tmux-play-175` |
| `TTMUX-076` | `tmux-play-176` |
| `TTMUX-078` | `tmux-play-178` |
| `TTMUX-079` | `tmux-play-179` |
| `TTMUX-080` | `tmux-play-180` |
| `TTMUX-081` | `tmux-play-181` |
| `TTMUX-082` | `tmux-play-182` |
| `TTMUX-083` | `tmux-play-183` |
| `TTMUX-084` | `tmux-play-184` |
| `TTMUX-085` | `tmux-play-185` |
| `TTMUX-086` | `tmux-play-186` |
| `TTMUX-087` | `tmux-play-187` |
| `TTMUX-088` | `tmux-play-188` |
| `TTMUX-090` | `tmux-play-190` |
| `TTMUX-091` | `tmux-play-191` |
| `TTMUX-092` | `tmux-play-192` |
| `TTMUX-093` | `tmux-play-193` |
| `TTMUX-096` | `tmux-play-196` |
| `TTMUX-097` | `tmux-play-197` |
| `TTMUX-098` | `tmux-play-198` |
| `PKG-001` | `package-1` |
| `PKG-002` | `package-2` |
| `PKG-003` | `package-3` |
| `PKG-004` | `package-4` |
| `PKG-005` | `package-5` |
| `PKG-006` | `package-6` |
| `PKG-007` | `package-7` |
| `PKG-008` | `package-8` |
| `PKG-009` | `package-9` |
| `PKG-009` | `package-17` |
| `PKG-009` | `package-16` |
| `PKG-009` | `engine-26` |
| `PKG-010` | `package-10` |
| `PKG-010` | `package-18` |
| `PKG-010` | `package-19` |
| `PKG-010` | `package-20` |
| `PKG-011` | `package-11` |
| `PKG-011` | `package-21` |
| `PKG-012` | `package-12` |
| `PKG-012` | `package-22` |
| `PKG-012` | `package-34` |
| `PKG-012` | `package-23` |
| `PKG-012` | `package-24` |
| `PKG-012` | `package-25` |
| `PKG-012` | `package-26` |
| `PKG-012` | `package-27` |
| `PKG-013` | `package-13` |
| `PKG-013` | `package-28` |
| `PKG-014` | `package-14` |
| `PKG-014` | `package-31` |
| `PKG-015` | `package-15` |
| `PKG-015` | `package-32` |
| `PKG-015` | `package-33` |
| `PKG-015` | `tmux-play-10` |
| `PKG-015` | `tmux-play-89` |
| `PKG-016` | `package-16` |
| `PKG-016` | `package-27` |
| `PKG-016` | `package-29` |
| `PKG-016` | `package-30` |
| `TPKG-001` | `package-101` |
| `TPKG-002` | `package-102` |
| `TPKG-003` | `package-103` |
| `TPKG-004` | `package-104` |
| `TPKG-005` | `codex-205` |
| `TPKG-005` | `codex-51` |
| `TPKG-005` | `package-105` |
| `TPKG-006` | `tmux-play-201` |
| `RELEASE-001` | `release-1` |
| `RELEASE-002` | `release-2` |
| `RELEASE-003` | `release-3` |
| `RELEASE-004` | `release-4` |
| `RELEASE-005` | `release-5` |
| `RELEASE-006` | `release-6` |
| `RELEASE-007` | `release-7` |
| `RELEASE-008` | `release-8` |
| `RELEASE-008` | `release-13` |
| `RELEASE-009` | `release-9` |
| `RELEASE-010` | `release-10` |
| `GIT-001` | `git-1` |
| `GIT-002` | `git-2` |
| `GIT-003` | `git-3` |
| `GIT-004` | `git-4` |
| `LIC-1` | `licensing-1` |
| `LIC-2` | `licensing-2` |
| `LIC-3` | `licensing-3` |
| `LIC-4` | `licensing-4` |
| `LIC-5` | `licensing-5` |
| `LIC-6` | `licensing-6` |
| `TADAPT-001` | `claude-code-201` |
| `TADAPT-001` | `claude-code-43` |
| `TADAPT-001` | `claude-code-44` |
| `TADAPT-001` | `codex-201` |
| `TADAPT-001` | `codex-41` |
| `TADAPT-001` | `codex-42` |
| `TADAPT-001` | `codex-43` |
| `TADAPT-001` | `gemini-201` |
| `TADAPT-001` | `kimi-201` |
| `TADAPT-001` | `opencode-201` |
| `TADAPT-002` | `claude-code-202` |
| `TADAPT-002` | `claude-code-36` |
| `TADAPT-002` | `codex-202` |
| `TADAPT-002` | `codex-48` |
| `TADAPT-002` | `opencode-202` |
| `TADAPT-003` | `engine-203` |
| `TADAPT-003` | `gemini-203` |
| `TADAPT-003` | `kimi-203` |
| `TADAPT-004` | `claude-code-204` |
| `TADAPT-004` | `codex-204` |
| `TADAPT-004` | `gemini-204` |
| `TADAPT-004` | `kimi-204` |
| `TADAPT-004` | `opencode-204` |
| `TADAPT-006` | `codex-206` |
| `TADAPT-007` | `gemini-207` |
| `TADAPT-007` | `ndjson-207` |
| `TADAPT-008` | `opencode-208` |
| `TADAPT-009` | `engine-209` |
| `TADAPT-010` | `claude-code-210` |
| `TADAPT-011` | `codex-211` |
| `TADAPT-012` | `opencode-212` |
| `TADAPT-013` | `gemini-213` |
| `TADAPT-014` | `engine-214` |
| `TADAPT-015` | `codex-215` |
| `TADAPT-016` | `gemini-216` |
| `TADAPT-017` | `codex-217` |
| `TADAPT-018` | `claude-code-218` |
| `TADAPT-018` | `codex-218` |
| `TADAPT-018` | `engine-218` |
| `TADAPT-018` | `gemini-218` |
| `TADAPT-018` | `kimi-218` |
| `TADAPT-018` | `opencode-218` |
| `TADAPT-019` | `claude-code-219` |
| `TADAPT-019` | `codex-219` |
| `TADAPT-019` | `engine-219` |
| `TADAPT-019` | `gemini-219` |
| `TADAPT-019` | `kimi-219` |
| `TADAPT-019` | `opencode-219` |
| `TADAPT-020` | `claude-code-220` |
| `TADAPT-020` | `codex-220` |
| `TADAPT-020` | `gemini-220` |
| `TADAPT-020` | `kimi-220` |
| `TADAPT-020` | `opencode-220` |
| `TADAPT-021` | `codex-221` |
| `TADAPT-021` | `engine-221` |
| `TADAPT-022` | `claude-code-222` |
| `TADAPT-022` | `engine-221` |
| `TADAPT-022` | `gemini-222` |
| `TADAPT-022` | `kimi-222` |
| `TADAPT-022` | `opencode-222` |
| `TADAPT-023` | `codex-223` |
| `TADAPT-023` | `engine-221` |
| `TADAPT-024` | `codex-224` |
| `TADAPT-025` | `gemini-225` |
| `TADAPT-026` | `engine-226` |
| `TADAPT-026` | `gemini-226` |
| `TADAPT-026` | `kimi-226` |
| `TADAPT-026` | `opencode-226` |
| `TADAPT-027` | `opencode-227` |
| `TADAPT-028` | `opencode-228` |
| `TADAPT-028` | `package-228` |
| `TADAPT-029` | `claude-code-229` |
| `TADAPT-029` | `codex-229` |
| `TADAPT-029` | `engine-229` |
| `TADAPT-029` | `gemini-229` |
| `TADAPT-029` | `kimi-229` |
| `TADAPT-029` | `opencode-229` |
| `TADAPT-030` | `kimi-230` |
| `TADAPT-031` | `opencode-231` |
| `TADAPT-032` | `opencode-232` |
| `TADAPT-033` | `codex-233` |
| `TADAPT-033` | `engine-233` |
| `TADAPT-033` | `gemini-233` |
| `TADAPT-033` | `kimi-233` |
| `TADAPT-033` | `opencode-233` |
| `TADAPT-034` | `opencode-234` |
| `TADAPT-035` | `opencode-235` |
| `TADAPT-036` | `opencode-236` |
| `TADAPT-037` | `opencode-237` |
| `TADAPT-038` | `claude-code-238` |
| `TADAPT-038` | `codex-238` |
| `TADAPT-038` | `engine-238` |
| `TADAPT-038` | `kimi-238` |
| `TADAPT-038` | `opencode-238` |
| `TADAPT-039` | `claude-code-239` |
| `TADAPT-039` | `codex-239` |
| `TADAPT-039` | `engine-239` |
| `TADAPT-039` | `opencode-239` |
| `TADAPT-040` | `claude-code-240` |
| `TADAPT-040` | `codex-240` |
| `TADAPT-040` | `engine-32` |
| `TADAPT-040` | `engine-240` |
| `TADAPT-040` | `gemini-240` |
| `TADAPT-040` | `kimi-240` |
| `TADAPT-040` | `opencode-240` |
| `TADAPT-041` | `gemini-241` |

The framework law's own released IDs resolve against the current law and the decision records.
Two found no carrier and the owner closed each, `META-15` through a restored carrier and `META-26` through an admitted retirement:

| Released ID | Carrier of its concern |
| --- | --- |
| `META-1` | `meta-1` |
| `META-3` | `meta-30` |
| `META-4` | `meta-4` |
| `META-5` | `meta-5` |
| `META-6` | `meta-6` |
| `META-7` | `meta-7` |
| `META-8` | `meta-8` |
| `META-9` | `meta-9` |
| `META-10` | `meta-10` |
| `META-11` | `meta-11` |
| `META-12` | `meta-12` |
| `META-13` | `meta-13` |
| `META-14` | `meta-14` |
| `META-15` | `meta-35` |
| `META-15` | `meta-36` |
| `META-16` | `meta-16` |
| `META-17` | [DR-000](000-spec-structure-format.md), which still lets DRs and items cite each other |
| `META-18` | `meta-18` |
| `META-19` | `meta-19` |
| `META-20` | `meta-20` |
| `META-21` | `meta-21` |
| `META-23` | `meta-23` |
| `META-24` | `meta-24` |
| `META-25` | `meta-25` |
| `META-26` | none — retirement approved by the owner |

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

### Approvals

The owner answered five questions, the three this migration turned on — the shape question before the renumbering one it scoped — and then one for each released framework item the map found without a carrier.

1. Respelling the IDs that public releases carried is approved, the migration's own terms rather than the released-ID clause being what required that approval, so every legacy ID takes the lowercase `<pack>-<N>` form [[meta-11](../meta.md#meta-11)].
   The spelling was never cosmetic: the previous generation declared a package's short form as its own attribute rather than deriving it from the basename — `package-management.md` carried the short form `PKGMGT` — and required each ID to be unique across the whole tree, which is why one `engine` basename published both `ENG` and `TENG`.
   `GIT-001` and `ENG-018` were published identifiers in their own right, not renderings of `git-1` and `engine-18`, so the approval reaches the two respellings already in the tree: the refreshed law's own `META-<N>` items, and the fold that turned `GIT-001` … `GIT-004` and `LIC-1` … `LIC-6` into `git-1` … `git-4` and `licensing-1` … `licensing-6`.

2. The shape the cross-adapter rule above states is approved, so a shared criterion stays restated once per destination package and no shared adapter-contract package is introduced.

3. Renumbering those IDs is approved, and with it the amendment to the released-ID clause of [`meta.md`](../meta.md), a file carrying a standing instruction against editing it without human approval.
   That clause now admits a one-time migration whose authorizing decision record maps each renumbered ID to what keeps its concern [[meta-12](../meta.md#meta-12)].
   Merging `ENG` with `TENG`, merging `TMUX` with `TTMUX`, merging `PKG` with `TPKG`, relocating a released test clause into another subject's package, and the refresh's own move of `META-3` to `meta-30` each move a released number that the clause forbade outright before the amendment.
   This record is the authorization that clause requires, and the per-item map it must carry beside the family table is the condition attached rather than a convenience, so a later migration reaches no released number without a record of its own.

4. Restoring `META-15` is approved, its concern becoming `meta-35` and `meta-36` — the minimizing duty and the disclosure duty, which fail independently and so take one item each [[meta-29](../meta.md#meta-29)] — and binding every package from tasks 7 through 15 onward.
   It read: "Each spec package shall minimize references to the containing project. When a project-specific reference is essential to a package's intent, it shall be documented in the package's `## Intent` section."
   Restoring it writes an item of the current law [[meta-11](../meta.md#meta-11)] obliging every package to hold its project references down and to disclose an essential one in `Intent`, which `git`, `licensing`, and `release` already practise with their `It is project-local.` line and which `package`, `tmux-play`, the adapters, and `engine` would each owe as they land.
   Retiring it would have left no law asking a package to minimize those references or to say why it keeps one, and the four packages already landed satisfy the restored item unchanged.

5. Retiring `META-26` is approved, and with it the amendment to the released-ID clause of [`meta.md`](../meta.md) that admits a retirement at all, the current generation having dropped the item deliberately, so no successor is written and its observability-and-negative-case demand does not return.
   That clause now retires a concern only where the owner approves it and an authorizing decision record admits it [[meta-12](../meta.md#meta-12)], this record being that authorization; without the amendment the approval alone would have left the clause binding `META-26` to a concern nothing carries.
   It read: "A spec item shall describe behavior as observable outcomes (e.g., file state, exit code, printed output, return value, network call) under named conditions, including any conditions under which a particular outcome shall not occur."
   Its named conditions survive in the GEARS clauses [[meta-6](../meta.md#meta-6)], so restoring it adds only the demand that an outcome be observable and that an item name where an outcome shall not occur, which would redraft `release-1`'s SemVer rule, `release-4`'s pre-tag procedure, `release-10`'s checklist, and `git-3`'s bullets-if-clearer judgment, none of them stating something anyone can observe.
   The GEARS clauses [[meta-6](../meta.md#meta-6)] and the one-requirement rule [[meta-29](../meta.md#meta-29)] are therefore the only shape an item must take, and the dead `meta-26` link in `iterations/022-tmux-play-layout-configuration.md` loses its target for good.

## Consequences

- Every legacy item reaches a destination ID this record maps, so a stale citation can still be resolved by hand.
- A criterion naming all five adapters is stated in five packages, so a later change to it must be applied in each of them.
- Dissolving the 40 cross-adapter items yields 99 per-package test items, because 18 of them fan out.
- `tmux-play` stays one file of roughly 1600 lines once merged.
- Released changelog entries keep IDs that no longer resolve in the tree, and this record's table is the only bridge back to them.
- Numbering is left non-contiguous, with `engine-101` following `engine-31` and the gap between them free for later items.
- The reconciled `git` and `licensing` packages arrive with requirements the legacy files never stated, so the project adopts them by completing this migration.
- Two released framework IDs reached no carrier, and the owner closed each: `META-15`, which required a package to minimize references to its containing project, returns as `meta-35` and `meta-36`, while `META-26`, which required an item to describe behavior as observable outcomes, is retired with no successor.
- The framework law now carries two exceptions to its released-ID clause [[meta-12](../meta.md#meta-12)], differing in reach: the recorded renumbering, which this record authorizes for this migration alone and a later one must earn through a record and a map of its own, and the owner-approved retirement, which stands as a general gate every later retirement passes the same way.
