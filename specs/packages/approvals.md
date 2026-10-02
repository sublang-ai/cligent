<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# approvals: Live Host Tool Approvals

## Intent

This package defines the project's per-invocation `ApprovalHandler` and live approval events per [DR-034](../decisions/034-live-host-tool-approvals.md).

## External Behavior

### approvals-1

Where an invocation supplies `approvalHandler`, an adapter with a live native decision route shall consult it only for unresolved tool permission asks, preserving native automatic decisions, hard denies, and existing explicit MCP authorization without storing or reusing the handler on another invocation.

### approvals-2

When a native tool ask is admitted, its host request shall be an immutable serializable `ApprovalRequest` with unique opaque `id`, `kind: 'tool'`, authentic `agent`, `sessionId`, `toolUseId`, `toolName`, detached `input`, optional detached native review `details`, optional `reason`, exact supported `choices` drawn from `allow_once` and `deny`, and epoch-millisecond `createdAt` and `expiresAt` ten minutes apart.

### approvals-3

While a request is pending, the invocation shall keep native execution awaiting the handler's supported decision until the earliest of settlement, its ten-minute deadline, caller or native cancellation, or invocation teardown, with every exceptional or invalid outcome resolving to denial and aborting the handler context's signal on cancellation, timeout, error, or teardown.

### approvals-4

When an admitted request is opened and settled, the event stream shall emit exactly one `approval_request` containing its request and one `approval_response` containing `requestId`, `decision`, and `source` (`host`, `timeout`, `cancelled`, or `error`) before returning its native decision, without treating a host allowance as proof that native execution occurred or producing a second response for a late handler result.

### approvals-5

Where no handler or live native decision transport is available, the invocation shall preserve ordinary execution and existing fail-closed permission handling without emitting a live approval request, leaving historical `permission_request` telemetry distinct from an answerable request.

### approvals-6

Where a native interaction requires structured answers or persistent permission choices, the adapter shall decline that unsupported interaction without converting one-time approval into an answer or persistent grant.

## Verification

### approvals-7

When a real adapter invocation reaches its native permission boundary through a controllable SDK or ACP peer, integration checks shall verify per-call admission and unchanged automatic/hard-denied behavior [[approvals-1](#approvals-1)], authentic detached request identity and choices [[approvals-2](#approvals-2)], no native side effect before a supported answer and fail-closed cancellation/error/deadline/teardown [[approvals-3](#approvals-3)], exactly-once ordered events including late answers [[approvals-4](#approvals-4)], unchanged handler-free and unsupported transport execution [[approvals-5](#approvals-5)], and rejection of structured or persistent interactions [[approvals-6](#approvals-6)].

### approvals-8

When continuous integration exercises portable SDK, ACP, provider-protocol, and attributed host-runtime approval flows on Linux, macOS, and Windows, the checks shall verify native admission [[approvals-1](#approvals-1)], authentic requests [[approvals-2](#approvals-2)], bounded native waits and cancellation [[approvals-3](#approvals-3)], ordered response events [[approvals-4](#approvals-4)], unchanged unsupported and handler-free paths [[approvals-5](#approvals-5)], and no persistent or structured-interaction grants [[approvals-6](#approvals-6)].
