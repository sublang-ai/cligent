<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-032: Agent Runtime and Package Readiness

## Goal

Validate Cligent against exact release-candidate targets for all four coding
agents and remove package or acceptance defects that could ship stale or
unverified behavior.
Gemini CLI behavior, adapter-scoped effort behavior, and the SDK peer floors
required by provider effort transports are outside this iteration; this
iteration owns only their exact development and CI validation targets, plus
the independent readiness defects listed below.

## Status

In Progress

Exact runtime targets, native permission defaults, validation tooling, and
clean package output are complete; live acceptance and final distributable
verification remain open.

## Deliverables

- [x] Canonical package and acceptance items specify the readiness boundary.
- [x] Exact Claude Agent SDK, Codex SDK, and OpenCode SDK development
  dependencies plus Gemini and OpenCode CI CLI packages name the versions
  exercised by repository verification.
- [x] SDK declaration conformance plus exact installed-CLI version checks make
  every validation target observable.
- [x] OpenCode preserves its native permission defaults when no
  `PermissionPolicy` is supplied.
- [x] Node and TypeScript consumer floors match emitted runtime and declaration syntax.
- [x] Every build and package operation removes stale `dist` output first.
- [ ] Live auto-mode acceptance uses safe create/update probes and bounded
  retries only for explicit transient upstream failures.
- [ ] Packed-package and dependency-audit checks pass.

## Tasks

Each task is one commit and keeps build, typecheck, lint, unit, and smoke checks green at its boundary.

1. [x] **Specify runtime and package readiness.**
   Amend package, adapter, and acceptance items for exact conformance targets,
   native-default preservation, supported floors, clean builds, safe live
   probes, and packed-package verification.
2. [x] **Refresh exact agent conformance targets.**
   Pin exact Claude Agent SDK, Codex SDK, and OpenCode SDK development
   dependencies and exact Gemini and OpenCode CI CLI packages; assert resolved
   versions; compile adapter mirrors against installed SDK declarations; and
   verify the OpenCode managed-server help surface. Keep optional peer floors
   unchanged; the provider behavior that first requires a newer surface owns
   its corresponding floor change.
3. [x] **Preserve OpenCode native permissions.**
   Omit session permission rules for an absent policy while keeping independent
   tool-list restrictions and the distinct explicit-empty-policy behavior.
4. [x] **Update the supported validation toolchain.**
   Move test, lint, and affected transitive dependencies to patched releases
   that remain compatible with every configured CI Node line without raising
   the packaged runtime floor, then clear production and full-graph audit
   findings.
5. [x] **Harden build and package output.**
   Declare accurate Node and TypeScript floors, clean `dist` before builds and
   packing, make the repository-local development launcher use clean output,
   and verify stale artifacts cannot enter a tarball. External shell aliases or
   wrappers are outside the repository boundary.
6. [ ] **Harden live adapter acceptance.**
   Use non-destructive create/update probes and retry only explicit upstream
   overload or invalid-stream failures with a fatal bounded limit.
7. [ ] **Verify and document the distributable.**
   Run dependency audits, inspect and install the tarball in an isolated consumer, exercise public exports and the launcher, and record the completed readiness boundary.

## Acceptance criteria

- Exact installed SDK and CLI versions equal the versions asserted by the
  repository and CI; installed SDK declarations cover the consumed type
  surfaces, each exact CLI target reports its version, and the OpenCode target
  exposes the managed-server options used by the adapter.
- With no `PermissionPolicy`, OpenCode creates or resumes a session without a
  permission ruleset; independent tool-list restrictions still apply.
- The package builds twice from a clean output tree and contains no orphaned artifacts from deleted sources.
- A packed runtime consumer on Node 18.3.0 can import every documented entry
  point and run launcher help, and a TypeScript 5.4 consumer can compile the
  emitted declarations.
- All four live adapters complete safe unattended create/update probes when credentials and host sandbox support are available; a third explicit transient failure remains fatal.
- Production and full dependency audits report no known vulnerabilities.
