<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-033: Effort Surface Simplification

## Goal

Reduce the implementation and verification cost of [DR-009](../decisions/009-adapter-scoped-effort-vocabularies.md) without losing provider-native values, runtime validation, actionable upgrade behavior, or useful adapter-correlated TypeScript APIs.

## Status

In Progress

Bounded legacy-key compatibility and table-derived correlated aliases are
complete; test consolidation, documentation, and final verification remain
open.

## Deliverables

- [x] Canonical effort and tmux-play items specify table-derived public aliases and bounded best-effort legacy-key compatibility.
- [x] Legacy tmux-play YAML runs through a best-effort key-token update with in-memory fallback and an actionable warning when the update is skipped.
- [x] Built-in effort aliases derive from the runtime support table while direct, custom, and adapter-discriminated APIs retain useful correlation.
- [ ] Runtime, declaration, and launcher tests cover distinct rules and transports without redundant Cartesian permutations.
- [ ] Guides and the changelog describe the best-effort deprecation path and the verified final surface.

## Tasks

Each task is one commit and keeps build, typecheck, lint, unit, and smoke checks green at its boundary.

1. [x] **Specify the simplified effort boundary.**
   Make runtime support metadata authoritative for built-in aliases, retain statically adapter-bound correlation, replace lossless disk migration with bounded one-release best-effort compatibility, and narrow acceptance coverage to distinct rules and transport classes.
2. [x] **Replace lossless effort-key migration.**
   Accept direct legacy YAML keys in memory, replace only their parsed key tokens after complete validation, skip safely when the source changed or the update fails, report accepted paths and outcome, preserve conflict and invalid-value errors, and remove the lossless replacement machinery.
3. [x] **Derive aliases and simplify correlated internals.**
   Derive public built-in effort aliases from the frozen support values, retain direct and custom adapter generics plus adapter-discriminated tmux-play declarations, and collapse internal type-driven switches behind localized validated boundaries.
4. [ ] **Consolidate effort verification.**
   Keep representative declaration contracts, table-driven mapping rules, distinct rejection paths, and each provider transport class while removing repeated compiler restatements and provider-by-model-by-value permutations.
5. [ ] **Document and close the simplification.**
   Update guides and the Unreleased changelog, run the full verification boundary, and mark only completed tasks and deliverables.

## Acceptance criteria

- Claude `ultracode`, Codex `ultra`, all portable mappings, omission behavior, and adapter-specific runtime errors remain unchanged.
- A valid direct legacy YAML key supplies in-memory `effort`, reports its config, field path, and update outcome once after complete validation, and is rewritten only when the source still matches; an old/new conflict or invalid legacy value rejects without callback or write.
- A changed or unwritable source leaves the validated runtime behavior available through the in-memory compatibility value and produces an actionable manual-rename warning without overwriting newer bytes.
- `EFFORT_SUPPORT` literal values define the exported built-in aliases and the values accepted by runtime validation.
- Direct built-in and arbitrary custom adapters retain vocabulary inference, and programmatic tmux-play configs reject cross-adapter provider-native values.
- Tests cover every distinct mapping rule and transport boundary without requiring every equivalent input permutation at every layer.
- Build, typecheck, lint, unit, smoke, and relevant acceptance checks pass.
