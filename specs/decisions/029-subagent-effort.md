<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-029: Subagent Effort

## Status

Accepted (2026-10-01).
Amends [DR-028](028-subagent-model.md): `subagentModel` gains the literal `inherit`, a companion `subagentEffort` joins it, the directive's first sentence follows both, and the adapter registers subagent definitions; the composition rule, the environment pair and every other decision of DR-028 stand.

## Context

A Claude session's reasoning effort is one setting for the whole session, and `ultracode` is session-scoped too [[1]].
A subagent started through the Agent tool therefore inherits the main agent's effort: the tool's per-invocation input carries a `model` but no effort [[2]], no environment variable names a subagent effort, and the only place Claude Code lets a subagent's effort differ is a subagent definition's own `effort` [[2]].
With [DR-028](028-subagent-model.md) alone, an agent on `ultracode` hands its fine-grained tasks to subagents that also run at `ultracode` — a cost the owner called a loophole: the reader should be able to pin a subagent effort, or, by default, leave the choice to the agent per task.

Definitions registered through the SDK's `agents` option appear in the Agent tool's own list as subagent types with their descriptions [[2]], so an agent learns a registered definition the way it learns the built-in `general-purpose`, `Explore` or `Plan`: by name and description in its tool, not by prose in its system prompt.
A definition fixes both a model — a model id, an alias, or `inherit` for the main model [[2]] — and an effort, which is exactly the pair a subagent setting names.
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` set alone binds every subagent, built-in or registered, to the main conversation's model [[3]].

## Decision

`subagentModel` admits the literal `inherit`, meaning the agent's own model, beside a model id or alias; omission still means no subagent configuration and leaves every query unchanged.
A new option `subagentEffort`, a value of the adapter's effort vocabulary other than its orchestration value `ultracode`, names the effort every subagent runs at; its omission, where `subagentModel` is set, leaves the effort to the agent's choice per task.
`subagentEffort` without `subagentModel`, on an adapter that serves no subagent model, or outside that vocabulary is rejected before backend invocation.

When the Claude adapter prepares a query with `subagentModel`:

- the environment carries `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, and `CLAUDE_CODE_SUBAGENT_MODEL=<model>` where a model is named;
- the query registers subagent definitions on that model (`inherit` for the agent's own): with `subagentEffort` pinned, one definition named `delegate` at that effort; otherwise one definition per effort the vocabulary admits, named `delegate-<effort>`, so the agent's choice of effort is a choice of definition the Agent tool enforces;
- each definition's description names its model — "your model" for `inherit` — and its effort, and its prompt is one short delegate prompt: complete exactly the task given within its bounds, with the tools available, and report precisely what was done and verified and what could not be;
- the directive's first sentence follows the two settings with one grammar — "Your subagents run on your own model" or "Your subagents run on <model>", then "; give each one the effort its task warrants." or " at <effort> effort." — and its remaining sentences are those of [DR-028](028-subagent-model.md), with "a subagent can implement well" in place of the model's name, so the four combinations differ in that first sentence alone;
- the directive names no definition and no effort level: the definitions explain themselves in the tool, and effort vocabularies differ between model lines.

Where the runtime lets a registered definition override a built-in one by name, a pinned `subagentEffort` also overrides `general-purpose`, `Explore` and `Plan` at that effort, so a built-in the agent still reaches runs at the pinned effort; the verification records which of the two the installed runtime does.

tmux-play admits `subagentEffort` beside `subagentModel` on Claude Captain and player configurations and in complete call settings, with the same omission semantics.

The rejected alternatives are an effort named in the directive's prose for the agent to request (the Agent tool cannot carry one, so it would be unenforceable), a single definition at the agent's own effort (the loophole restated), and level semantics in the directive (they differ by model line and the tool already describes each definition).

Canonical behavior is specified by [[engine-90](../packages/engine.md#engine-90)], [[engine-91](../packages/engine.md#engine-91)], [[engine-97](../packages/engine.md#engine-97)], [[claude-code-60](../packages/adapters/claude-code.md#claude-code-60)], [[claude-code-61](../packages/adapters/claude-code.md#claude-code-61)], [[claude-code-63](../packages/adapters/claude-code.md#claude-code-63)], [[claude-code-67](../packages/adapters/claude-code.md#claude-code-67)], [[tmux-play-211](../packages/tmux-play.md#tmux-play-211)], [[tmux-play-212](../packages/tmux-play.md#tmux-play-212)], and [[tmux-play-216](../packages/tmux-play.md#tmux-play-216)]; [[claude-code-69](../packages/adapters/claude-code.md#claude-code-69)] records that the installed runtime lets a definition override a built-in one by name.

## Consequences

The option, the literal, the definitions and the directive's first sentence are additive; omission preserves existing behavior, so this ships in a MINOR release.
A host that defaults a Claude agent's subagent model to `inherit` gives every such agent the directive and the definitions; that default is the host's decision, not this adapter's, which still composes nothing when the option is omitted.
A registered definition replaces the subagent's system prompt with the delegate prompt, so the built-in `general-purpose` keeps its own; the agent may still reach it, at the agent's effort unless the runtime lets a pinned effort override it by name.

## References

[1]: https://code.claude.com/docs/en/agent-sdk/typescript "Claude Agent SDK TypeScript reference"
[2]: https://code.claude.com/docs/en/sub-agents "Claude Code subagents"
[3]: https://code.claude.com/docs/en/model-config "Claude Code model configuration"
