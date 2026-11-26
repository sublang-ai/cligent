<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-046: Primary and Subagent Defaults

## Status

Accepted (2026-11-14).
Amends [DR-044](044-codex-subagent-tuning.md).
Amended by [DR-047](047-provider-aware-model-defaults-and-fork-history.md).

## Context

The owner selects Claude Fable 5.2 with Opus 5.5 subagents and GPT-6 Astra with GPT-6.1 Sol subagents for shipped configurations.
Astra and legacy Codex parents advertise different spawn schemas: `collaboration.spawn_agent` uses `fork_turns`, while `multi_agent_v1.spawn_agent` uses `fork_context`.
Hardcoding either field in shared delegation instructions misguides the other runtime surface.

## Decision

Generated tmux-play Claude roles pin `claude-fable-5-2` with `claude-opus-5-5` subagents; Codex roles pin `gpt-6-astra` with `gpt-6.1-sol` subagents.
Both retain their existing `xhigh` parent effort and leave subagent effort unconfigured.
Existing configuration values and omitted library options remain unchanged.
The Claude runtime floor follows the oldest published SDK carrying Fable 5.2 under [DR-027](027-latest-models-oldest-serving-runtime.md), independently of the tested SDK pin.
The shipped pairs apply to direct providers, and history selection stays independent of tuning ([DR-047](047-provider-aware-model-defaults-and-fork-history.md)).
This amends [DR-044](044-codex-subagent-tuning.md): the directive names no schema-specific field and retains the native precedence, bounded delegation, briefing, and verification requirements of [DR-044](044-codex-subagent-tuning.md).
Canonical behavior lives in [[tmux-play-11](../packages/tmux-play.md#tmux-play-11)] and [[codex-88](../packages/adapters/codex.md#codex-88)].

## Consequences

First-run configurations carry the requested model hierarchy without changing explicit user choices.
Both native Codex spawn schemas receive actionable instructions, and acceptance checks observe real children under both parent profiles.
The Claude compatibility floor rise ships in a minor release under [[package-17](../packages/package.md#package-17)].
