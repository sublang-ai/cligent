<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-044: Codex Subagent Tuning

## Status

Accepted (2026-11-14).
Amended by [DR-046](046-primary-and-subagent-defaults.md) for schema-neutral spawn guidance and by [DR-047](047-provider-aware-model-defaults-and-fork-history.md) for history selection independent of child tuning.
Amends [DR-028](028-subagent-model.md) and [DR-029](029-subagent-effort.md): Codex supports their shared options with native defaults and outbound delegation instructions rather than Claude's forced model and registered definitions.

## Context

Codex provides default subagent model and reasoning-effort settings, overridden by explicit spawn values and then by custom role settings [[1]].
A default alone cannot guarantee the settings of every subagent.
A player must also receive actionable delegation instructions on every tuned call, including resumed turns.

## Decision

Codex accepts the existing `subagentModel` and companion `subagentEffort` options, with effort restricted to `CodexEffort` except `ultra`.
Effort still requires a model selection.
A named model becomes `agents.default_subagent_model`; `inherit` becomes the explicit parent model when known and otherwise leaves the native default omitted for native model selection.
A supplied effort becomes `agents.default_subagent_reasoning_effort`; omission adds no effort override.
These settings are native defaults, never runtime-wide enforcement: explicit spawn choices and role-defined overrides retain native precedence [[1]].

Every tuned outbound prompt, fresh or resumed, instructs the player to explicitly select the named model or parent model at spawn, and the pinned effort when supplied, while honoring native role overrides.
[DR-046](046-primary-and-subagent-defaults.md) makes the wording schema-neutral.
[DR-047](047-provider-aware-model-defaults-and-fork-history.md) corrects the original fresh-spawn restriction after observing native full-history children.
The player delegates only fully specified, bounded, fine-grained work, retains deep reasoning and design, briefs the delegate fully, and verifies its result.
Untuned calls add neither defaults nor the directive.
Native agent enablement, unrelated agent settings, and configuration files remain untouched.
No model is forced as a cross-project default.

Canonical behavior is specified by [[engine-90](../packages/engine.md#engine-90)], [[engine-91](../packages/engine.md#engine-91)], [[engine-97](../packages/engine.md#engine-97)], [[engine-92](../packages/engine.md#engine-92)], [[codex-87](../packages/adapters/codex.md#codex-87)], [[codex-88](../packages/adapters/codex.md#codex-88)], [[tmux-play-211](../packages/tmux-play.md#tmux-play-211)], [[tmux-play-212](../packages/tmux-play.md#tmux-play-212)], and [[tmux-play-216](../packages/tmux-play.md#tmux-play-216)].

## Consequences

Support is additive and omission preserves native configuration.
The directive is delivered with each call rather than relying on a fresh thread's saved instructions.
Native availability and role overrides limit what the requested tuning can achieve; support metadata and documentation disclose those limits.

## References

[1]: https://learn.chatgpt.com/docs/agent-configuration/subagents "Codex subagent defaults, explicit spawn settings, and custom agent precedence"
