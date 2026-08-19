<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-051: Legacy Spec Generation Migration

## Status

In progress.
Tasks 1 through 4 and task 6 are done; task 5 and tasks 7 through 21 remain.
The per-item map now in [DR-017](../decisions/017-spec-generation-migration.md) leaves two released framework IDs without a carrier, `META-15` and `META-26`, so task 5 puts both to the owner, task 16 waits on the one it must retarget, and completion waits on both.
Task 6 ran ahead of that open question, its destinations fixed by [DR-017](../decisions/017-spec-generation-migration.md) whichever way the answer falls, but the law a restored carrier writes would still govern the items it produced, so task 5 re-checks them.
Task 6 also found the parser conflict that task 20 now carries, and completion waits on that too.
The three approval questions in [DR-017](../decisions/017-spec-generation-migration.md) are answered, so task 2's respelling stands and the tasks below may move the released IDs their work collides on.

## Intent

Migrate the whole specs tree from the legacy generation — `user/` + `dev/` + `test/` item files, `iterations/` records, uppercase `<PACK>-<N>` IDs, and `Verifies:` metadata lines — to the current generation that `spex scaffold --update` reinstated in [`meta.md`](../meta.md) and [DR-000](../decisions/000-spec-structure-format.md).
Measured when this plan was written, the tree held 402 items across 18 legacy item files and 51 legacy records, and `spex lint` reported 1110 errors and 105 warnings against the current law, so the work is decomposed below rather than attempted at once.
Later tasks shrink those counts; they are this plan's baseline, not a live measurement.
Every stated behavior, local extension, record state, and item concern in the project's own spec body survives the move; nothing is invented or dropped.
The framework law is not part of that body — the refresh replaced it wholesale — so the map records which of its released items reached no successor rather than hiding the loss.

Seven invariants govern every task:

- Each commit leaves every citation resolving: the inbound citations across `specs/` and the item IDs quoted in `src/`, `scripts/`, and `.github/workflows/` are retargeted in the same commit that moves their package.
- Each task's citation figure counts inbound citations from other files, a package's own internal citations moving with it.
- A destination package lands complete in one commit — `Intent`, `External Behavior`, optional `Internal Behavior`, `Verification`, in that order [[meta-30](../meta.md#meta-30)] — because a package without `Verification` is unlawful and cannot be staged across commits.
- A legacy test file survives until its last item reaches a lawful home: a test item's behavior citations stay inside its own package [[meta-20](../meta.md#meta-20)], so a clause verifying a peer's behavior waits for that peer's task.
- A task that changes where a released concern lives — splitting an item [[meta-29](../meta.md#meta-29)], dropping a restatement another package already owns [[meta-34](../meta.md#meta-34)], or moving a clause — records the added, removed, or retargeted row in the same commit, so the map never lags the tree.
- A released item found false of the artifact it describes moves unchanged, because a move settles where a requirement lives and never what it says; its contradiction becomes a task of its own ahead of the handover, closed by conforming the artifact to the item or by a decision record [[meta-24](../meta.md#meta-24)] carrying the decision that amends the item, and this plan stays incomplete until every such task closes.
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
- [ ] The per-item rename map built into the decision record in task 4 and reconciled in task 21, every classification and split judgment, and every open question reach a human diff review.

## Tasks
1. **Record the migration contract.**
   Add `specs/decisions/017-spec-generation-migration.md` as `Proposed`, fixing the destination package set, the `+100` and `+200` ID blocks and the dropped zero padding, the dissolution of the cross-adapter test file into per-package verification, `tmux-play` remaining one package, and the exemption of released changelog history from the rename.
   Record the three owner-approval questions it turns on — respelling the item IDs that public releases carried, duplicating a shared adapter criterion into each adapter package rather than introducing a shared adapter-contract package, and renumbering the IDs where a merge or relocation collides [[meta-12](../meta.md#meta-12)] — the second scoping the third.
   No file moves in this task.

2. **Fold `git` and `licensing` onto their scaffold seeds.**
   Reconcile `dev/git.md` into `packages/git.md` and `dev/licensing.md` plus `test/licensing.md` into `packages/licensing.md`, keeping every project-local exclusion, example, and trailer rule the seeds do not already state.
   Reconcile the duplicated SPDX-header record at `iterations/000-spdx-headers.md` into `intents/000-spdx-headers.md` with this project's true checkbox state, then delete the legacy trio and the duplicate record and retarget their 8 inbound citations.

3. **Settle the approval gates.**
   Put the three questions of [DR-017](../decisions/017-spec-generation-migration.md) to the owner before any further item moves, taking the shape question before the renumbering one it scopes, and record each answer.
   Since the answers let the migration go on, amend the released-ID clause of [`meta.md`](../meta.md) as the renumbering answer requires, rewrite that record's Decision and Consequences and the index summary to the shape chosen, and set it to `Accepted` once its text states that combination.

4. **Build the complete rename map.**
   Enumerate every one of the 402 baseline items with the destination the settled gates give it, one row per branch where a clause splits, and add the 24 released `META-<N>` items with whatever now carries each concern — an item, a decision record, or several between them — or an explicit no-successor row, checking each against the current law and the decision records rather than taking the scaffold's list as final.
   A row that finds no carrier is a loss of released law rather than a resolved mapping, so it closes only as [DR-017](../decisions/017-spec-generation-migration.md) allows: a carrier restored, which the row then points at, or the owner's approved amendment, which the row records as the retirement it admits.
   Record it in [DR-017](../decisions/017-spec-generation-migration.md), extending the family table there to per-item resolution, because the map outlives this plan as the only bridge from a released ID to where its concern went [[meta-28](../meta.md#meta-28)].
   The migration's own terms require the map before content moves, and the settled gates are what make it decidable.

5. **Resolve the two losses the map found.**
   Put `META-15`'s minimizing of project references and `META-26`'s observable-outcome drafting rule to the owner, each closing as [DR-017](../decisions/017-spec-generation-migration.md) requires: a carrier restored, or an approved amendment admitting the retirement.
   Restoring either writes law that every task below must then satisfy.
   Where a carrier is restored, re-check every package already migrated — `git`, `licensing`, `ndjson`, `release` — against it and redraft what it fails, in the commit that records the outcome.
   Carry each outcome into every place that states the loss: the map's framework table, that record's finding and its consequence, this plan's status, and the index summary.
   Leave this plan incomplete for as long as a row stays open.

6. **Migrate `ndjson` and `release`.**
   Create `packages/ndjson.md` and `packages/release.md`, moving the parser's verification out of `test/adapters.md` and deleting `user/ndjson.md` and `dev/release.md`.
   The release behaviors carry no legacy verification at all, so add verification items only where a real check exists today and leave the residual coverage gap [[meta-33](../meta.md#meta-33)] to task 19 instead of inventing tests here.
   Retarget the 5 inbound citations the parser package carries.

7. **Migrate `package`.**
   Merge `dev/package.md` and `test/package.md` into `packages/package.md` under the `+100` block, take the conformance-target clause of `test/adapters.md` under the `+200` block, and retarget its 28 inbound citations and the 16 ID references in `scripts/` and `src/`.
   Leave the clauses that verify Codex and tmux-play behavior in `test/package.md` for tasks 9 and 14 to absorb.

8. **Migrate the Claude Code adapter package.**
   Merge `user/adapters/claude-code.md` with its slice of `test/adapters.md` into `packages/adapters/claude-code.md`, restating each item as one GEARS requirement and converting its `Verifies:` lines to inline citations at the verifying assertion.
   Strip the migrated claims from `test/adapters.md`, whose 14 criteria naming two or more adapters each fan out into every adapter they name, and retarget the 28 inbound citations and 7 code references.

9. **Migrate the Codex adapter package.**
   Merge `user/adapters/codex.md`, `dev/adapters/codex.md`, the Codex slice of `test/adapters.md`, and the Codex clauses parked in `test/package.md` into `packages/adapters/codex.md`, classifying the delivery and executable-resolution items as `Internal Behavior`.
   Retarget the 39 inbound citations and 7 code references.

10. **Migrate the Gemini adapter package.**
    Merge `user/adapters/gemini.md` with its slice of `test/adapters.md` into `packages/adapters/gemini.md`, and retarget the 33 inbound citations.

11. **Migrate the Kimi adapter package.**
    Merge `user/adapters/kimi.md` with its slice of `test/adapters.md` into `packages/adapters/kimi.md`, and retarget the 35 inbound citations and 13 code references.

12. **Migrate the OpenCode adapter package.**
    Merge `user/adapters/opencode.md`, the largest behavior file, with its slice of `test/adapters.md` into `packages/adapters/opencode.md`, and retarget the 69 inbound citations and 6 code references.

13. **Migrate `engine`.**
    Merge `user/engine.md` and `test/engine.md` under the `+100` block with the cross-adapter tests that verify engine behavior, move the clause that verifies the peer-SDK floor into `packages/package.md`, and delete `test/adapters.md` once its last item has moved.
    Retarget the 91 inbound citations and 55 code references.

14. **Port `tmux-play` structurally.**
    Merge `user/tmux-play.md` and `test/tmux-play.md` under the `+100` block into `packages/tmux-play.md` with the lawful section order, faithful item text, renamed IDs, and all 93 `Verifies:` lines converted to inline citations.
    Move the clauses verifying adapter and engine behavior into those packages, absorb the last clauses parked in `test/package.md`, delete both tmux-play files, the emptied `test/package.md`, and the three emptied legacy directories, and retarget the 472 spec citations and 458 code references.

15. **Bring the items into item law.**
    Split the multi-requirement items into one requirement each [[meta-29](../meta.md#meta-29)], classify presenter and launcher mechanics hidden from the package's users as `Internal Behavior` [[meta-30](../meta.md#meta-30)], and drop restatements another package already owns [[meta-34](../meta.md#meta-34)].
    Every package is in scope, not `tmux-play` alone, which merely carries the bulk: no other task applies item law, so `release-8` — mandating its provenance attestation and its OIDC authentication independently, either able to fail while the other holds — would otherwise reach the handover unlawful.
    Each split carries its verification with it: every branch takes the assertion reaching it and the citation naming it [[meta-20](../meta.md#meta-20)], [[meta-33](../meta.md#meta-33)].
    Where the legacy verification never reached a branch — `TMUX-061`'s create-no-config case, which `TTMUX-061` omits and no test covers — this task still writes the assertion and hands the check it needs to task 19.
    This task moves no file, so it can be reviewed as pure item law.

16. **Move the records.**
    Move the 50 records left in `specs/iterations/` to `specs/intents/`, task 2 having retired the duplicate, rename `Goal` to `Intent` and both `Acceptance criteria` and `Acceptance` to `Verification`, supply the `Status` the two remaining records without one are missing, and order the sections per [[meta-5](../meta.md#meta-5)].
    Convert the 54 decision-record citations to the plain relative-link form [[meta-16](../meta.md#meta-16)], and retarget the seven legacy `META-*` citations on what the task-4 map settled for each concern.
    A concern with a carrier takes a citation pointing at it, while a concern whose retirement the owner approved keeps its still-true prose and loses the link, a claim the current law no longer makes being rewritten or removed — the `META-20` sentence about `Verifies:` lines among them.
    This task waits on that map rather than leaving a citation unresolved, one of the seven pointing at a `meta.md` anchor that is already gone.

17. **Empty the records of design.**
    Move the design content the legacy records hold — their `Mechanism notes`, `Design decision`, and `Open questions` sections — into the decision records that own it, so deleting an intent record loses nothing [[meta-28](../meta.md#meta-28)].
    Remove every mention of an intent record from the other specs — the index, the one decision record that names one, and the intent records that cite each other [[meta-18](../meta.md#meta-18)].
    While the decision records are open, convert the two that carry `[^n]` footnotes to the numbered external-reference markers the current law requires [[meta-19](../meta.md#meta-19)].

18. **Rewrite the index and the guidance.**
    Rebuild `specs/map.md` in the current shape — layout block, decisions table, packages table — with no intent-record index [[meta-18](../meta.md#meta-18)], and refresh whatever repo guidance still describes the legacy layout.

19. **Close or record the verification gaps.**
    Give every behavior of `licensing`, `release`, and `git` an integration or system check [[meta-21](../meta.md#meta-21)] that prefers real behavior to a substitute [[meta-32](../meta.md#meta-32)], implementing the audits these three state and nothing runs, and writing the verification items they still lack [[meta-33](../meta.md#meta-33)]:

    | Package     | Audit stated but unrun                                                                               | Behavior no assertion reaches                                                                                                                                                                                                                           |
    | ----------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `licensing` | `licensing-3`, `licensing-4`, and `licensing-6`, no script, workflow, or hook reading an SPDX header | `licensing-7` and `licensing-8`, which reach `licensing-3` and `licensing-4` as preconditions only                                                                                                                                                      |
    | `release`   | `release-11`'s workflow audit and `release-12`'s smoke composition                                   | `release-1`, `release-3`, `release-4`, and `release-5`, which no item cites; `release-7`'s build, notes-extraction, and GitHub-release steps, which `release-11` cites without asserting; and every `release-10` checklist line outside `smoke:release` |
    | `git`       | `git-6`, nothing auditing a commit message                                                           | both halves of `git-1`, its reporting duty and its refusal to commit until both values are configured, `git-6` reading a commit already made                                                                                                            |

    A citation is not coverage: where a verification item asserts less than the behavior it cites states, strengthen it, or add the item its own statement cannot reach, until every case that behavior states is asserted [[meta-33](../meta.md#meta-33)], each assertion citing every behavior it reaches [[meta-20](../meta.md#meta-20)].
    `git-6`'s trailer bullet shows the shape: it takes `git-4`'s `Co-authored-by` without its `<model> (<role>) <email>` schema, its role set, or its address, so a check written to it would accept the address this project forbids.
    Reconciling every behavior against the items citing it is this task's output rather than this plan's, so the clause-by-clause list lands in the strengthened items instead of here.
    The branches task 15 splits arrive here too, each carrying the assertion it wrote and no check behind it.

    Where a behavior admits no check at all, `git-3`'s bullets-if-clearer clause the candidate, a decision record [[meta-24](../meta.md#meta-24)] amends it into a checkable form with its concern preserved [[meta-12](../meta.md#meta-12)], the package then verifying everything it states.
    Where a gap is neither closed nor so amended, this plan does not complete: record it as blocking, name the behavior left unverified, and leave the deliverable open, a package that states a behavior it never verifies being unlawful [[meta-33](../meta.md#meta-33)].

20. **Settle the parser's unterminated-tail conflict.**
    `ndjson-2` carries `NDJSON-002`'s rule that a result follows only a complete newline-delimited line, while `parseNDJSON()` has read an unterminated final line since it was written, a passing test pins that flush, and the Gemini adapter is its only consumer.
    Put the contradiction to the owner, who either conforms the parser and its test to the rule, the package's `External Behavior` then standing as written, or writes the decision record adopting the flush, which amends `ndjson-2` to stop excluding the end of the stream, gains the package an item for the tail, and gains the map its row.
    Either branch ends the silence this question bought: `ndjson-207` gains the assertion of what a stream ending without a newline yields, and the trigger that carries it.
    Task 6 found this and left it open rather than settling a behavior question inside a move.
    Leave this plan incomplete until it closes.

21. **Verify and hand over.**
    Drive `spex lint` to zero errors and zero warnings, reconcile the task-4 rename map against the tree, run typecheck, lint, unit tests, and build, and hand that map, the classifications, the split judgments, the open questions, and any coverage left open to human diff review.

## Verification

- `spex lint` reports no error and no warning.
- No path under `specs/user/`, `specs/dev/`, `specs/test/`, or `specs/iterations/` exists, and no file in the repository links to one.
- No legacy uppercase item ID remains anywhere except in `CHANGELOG.md`, whose released entries are unchanged byte-for-byte, and in the migration's own two records, which name those IDs to bridge them — the decision record through its rename map, this plan through the retargeting its tasks describe.
- Each of the 402 items in that baseline resolves through the rename map to at least one live destination anchor, a split clause resolving to one per branch so that no branch is dropped to make the count come out.
- Each of the 24 released `META-<N>` items resolves through that map to every current carrier of its concern, item or decision record and a restored one among them, or to a no-successor row that only the owner's amendment admits, an unsettled loss leaving this plan incomplete.
- Each of the 51 baseline records keeps its status and checkbox state, except where a legacy checkbox was factually wrong and the record states why it was corrected.
- Every package file carries the required sections in order and cites no peer behavior from its `Verification` section.
- Every package's `Verification` covers every behavior in that package [[meta-33](../meta.md#meta-33)], which `spex lint` does not check; any gap that stays open leaves this plan incomplete.
- Every item citation uses the outer-bracketed inline form, and the two `src/` comments that link into the legacy layout point at their packages.
- `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build` stay green, as does every check task 19 adds or cites, including the smoke and acceptance suites `npm run test` excludes.
- A human settles each of the decision record's three approval gates, every loss its map has recorded, `META-15` and `META-26` among them, and every contradiction a move recorded between an item and the artifact it describes, then reviews the full diff before it merges.
