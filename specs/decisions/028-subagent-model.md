<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-028: Subagent Model

## Status

Accepted (2026-09-30).
Amends [DR-021](021-agent-runtime-fast-mode.md) in nothing; reuses its adapter-scoped option pattern.
Amends the Claude query preparation of [[claude-code-34](../packages/adapters/claude-code.md#claude-code-34)]: the per-run environment clone may carry two Cligent-set variables.

## Context

Claude Code delegates bounded work to subagents through its Agent tool, and its runtime resolves each subagent's model in a fixed order: the per-invocation `model` the main agent passes, then the subagent definition's own `model`, then the `CLAUDE_CODE_SUBAGENT_MODEL` environment variable, then the main conversation's model [[1]], [[2]].
Setting `CLAUDE_CODE_SUBAGENT_MODEL` alone therefore leaves the built-in Explore and Plan subagents on the models their definitions pin, and leaves the main agent free to pass another; `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` makes the variable's model apply to every subagent, ignoring definitions and per-invocation choices, from Claude Code 2.1.257 [[1]].
The SDK's `env` option replaces the subprocess environment rather than merging it [[3]], which the adapter already handles by passing a clone of the caller's environment.

A host wants a stronger, slower agent to keep the reasoning and design work and to hand well-defined, fine-grained tasks to subagents on a cheaper or faster model, without the delegation lowering the delivered quality.
Choosing that model is only half of it: an agent that is not told to delegate deliberately delegates as it always did, and an agent told in prose which model to prefer cannot enforce it.
The two halves belong together, and only the adapter reaches both the process environment and the SDK's `systemPrompt` [[3]].

The Claude adapter passes no `systemPrompt` today; the SDK then sends an empty custom prompt, not the `claude_code` preset, so a custom prompt carrying only the delegation directive adds to the runs without changing the base prompt they already have.
A recorded system-prompt snapshot would repeat the first request's text on later requests and resumes even when a later launch passes different text [[3]], so the directive must not be snapshotted, or a changed or cleared choice would keep naming the old model.

Codex, Gemini, Kimi, and OpenCode expose no per-run subagent model in the surfaces Cligent drives.

## Decision

Cligent uses one public property named `subagentModel`, a model id or alias string, on its shared agent, instance-default, and per-run option surfaces, separate from `model`.
A supplied value selects the model every subagent of the run uses; omission adds no Cligent override and leaves the runtime's own order in force.
Per-call option merging treats it as a scalar: the per-call value when provided, otherwise the instance default.

Support is adapter-scoped exactly as fast mode is under [DR-021](021-agent-runtime-fast-mode.md): a defaulted type capability carried by statically adapter-bound APIs, an exported immutable `SUBAGENT_MODEL_SUPPORT` table with helpers, and a built-in check that rejects any defined value on an unsupported adapter before backend invocation.
Claude binds string support; Codex, Gemini, Kimi, and OpenCode bind no assignable value; custom adapters default to unsupported and may opt in.

When the Claude adapter prepares a query carrying `subagentModel`, it sets `CLAUDE_CODE_SUBAGENT_MODEL` to the value and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` to `1` in the per-run environment clone, and passes a custom, unsnapshotted system prompt consisting of one delegation directive that names the value:

> Your subagents run on {model}. Offload to them the work you can specify completely and bound tightly — well-defined, fine-grained tasks that {model} can implement well — and keep the deep thinking, reasoning, and design work yourself. Offloading must never lower the quality of what you deliver: brief each subagent fully, and verify its result before you build on it.

The directive is Cligent's text, not a caller option; the caller chooses the model, and the words follow.
The adapter composes its system prompt from ordered parts rather than assigning one string: a caller's own system prompt, when Cligent offers one, comes first in whatever form the caller gives it, and each Cligent directive follows as its own final paragraph — joined to a custom prompt by a blank line, or carried in the preset's `append` after the caller's own — so a later caller-supplied system prompt joins the directive and never replaces it.
Today the parts hold at most the directive, and a run without `subagentModel` composes nothing, which leaves the query without a `systemPrompt` exactly as before.
Without `subagentModel` the adapter sets neither variable and no system prompt, so existing runs are unchanged.
A value the runtime cannot serve is refused by the runtime through the ordinary error path; Cligent validates the string's presence, not its membership in a catalog, because discovery lists evidence rather than promises.

tmux-play admits `subagentModel` for Claude Captain and player configurations, validates it against the selected adapter, and carries it in complete call settings as an optional string whose omission selects the provider default without merging the configured role value.

A generic caller-supplied system prompt was weighed as the whole mechanism and declined: it cannot fix which model the subagents run on, and it would make every host author the words; it remains a reasonable later option, which the composition rule above already accommodates.
The other rejected alternatives are, the `claude_code` preset with an `append` (it would change the base prompt of every run that sets the option), the `agents` option (it defines new subagents; it cannot retarget the built-in ones or a per-call choice), prepending the directive to the user prompt (repeated in every turn's transcript as if the caller said it), and `CLAUDE_CODE_SUBAGENT_MODEL` without `FORCE` (a default the built-in definitions ignore, so a chip naming it would lie).

Canonical behavior is specified by [[engine-90](../packages/engine.md#engine-90)], [[engine-91](../packages/engine.md#engine-91)], [[engine-92](../packages/engine.md#engine-92)], [[engine-93](../packages/engine.md#engine-93)], [[claude-code-60](../packages/adapters/claude-code.md#claude-code-60)], [[claude-code-61](../packages/adapters/claude-code.md#claude-code-61)], [[claude-code-62](../packages/adapters/claude-code.md#claude-code-62)], [[claude-code-63](../packages/adapters/claude-code.md#claude-code-63)], [[tmux-play-211](../packages/tmux-play.md#tmux-play-211)], and [[tmux-play-212](../packages/tmux-play.md#tmux-play-212)].

## Consequences

The option, capability parameter, table, helpers, environment variables, system prompt, and tmux-play key are additive; every new member is optional, and omission preserves existing behavior, so this ships in a MINOR release.
The Claude supported floor of 0.3.284 already bundles Claude Code 2.1.283, past the 2.1.257 that `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` requires [[1]], so no floor rises under [[package-17](../packages/package.md#package-17)].
A run with `allowedTools` that omits `Agent` keeps its subagents unavailable as before; the option changes which model subagents use, never whether the agent may start them.
Hosts that expose the choice reuse the adapter's model list from discovery and `isSubagentModelSupported` to decide where to offer it.
A future system-prompt option changes the composition's first part and nothing about the directive, so it will not be a breaking change to this contract.

## References

[1]: https://code.claude.com/docs/en/sub-agents "Claude Code subagents"
[2]: https://code.claude.com/docs/en/model-config "Claude Code model configuration"
[3]: https://code.claude.com/docs/en/agent-sdk/typescript "Claude Agent SDK TypeScript reference"
