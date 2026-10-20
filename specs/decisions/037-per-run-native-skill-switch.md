<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-037: Per-Run Native Skill Switch

## Status

Accepted (2026-10-19).
Amends the engine option forwarding of [[engine-124](../packages/engine.md#engine-124)] and the omitted-or-empty row of [[engine-130](../packages/engine.md#engine-130)]: the native-skill selection travels with the skill list, and a run without skills leaves native discovery as [[engine-132](../packages/engine.md#engine-132)] selects it.
Amends the Codex carrier of [[codex-75](../packages/adapters/codex.md#codex-75)]: user-level and project skills stay unchanged only while native discovery stays on, and the run's own `skills.config` rules follow the user's.
Amends the overlay `.gemini/skills` row of [[gemini-51](../packages/adapters/gemini.md#gemini-51)] and the reconciliation of [[gemini-45](../packages/adapters/gemini.md#gemini-45)]: with native discovery off the overlay links no real user skill, and its `.gemini/skills` takes the same reconciliation.
Amends the OpenCode child environment of [[opencode-67](../packages/adapters/opencode.md#opencode-67)]: a run with native discovery off sets both configured skill arrays inline.
Amended by [DR-038](038-native-skills-in-tmux-play-call-settings.md): tmux-play call settings carry `nativeSkills`, while tmux-play configuration stays out of scope.
Field-list extensions of [[engine-1](../packages/engine.md#engine-1)], [[engine-3](../packages/engine.md#engine-3)], and [[engine-103](../packages/engine.md#engine-103)] add `nativeSkills` beside the existing options.

## Context

[DR-036](036-cross-agent-skill-installation.md) delivers a run's skills beside each runtime's own discovery, so `skills: []` clears only the run's carrier.
Hosts now install skills persistently into the folders the runtimes scan, `.claude/skills` for Claude Code and `.agents/skills` for the other four, in a project and in the home, and copy those folders from DR-036's prose.
Some calls must not read them: a Captain's routing and adjudication calls on Codex, Kimi, and OpenCode, which cannot restrict tools ([DR-010](010-isolated-captain-control-calls.md)), and calls whose inputs must be recorded, such as a compiler's.

No runtime offers one switch that drops its own sources and keeps a run carrier:

| Runtime | Native sources | Narrowest levers |
| --- | --- | --- |
| Claude Code | project and user skill directories and the plugins placed in them, synced skills, enabled plugins, bundled skills [[12]] | a parent policy `strictPluginOnlyCustomization: ['skills']` drops the non-plugin sources and every plugin placed in a skill directory, with all its components, in every thread, and is dropped where an admin policy tier exists that does not merge parent settings [[1]][[2]][[12]]; `disableBundledSkills` drops the bundled skills and workflows and hides built-in prompt commands from the model [[1]][[2]]; the SDK `skills` list filters the main thread alone, while subagents still list and invoke every discovered skill [[1]] |
| Codex | `.agents/skills` from the project root down to the working directory, project `.codex/skills`, `$CODEX_HOME/skills`, `~/.agents/skills`, `/etc/codex/skills`, bundled system skills, enabled plugins [[4]] | `skills.bundled.enabled=false`, and one `skills.config` override disabling each `SKILL.md` by exact path, since no rule names a directory and every global switch also drops plugin skills [[3]][[5]] |
| Gemini CLI | built-in, extension, user `.gemini/skills` and `.agents/skills` under the home the child receives, and workspace `.gemini/skills` and `.agents/skills` where trusted [[6]][[7]] | the per-run home decides the user tier; `skills.disabled` drops skills by name [[6]]; `skills.enabled: false` drops the carrier too [[13]][[14]], extensions go only as whole extensions [[6]], and untrusting the workspace forces the default approval mode [[15]] |
| Kimi Code | `.kimi-code/skills` and `.agents/skills` at the nearest `.git` ancestor of the working directory, `$KIMI_CODE_HOME/skills`, `~/.agents/skills`, configured `extra_skill_dirs`, enabled plugins, built-ins [[10]] | none the adapter reaches: `kimi acp` takes only `--login` and `--region` and passes no skill directory, the carrier and the project `.agents/skills` come from one project-root scan, and every other channel is the home's configuration [[11]] |
| OpenCode | `.claude/skills` and `.agents/skills` from the working directory to the worktree and in the home, `skill` and `skills` folders in every configuration directory (the global one, each `.opencode`, and `OPENCODE_CONFIG_DIR`), configured `skills.paths` and `skills.urls`, one built-in skill [[8]][[16]] | `OPENCODE_DISABLE_EXTERNAL_SKILLS` drops the `.claude` and `.agents` sources and nothing else [[9]]; inline configuration replaces the arrays of configuration files, but organization, managed, and macOS managed-preferences configuration merge after it [[17]]; only redirecting configuration reaches the configuration directories' folders |

## Decision

- One shared boolean option, `nativeSkills`, as an instance default and a per-call value: `false` turns off, for that run, the skills its runtime discovers by itself as far as the adapter's levers reach, while the run's `skills` still arrive; `true` or omission leaves native discovery as it is; a per-call value replaces the instance value, `true` included.
- A defined value other than a boolean is rejected on a built-in adapter before any provider work; a custom adapter receives the value unchanged.
- Every adapter that accepts `false` drops the project and user folders hosts install into, except that Claude subagents keep them under an administrator's policy tier that does not merge parent settings.
- Each lever stays within skills and skill folders, never disabling a whole feature such as plugins, extensions, project configuration, or instruction files, except that Claude adopts no plugin placed in a skill folder.
- Claude passes the parent policy `strictPluginOnlyCustomization: ['skills']`, `disableBundledSkills: true` beside its other flag settings, and the SDK main-thread skill list naming exactly the run's `cligent:<name>` skills.
- Codex passes `skills.bundled.enabled=false` and one `skills.config` override disabling, by real path, every `SKILL.md` found before the run under `.agents/skills` and `.codex/skills` of the working directory and each ancestor, `$CODEX_HOME/skills`, `~/.agents/skills`, and `/etc/codex/skills`, a superset of what the runtime scans.
- Gemini always takes the per-run home for such a run, its `.gemini/skills` a real directory holding only the run's skills and no `.agents` entry, and adds every workspace skill name other than a run skill's to the user-tier `skills.disabled`.
- Managed OpenCode sets `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` and inline `skills.paths` and `skills.urls` that replace the configured arrays.
- Runs that cannot honor `false` are rejected before backend invocation: every Kimi run, OpenCode's external server mode, Codex where a native skill root cannot be read or the disabled paths exceed the process-argument bound, and Gemini where the per-run home cannot be built, its workspace skills cannot be read, its user settings cannot take the names without changing whether the runtime validates them, or a workspace skill name changes under the runtime's settings expansion.
- Frozen `NATIVE_SKILL_SUPPORT` metadata, beside `SKILL_SUPPORT`, names for each adapter the project and user folders a host installs a persistent skill into, whether `nativeSkills: false` is accepted, and notes on what stays and which runs reject.
- Rejected: `settingSources: []` on Claude and `OPENCODE_DISABLE_CLAUDE_CODE`, which drop instruction files; `OPENCODE_DISABLE_PROJECT_CONFIG`, Gemini's `-e none`, and an untrusted Gemini workspace, which drop whole features; Gemini `skills.enabled: false`, which drops the carrier; enumerating Codex skills through a second app-server process per run; redirecting Kimi's home; and a type-level capability parameter, because OpenCode's support depends on its server mode.
- Out of scope: tmux-play configuration and Captain call settings, and hiding skill files from a model's file tools.

## Consequences

What stays with `nativeSkills: false`:

| Adapter | Still offered to the model |
| --- | --- |
| `claude-code` | to subagents, the skills of enabled marketplace plugins and managed policy skills, and, where an admin policy tier drops the parent policy, the project and user skills; the main thread lists only the run's skills either way |
| `codex` | skills of plugins enabled in user configuration, which loads only without a permission policy, and of account-installed plugins; a skill written after enumeration |
| `gemini` | extension and built-in skills, unless named like a disabled workspace skill, which disables them too; a workspace skill with a run skill's exact name, which shadows it, and one whose name differs only in letter case, which stays listed beside it |
| `opencode` | skill folders of every configuration directory (the global one, `OPENCODE_CONFIG_DIR`, and each `.opencode`); skill paths and URLs from organization, managed, or macOS managed-preferences configuration; the built-in skill; and the caller's own inline skill entries |

Claude adopts no plugin placed in `.claude/skills` or `~/.claude/skills` for such a run, so that plugin's agents, hooks, MCP servers, and commands go with its skills, and Claude's bundled workflows go with its bundled skills.
A resumed session keeps the native skill listings and skill bodies already in its history, so a caller isolating a call passes `resume: false` or resumes only a session every turn of which used `nativeSkills: false`.
No runtime reports before the first model turn what the model is offered, so the switch carries no delivery check: Claude's initialization still lists hidden built-in commands and ignores its main-thread filter.
A disabled skill stays readable through file tools, and a Gemini or Codex skill disabled by name or path stays in each runtime's own listing commands.
Gemini users lose their own `.gemini/skills` and `.agents/skills` for such a run, and Codex runs expose every native `SKILL.md` path in their process arguments.
Hosts read the install folders from `NATIVE_SKILL_SUPPORT` instead of copying them, and a host selecting an adapter for isolated calls reads whether it accepts the switch.
The option, metadata, and helper are additive, and omitting the option preserves existing behavior, so the feature ships in a MINOR release.

## References

[1]: https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.284/sdk.d.ts "Claude Agent SDK 0.3.284 skills, managedSettings, and settings options"
[2]: https://code.claude.com/docs/en/settings-reference "Claude Code settings: strictPluginOnlyCustomization and disableBundledSkills"
[3]: https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/core/config.schema.json "Codex 0.159.0 configuration schema"
[4]: https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/ext/skills/src/host_roots.rs "Codex 0.159.0 skill roots"
[5]: https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/config/src/skills_config.rs "Codex 0.159.0 skills.config rules"
[6]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/skills/skillManager.ts "Gemini CLI 0.61.0 skill discovery"
[7]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/paths.ts "Gemini CLI 0.61.0 home resolution through GEMINI_CLI_HOME"
[8]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/skill/index.ts "OpenCode 1.18.33 skill sources"
[9]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/effect/runtime-flags.ts "OpenCode 1.18.33 runtime flags"
[10]: https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/features/skill/catalog/skillRoots.ts "Kimi Code 2.1.1 skill roots"
[11]: https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/apps/kimi-code/src/cli/sub/acp.ts "Kimi Code 2.1.1 ACP subcommand options"
[12]: https://code.claude.com/docs/en/plugins/loading#find-where-a-plugin-came-from "Claude Code plugins adopted from a project or user skill directory"
[13]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/config.ts#L1055 "Gemini CLI 0.61.0 skills.enabled read as skills support"
[14]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/config/config.ts#L1537-L1545 "Gemini CLI 0.61.0 skills discovered only where skills support is truthy"
[15]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/config.ts#L758-L764 "Gemini CLI 0.61.0 approval mode forced to default in an untrusted folder"
[16]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/config/paths.ts#L23-L41 "OpenCode 1.18.33 configuration directories"
[17]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/config/config.ts#L482-L548 "OpenCode 1.18.33 organization, managed, and macOS managed-preferences configuration merged after inline configuration"
