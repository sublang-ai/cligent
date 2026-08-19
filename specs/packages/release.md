<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# release: Release Workflow

## Intent

This package lets a developer or agent cut a published release of this project from a git tag, with a changelog a reader can trust and provenance a consumer can verify.
It owns versioning, changelog form, and the tag-triggered publish, not what any release contains.
It is project-local.

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
3. build and validate the package;
4. extract release notes from `CHANGELOG.md`;
5. publish to npm with a provenance attestation;
6. create a GitHub release carrying the extracted notes.

### release-8

npm packages shall be published with the `--provenance` flag for supply chain security, generating a signed attestation that links the package to its source repository and build, and authentication shall use npm OIDC trusted publishing — static npm tokens shall not be used.

### release-9

Scoped packages such as `@sublang/cligent` shall be published with `--access public`, to ensure public availability.

### release-10

Before tagging a release, the developer or agent shall verify:

- [ ] all tests pass;
- [ ] `npm run smoke:release` passes locally — the single local release-smoke entry point, chaining the existing gates in order: `build`, `test:package`, `test:distributable`, `test:smoke`;
- [ ] `CHANGELOG.md` is updated with the new version and date;
- [ ] the `package.json` version is bumped;
- [ ] all changes are committed and pushed to `main`.

## Verification

### release-11

When the release workflow is audited, the audit shall assert the gates the workflow runs before it publishes:

- a pushed tag, and nothing else, starts the workflow [[release-6](#release-6)];
- the run compares the tag against the `package.json` version and stops before publishing where the two disagree [[release-7](#release-7)], leaving only a matching pair publishable [[release-2](#release-2)];
- the CI run for the tagged commit is awaited while in progress, and publishing is refused unless it concluded successfully [[release-7](#release-7)];
- the publish step carries `--provenance`, the job grants `id-token: write`, and no static npm token appears in the workflow [[release-8](#release-8)];
- the publish step carries `--access public` [[release-9](#release-9)].

### release-12

When `npm run smoke:release` runs, the verification shall assert that this one entry point runs `build`, `test:package`, `test:distributable`, and `test:smoke`, in that order [[release-10](#release-10)].

## References

[1]: https://semver.org/spec/v2.0.0.html "Semantic Versioning 2.0.0"
[2]: https://keepachangelog.com/en/1.1.0/ "Keep a Changelog 1.1.0"
