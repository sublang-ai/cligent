<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-043: Audited Development Matchers

## Status

Accepted (2026-11-02) for the authorized dependency-security repair of PR #88.
Defines the narrow repository-supported override exception in [[package-35](../packages/package.md#package-35)] without waiving the audit or runtime-floor safeguards.

## Context

The unchanged main dependency graph fails the full audit for GHSA-g3hv-75wg-m249 and GHSA-rmxm-3fg6-px4f.
Production audit remains clean; the affected server and matcher entries belong to the development graph.
Upstream ESLint and typescript-eslint still declare matcher ranges below the patched major.
Blindly overriding the ESLint 9 graph breaks the ESM default import in `@eslint/eslintrc`, even when the configured lint command succeeds.

## Decision

- Use ESLint 10's flat-config-only architecture, removing the incompatible legacy eslintrc chain; existing parser and Node plugin peers admit ESLint 10.
- Support exact `minimatch@11.0.3` substitutions only beneath ESLint, config-array and typescript-estree in npm and pnpm.
- Review both CJS and ESM consumers: ESLint and config-array use `Minimatch` construction and `match`; typescript-estree uses the named `minimatch` function, all retained in version 11.
- Verify the actual configured lint and parser behavior through integration checks, including negative selection and rejection cases; an audit result or version assertion alone does not establish compatibility.
- Upgrade the development MCP SDK's `@hono/node-server` resolution to patched 2.1.5 within its existing admitted range, and align the pre-existing pnpm override.
- Reuse the already locked compatible `qs@6.16.1` for pnpm's remaining development-only 6.16.0 resolution rather than retaining GHSA-6pq8-jhm2-2vcw or updating unrelated packages.
- Keep runtime dependencies, Agent SDK pins, consumer API, Node runtime floor and both zero-finding audit gates unchanged.
- Remove the matcher substitutions once upstream ranges admit the patched version; do not generalize this exception to unreviewed consumers.

## Consequences

Development linting requires Node `^20.19.0 || ^22.13.0 || >=24`, as declared by ESLint 10; the published library retains Node `>=18.3.0`.
These root development overrides are not a compatibility claim for arbitrary ESLint plugins, legacy configurations or other packages consuming minimatch.
The repository assumes maintenance of these three reviewed substitutions until upstream adopts the patched major.
The ordinary CI matrix and distributable verification still need to pass before merging; no release or tag is authorized by this repair.

## References

- [Matcher advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- [ESLint upstream adoption issue](https://github.com/eslint/eslint/issues/21463)
- [Server advisory](https://github.com/advisories/GHSA-rmxm-3fg6-px4f)
