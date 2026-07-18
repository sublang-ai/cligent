<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-036: Kimi Code Adapter

## Goal

Implement [DR-011](../decisions/011-kimi-code-acp-integration.md) so Cligent can drive the maintained Kimi Code CLI through its structured ACP client mode with safe option rejection, session continuity, and distributable-package support.

## Status

Complete

The production adapter, public/runtime registration, package boundary, exact
ACP/CLI conformance, and documentation are complete. The authenticated Kimi
safe-write and five-player fanout legs were not run locally because no
dedicated `CLIGENT_KIMI_ACCEPTANCE_HOME` authenticated by `kimi login` was
supplied; both cleanly retain their documented environment gate, while the
credential-free exact `0.27.0` ACP initialization check passed.

## Deliverables

- [x] Canonical Kimi, engine, tmux-play, package, and acceptance items define the supported boundary.
- [x] `KimiAdapter` drives one `kimi acp` process per run and normalizes text, tools, permissions, terminal results, and failures.
- [x] Fresh and resumed sessions, abort cancellation, and resume tokens preserve continuity.
- [x] Kimi is available through the public package, effort metadata, tmux-play configuration, and runtime adapter registry.
- [x] Exact ACP SDK and Kimi CLI conformance targets are installed and verified without adding a Kimi-specific SDK peer.
- [x] Unit, package, smoke, exact-target, and applicable environment-gated acceptance checks pass.
- [x] User documentation and the unreleased changelog describe setup, authentication, capabilities, and intentional limitations.

## Tasks

Each task is one-commit size and keeps build, typecheck, lint, and focused tests green at its boundary.

1. [x] **Specify the Kimi integration.**
       Record the official-surface decision, ACP lifecycle, event mapping, permission and effort limits, package boundary, and acceptance coverage.
2. [x] **Implement the ACP adapter.**
       Add the ACP dependency, child-process lifecycle, session setup, configuration, event normalization, fail-closed permission handling, abort cleanup, and focused fake-protocol tests.
3. [x] **Register Kimi across public surfaces.**
       Add built-in types, effort metadata, exports, tmux-play config validation, runtime loading, colors, and their type/runtime tests.
4. [x] **Verify the distributable and live target.**
       Pin Kimi Code CLI and ACP protocol versions, update CI and package consumers, add an installed-CLI ACP contract check, and add credential-gated real-run acceptance.
5. [x] **Document and verify the feature.**
       Update user guides and changelog, run the complete repository verification sequence, and record any environment-gated acceptance skip explicitly.

## Acceptance criteria

- A fake ACP server proves initialize, new/resume, model-before-thinking configuration, prompt streaming, permission rejection, abort cancellation, process cleanup, and exact-once terminal behavior.
- Kimi text and canonical tool lifecycle events normalize without exposing raw thought chunks or duplicating tool events.
- Fresh and resumed interrupted runs retain the backend session identifier when it is known.
- Unsupported bypass, policies without a mode (including per-capability-only policies), explicit tool lists, turn/budget limits, and non-Kimi effort values fail before the Kimi process starts.
- `mode: 'auto'`, ambient writable-path reporting, and native `off` / `on` thinking controls reach their documented ACP options.
- The packed package imports `@sublang/cligent/adapters/kimi` on Node 18.3 and its declarations preserve `KimiEffort` correlation under TypeScript 5.4.
- CI verifies the exact Kimi Code CLI target and the ACP command surface; a live safe-write probe succeeds when Kimi credentials are available.
- Build, typecheck, lint, unit, smoke, package, distributable, and applicable acceptance checks pass.
