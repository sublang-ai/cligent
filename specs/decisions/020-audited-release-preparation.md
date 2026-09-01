<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-020: Audited Release Preparation

## Status

Accepted

## Context

The release workflow requires a developer or agent to review every commit since the previous tag, classify the release under Semantic Versioning, reconcile every notable change into the changelog, and complete the pre-tag checklist.
Those duties require judgment: a mechanical artifact check can prove a range, version, or heading, but it cannot decide whether a change is notable or whether a summary is faithful.
Without durable evidence, a later reviewer can see the resulting version bump and changelog but cannot audit which range was reviewed, why that version was chosen, or which checklist work remains before tagging.

## Decision

- Every final release-preparation commit carries the evidence record required by [[release-14](../packages/release.md#release-14)] and is the intended release-tag target.
- The record fixes the reviewed range by previous tag and the containing final release-preparation commit's intended sole parent as audited head, plus commit count, subject-class counts, and an ordered-log digest; records the previous and chosen versions, release date, Semantic Versioning level, and rationale; reconciles every audited and containing change as notable or non-notable; and reports every pre-tag checklist outcome.
- The containing final release-preparation commit is reviewed symbolically from its staged contents and planned message so its own hash need not appear recursively in its evidence record.
- Any later commit chosen for the intended release invalidates the boundary and requires a new final release-preparation commit before tagging, while descendants not included by that tag remain ordinary development history.
- Untagged repository audits verify evidence ancestry without treating the checked-out commit as the tag target; the tag-triggered workflow enforces the exact sole-parent and evidence-change boundary before publication.
- A repository system check verifies the deterministic parts of that evidence against Git, `CHANGELOG.md`, `package.json`, `package-lock.json`, the release workflow, and the release-smoke command.
- The developer or agent remains responsible for the semantic review and attests in the record that every commit was considered; the check does not replace that judgment with commit-message heuristics.
- Work deliberately left for the post-preparation phase, including pushing the preparation commit and creating the tag, remains visibly pending rather than being inferred complete.

## Consequences

- A release reviewer can reproduce the exact commit-range inventory and distinguish verified facts from the preparer's semantic judgment.
- Manual release duties remain enforceable without pretending that a script can decide notability or release impact.
- A release-preparation commit may be reviewed and committed before its later push and tag, while the record still makes those remaining gates explicit.
- Review follow-ups may land before a release without freezing ordinary CI; where a follow-up must enter that release, it becomes the audited parent of a refreshed final release-preparation commit rather than silently falling outside the record.
- The prepared changelog remains auditable after the matching release tag while `[Unreleased]` accumulates entries for a later release.
- The tag-triggered workflow rejects a tag whose commit does not satisfy the recorded final-preparation boundary before publication; its other publication controls remain unchanged.
