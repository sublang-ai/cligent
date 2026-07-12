<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-010: Isolated Captain Control Calls

## Status

Accepted

## Context

Playbook Captains use their runtime-owned Captain agent for short routing and adjudication calls.
Those calls previously inherited the Captain agent's conversation and full tool surface because `callCaptain` exposed only presentation visibility.
The shared `allowedTools` contract also did not consistently distinguish an omitted allowlist from an explicit empty allowlist across adapters.
Consequently a routing call could investigate the workspace, reuse unrelated context, or silently run with tools when its caller requested none.

## Decision

`CallCaptainOptions` exposes the per-call session selector `resume?: string | false` and the tool restriction `allowedTools?: readonly string[]` in addition to presentation visibility.
This decision supersedes only [DR-004](004-tmux-play-captain-architecture.md)'s visibility-only `CallCaptainOptions` surface; its remaining architecture stays in force.
The tmux-play runtime forwards present values to the Captain `Cligent.run()` call, copying the readonly allowlist at the boundary.
Omission preserves Captain auto-resume and adapter-native tool availability; `resume: false` forces a fresh backend session; `allowedTools: []` requires a backend call with no available tools.

An explicit allowlist, including an empty one, is a security and control boundary rather than a hint.
Adapters shall enforce the effective allowlist through a provider surface that removes other tools from model availability, with `disallowedTools` retaining precedence.
An adapter that cannot honor an explicit tool restriction shall reject before invoking its backend instead of silently weakening the request.

The built-in adapter mappings are:

| Adapter | Explicit allowlist mapping |
| --- | --- |
| Claude Code | SDK `tools` selects the available built-ins and SDK `allowedTools` preserves automatic permission approval for the selected names; every explicit list sets `strictMcpConfig: true` to ignore ambient MCP configuration, while `tools: []` disables all built-ins and additionally uses `settingSources: []` to disable filesystem settings and `CLAUDE.md`. |
| Gemini | User-tier Policy Engine allow rules plus a catch-all deny; an empty list emits only the catch-all deny. |
| OpenCode | Prompt tool booleans beginning with wildcard deny for every explicit allowlist, followed by allowed `true` and denied `false` entries; an empty list is exactly `{ "*": false }`. |
| Codex | Reject before SDK loading because the supported Codex SDK surface cannot constrain the available tool registry. |

Gemini and OpenCode init telemetry shall report an explicit allowlist as configured and known even when the effective list is empty.

## Consequences

Playbook Captains can make fresh, tool-free control calls without constructing agents or bypassing tmux-play records.
Existing callers that omit the new fields preserve prior continuity and provider defaults.
Codex callers that explicitly set either tool-list option now receive an actionable failure rather than an unenforced request.
Claude Code non-empty allowlists become true availability restrictions while retaining their prior automatic-approval behavior.
Claude Code's explicit-allowlist mapping also removes ambient MCP configuration, and its empty-list mapping removes supported ambient filesystem settings; it does not claim to erase provider context outside those documented controls.
