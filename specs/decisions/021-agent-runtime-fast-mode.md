<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-021: Agent Runtime Fast Mode

## Status

Accepted

## Context

Agent runtimes may offer lower-latency serving for additional usage cost without changing reasoning depth, so fast mode is orthogonal to the adapter-scoped `effort` contract in [DR-009](009-adapter-scoped-effort-vocabularies.md) [[1]].
The installed-runtime survey for this decision examined Claude Agent SDK 0.3.251, Codex SDK and CLI 0.151.0, OpenCode SDK and CLI 1.18.25, Gemini CLI 0.57.0, ACP SDK 1.4.0, and Kimi CLI 0.39.1.
The Claude declaration exposes dedicated fast-mode settings, model capability, initialization and terminal state, disabled reasons, and terminal response speed [[5]].
The Codex declaration exposes a generic configuration transport that can select Codex fast mode, but its public event union exposes no effective service tier [[4]], [[6]].
Gemini, OpenCode, and Kimi expose no corresponding built-in runtime contract.

Claude requires a non-interactive SDK session to opt in explicitly through flag settings, while `fastModePerSessionOptIn` is a separate persistence and cost-control policy [[1]], [[2]].
Accordingly, `sdk_opt_in_required` means that the SDK session did not carry the explicit `settings.fastMode: true` opt-in; a saved interactive preference does not satisfy it [[1]], [[5]].
Claude also distinguishes selected session state from actual serving speed: a fast-mode rate limit produces `cooldown`, which is state rather than a disabled reason, temporarily uses standard speed and pricing, and later reenables fast mode, while response usage reports the speed actually used for that response [[1]], [[3]], [[5]].

Fast-mode availability remains dependent on the selected model, account, provider, organization policy, billing, network state, and installed runtime.
Cligent therefore needs to distinguish the ability to deliver a request from proof that fast serving occurred, while preserving its rule that reported data is authentic rather than inferred from caller intent.

## Decision

Cligent uses one public property named `fastMode`, separate from `effort`, on its shared agent, instance-default, and per-run option surfaces.
`true` explicitly requests the adapter's native fast mode, `false` explicitly requests its native standard or off mode, and omission adds no Cligent override.
Per-call option merging treats `false` as a provided scalar value, so it can override an instance default of `true`.

Fast-mode request support remains adapter-scoped through a defaulted type capability carried by statically adapter-bound APIs.
Claude and Codex bind boolean support; Gemini, OpenCode, and Kimi bind no assignable value; custom adapters default to unsupported and may opt in.
Dynamic paths accept the boolean broadly enough to select an adapter at runtime, reject malformed built-in values before backend invocation, and require a custom adapter to validate its declared capability.

Any defined `fastMode` value on an unsupported built-in adapter is rejected before backend invocation, including `false`.
Where a request-supported backend rejects fast mode for the selected model, account, provider, policy, network, or installed runtime, Cligent exposes the upstream refusal through the ordinary error path without substituting another request.
Where the backend itself completes through standard-speed fallback or cooldown, Cligent preserves that backend outcome rather than manufacturing an error or claiming fast delivery.

Cligent exports separate, immutable `FAST_MODE_SUPPORT` metadata and helpers for adapter-selection interfaces.
The metadata describes adapter request transport and observation support, not current model or account entitlement, and does not become part of `EFFORT_SUPPORT`.
No model-catalog API is added solely for Claude's initialization-time `ModelInfo.supportsFastMode` value.

Cligent exposes authentic fast-mode observation through typed optional members on both unified initialization and terminal payloads, not through vendor metadata.
An observation may carry state, a disabled reason, and the terminal upstream response speed.
Absent upstream data remains absent; the requested boolean is never echoed as observation; `unknown` is never synthesized; and `cooldown` is preserved as state rather than converted into a disabled reason.
Claude supplies the currently available observations.
Codex supplies none until its public SDK reports an effective service tier, and its static descriptor discloses that limitation.

`fastModePerSessionOptIn` is neither a Cligent caller option nor a setting the Claude adapter writes.
It remains an upstream persistence policy rather than the per-run speed selection.

tmux-play admits `fastMode` for Claude and Codex Captain and player configurations, validates it against the selected adapter, retains explicit `false`, and adds no generated paid-mode default.
Complete tmux-play call settings may replace a configured value or omit fast mode to restore provider-default selection without merging the configured role value.

Canonical behavior is specified by [[engine-74](../packages/engine.md#engine-74)], [[engine-75](../packages/engine.md#engine-75)], [[engine-76](../packages/engine.md#engine-76)], [[engine-77](../packages/engine.md#engine-77)], [[engine-78](../packages/engine.md#engine-78)], [[engine-79](../packages/engine.md#engine-79)], [[claude-code-52](../packages/adapters/claude-code.md#claude-code-52)], [[claude-code-53](../packages/adapters/claude-code.md#claude-code-53)], [[codex-55](../packages/adapters/codex.md#codex-55)], [[codex-56](../packages/adapters/codex.md#codex-56)], [[tmux-play-206](../packages/tmux-play.md#tmux-play-206)], and [[tmux-play-207](../packages/tmux-play.md#tmux-play-207)].

The rejected alternatives are treating fast mode as effort, using provider-named caller fields, accepting and silently ignoring the field on unsupported adapters, echoing a request as observed state, and promising actual fast serving where the runtime exposes only request configuration.

## Consequences

The public option, capability parameter, metadata, helpers, observations, and tmux-play keys are additive.
Existing single-parameter generic uses remain valid, every new data or configuration member is optional, and omitted fast mode preserves existing behavior.
Only newly supplied unsupported fast-mode requests acquire a new rejection path.

Selector interfaces can distinguish adapters that accept a request from those that can authenticate its outcome.
They must still present model, account, and policy eligibility as dynamic.
Codex callers can request fast mode but cannot confirm its effective tier through the current SDK event stream.

The existing Claude 0.3.219 and Codex 0.144.0 supported floors already contain the direct surfaces this contract uses [[7]], [[8]], so this decision raises no runtime floor under [[package-17](../packages/package.md#package-17)].
The additive feature ships in a MINOR release without making the release breaking.

## References

[1]: https://code.claude.com/docs/en/fast-mode "Claude Code fast mode"
[2]: https://code.claude.com/docs/en/agent-sdk/typescript "Claude Agent SDK TypeScript reference"
[3]: https://platform.claude.com/docs/en/build-with-claude/fast-mode#checking-which-speed-was-used "Checking which Claude serving speed was used"
[4]: https://learn.chatgpt.com/docs/agent-configuration/speed "Codex speed"
[5]: https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.251/sdk.d.ts "Claude Agent SDK 0.3.251 declarations"
[6]: https://unpkg.com/@openai/codex-sdk@0.151.0/dist/index.d.ts "Codex SDK 0.151.0 declarations"
[7]: https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.219/sdk.d.ts "Claude Agent SDK 0.3.219 declarations"
[8]: https://github.com/openai/codex/blob/rust-v0.144.0/codex-rs/core/config.schema.json "Codex 0.144.0 configuration schema"
