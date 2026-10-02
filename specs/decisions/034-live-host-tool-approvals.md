<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-034: Live Host Tool Approvals

## Status

Accepted; amends the headless fallback in [DR-005](005-per-adapter-permission-configuration.md).

## Context

Some native transports can suspend a tool until a host supplies a permission decision.
Historical permission telemetry cannot answer that request, and workflow questions after a call cannot unblock a waiting native tool.
Native policy, operating-system privacy consent, and the host application's own approval review remain separate authorities.

## Decision

A caller may supply an asynchronous approval handler for one invocation.
Only unresolved native tool requests enter this handler; native automatic grants, explicit denies, and already admitted MCP servers retain their existing behavior.
The portable decisions are one-time allowance and denial, restricted to choices the native request can honor.
Each request has a unique host identity, authentic native identity, immutable serializable input, and a ten-minute deadline.
Cancellation, handler failure, deadline expiry, and invocation teardown deny unresolved requests.
Typed request and response events describe host decisions independently of subsequent native execution.
Unsupported transports continue ordinary work and report their limitation through capability discovery.
Structured questions and forms are not boolean permissions and remain unsupported through this interface.
Callbacks belong to invocation options, never saved configuration or hidden controller calls.

## Consequences

Claude's permission callback, Kimi's ACP reverse request, and OpenCode's validated pending-permission registry can support interactive hosts.
Codex's current exec SDK and Gemini's current NDJSON transport cannot return host decisions, even though other native transports may do so.
A human allowance does not override native policy, grant persistent permission, or satisfy macOS Accessibility or Screen Recording consent.
