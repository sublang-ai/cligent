<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-026: Runtime-Reported Model Identity

## Status

Accepted (2026-09-28).
Amends [DR-023](023-provider-model-discovery.md) for model descriptions, human names, resolved Kimi models, and the runtime's default model.

## Context

A host presenting model choices needs the specific model behind each choice, the model an unconfigured run selects, and the model a call actually runs.
[DR-023](023-provider-model-discovery.md)'s catalogs drop identity the runtimes report: Claude Agent SDK 0.3.283 and Codex 0.158.0 describe each choice, OpenCode 1.18.25's verbose listing names each model, and Kimi Code 0.39.1's listing names each alias's concrete model and display name.
A listing's default flag is not the effective default.
Codex 0.158.0 flags `gpt-6-astra` as `isDefault`, while its `config/read` returns the user-configured `gpt-5.6-sol`, which is what a run without a model uses.
Claude discovery loads no settings sources while runs load all of them, so a configured `opus[1m]` is what an unconfigured run selects, although it differs from the catalog's `default` row and names no catalog row.
[DR-002](002-unified-event-stream-and-adapter-interface.md)'s `InitPayload.model` falls back to the requested model or `unknown`, so it cannot show whether the runtime itself named the model that runs.

## Decision

- A discovered model carries the runtime's own description, verbatim, and its human name wherever the runtime reports them; Cligent never writes either.
- A Kimi alias carries its concrete model as its resolved model.
- An available catalog carries `defaultModel`: the value the runtime's own configuration selects when the caller configures none, resolved as a run in the discovery context would resolve it, including documented environment precedence.
- `defaultModel` may name a value outside the catalog and is omitted whenever the runtime cannot establish it; a listing's default flag counts only where the runtime's configuration names no model.
- Configuration is read only through runtime-owned, read-only, non-session interfaces within discovery's existing bounds, and a failed read omits `defaultModel` without failing the catalog.
- Claude reads the Agent SDK's settings resolver for the discovery `cwd`, or user-level settings without one; Codex reads its app-server's effective configuration; Kimi reads the default its provider listing prints; OpenCode offers no such interface and reports none.
- `InitPayload.reportedModel` carries only the model the runtime itself names for the call, verbatim; it is never the requested value, a Cligent-internal alias, or a placeholder, and `InitPayload.model` keeps its compatibility fallbacks.
- Credential-bearing listing fields never leave their parser, and errors never quote listing output.

Rejected alternatives: treating a listing's default flag as the effective default; falling back to a catalog row when configuration cannot be read; reading OpenCode's resolved configuration, which names only a configured model and carries provider credentials; and changing `InitPayload.model`'s meaning.

## Consequences

- Hosts can label each choice with its concrete model, mark what an unconfigured run selects, and show what a call reported, while distinguishing reported facts from requests.
- `defaultModel` describes configuration, not entitlement or allowlist enforcement, so it can name a model the account cannot use.
- Claude's resolver runs in the host process and reports the raw settings cascade, so an environment overlay relocating Claude's configuration, or a settings `env` entry for `ANTHROPIC_MODEL` whose effect that cascade cannot establish, omits `defaultModel`.
- Kimi's default comes from a human-readable listing and counts only when it names a listed alias; a format change omits it rather than misreports it.
- Codex and OpenCode currently name no model at initialization, so their `reportedModel` stays absent; Gemini names its configured selection, which may be a routing alias.
- Every addition is optional and existing members keep their meaning, so the change is additive; OpenCode and Kimi catalog names become the runtime's human names where reported.
