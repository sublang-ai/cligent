<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# release: Release Workflow

## Intent

This package lets a developer or agent cut a published release of this project from a git tag, with a changelog a reader can trust and provenance a consumer can verify.
It owns versioning, changelog form, the tag-triggered publish, and the gate every merge into `main` passes, not what any release contains.
It is project-local: the scoped distributable it publishes is `@sublang/cligent`, and the CI jobs it names are this repository's.

## External Behavior

### release-1

The project shall follow Semantic Versioning 2.0.0 [[1]] — stable `MAJOR.MINOR.PATCH` and candidate `MAJOR.MINOR.PATCH-rc.N`, where MAJOR indicates breaking changes, MINOR indicates new features, and PATCH indicates bug fixes.

### release-2

The version in `package.json` shall match the git tag without its `v` prefix.

### release-3

All notable changes shall be documented in `CHANGELOG.md` in the Keep a Changelog format [[2]].

### release-4

When preparing a stable release tag, the developer or agent shall:

1. review every commit since the last release that precedes the final release-preparation commit (`git log <last-tag>..<audited-head>`), initially recording the current `HEAD` as `<audited-head>`;
2. ensure all notable changes are documented in `[Unreleased]`;
3. add a new version section to `CHANGELOG.md` with the release date;
4. move the `[Unreleased]` items into that section;
5. update the comparison links at the bottom of the file;
6. review the staged final release-preparation changes and create that commit with `<audited-head>` as its sole parent; and
7. create the release tag only on that final release-preparation commit, repeating these steps where another commit must enter the release first.

### release-5

Changelog entries shall be grouped under these headings, in this order: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

### release-6

Stable releases shall be triggered by pushing a git tag matching the pattern `vMAJOR.MINOR.PATCH` (e.g., `v1.0.0`).

### release-7

When the stable release lane runs on GitHub, it shall:

1. verify the tag version matches the `package.json` version [[release-2](#release-2)];
2. require the CI run for the tagged commit — its `push` to `main` — to have concluded successfully, waiting while it is in progress and refusing to publish where it concluded unsuccessfully or never ran, as for a tag off `main`;
3. run the package's clean build [[package-10](package.md#package-10)] and validate the package;
4. run the default unit suite with full Git history and tags, refusing publication unless the tagged commit changes its matching preparation record and has exactly one parent, the audited head recorded there [[release-4](#release-4)], [[release-14](#release-14)];
5. extract release notes from `CHANGELOG.md`;
6. publish the scoped package to npm with `--access public` [[release-9](#release-9)], `--provenance` [[release-8](#release-8)], and OIDC trusted publishing without a static npm token [[release-13](#release-13)];
7. create a GitHub release carrying the extracted notes.

### release-8

When an npm package is published, the publish command shall carry the `--provenance` flag, generating a signed attestation that links the package to its source repository and build.

### release-13

When authenticating an npm publication, the release workflow shall use npm OIDC trusted publishing without a static npm token.

### release-9

Scoped packages such as `@sublang/cligent` shall be published with `--access public`, to ensure public availability.

### release-10

Before tagging a stable release, the developer or agent shall verify:

- [ ] all tests pass;
- [ ] `npm run smoke:release` passes locally — the single local release-smoke entry point, chaining the existing gates in order: `build` [[package-10](package.md#package-10)], `test:package`, `test:distributable`, `test:smoke`;
- [ ] `CHANGELOG.md` is updated with the new version and date;
- [ ] the chosen version is carried by `package.json` `version`, `package-lock.json` top-level `version`, and `package-lock.json` `packages[""].version`;
- [ ] all changes are committed and pushed to `main`.

### release-14

Before creating the final stable release-preparation commit, the developer or agent shall add `docs/releases/<version>-preparation.md` as a durable evidence record with the following contents [DR-020](../decisions/020-audited-release-preparation.md):

| Evidence                                                | Required contents                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commit-range review                                     | previous tag; audited head as the containing final release-preparation commit's intended sole parent; commit count; subject-class counts derived from the text before each subject's first `(` or `:` and ordered lexicographically by class; ordered-log digest; review command; and attestation that every commit was considered |
| containing preparation review                           | attestation that the staged contents and planned message of the symbolic `containing release-preparation commit` were considered and that this commit is the intended release-tag target [[release-4](#release-4)]                                                                                                                 |
| release identity and Semantic Versioning classification | previous version, chosen version, release date, change level, and rationale tied to the reviewed changes [[release-1](#release-1)]                                                                                                                                                                                                 |
| notable-change reconciliation                           | each notable change group, its changelog heading, and the commits that establish it, with every audited commit and the containing preparation changes either tied to a group or explicitly classified as non-notable with rationale [[release-3](#release-3)], [[release-5](#release-5)]                                           |
| pre-tag checklist                                       | the result of every [[release-10](#release-10)] line, with work intentionally deferred until after the preparation commit still marked pending                                                                                                                                                                                     |

### release-16

When a pull request into `main` is ready, the maintainer shall ask GitHub to merge it on green, and the repository shall merge it with a merge commit once every job of the CI workflow's pull-request run has passed on the pull request's head, requiring no job to re-run for a later move of `main` ([DR-039](../decisions/039-merge-on-green.md)):

- `main` is a protected branch whose required status checks are exactly the jobs a pull request's run holds [[release-19](#release-19)], with the branch not required to be up to date;
- a conflicting pull request merges only once its branch merges `main` and its checks pass again on that head.

### release-17

While a pull request targets a branch, the maintainer shall keep that branch ([DR-039](../decisions/039-merge-on-green.md)).

### release-18

When a push reaches a pull request's branch, the CI workflow shall cancel the run of the head that push supersedes and run the new head once, cancelling no run of a push to `main` or of its nightly schedule ([DR-039](../decisions/039-merge-on-green.md)).

### release-19

The CI workflow shall run the jobs the event starting it selects ([DR-039](../decisions/039-merge-on-green.md)):

| Event | Jobs |
| --- | --- |
| pull request into `main` | `ci` on Linux for each of its Node versions, `distributable` on Linux, and `browser` on Linux, Windows and macOS, `browser (macos-latest)` being its one macOS job |
| push to `main`, nightly schedule | every job of a pull request's run, and `acceptance` |

### release-20

When the developer or agent is about to push, they shall run `npm run prepush`, which refuses a tree holding a conflict marker and then runs the spec lint and the type check, pushing only once it passes ([DR-039](../decisions/039-merge-on-green.md)).

### release-21

A test suite shall be deterministic by construction ([DR-039](../decisions/039-merge-on-green.md)):

- an order it reads from Git or from a directory listing is sorted on both sides of the comparison, or read from the source whose order its subject promises;
- a step is bounded by the event the behavior names, never by wall-clock time;
- a tool's calls are asserted by where they went, never by their exact count;
- a scripted fault outlasts every call that may consume it before the call under test.

### release-23

When a same-repository branch candidate is published for pre-merge delivery acceptance, the publisher shall use a distinct candidate lane under [DR-049](../decisions/049-included-agent-sdks.md):

- a unique SemVer `MAJOR.MINOR.PATCH-rc.N` package version, a matching immutable candidate source/tag identity, passing checks for that exact branch/PR head under the candidate rule below, and no requirement that the candidate already be merged into `main`;
- an explicit non-`latest` npm dist-tag, provenance, public scoped-package access and the existing trusted OIDC publication authority, with no stable-tag publication or stable GitHub release as a side effect;
- ordinary build, package and credential-free gates retained, with production audit strict and only the explicitly recorded development exception admitted by [[package-38](package.md#package-38)];
- the latest exact-head ordinary CI must complete with its four Node jobs and three browser jobs successful, and the latest exact-head `candidate.yml` workflow must pass its full distributable validation; the ordinary distributable job is replaced only for candidate readiness by that complete candidate validation, while skipped acceptance on a PR is expected;
- stable-only `main`, full clean-audit and final stable preparation-record requirements remain confined to stable publication and merge readiness, with no candidate validation authorizing a merge of red ordinary CI;
- coordinated candidate dependencies naming the exact intended Cligent/Playbook candidate versions where needed, recorded separately from stable caret-range policy, with no checkout path, workspace link or manual SDK installation in the registry consumer;
- a durable record of source head, PR, version, dependency candidate set, tarball integrity and actual registry installation results; source or packaged-code changes require a new candidate and affected verification;
- formal stable publication remains a later, separately gated operation, and acceptance does not require moving `latest` before merge.

## Verification

### release-11

When the release workflow is audited, the audit shall assert what starts the workflow and the gates it runs before publishing:

- only a pushed git tag starts the workflow, with stable `vMAJOR.MINOR.PATCH` tags following the stable lane [[release-6](#release-6)] and rc tags following the candidate lane [[release-23](#release-23)];
- the run compares the tag against the `package.json` version and stops before publishing where the two disagree [[release-7](#release-7)], leaving only a matching pair publishable [[release-2](#release-2)];
- the run's default unit suite executes after package validation and before release-note extraction or publishing [[release-7](#release-7)];
- the stable lane awaits successful whole ordinary CI for the tagged commit [[release-7](#release-7)], while candidate publication requires the exact-head ordinary jobs and complete candidate validation under [[release-23](#release-23)];
- the package is built and its publishable surface is validated before publication [[release-7](#release-7)];
- release notes are extracted from the matching version section in `CHANGELOG.md` before publication [[release-7](#release-7)];
- the publish step carries `--provenance` [[release-8](#release-8)];
- the job grants `id-token: write`, and no static npm token appears in the workflow [[release-13](#release-13)];
- the publish step carries `--access public` [[release-9](#release-9)];
- the GitHub release is created from the extracted notes after publication [[release-7](#release-7)].

### release-12

When `npm run smoke:release` runs, the verification shall assert that this one entry point runs `build`, `test:package`, `test:distributable`, and `test:smoke`, in that order [[release-10](#release-10)].

### release-15

When a release-preparation record is audited, the system check shall assert the following evidence against the real repository [[release-14](#release-14)]:

- the recorded previous tag, audited head, commit count, subject-class counts, ordered-log digest, and review command agree with the real Git range, and the record carries the complete-review attestation [[release-14](#release-14)], [[release-4](#release-4)];
- the record carries the complete containing-preparation review attestation; reconciliation commit citations belong to the audited range, while each aggregate `all <count> <class> commits in the audited digest` citation names a recorded subject class and agrees with its count; the reconciliation represents the containing preparation changes; and the repository state satisfies one case [[release-14](#release-14)], [[release-4](#release-4)]:
  - with a matching tag reachable from current `HEAD`, that tag changes the evidence record and has exactly one parent, the audited head [[release-7](#release-7)], while later descendants are permitted;
  - with no matching tag, the audited head is an ancestor of current `HEAD`, and any pending working-tree change to the evidence record additionally requires the audited head to equal current `HEAD`; or
  - every other state fails the audit;
- the `ci` job in `.github/workflows/ci.yml` and the `release` job in `.github/workflows/release.yml`, each of which executes the default unit suite containing this audit, are the complete set of jobs invoking `npm test` and check out full Git history and tags before that suite runs [[release-7](#release-7)], so the previous tag and audited head are available, while an otherwise valid checkout lacking the recorded history fails the audit [[release-4](#release-4)];
- the recorded previous tag and previous version agree, the recorded change level produces the chosen version, and the recorded release date identifies its changelog section [[release-1](#release-1)], [[release-4](#release-4)];
- `CHANGELOG.md` has the chosen version and date, ordered headings, reconciled notable entries, and correct comparison links; `[Unreleased]` is empty in the pending final-preparation changes, committed final-preparation tree, and matching release-tag tree, while ordered later-release entries in a working tree based on the committed preparation or tag, or in a later descendant, do not invalidate the prepared record [[release-3](#release-3)], [[release-4](#release-4)], [[release-5](#release-5)];
- `package.json` `version`, `package-lock.json` top-level `version`, and `package-lock.json` `packages[""].version` carry the chosen version, and the untagged record distinguishes completed checks from those deferred until its commit exists, and the tagged record marks both unit and local release-smoke checks passed [[release-10](#release-10)].

### release-22

When the repository audit reads the CI workflow and the pre-push script, it shall assert:

- the workflow's concurrency groups a pull request's runs by its number and cancels the run in progress for a pull request, and not for a push to `main` or a scheduled run [[release-18](#release-18)];
- a nightly schedule starts the workflow, and the jobs it runs narrow for a pull request to its one macOS job beside Linux and Windows and are whole for a push to `main` and for the schedule [[release-19](#release-19)];
- the required checks the merge rule names are exactly the jobs a pull request's run holds [[release-16](#release-16)], [[release-19](#release-19)];
- `npm run prepush` refuses a tree holding a conflict marker, naming the file that holds it [[release-20](#release-20)].

### release-24

When candidate publication and exact-version clean-prefix installation are exercised through the actual configured publisher, the system suite shall verify source/PR identity, candidate version and tag, trusted publication, intended transitive candidate acquisition, retained stable-lane restrictions and no mutation of `latest`, retaining failed and skipped publication evidence rather than claiming an unperformed install [[release-23](#release-23)].

### release-25

When the candidate publisher evaluates real workflow runs and their jobs, the release integration suite shall assert the latest matching exact-head candidate validation and all seven required ordinary Node/browser jobs must pass, rejecting stale heads, fork or unrelated PRs, incomplete or failed validation, missing/duplicate jobs, and any failure of the seven required ordinary jobs without relaxing the stable source guard [[release-23](#release-23)].

## References

[1]: https://semver.org/spec/v2.0.0.html "Semantic Versioning 2.0.0"
[2]: https://keepachangelog.com/en/1.1.0/ "Keep a Changelog 1.1.0"
