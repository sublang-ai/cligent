<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-056: Codex JSONL Separator Preservation

## Status

Implementation complete and reviewed locally; integration and release pending.

## Intent

Preserve valid JSONL strings containing raw Unicode line and paragraph separators before the SDK's line reader, without altering provider output semantics or private SDK internals.

## Deliverables

- [x] Specify and implement the POSIX transport and owned lifecycle in [[codex-79](../packages/adapters/codex.md#codex-79)] and [[codex-80](../packages/adapters/codex.md#codex-80)].
- [x] Exercise the installed SDK with recording subprocesses under [[codex-81](../packages/adapters/codex.md#codex-81)].
- [x] Complete repository and packaging validation, retaining the unchanged Windows limitation.
- [ ] Integrate and release the reviewed changes separately.

## Tasks

1. Specify the narrow transport, implement it in the existing wrapper and verify the real-SDK integration matrix.

## Verification

- The installed Codex SDK 0.159.0 recording-subprocess matrix passes 24/24 tests on Node 25.8.0, including raw/escaped separators, byte splits, exact wire data, drain/backpressure, real failures, cancellation, early return, startup retirement, native environment and helper PATH.
- Build, production/declaration typecheck, lint, license checks, spec lint and the focused existing SDK lifecycle/MCP checks pass.
- The ordinary `.test.ts` files run through Vitest; the production-project noEmit check does not typecheck them.
- The full repository suite passes all 2,196 tests across 79 files on Node 25.8.0 with exact isolated runtime targets and two workers.
- The first full run reported 2,040 passing and 156 failing tests: the scripted Kimi suites encountered the ambient CLI's unsupported 0.27.0 version, and one composite Codex lifecycle case exceeded its default five-second deadline.
- The passing full run retains the Kimi floor, readiness gate, Codex deadline and all test assertions unchanged.
- The initial release-smoke entry point passed build and package stages, then failed because Gemini was absent; corrected distributable verification passes, including tarball, consumer, audit, conformance, runtime-authority and global-onboarding checks.
- All four ordered release-smoke stages are verified through the resumed distributable step; the final 13 smoke tests pass in 29.93 seconds, while the initial failed entry point remains preserved as a failure.
- Local implementation and validation are complete; integration and release remain pending.
- Separator protection is POSIX-only; native Windows without a policy retains direct SDK execution and native Windows with a supplied policy retains its rejection.
