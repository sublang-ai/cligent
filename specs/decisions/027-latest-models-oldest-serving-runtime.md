<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-027: Latest Models on the Oldest Serving Runtime

## Status

Accepted (2026-09-28).
Amends [DR-013](013-cligent-owned-runtime-compatibility.md) for the supported-floor definition and [DR-023](023-provider-model-discovery.md) for its consequence that a newer optional model does not raise the general compatibility floor.

## Context

[DR-013](013-cligent-owned-runtime-compatibility.md) set each runtime's supported floor at the lowest release serving the models and routes a release's declared behavior depends on, and [DR-023](023-provider-model-discovery.md) added that a newer optional model does not raise it.
Shipped defaults and examples then trailed the providers: generated tmux-play roles still named Claude Opus 4.8 and GPT-5.5 after Claude Opus 5.5 and GPT-6 shipped.
Naming a current model under the old floors would have admitted supported installs that cannot serve it.
A runtime that predates a model rarely refuses it at the gate: Codex resolves an unlisted model through a longest-prefix match or generic fallback metadata, Gemini CLI passes an unlisted slug through with generic defaults, and Claude Code keeps a model's effort levels and capabilities only in its baked-in catalog.
The model then fails late or runs without its own effort levels and capabilities, the silent mismatch [DR-013](013-cligent-owned-runtime-compatibility.md) exists to prevent.

## Decision

- Every shipped default, example, and seed that names a model names the latest model of its line.
- Each runtime's supported floor, and a peer runtime's published peer floor, is the oldest published release that serves the latest models its provider offers and supplies every runtime surface the adapter drives.
- A runtime serves a model when its own bundled model catalog carries that model; where a runtime takes its models and their capabilities from the provider or its configuration without a version gate, serving adds no bound and the surface requirement alone sets the floor.
- Each floor is established by bisecting published releases, and the descriptor records beside it the serving capability and the adjacent-release evidence.
- Captured fixtures and release records stay as recorded, because they are evidence of a past run rather than examples.

## Consequences

- A shipped default or example runs on every supported install, and the pinned model's effort levels and capabilities come from the runtime's own catalog.
- A provider model launch raises the floor, and releases that loaded before are refused with the exact repair; each rise still ships only in a MINOR release that names the new floor, as [DR-013](013-cligent-owned-runtime-compatibility.md) requires.
- Floors move more often, so consumers holding an older runtime in a lockfile or global install see the refusal and its remedy sooner.
- Discovery results from [DR-023](023-provider-model-discovery.md) remain account- and runtime-dependent facts; they neither set nor lower a floor.
