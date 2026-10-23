<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-039: Merge on Green

## Status

Accepted (2026-10-23) on the owner's direction to make merging timely while several people land work on `main` at once.

## Context

Several branches now land on `main` in one day.
A pull request's checks run against the pull request merged with `main` as it stands, so a run goes stale the moment `main` moves, and a stale green run is no ground to merge once the branch turns conflicting or `main` brings a red test of its own.
Nothing keeps `main` green: a merge needs no check, so a red test on `main` turns every open pull request red, and the release workflow refuses to publish a commit whose `push` run on `main` did not pass.
Every push to a branch queues a full run beside the runs it superseded, and `browser (macos-latest)`, the only macOS job, waits on the slowest runner queue.
Deleting a base branch closes the pull requests stacked on it.
A suite that takes an order from Git or a directory listing, bounds a step by wall-clock time, counts a tool's calls exactly, or scripts a fault one call consumes before the call under test passes on one platform and fails on another, each such failure costing a full round to find.

## Decision

- `main` is protected: a merge into it requires every job of the CI workflow's pull-request run to have passed on the pull request's head, with no requirement that the branch be up to date with `main`, so a green run stands until the branch itself changes.
- A pull request merges by GitHub's auto-merge, with a merge commit, once its checks pass, the maintainer having asked for the merge when the pull request was ready, so no interval stands between green and merged for `main` to move in.
- The CI workflow runs one run per pull-request head: a push to the branch cancels the run of the head it supersedes, while a push to `main` and the nightly run cancel nothing.
- A pull request's run is `ci` on Linux for each Node version, `distributable` on Linux, and `browser` on Linux, Windows and macOS, `browser (macos-latest)` being its one macOS job; a push to `main` and a nightly run add `acceptance`, the suite against the live agent runtimes, so the full set runs on `main` within a day and a pull request needs no provider secret.
- A base branch is never deleted while a pull request still targets it: GitHub retargets its children only when the base merges, and deleting it closes them.
- Before a push, the developer or agent runs the pre-push check — no conflict marker left in the tree, the spec lint and the type check — so a push never carries what the first CI minutes would refuse, nor a spec item id another branch took.
- A suite is deterministic by construction: it takes no order from Git or a directory listing but sorts both sides or reads the order its subject promises, bounds no step by wall-clock time but by the event the behavior names, counts no tool's calls exactly but asserts where they went, and scripts a fault to outlast every call that may consume it before the call under test.

## Consequences

- A red test on `main` blocks every merge until `main` is fixed, which is what keeps `main` green and its commits publishable: a fix for `main` is a pull request like any other, and it merges once its own checks pass.
- `release` states the merge rule, the kept base branch, the run per head, the jobs per event, the pre-push check and the suites' determinism; its workflow audit asserts the cancellation rule, the jobs per event, that the required checks are the pull request's jobs and that the pre-push check refuses a conflict marker.
- Renaming a job or changing a matrix value renames a required check, so the audit's list and the branch protection move together.
- The nightly run spends one `acceptance` run's provider tokens each night, and finds a provider's drift within a day even when nothing lands.
- The repository's branch protection and auto-merge settings are the operator's to set; the record names them so a person can check them against the specs.
