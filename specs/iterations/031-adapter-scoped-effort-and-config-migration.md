<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-031: Adapter-Scoped Effort and Config Migration

## Goal

Implement [DR-009](../decisions/009-adapter-scoped-effort-vocabularies.md): rename `reasoningEffort` to `effort`, preserve adapter-specific vocabularies across statically adapter-bound APIs, preserve exact effort strings at the legacy dynamic registry boundary, expose built-in support metadata, and migrate legacy tmux-play YAML.

## Status

In Progress

The canonical effort and migration contract is specified; implementation tasks remain open.

## Deliverables

- [x] Canonical engine, adapter, tmux-play, and acceptance items specify adapter-scoped effort and legacy-key migration.
- [x] Public vocabularies, deeply immutable built-in metadata, helpers, and runtime validation agree on every built-in adapter value.
- [ ] Direct `Cligent` and heterogeneous parallel TypeScript surfaces preserve built-in and custom vocabularies; the legacy registry forwards exact custom strings unchanged.
- [ ] Claude Code supports `ultracode`; Codex supports `ultra`; Gemini and OpenCode retain their portable mappings.
- [ ] tmux-play uses adapter-discriminated `effort` types and migrates legacy YAML only after complete validation.
- [ ] Guides document discovery, migration, provider-native values, no-op or lossy mappings, and availability and resource caveats.

## Tasks

Each task is one commit and keeps build, typecheck, lint, unit, and smoke checks green at its boundary.

1. [x] **Specify adapter-scoped effort.**
   Amend canonical user and acceptance items for DR-009, index them, and record only supersession and the legacy-registry boundary in the decision record.
2. [x] **Add effort vocabularies and metadata.**
   Add public built-in type aliases, deeply immutable support metadata, lookup and validation helpers, root exports, and focused runtime tests without changing the existing option name.
3. [ ] **Rename and correlate the core effort API.**
   Rename the option and mechanically carry it through existing callers without adding provider-native behavior; preserve correlation through `Cligent`, heterogeneous parallel calls, and custom adapters; preserve exact string pass-through through the legacy registry and engine; and add focused compile-time and runtime conformance tests.
4. [ ] **Map Claude Code effort.**
   Map portable values and `ultracode`, make explicit ordinary values disable inherited ultracode, declare the minimum compatible Claude SDK peer floor required by those surfaces, and add focused tests.
5. [ ] **Map Codex effort.**
   Preserve portable values and native `ultra` through verified thread and config transports, declare the minimum compatible Codex SDK peer floor required by those transports, and add focused plus installed-SDK serialization tests.
6. [ ] **Map Gemini effort.**
   Validate the portable vocabulary, preserve documented concrete-model mappings and no-alias cases, and add focused tests.
7. [ ] **Map OpenCode effort.**
   Validate the portable vocabulary, preserve provider and model variant mappings and no-variant cases, and add focused tests.
8. [ ] **Add canonical tmux-play effort config.**
   Make captain, player, and runtime types adapter-discriminated; validate and forward canonical `effort`; retain in-memory legacy-key compatibility; and add type, loader, and launcher-seam tests.
9. [ ] **Migrate legacy tmux-play YAML.**
   Rewrite legacy keys for every loaded YAML only after full validation; reject conflicts without writing; preserve comments, key order, scalar style, config-path symlinks, and owner/group/other permission bits; use optimistic checks followed by same-directory atomic replacement; and add migration tests.
10. [ ] **Document and close the iteration.**
   Update guides and the Unreleased changelog, run the full verification boundary, and mark only completed tasks and deliverables.

## Acceptance criteria

- Metadata, public types, adapter validation, and tmux-play validation agree for every accepted and rejected value.
- Claude Code accepts `ultracode` but not `ultra`; Codex accepts `ultra` but not `ultracode`; Gemini and OpenCode accept only portable values.
- Built-in and arbitrary custom vocabularies stay correlated through direct and heterogeneous parallel calls; wrong values fail compilation. The legacy mutable registry forwards exact effort strings without claiming compile-time narrowing.
- Claude and Codex peer floors match the minimum verified lines required by their new transports; exact development and CI pins are outside this iteration.
- Omitting effort sets no provider override; explicit ordinary Claude effort disables inherited ultracode orchestration.
- A legacy YAML key is migrated only after the full document validates; old/new conflicts never rewrite the source.
- Successful migration preserves comments, key order, scalar style, the config-path symlink, and owner/group/other permission bits. Observed source or symlink changes reject with a retry and clean the temporary file; no guarantee extends past the final optimistic check.
- Documentation makes clear that metadata does not promise model, account, or runtime availability and explains orchestration resource effects and lossy or no-op mappings.
- Build, typecheck, lint, unit, smoke, and relevant acceptance checks pass.
