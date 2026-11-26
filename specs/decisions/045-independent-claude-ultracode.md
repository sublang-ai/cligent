<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-045: Independent Claude Ultracode

## Status

Accepted (2026-11-14).
Amends [DR-009](009-adapter-scoped-effort-vocabularies.md).

## Context

Reasoning effort and Claude workflow orchestration are separate choices.
Coupling orchestration activation to one effort value cannot express ordinary effort with workflows enabled or explicit workflow disabling independently of effort.
Automatically disabling workflows for every ordinary effort also overwrites native configuration without a caller request.

## Decision

Run and instance defaults and tmux-play role and call settings accept optional `ultracode: boolean` independently of effort.
An explicit boolean reaches Claude's native settings on fresh and resumed runs and overrides the legacy shorthand's orchestration choice.
The legacy `effort: 'ultracode'` still selects `xhigh` effort and enables workflows unless the independent boolean overrides it.
Ordinary or omitted effort creates no workflow override when the boolean is absent.
`isUltracodeSupported` advertises native request transport support for Claude, including its configuration alias, without promising account, model, or runtime policy availability.
Unsupported adapters reject explicit activation and accept false without forwarding a native option.
Malformed values fail before native invocation; upstream availability errors remain visible without substitution.

Canonical behavior is specified by [[engine-134](../packages/engine.md#engine-134)], [[engine-135](../packages/engine.md#engine-135)], [[claude-code-8](../packages/adapters/claude-code.md#claude-code-8)], [[claude-code-94](../packages/adapters/claude-code.md#claude-code-94)], and [[tmux-play-229](../packages/tmux-play.md#tmux-play-229)].

## Consequences

Existing shorthand configurations remain readable.
Explicit false is meaningful even beside the shorthand.
Omission preserves the native workflow default rather than implicitly disabling workflows with ordinary effort.
Consumers can discover transport support instead of maintaining adapter lists.
