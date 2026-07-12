<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-034: Isolated Captain Control Calls

## Goal

Implement [DR-010](../decisions/010-isolated-captain-control-calls.md) so a Captain can request a fresh, tool-free control call with fail-closed adapter semantics.

## Status

Complete

## Deliverables

- [x] `callCaptain` exposes and forwards per-call resume selection and explicit allowlists.
- [x] Claude Code isolates its documented ambient control sources, and Claude Code, Gemini, and OpenCode enforce and report an explicit empty allowlist.
- [x] Codex rejects every explicit tool-list restriction before backend invocation.
- [x] Focused runtime and adapter tests pin omission, non-empty, and empty-list behavior.

## Tasks

Each task is one-commit size and keeps build, typecheck, lint, and unit checks green at its boundary.

1. [x] **Specify the isolation boundary.**
   Define the Captain call controls, explicit-empty semantics, adapter enforcement mappings, fail-closed behavior, and acceptance coverage.
2. [x] **Forward Captain controls.**
   Extend the public contract and pass present session and allowlist values through the runtime-owned Captain `Cligent`.
3. [x] **Enforce built-in adapter mappings.**
   Use Claude Code availability and documented settings/MCP isolation controls, preserve Gemini policy enforcement with accurate telemetry, map OpenCode empty allowlists to wildcard deny, and reject unsupported Codex restrictions.
4. [x] **Verify the boundary.**
   Add focused unit and integration tests and run the repository verification commands.

## Acceptance criteria

- `callCaptain(prompt, { resume: false, allowedTools: [] })` passes both controls to the Captain `Cligent.run()` call and retains normal records and visibility behavior.
- Omitting `resume` and `allowedTools` preserves the Captain's stored auto-resume behavior and adapter-native tool surface.
- Claude Code receives `tools: []`, `settingSources: []`, and `strictMcpConfig: true`; Gemini emits its catch-all deny policy and reports a known configured empty set; and OpenCode receives `{ "*": false }` on its supported prompt path.
- Codex rejects explicit `allowedTools` or `disallowedTools`, including empty arrays, before loading or invoking its SDK.
- Non-empty Claude Code, Gemini, and OpenCode restrictions preserve `disallowedTools` precedence.
- Build, typecheck, lint, and focused unit tests pass.
