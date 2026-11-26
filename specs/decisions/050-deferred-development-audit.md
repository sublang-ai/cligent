<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-050: Current-Release Development Audit Deferral

## Status

Accepted (2026-11-18).
Amends [DR-043](043-audited-development-matchers.md).

## Context

GHSA-fc5q-39xc-vjpf has no simple published repair; removing the affected development matcher requires tool replacement or patch maintenance.
The user explicitly directed on 2026-11-18: skip this vulnerability for testing and formal publication, and repair it in the next version.
The actual advisory and failing audit must remain visible rather than being represented as remediated.

## Decision

- The only deferred advisory is GHSA-fc5q-39xc-vjpf through the locked development-only picomatch 4.0.4 graph.
- The deferral applies to Cligent 0.40.0 and its rc prereleases, covering tests, candidates, formal publication and merge readiness for this delivery.
- Any later version, including 0.40.1-rc.N or 0.41.0-rc.N, automatically rejects the finding until repaired; no indefinite or global audit-disable switch is introduced.
- Production and installed-production audits, other advisories, unusable reports and runtime-exposed nodes remain strict failures.
- Keep raw audit stdout/stderr/status and an explicit deferred-risk decision with package version and lock digest; the underlying full audit still reports the vulnerability.
- Use the ordinary complete CI and existing candidate/stable release source gates; a separate candidate-only workflow is unnecessary.
- This amends [DR-043](043-audited-development-matchers.md)'s full-development audit scope for the current release family.
- Track remediation in the next-version backlog, without claiming a repair or scheduling unsupported upstream work.

## Consequences

The known development-tool advisory no longer blocks this release's installation acceptance or formal publication.
All other existing build, functional, publication, source-identity, provenance and merge checks still apply.
Next-version readiness will fail unless the dependency graph is repaired or the user explicitly revises the policy.

## References

- [Official advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
