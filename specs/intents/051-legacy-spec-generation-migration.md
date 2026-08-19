<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-051: Legacy Spec Generation Migration

## Status

Planned

## Intent

Migrate the whole specs tree from the legacy generation — `user/` + `dev/` + `test/` item files, `iterations/` records, uppercase `<PACK>-<N>` IDs, and `Verifies:` metadata lines — to the current generation that `spex scaffold --update` reinstated in [`meta.md`](../meta.md) and [DR-000](../decisions/000-spec-structure-format.md).
The tree holds 402 items across 18 legacy item files and 51 legacy records, and `spex lint` reports 1110 errors and 105 warnings against the current law, so the work is decomposed below rather than attempted at once.
Every stated behavior, local extension, record state, and item concern survives the move; nothing is invented or dropped.

Four invariants govern every task:

- Each commit leaves every citation resolving: the inbound citations across `specs/` and the item IDs quoted in `src/` comments and test names are retargeted in the same commit that moves their package.
- A destination package lands complete in one commit — `Intent`, `External Behavior`, optional `Internal Behavior`, `Verification`, in that order [[meta-30](../meta.md#meta-30)] — because a package without `Verification` is unlawful and cannot be staged across commits.
- A legacy test file survives until its last item reaches a lawful home: a test item's behavior citations stay inside its own package [[meta-20](../meta.md#meta-20)], so a clause verifying a peer's behavior waits for that peer's task.
- Every citation the tree carries is rewritten as it moves: all 1306 item citations use the legacy unbracketed `[ID](path#anchor)` form and none the outer-bracketed form the current law requires [[meta-16](../meta.md#meta-16)].

Rename map — `<N>` keeps its value and loses its zero padding, a family that would collide on merge takes a reserved `+100` block, and the dissolved cross-adapter tests take a `+200` block in each destination:

| Legacy source | Destination package | Item IDs |
| --- | --- | --- |
| `user/adapters/claude-code.md` | `packages/adapters/claude-code.md` | `CLAUDE-<N>` → `claude-code-<N>` |
| `user/adapters/codex.md`, `dev/adapters/codex.md` | `packages/adapters/codex.md` | `CODEX-<N>` → `codex-<N>`, the two ranges being disjoint |
| `user/adapters/gemini.md` | `packages/adapters/gemini.md` | `GEMINI-<N>` → `gemini-<N>` |
| `user/adapters/kimi.md` | `packages/adapters/kimi.md` | `KIMI-<N>` → `kimi-<N>` |
| `user/adapters/opencode.md` | `packages/adapters/opencode.md` | `OPENCODE-<N>` → `opencode-<N>` |
| `user/engine.md`, `test/engine.md` | `packages/engine.md` | `ENG-<N>` → `engine-<N>`; `TENG-<N>` → `engine-<100+N>` |
| `user/ndjson.md` | `packages/ndjson.md` | `NDJSON-<N>` → `ndjson-<N>` |
| `user/tmux-play.md`, `test/tmux-play.md` | `packages/tmux-play.md` | `TMUX-<N>` → `tmux-play-<N>`; `TTMUX-<N>` → `tmux-play-<100+N>` |
| `dev/package.md`, `test/package.md` | `packages/package.md` | `PKG-<N>` → `package-<N>`; `TPKG-<N>` → `package-<100+N>` |
| `dev/release.md` | `packages/release.md` | `RELEASE-<N>` → `release-<N>` |
| `dev/git.md` | `packages/git.md`, the scaffold seed | `GIT-00<N>` → `git-<N>` |
| `dev/licensing.md`, `test/licensing.md` | `packages/licensing.md`, the scaffold seed | `LIC-<N>` → `licensing-<N>` |
| `test/adapters.md` | dissolved into the five adapter packages plus `engine`, `ndjson`, and `package` | `TADAPT-<N>` → `<destination>-<200+N>`, once per destination it verifies |
| `iterations/<NNN>-*.md` | `intents/<NNN>-*.md` | record IDs unchanged |

## Deliverables

- [ ] A decision record fixes the destination package set, the ID scheme, the disposition of the cross-adapter test file, and what the migration leaves alone.
- [ ] `specs/packages/` holds one lawful package per subject, and `specs/user/`, `specs/dev/`, and `specs/test/` are gone.
- [ ] `specs/intents/` holds every intent record with its status and checkbox state intact, and `specs/iterations/` is gone.
- [ ] Every item states one GEARS requirement [[meta-29](../meta.md#meta-29)] under the current section order, with peer relationships and verification evidence carried only by inline citations [[meta-14](../meta.md#meta-14)], [[meta-16](../meta.md#meta-16)], [[meta-20](../meta.md#meta-20)], and no `Verifies:` line survives.
- [ ] `specs/map.md` indexes decisions and packages in the current shape and names no intent record [[meta-18](../meta.md#meta-18)].
- [ ] `src/` comments and test names quote current item IDs, while released `CHANGELOG.md` history stays byte-for-byte.
- [ ] `spex lint` reports no error and no warning.
- [ ] The rename map, every classification and split judgment, and every open question reach a human diff review.

## Tasks

1. **Record the migration contract.**
   Add `specs/decisions/017-spec-generation-migration.md` as `Proposed`, fixing the destination package set above, the `+100` and `+200` ID blocks and the dropped zero padding, the dissolution of the cross-adapter test file into per-package verification, `tmux-play` remaining one package, and the exemption of released changelog history from the rename.
   Record the two owner-approval questions it turns on: renaming item IDs that appeared in public releases at all [[meta-12](../meta.md#meta-12)], and duplicating a shared adapter criterion into each adapter package rather than introducing a shared adapter-contract package.
   No file moves in this task.

2. **Fold `git` and `licensing` onto their scaffold seeds.**
   Reconcile `dev/git.md` into `packages/git.md` and `dev/licensing.md` plus `test/licensing.md` into `packages/licensing.md`, keeping every project-local exclusion, example, and trailer rule the seeds do not already state.
   Reconcile the duplicated SPDX-header record at `iterations/000-spdx-headers.md` into `intents/000-spdx-headers.md` with this project's true checkbox state, then delete the legacy trio and the duplicate record and retarget their 8 inbound citations.

3. **Migrate `ndjson` and `release`.**
   Create `packages/ndjson.md` and `packages/release.md`, moving the parser's verification out of `test/adapters.md` and deleting `user/ndjson.md` and `dev/release.md`.
   The release behaviors carry no legacy verification at all, so add verification items only where a real check exists today and hand the residual coverage gap [[meta-33](../meta.md#meta-33)] to review instead of inventing tests.
   Retarget the 5 inbound citations the parser package carries.

4. **Migrate `package`.**
   Merge `dev/package.md`, `test/package.md`, and the conformance-target clause of `test/adapters.md` into `packages/package.md` under the `+100` block, and retarget its 28 inbound citations and the 16 ID references in `scripts/` and `src/`.
   Leave the clauses that verify Codex and tmux-play behavior in `test/package.md` for tasks 6 and 11 to absorb.

5. **Migrate the Claude Code adapter package.**
   Merge `user/adapters/claude-code.md` with its slice of `test/adapters.md` into `packages/adapters/claude-code.md`, restating each item as one GEARS requirement and converting its `Verifies:` lines to inline citations at the verifying assertion.
   Strip the migrated claims from `test/adapters.md`, whose 16 adapter-agnostic criteria each fan out into every adapter they name, and retarget the 28 inbound citations and 7 code references.

6. **Migrate the Codex adapter package.**
   Merge `user/adapters/codex.md`, `dev/adapters/codex.md`, the Codex slice of `test/adapters.md`, and the Codex clauses parked in `test/package.md` into `packages/adapters/codex.md`, classifying the delivery and executable-resolution items as `Internal Behavior`.
   Retarget the 39 inbound citations and 7 code references.

7. **Migrate the Gemini adapter package.**
   Merge `user/adapters/gemini.md` with its slice of `test/adapters.md` into `packages/adapters/gemini.md`, and retarget the 33 inbound citations.

8. **Migrate the Kimi adapter package.**
   Merge `user/adapters/kimi.md` with its slice of `test/adapters.md` into `packages/adapters/kimi.md`, and retarget the 35 inbound citations and 13 code references.

9. **Migrate the OpenCode adapter package.**
   Merge `user/adapters/opencode.md`, the largest behavior file, with its slice of `test/adapters.md` into `packages/adapters/opencode.md`, and retarget the 69 inbound citations and 6 code references.

10. **Migrate `engine`.**
    Merge `user/engine.md` and `test/engine.md` under the `+100` block with the cross-adapter tests that verify engine behavior, move the clause that verifies the peer-SDK floor into `packages/package.md`, and delete `test/adapters.md` once its last item has moved.
    Retarget the 91 inbound citations and 55 code references.

11. **Port `tmux-play` structurally.**
    Merge `user/tmux-play.md` and `test/tmux-play.md` under the `+100` block into `packages/tmux-play.md` with the lawful section order, faithful item text, renamed IDs, and all 93 `Verifies:` lines converted to inline citations.
    Move the clauses verifying adapter and engine behavior into those packages, absorb the last clauses parked in `test/package.md`, delete both tmux-play files, the emptied `test/package.md`, and the three emptied legacy directories, and retarget the 472 spec citations and 458 code references.

12. **Bring the `tmux-play` items into item law.**
    Split the multi-requirement items into one requirement each [[meta-29](../meta.md#meta-29)], classify presenter and launcher mechanics hidden from the package's users as `Internal Behavior` [[meta-30](../meta.md#meta-30)], and drop restatements another package already owns [[meta-34](../meta.md#meta-34)].
    This task moves no file, so it can be reviewed as pure item law.

13. **Move the records.**
    Move all 51 records from `specs/iterations/` to `specs/intents/`, rename `Goal` to `Intent` and both `Acceptance criteria` and `Acceptance` to `Verification`, supply the `Status` the three records without one are missing, and order the sections per [[meta-5](../meta.md#meta-5)].
    Convert the 54 decision-record citations to the plain relative-link form [[meta-16](../meta.md#meta-16)], and retarget the seven legacy `META-*` citations by concern: `META-11`, `META-12`, `META-19`, `META-21`, and `META-24` keep their number, the `META-20` claim about `Verifies:` lines is rewritten to the inline-citation law, and `META-26` has no successor so its sentence keeps its still-true prose and drops the link.

14. **Empty the records of design.**
    Move the design content the legacy records hold — their `Mechanism notes`, `Design decision`, and `Open questions` sections — into the decision records that own it, so deleting an intent record loses nothing [[meta-28](../meta.md#meta-28)].
    Remove every mention of an intent record from the other specs — the index, the one decision record that names one, and the intent records that cite each other [[meta-18](../meta.md#meta-18)].
    While the decision records are open, convert the two that carry `[^n]` footnotes to the numbered external-reference markers the current law requires [[meta-19](../meta.md#meta-19)].

15. **Rewrite the index and the guidance.**
    Rebuild `specs/map.md` in the current shape — layout block, decisions table, packages table — with no intent-record index [[meta-18](../meta.md#meta-18)], and refresh whatever repo guidance still describes the legacy layout.

16. **Verify and hand over.**
    Drive `spex lint` to zero errors and zero warnings, reconcile the rename map against the tree, run typecheck, lint, unit tests, and build, and hand the rename map, classifications, split judgments, and open questions to human diff review.

## Verification

- `spex lint` reports no error and no warning.
- No path under `specs/user/`, `specs/dev/`, `specs/test/`, or `specs/iterations/` exists, and no file in the repository links to one.
- No legacy uppercase item ID remains anywhere except `CHANGELOG.md`, whose released entries are unchanged byte-for-byte.
- Each of the 402 legacy items resolves through the rename map to exactly one live destination anchor, and each of the 51 legacy records keeps its status and checkbox state.
- Every package file carries the required sections in order and cites no peer behavior from its `Verification` section.
- Every item citation uses the outer-bracketed inline form, and the two `src/` comments that link into the legacy layout point at their packages.
- `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build` stay green, the code changes being comments and test names only.
- A human approves the decision record's two open questions and reviews the full diff before it merges.
