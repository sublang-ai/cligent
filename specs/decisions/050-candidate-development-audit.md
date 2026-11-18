<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-050: Candidate Development Audit Exception

## Status

Accepted for branch-candidate installation acceptance by the user on 2026-11-18.
Amends DR-049's candidate publication gates and DR-043's audit scope only for the bounded exception below.

## Context

The user authorizes a separate candidate-test release when repairing the development dependency graph requires substantial tool replacement or maintaining an upstream patch.
GHSA-fc5q-39xc-vjpf has no published patched picomatch version at this decision.
The complete development audit must continue to report this finding; an installation test must not be represented as security clearance or merge approval.

## Decision

- Stable publication, ordinary CI, merge rules and the zero-finding production audit remain unchanged.
- A same-repository open-PR candidate may use a separate candidate validation workflow and the seven ordinary Node/browser jobs from the latest CI run for its exact head.
- Candidate validation re-executes all ordinary distributable checks rather than using the normal distributable result for candidate readiness, retaining the complete raw audit and explicitly recording a development-risk exception rather than a clean full audit.
- The only admitted finding is GHSA-fc5q-39xc-vjpf through the currently locked picomatch 4.0.4 development graph; every affected node must be development-only in the lockfile, with no additional advisory or audit error.
- The exception is available only through the explicit candidate audit option for an rc package; production and installed-production audits remain strict.
- The separate validation must pass before candidate publication; failed, missing, skipped, stale or unrelated Node/browser checks cannot be excused by this policy.
- Candidates use the non-latest test tag and provenance under the existing publisher; the exception grants neither formal stable readiness nor permission to merge a failed ordinary CI run.

## Consequences

Public installation acceptance can proceed while the unrelated development-tool remediation remains open.
The ordinary distributable job remains red until the complete development audit is clean, preserving the merge blocker.
Any different advisory, production exposure or matcher version needs a new reviewed decision rather than a generalized bypass.

## References

- [Official advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
