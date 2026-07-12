<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-009: Adapter-Scoped Effort Vocabularies

## Status

Accepted

## Context

Coding agents expose different reasoning and orchestration controls.
A single universal ladder cannot represent provider-native values such as Claude Code `ultracode` and Codex `ultra` without implying false equivalence.
Future adapters may expose different names or numbers of levels.
Callers still need a simple option name, compile-time guidance, and runtime metadata for configuration interfaces.

## Decision

Cligent uses one public property named `effort`.
The six portable values remain available where an adapter can map them: `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
Provider-native values retain their provider terminology and are accepted only by the owning adapter; they are not cross-provider aliases.

Built-in adapters bind adapter-specific effort vocabularies through the common adapter contract.
Custom adapters may bind arbitrary string-literal vocabularies with any names or number of levels.
Built-in readonly metadata exposes supported values for user interfaces and preflight validation, and runtime validation agrees with that metadata.
Model, account, and installed-runtime availability remain provider concerns, so an adapter-valid value may still receive an observable upstream rejection.

The alternatives rejected are a global superset accepted by every adapter, normalized ordinal aliases for provider-native orchestration modes, and unchecked opaque strings for built-in adapters.

## Consequences

Users can select the terms they already know from each coding agent without Cligent inventing equivalences.
TypeScript APIs and tmux-play configuration must preserve the correlation between the selected adapter and its effort vocabulary.
Configuration interfaces can discover built-in values without duplicating validation tables.
The `reasoningEffort` to `effort` rename is a breaking public API and configuration change that requires automatic legacy-config migration where Cligent owns the configuration loader.
Provider-native orchestration modes may increase token use, latency, cost, concurrency, and tool activity without broadening configured permissions.
