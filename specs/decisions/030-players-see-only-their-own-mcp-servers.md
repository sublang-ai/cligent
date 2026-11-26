<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-030: Players See Only Their Own MCP Servers

## Status

Accepted (2026-10-01).
Amends [DR-010](010-isolated-captain-control-calls.md).
Amended by [DR-032](032-browser-tools-and-media-output.md).

## Context

A Claude run through this adapter passed `strictMcpConfig` only under an explicit `allowedTools`, so a player with its native tool surface — the common case in Spex and Playbook — ran with the SDK's default MCP configuration.
On a machine whose Claude account has claude.ai connectors enabled, the runtime auto-fetches those connectors into every such run and, where they are not yet authorized, places a reminder in the agent's context; players relayed "The Gmail and Google Calendar connectors need authorizing" into their transcripts, and a Captain repeated it to the reader, though nothing in the workflow uses them.
Model discovery already isolates its own probe with `mcpServers: {}`, `strictMcpConfig: true`, and `settingSources: []`.

The SDK documents three distinct controls [[1]]:

- `strictMcpConfig` uses only the servers passed via `mcpServers` (and those explicitly passed agent definitions declare), ignoring project `.mcp.json`, user settings, plugins, and on-disk agent frontmatter;
- `settingSources` selects which filesystem settings load — user, project, local — with `[]` disabling them all and `project` required for `CLAUDE.md`;
- the `disableClaudeAiConnectors` setting, true in any settings source, stops claude.ai MCP cloud connectors from being auto-fetched or connected, gating only auto-fetched connectors.

The connectors are auto-fetched from the account, not read from a settings file, so `settingSources` is not their carrier, and `strictMcpConfig`'s documented list does not name them.

## Decision

Every Claude run confines its MCP servers to those the query itself passes, with `strictMcpConfig: true` and `disableClaudeAiConnectors: true` in the query's settings on every run.
A run passes only the servers its caller supplies ([DR-032](032-browser-tools-and-media-output.md)).
This amends [DR-010](010-isolated-captain-control-calls.md): `strictMcpConfig: true` moves from every explicit allowlist to every run, with the account's claude.ai connectors gated beside it.
`settingSources` and the allowlist mapping of `tools` and `allowedTools` keep [DR-010](010-isolated-captain-control-calls.md)'s mapping, so a tool-using run still loads filesystem settings and `CLAUDE.md`.

The rejected alternatives are `settingSources: []` on every run, which does not reach auto-fetched connectors and would cost tool-using runs their `CLAUDE.md`, and `strictMcpConfig` alone, whose documented scope does not name the connectors.

Canonical behavior is specified by [[claude-code-70](../packages/adapters/claude-code.md#claude-code-70)].

## Consequences

No Claude run sees the account's connectors or their reminder; a run's MCP surface is exactly the servers its caller supplies.
A host that relied on a player inheriting `.mcp.json`, user-settings, or plugin MCP servers under an omitted allowlist loses them; the adapter never documented that inheritance, and the fix is a PATCH release.
The effort and fast-mode settings share one settings object with the connector gate, so a run's settings are never absent.

## References

[1]: https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.284/sdk.d.ts "Claude Agent SDK 0.3.284 declarations"
