<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-051: Legacy Spec Generation Migration

## Status

In progress.
Tasks 1 and 2 are done; tasks 3 through 19 remain.
Task 3 settles the three approval gates in [DR-017](../decisions/017-spec-generation-migration.md), and every task after it waits on their outcomes — task 2 included, since the respelling gate ratifies or reverts it.

## Intent

Migrate the whole specs tree from the legacy generation — `user/` + `dev/` + `test/` item files, `iterations/` records, uppercase `<PACK>-<N>` IDs, and `Verifies:` metadata lines — to the current generation that `spex scaffold --update` reinstated in [`meta.md`](../meta.md) and [DR-000](../decisions/000-spec-structure-format.md).
Measured when this plan was written, the tree held 402 items across 18 legacy item files and 51 legacy records, and `spex lint` reported 1110 errors and 105 warnings against the current law, so the work is decomposed below rather than attempted at once.
Later tasks shrink those counts; they are this plan's baseline, not a live measurement.
Every stated behavior, local extension, record state, and item concern survives the move; nothing is invented or dropped.

Four invariants govern every task:

- Each commit leaves every citation resolving: the inbound citations across `specs/` and the item IDs quoted in `src/`, `scripts/`, and `.github/workflows/` are retargeted in the same commit that moves their package.
- Each task's citation figure counts inbound citations from other files, a package's own internal citations moving with it.
- A destination package lands complete in one commit — `Intent`, `External Behavior`, optional `Internal Behavior`, `Verification`, in that order [[meta-30](../meta.md#meta-30)] — because a package without `Verification` is unlawful and cannot be staged across commits.
- A legacy test file survives until its last item reaches a lawful home: a test item's behavior citations stay inside its own package [[meta-20](../meta.md#meta-20)], so a clause verifying a peer's behavior waits for that peer's task.
- Every citation the tree carries is rewritten as it moves: 1249 item citations still use the legacy unbracketed `[ID](path#anchor)` form rather than the outer-bracketed form the current law requires [[meta-16](../meta.md#meta-16)].

The destination packages, the `+100` and `+200` ID blocks, the dropped zero padding, and the scope boundary are recorded as the migration contract in [DR-017](../decisions/017-spec-generation-migration.md).

## Deliverables

- [x] A decision record fixes the destination package set, the ID scheme, the disposition of the cross-adapter test file, and what the migration leaves alone.
- [ ] `specs/packages/` holds one lawful package per subject, and `specs/user/`, `specs/dev/`, and `specs/test/` are gone.
- [ ] `specs/intents/` holds every intent record with its status and checkbox state intact, and `specs/iterations/` is gone.
- [ ] Every item states one GEARS requirement [[meta-29](../meta.md#meta-29)] under the current section order, with peer relationships and verification evidence carried only by inline citations [[meta-14](../meta.md#meta-14)], [[meta-16](../meta.md#meta-16)], [[meta-20](../meta.md#meta-20)], and no `Verifies:` line survives.
- [ ] `specs/map.md` indexes decisions and packages in the current shape and names no intent record [[meta-18](../meta.md#meta-18)].
- [ ] Comments, test names, and CI annotations quote current item IDs, while released `CHANGELOG.md` history stays byte-for-byte.
- [ ] `spex lint` reports no error and no warning.
- [ ] The per-item rename map built into the decision record in task 4 and reconciled in task 19, every classification and split judgment, and every open question reach a human diff review.

## Tasks
1. **Record the migration contract.**
   Add `specs/decisions/017-spec-generation-migration.md` as `Proposed`, fixing the destination package set, the `+100` and `+200` ID blocks and the dropped zero padding, the dissolution of the cross-adapter test file into per-package verification, `tmux-play` remaining one package, and the exemption of released changelog history from the rename.
   Record the three owner-approval questions it turns on — respelling the item IDs that public releases carried, duplicating a shared adapter criterion into each adapter package rather than introducing a shared adapter-contract package, and renumbering the IDs where a merge or relocation collides [[meta-12](../meta.md#meta-12)] — the second scoping the third.
   No file moves in this task.

2. **Fold `git` and `licensing` onto their scaffold seeds.**
   Reconcile `dev/git.md` into `packages/git.md` and `dev/licensing.md` plus `test/licensing.md` into `packages/licensing.md`, keeping every project-local exclusion, example, and trailer rule the seeds do not already state.
   Reconcile the duplicated SPDX-header record at `iterations/000-spdx-headers.md` into `intents/000-spdx-headers.md` with this project's true checkbox state, then delete the legacy trio and the duplicate record and retarget their 8 inbound citations.

3. **Settle the approval gates.**
   Put the three gates of [DR-017](../decisions/017-spec-generation-migration.md) to the owner before any further item moves, taking the verification-shape gate before the renumbering gate it scopes, and record each outcome on its own.
   Where respelling is granted, task 2 stands ratified; where it is withheld, revert task 2 and remove everything this migration introduced whenever it arrived — the refreshed law and its decision record, the agent guidance, the index changes, the two seeded packages, the seeded SPDX-header record, this plan, and the migration's own decision record — because any survivor would cite a law the rollback takes away.
   Where the shared-contract alternative wins the shape gate, rewrite the decision record's Decision and Consequences and the index summary to that outcome, then replan tasks 5 through 13 against the destinations it creates before the renumbering gate is asked, those destinations being what it is asked about.
   Where renumbering is granted, amend the released-ID clause of [`meta.md`](../meta.md), which may not be edited without human approval; where it is withheld, tasks 5 through 13 cannot proceed, each of them moving a released number.
   Set the decision record to `Accepted` only once its text states the combination the owner chose.

4. **Build the complete rename map.**
   Enumerate every one of the 402 baseline items with the destination the settled gates give it, one row per branch where a clause splits.
   Record it in [DR-017](../decisions/017-spec-generation-migration.md), extending the family table there to per-item resolution, because the map outlives this plan as the only bridge from a released ID to where its concern went [[meta-28](../meta.md#meta-28)].
   The migration's own terms require the map before content moves, and the settled gates are what make it decidable.

5. **Migrate `ndjson` and `release`.**
   Create `packages/ndjson.md` and `packages/release.md`, moving the parser's verification out of `test/adapters.md` and deleting `user/ndjson.md` and `dev/release.md`.
   The release behaviors carry no legacy verification at all, so add verification items only where a real check exists today and leave the residual coverage gap [[meta-33](../meta.md#meta-33)] to task 18 instead of inventing tests here.
   Retarget the 5 inbound citations the parser package carries.

6. **Migrate `package`.**
   Merge `dev/package.md` and `test/package.md` into `packages/package.md` under the `+100` block, take the conformance-target clause of `test/adapters.md` under the `+200` block, and retarget its 28 inbound citations and the 16 ID references in `scripts/` and `src/`.
   Leave the clauses that verify Codex and tmux-play behavior in `test/package.md` for tasks 8 and 13 to absorb.

7. **Migrate the Claude Code adapter package.**
   Merge `user/adapters/claude-code.md` with its slice of `test/adapters.md` into `packages/adapters/claude-code.md`, restating each item as one GEARS requirement and converting its `Verifies:` lines to inline citations at the verifying assertion.
   Strip the migrated claims from `test/adapters.md`, whose 14 criteria naming two or more adapters each fan out into every adapter they name, and retarget the 28 inbound citations and 7 code references.

8. **Migrate the Codex adapter package.**
   Merge `user/adapters/codex.md`, `dev/adapters/codex.md`, the Codex slice of `test/adapters.md`, and the Codex clauses parked in `test/package.md` into `packages/adapters/codex.md`, classifying the delivery and executable-resolution items as `Internal Behavior`.
   Retarget the 39 inbound citations and 7 code references.

9. **Migrate the Gemini adapter package.**
   Merge `user/adapters/gemini.md` with its slice of `test/adapters.md` into `packages/adapters/gemini.md`, and retarget the 33 inbound citations.

10. **Migrate the Kimi adapter package.**
    Merge `user/adapters/kimi.md` with its slice of `test/adapters.md` into `packages/adapters/kimi.md`, and retarget the 35 inbound citations and 13 code references.

11. **Migrate the OpenCode adapter package.**
    Merge `user/adapters/opencode.md`, the largest behavior file, with its slice of `test/adapters.md` into `packages/adapters/opencode.md`, and retarget the 69 inbound citations and 6 code references.

12. **Migrate `engine`.**
    Merge `user/engine.md` and `test/engine.md` under the `+100` block with the cross-adapter tests that verify engine behavior, move the clause that verifies the peer-SDK floor into `packages/package.md`, and delete `test/adapters.md` once its last item has moved.
    Retarget the 91 inbound citations and 55 code references.

13. **Port `tmux-play` structurally.**
    Merge `user/tmux-play.md` and `test/tmux-play.md` under the `+100` block into `packages/tmux-play.md` with the lawful section order, faithful item text, renamed IDs, and all 93 `Verifies:` lines converted to inline citations.
    Move the clauses verifying adapter and engine behavior into those packages, absorb the last clauses parked in `test/package.md`, delete both tmux-play files, the emptied `test/package.md`, and the three emptied legacy directories, and retarget the 472 spec citations and 458 code references.

14. **Bring the `tmux-play` items into item law.**
    Split the multi-requirement items into one requirement each [[meta-29](../meta.md#meta-29)], classify presenter and launcher mechanics hidden from the package's users as `Internal Behavior` [[meta-30](../meta.md#meta-30)], and drop restatements another package already owns [[meta-34](../meta.md#meta-34)].
    This task moves no file, so it can be reviewed as pure item law.

15. **Move the records.**
    Move the 50 records left in `specs/iterations/` to `specs/intents/`, task 2 having retired the duplicate, rename `Goal` to `Intent` and both `Acceptance criteria` and `Acceptance` to `Verification`, supply the `Status` the two remaining records without one are missing, and order the sections per [[meta-5](../meta.md#meta-5)].
    Convert the 54 decision-record citations to the plain relative-link form [[meta-16](../meta.md#meta-16)], and retarget the seven legacy `META-*` citations by concern: `META-11`, `META-12`, `META-19`, `META-21`, and `META-24` keep their number, the `META-20` claim about `Verifies:` lines is rewritten to the inline-citation law, and `META-26` has no successor so its sentence keeps its still-true prose and drops the link.

16. **Empty the records of design.**
    Move the design content the legacy records hold — their `Mechanism notes`, `Design decision`, and `Open questions` sections — into the decision records that own it, so deleting an intent record loses nothing [[meta-28](../meta.md#meta-28)].
    Remove every mention of an intent record from the other specs — the index, the one decision record that names one, and the intent records that cite each other [[meta-18](../meta.md#meta-18)].
    While the decision records are open, convert the two that carry `[^n]` footnotes to the numbered external-reference markers the current law requires [[meta-19](../meta.md#meta-19)].

17. **Rewrite the index and the guidance.**
    Rebuild `specs/map.md` in the current shape — layout block, decisions table, packages table — with no intent-record index [[meta-18](../meta.md#meta-18)], and refresh whatever repo guidance still describes the legacy layout.

18. **Close or record the inherited verification gaps.**
    Give an integration or system check that executes the real behavior [[meta-21](../meta.md#meta-21)], [[meta-32](../meta.md#meta-32)] to the three gaps this migration inherits rather than creates: the licensing scope and detector items, the release behaviors, and both halves of `git-1` — its reporting duty and its missing-identity branch — which the commit audit reaches neither of, reading a commit that already exists.
    Where a gap cannot be closed, this plan does not complete: record it as blocking, name the behavior left unverified, and leave the deliverable open, a package that states a behavior it never verifies being unlawful [[meta-33](../meta.md#meta-33)].

19. **Verify and hand over.**
    Drive `spex lint` to zero errors and zero warnings, reconcile the task-4 rename map against the tree, run typecheck, lint, unit tests, and build, and hand that map, the classifications, the split judgments, the open questions, and any coverage left open to human diff review.

## Verification

- `spex lint` reports no error and no warning.
- No path under `specs/user/`, `specs/dev/`, `specs/test/`, or `specs/iterations/` exists, and no file in the repository links to one.
- No legacy uppercase item ID remains anywhere except in `CHANGELOG.md`, whose released entries are unchanged byte-for-byte, and in the migration's own decision record, whose rename map bridges those IDs.
- Each of the 402 items in that baseline resolves through the rename map to at least one live destination anchor, a split clause resolving to one per branch so that no branch is dropped to make the count come out.
- Each of the 51 baseline records keeps its status and checkbox state, except where a legacy checkbox was factually wrong and the record states why it was corrected.
- Every package file carries the required sections in order and cites no peer behavior from its `Verification` section.
- Every package's `Verification` covers every behavior in that package [[meta-33](../meta.md#meta-33)], which `spex lint` does not check; any gap that stays open leaves this plan incomplete.
- Every item citation uses the outer-bracketed inline form, and the two `src/` comments that link into the legacy layout point at their packages.
- `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build` stay green, as does every check task 18 adds or cites, including the smoke and acceptance suites `npm run test` excludes.
- A human settles each of the decision record's three approval gates and reviews the full diff before it merges.
