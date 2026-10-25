<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-057: Bounded Browser Empty-Image Recovery

## Status

Implemented, verified locally and independently reviewed; integration and release preparation pending.

## Intent

Make the existing point-in-time browser proof tolerate one specifically identified empty-image capture failure without relaxing readiness or its deadline.
The packaged-host observation establishes that capture failed, without establishing a timing or compositor cause.
Resolve the dependency audit prerequisite for integration without waiving it.

## Deliverables

- [x] Specify the narrow recovery and bounded pre-disposal diagnostics in [[mcp-11](../packages/mcp.md#mcp-11)].
- [x] Implement and verify the controlled subprocess cases in [[mcp-14](../packages/mcp.md#mcp-14)].
- [x] Restore clean dependency audits under [[package-13](../packages/package.md#package-13)] with the remediation safeguards in [[package-28](../packages/package.md#package-28)].

## Tasks

1. [x] Add one same-page recapture, preserve the original budget and cleanup, and verify success, refusal and interruption cases.
2. [x] Remediate the direct Zod pin and compatible locked development dependencies flagged by integration without broad dependency updates.

## Verification

- Focused browser preparation subprocess checks pass 32/32, covering oversized capture diagnostics, recovery, refusal, disposal rejection, deadline and cancellation.
- The native browser/MCP loopback navigation and PNG acceptance case passes 1/1; targeted ESLint and the required pre-push spec lint/typecheck gate pass.
- The initial focused run passed 30/31: its overall-timeout assertion expected proof-stage wording rather than the existing typed overall timeout; the corrected assertion preserves that behavior and the initial failure log.
- Review follow-up retains primary diagnostics before disposal and triggers the accelerated parent proof deadline only after the additional capture is waiting.
- PR 87 at `65ff01cf` failed the distributable dependency audit (run `40231017759`, job `121283035414`): Zod 4.4.3 was affected by GHSA-mrhx-c7xc-m3w5; the failure is retained rather than waived.
- The direct Zod 4.6.6 graph passed the production audit, clean-build/tarball verification and 35 ACP schema/runtime checks; its full audit exposed unchanged body-parser 2.3.0 and fast-uri 3.1.8 development entries, and that failure is retained.
- The direct pin moves to patched Zod 4.6.6; compatible locked development updates select body-parser 2.4.0 and fast-uri 3.1.9, plus body-parser's required content-type 2.1.0, iconv-lite 0.7.3 and qs 6.16.1 minima, without SDK pin, Node-floor or override changes.
- The strict distributable runtime-dependency expectation also selects Zod 4.6.6; its exact manifest comparison remains unchanged.
- Final npm production and full dependency audits report zero known vulnerabilities.
- Isolated pnpm lock-only regeneration preserves SDK versions, engines, settings and the existing override, aligning the affected matcher, source-map, server, address and Vite/Vitest families with patched npm resolutions and matching integrity values.
- The pnpm full audit's initial 17 advisories are retained; separate final production/full pnpm audits report zero, and its frozen lockfile-only consistency check passes with scripts disabled on pnpm 10.34.9.
- Maintainer default-suite verification passed 2,306 cases and failed one read-only fixture case under umask 077; an explicit fixture chmod then passed all 53 affected-file tests without changing production permission behavior or the expectation, and the original full-run failure is retained.
- Full-run and focused-rerun receipts remain separate; release smoke is pending the versioned candidate.
- The packaged capture failure's cause remains unproven; integration and release remain pending.
