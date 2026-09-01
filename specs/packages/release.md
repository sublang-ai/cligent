<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# release: Release Workflow

## Intent

This package lets a developer or agent cut a published release of this project from a git tag, with a changelog a reader can trust and provenance a consumer can verify.
It owns versioning, changelog form, and the tag-triggered publish, not what any release contains.
It is project-local: the scoped distributable it publishes is `@sublang/cligent`.

## External Behavior

### release-1

The project shall follow Semantic Versioning 2.0.0 [[1]] — `MAJOR.MINOR.PATCH`, where MAJOR indicates breaking changes, MINOR indicates new features, and PATCH indicates bug fixes.

### release-2

The version in `package.json` shall match the git tag without its `v` prefix.

### release-3

All notable changes shall be documented in `CHANGELOG.md` in the Keep a Changelog format [[2]].

### release-4

Before creating a release tag, the developer or agent shall:

1. review all commits since the last release (`git log <last-tag>..HEAD`);
2. ensure all notable changes are documented in `[Unreleased]`;
3. add a new version section to `CHANGELOG.md` with the release date;
4. move the `[Unreleased]` items into that section;
5. update the comparison links at the bottom of the file.

### release-5

Changelog entries shall be grouped under these headings, in this order: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

### release-6

Releases shall be triggered by pushing a git tag matching the pattern `vMAJOR.MINOR.PATCH` (e.g., `v1.0.0`).

### release-7

When the release workflow runs on GitHub, it shall:

1. verify the tag version matches the `package.json` version [[release-2](#release-2)];
2. require the CI run for the tagged commit — its `push` to `main` — to have concluded successfully, waiting while it is in progress and refusing to publish where it concluded unsuccessfully or never ran, as for a tag off `main`;
3. run the package's clean build [[package-10](package.md#package-10)] and validate the package;
4. extract release notes from `CHANGELOG.md`;
5. publish the scoped package to npm with `--access public` [[release-9](#release-9)], `--provenance` [[release-8](#release-8)], and OIDC trusted publishing without a static npm token [[release-13](#release-13)];
6. create a GitHub release carrying the extracted notes.

### release-8

When an npm package is published, the publish command shall carry the `--provenance` flag, generating a signed attestation that links the package to its source repository and build.

### release-13

When authenticating an npm publication, the release workflow shall use npm OIDC trusted publishing without a static npm token.

### release-9

Scoped packages such as `@sublang/cligent` shall be published with `--access public`, to ensure public availability.

### release-10

Before tagging a release, the developer or agent shall verify:

- [ ] all tests pass;
- [ ] `npm run smoke:release` passes locally — the single local release-smoke entry point, chaining the existing gates in order: `build` [[package-10](package.md#package-10)], `test:package`, `test:distributable`, `test:smoke`;
- [ ] `CHANGELOG.md` is updated with the new version and date;
- [ ] the chosen version is carried by `package.json` `version`, `package-lock.json` top-level `version`, and `package-lock.json` `packages[""].version`;
- [ ] all changes are committed and pushed to `main`.

### release-14

Before creating a release-preparation commit, the developer or agent shall add `docs/releases/<version>-preparation.md` as a durable evidence record with the following contents [DR-020](../decisions/020-audited-release-preparation.md):

| Evidence                                                | Required contents                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commit-range review                                     | previous tag, audited head, commit count, subject-class counts derived from the text before each subject's first `(` or `:` and ordered lexicographically by class, ordered-log digest, review command, and attestation that every commit was considered |
| release identity and Semantic Versioning classification | previous version, chosen version, release date, change level, and rationale tied to the reviewed changes [[release-1](#release-1)]                                                                                                                       |
| notable-change reconciliation                           | each notable change group, its changelog heading, and the commits that establish it [[release-3](#release-3)], [[release-5](#release-5)]                                                                                                                 |
| pre-tag checklist                                       | the result of every [[release-10](#release-10)] line, with work intentionally deferred until after the preparation commit still marked pending                                                                                                           |

## Verification

### release-11

When the release workflow is audited, the audit shall assert what starts the workflow and the gates it runs before publishing:

- only a pushed git tag starts the workflow, and a run whose tag is not `vMAJOR.MINOR.PATCH` stops before publishing [[release-6](#release-6)];
- the run compares the tag against the `package.json` version and stops before publishing where the two disagree [[release-7](#release-7)], leaving only a matching pair publishable [[release-2](#release-2)];
- the CI run for the tagged commit is awaited while in progress, and publishing is refused unless it concluded successfully [[release-7](#release-7)];
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
- the `ci` job in `.github/workflows/ci.yml` and the `release` job in `.github/workflows/release.yml`, each of which executes the default unit suite containing this audit, are the complete set of jobs invoking `npm test` and check out full Git history and tags before that suite runs so the previous tag and audited head are available, while an otherwise valid checkout lacking the recorded history fails the audit [[release-4](#release-4)];
- the recorded previous tag and previous version agree, the recorded change level produces the chosen version, and the recorded release date identifies its changelog section [[release-1](#release-1)], [[release-4](#release-4)];
- `CHANGELOG.md` has the chosen version and date, ordered headings, reconciled notable entries, and correct comparison links; `[Unreleased]` is empty in the prepared tree and matching release-tag tree, while later-release entries in a working tree based on that tag or in a descendant tree do not invalidate the prepared record [[release-3](#release-3)], [[release-4](#release-4)], [[release-5](#release-5)];
- `package.json` `version`, `package-lock.json` top-level `version`, and `package-lock.json` `packages[""].version` carry the chosen version, and the record truthfully distinguishes completed preparation checks from the push and tag work that remains [[release-10](#release-10)].

## References

[1]: https://semver.org/spec/v2.0.0.html "Semantic Versioning 2.0.0"
[2]: https://keepachangelog.com/en/1.1.0/ "Keep a Changelog 1.1.0"
