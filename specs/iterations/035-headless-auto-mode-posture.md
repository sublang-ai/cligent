<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-035: Headless Auto-Mode Posture

## Goal

Record the headless auto-mode posture after investigating why `permissions: { mode: 'auto' }` could not answer network-dependent prompts on Claude Fable 5 sessions: `mode: 'auto'` stays mapped to each SDK's native protected auto-mode with no cligent-selected capability grants, and no adapter behavior changes.

## Status

Complete

## Deliverables

- [x] DR-005 context corrected from official docs: Claude's auto-mode classifier is a separate model (Sonnet 5 default, Opus fallback for Fable 5 sessions, server-side override, not user-configurable) that fails closed when unavailable; headless runs abort on repeated blocks; allow rules resolve before the classifier.
- [x] DR-005 *Headless auto-mode posture* decision recorded: semi-equivalence to interactive auto (minus the human fallback) is accepted; the implemented-then-rolled-back network-widening alternative (Claude pre-approved fetch rules, Codex generated `network = { enabled = true }` workspace profile, opencode `websearch: 'allow'` pin) is documented for future readers; unattended capability needs route to explicit `mode: 'bypass'` or a future typed opt-in; the opencode `websearch: 'ask'` headless hang is noted as a known hazard left to user configuration.

## Tasks

Each task is one-commit size and keeps build, typecheck, lint, and unit checks green at its boundary.

1. [x] **Record the posture and correct classifier facts.**
   Amend DR-005 (context + *Headless auto-mode posture*); update the map. No code, item, or test changes.

## Acceptance criteria

- All four adapters' permission mappings are byte-identical to their pre-IR-035 behavior; no adapter injects cligent-selected allow rules, generated network profiles, or permission pins under `mode: 'auto'`.
- Build, typecheck, lint, and unit tests pass.
