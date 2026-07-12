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

This decision supersedes the global `ReasoningEffort` field and vocabulary in [DR-002](002-unified-event-stream-and-adapter-interface.md) and [DR-003](003-role-scoped-session-management.md); all unrelated decisions in those records remain in force.
Canonical behavior is specified by [ENG-020](../user/engine.md#eng-020) and [TMUX-056](../user/tmux-play.md#tmux-056).

Static TypeScript correlation applies where the adapter identity remains present in the type.
On the legacy name-based mutable-registry path, `runAgent()` accepts `AgentOptions<string>` and forwards the exact effort string unchanged.
Dynamic unregister and re-registration prevent compile-time agent-name-to-vocabulary narrowing on that path.

## Consequences

Users can select the terms they already know from each coding agent without Cligent inventing equivalences.
Statically adapter-bound TypeScript APIs and tmux-play configuration must preserve the correlation between the selected adapter and its effort vocabulary.
Configuration interfaces can discover built-in values without duplicating validation tables.
The `reasoningEffort` to `effort` rename is a breaking public API and configuration change that requires automatic legacy-config migration where Cligent owns the configuration loader.
Cligent shall leave independently configured permission controls unchanged solely because a provider-native orchestration value is selected.
Provider-native orchestration modes may increase token use, latency, cost, concurrency, and tool activity.
