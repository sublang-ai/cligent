<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-036: Cross-Agent Skill Installation

## Status

Accepted (2026-10-15).
Amends the engine option forwarding of [[engine-124](../packages/engine.md#engine-124)]: the skill list travels with the MCP map and browser selection.
Amends the Claude tool mapping of [[claude-code-9](../packages/adapters/claude-code.md#claude-code-9)] and preparation cancellation of [[claude-code-73](../packages/adapters/claude-code.md#claude-code-73)]: skill grants extend `allowedTools`, populating it when otherwise undefined, and skill preparation cancels like attachment preparation.
Amends the Codex preparation cancellation of [[codex-69](../packages/adapters/codex.md#codex-69)]: skill preparation cancels like attachment preparation.
Amends the Gemini policy mapping of [[gemini-12](../packages/adapters/gemini.md#gemini-12)] and overlay reconciliation of [[gemini-45](../packages/adapters/gemini.md#gemini-45)]: a skills run generates a policy file, and the run's skills and the links beside them are not reconciled into the real home.
Amends the Kimi wire boundary of [[kimi-27](../packages/adapters/kimi.md#kimi-27)] and terminal priority of [[kimi-33](../packages/adapters/kimi.md#kimi-33)]: `available_commands_update` is retained for a skills run from its session setup request, and a carrier removal failure after child close is an error terminal.
Amends the OpenCode cancellation matrix of [[opencode-9](../packages/adapters/opencode.md#opencode-9)]: skill preparation before managed spawn is a cancellation phase.
Amends the tmux-play Captain control-call mapping of [[tmux-play-88](../packages/tmux-play.md#tmux-play-88)]: a call restricting tools away from the skill tool passes no skills.
Field-list extensions of [[engine-1](../packages/engine.md#engine-1)], [[engine-3](../packages/engine.md#engine-3)], [[engine-103](../packages/engine.md#engine-103)], [[tmux-play-5](../packages/tmux-play.md#tmux-play-5)], [[tmux-play-6](../packages/tmux-play.md#tmux-play-6)], [[tmux-play-7](../packages/tmux-play.md#tmux-play-7)], [[tmux-play-29](../packages/tmux-play.md#tmux-play-29)], [[tmux-play-90](../packages/tmux-play.md#tmux-play-90)], and [[tmux-play-175](../packages/tmux-play.md#tmux-play-175)] add `skills` beside the existing options; [[tmux-play-34](../packages/tmux-play.md#tmux-play-34)] snapshots relative entries as absolute paths, and [[tmux-play-93](../packages/tmux-play.md#tmux-play-93)] admits and rejects supplied lists.

## Context

The Agent Skills convention defines a skill as a directory holding `SKILL.md` with `name` and `description` frontmatter beside optional scripts, references, and assets, and asks the name to equal the directory name [[1]].
All five runtimes discover such directories from their own locations: Claude Code from `.claude/skills` beside the working directory and under its user configuration directory [[2]], and Codex, Gemini CLI, Kimi Code, and OpenCode from `.agents/skills` and their own project and user directories [[3]][[4]][[5]][[6]].
They key a skill differently: Claude keys it by its directory name and accepts the frontmatter name as an alias, while the other four use the frontmatter name, so only a skill whose name equals its directory name has one name everywhere [[2]].
Hosts such as tmux-play run players of different runtimes in one working directory and want one skill to reach all of them without committing it to the repository or installing it into every runtime's home.

Four runtimes expose a per-run channel that needs no workspace write.
Claude's Agent SDK loads local plugins whose `skills/` entries become `<plugin>:<skill>` skills, whatever the run's setting sources select [[7]][[13]].
Codex enables a plugin per run from the plugin cache under its home through the configuration override channel the adapter already drives [[codex-70](../packages/adapters/codex.md#codex-70)] [[8]][[9]].
Gemini reads user-tier skills from the home directory the adapter can already replace per run for model aliases and MCP servers [[gemini-34](../packages/adapters/gemini.md#gemini-34)] [[4]].
A managed OpenCode server reads extra skill directories from the inline configuration in its environment [[10]].
Kimi's ACP server takes no skill directory flag, its home holds its configuration and OAuth credentials, `extra_skill_dirs` lives in that global configuration, and a redirected `HOME` reaches every tool subprocess, so its only channel that writes no user state is the project root it scans: `.kimi-code/skills` or `.agents/skills` under the nearest `.git` ancestor of the session's working directory [[5]][[11]].

Discovery is not invocation.
Claude's `Skill` tool must be in any explicit tool list [[13]], and a skill whose frontmatter declares tools or hooks asks before it runs, which a headless run without an approver denies [[2]].
Gemini's bundled headless policy denies `activate_skill` [[12]].
Codex, Kimi, and OpenCode invoke skills by default [[3]][[5]][[6]].
Cligent's shared options follow one pattern: a shared option, a per-adapter native mapping, and frozen support metadata, with rejection before backend invocation where a transport cannot honor the request.

## Decision

- One shared option, `skills`, lists skill directories by path, or the `SKILL.md` file each holds, as an instance default and a per-call value; a per-call list replaces the instance list for that call, including an empty one.
- One validation before any provider work admits only the portable subset of the convention: `SKILL.md` frontmatter whose `name` equals the directory name in the ASCII lowercase letter, digit, and hyphen grammar and whose `description` is non-empty and at most 1024 characters, a flat layout with no nested `SKILL.md` and no link escaping the directory, and distinct names in one list; a skill is rejected, never rewritten.
- Delivery is a run-scoped snapshot: each accepted directory is copied into a carrier the runtime discovers for that run, entries written under temporary names and renamed into place, and the copy is removed after the native process exits, or before the run's terminal or rejection where no process started; no run writes user-level configuration, credentials, or persistent agent state.
- A removal failure before the terminal is an error terminal with code `SKILL_CARRIER_CLEANUP_FAILED` that keeps the run's resume token; after the terminal, or after a caller abort, it is reported through the adapter's cleanup reporter where one exists and otherwise suppressed.
- Each adapter uses the per-run channel its runtime offers: Claude a private local plugin named `cligent` through the SDK `plugins` option with MCP discovery skipped; Codex a private plugin named `cligent` under a marketplace named for this host, process, and run in the Codex home plugin cache, enabled by one unquoted single-entry configuration override and swept of marketplaces left by dead processes; Gemini the user-tier skills directory of the per-run settings home, with the run's names removed from the user's disabled list; managed OpenCode the run's paths appended to the caller's own inline configuration in the server's environment, left for the runtime's own substitution and classification.
- Kimi alone writes into the workspace: one directory per Cligent process, named for this host and process, under `<project root>/.kimi-code/skills`, the project root being the nearest `.git` ancestor of the effective working directory or that directory itself, shared by that process's concurrent runs, which reuse an entry supplied from the same directory and are rejected when they supply another directory under the same name, swept of carriers left by dead processes of this host, and removed once no Kimi run of the process remains active; a project root that is the operating-system home or whose `.kimi-code` is the Kimi home is rejected.
- Invocation is opened where the runtime would otherwise refuse it: Claude adds one `Skill(cligent:<name>)` allow rule per skill and rejects a tool restriction that excludes the `Skill` tool; Gemini adds an `activate_skill` allow rule to the per-run policy, rejects a tool restriction that excludes the tool, and passes the runtime's merged policy sources beside a policy file that holds only that rule; Codex, Kimi, and OpenCode keep their native defaults.
- Delivery is verified where the transport gives evidence before the first model turn: Claude's initialization lists the plugin and each skill, Kimi's first command list from its session setup request names every skill with its description, and a managed OpenCode server lists every skill at its injected location; Codex and Gemini give no such evidence, and their support notes say so.
- Runs the carrier cannot serve are rejected before browser preparation: Gemini's real-home working directory, native sandbox, and user settings that disable skills, OpenCode's external server mode, Kimi's home project root and a concurrent run disputing a skill name, and the tool restrictions above.
- Frozen `SKILL_SUPPORT` metadata names each adapter's carrier kind, the namespace the model sees, and its limits.
- tmux-play accepts `skills` at the top level, applied to the Captain and every player, and on a role, replacing the top-level list for that role; YAML entries resolve against the config file's directory at load time, programmatic entries against the run's working directory; two Kimi roles mapping one name to different directories are rejected at load, and a Captain control call that restricts tools away from the skill tool passes no skills.
- Out of scope: persistent installation into a repository or a home, which a host does by copying a skill into `.agents/skills` or `.claude/skills` itself; remote skill sources; renaming or rewriting a skill; translating runtime-specific frontmatter.

## Consequences

On Claude and Codex the model lists a run's skill as `cligent:<name>`; Claude also resolves the bare name while it is unique, and Codex injects the body for a `$cligent:<name>` mention.
A same-named skill the runtime discovers elsewhere can shadow a run's skill on Gemini, Kimi, and OpenCode, and the support notes disclose where; Claude and Codex names collide only with another enabled plugin named `cligent`.
On Kimi every concurrent Kimi run sharing a project root, including one with no skills of its own, discovers every other Kimi run's skills, so tmux-play's per-role selection does not hold there.
A resumed session keeps transcript references to the previous run's carrier paths, so a caller keeping a session's skills passes them on every call; Kimi rebuilds its command list from the working directory a session was created with and keeps the model listing persisted at creation, so a session resumed elsewhere fails the delivery check instead of silently lacking the skill.
The Kimi carrier is visible to version control and to every other live Kimi process in the same project root while it lasts, and an abnormal exit leaves it, or a Codex run's marketplace directory, behind until a later run of another process on the same host sweeps it.
The Codex carrier relies on the runtime leaving an unknown marketplace's cache entry in place: the real-runtime acceptance check shows this for the run's own process, but no check shows it for another Codex process sharing that home, such as a desktop application's server.
OpenCode's inline configuration replaces a `skills.paths` array from the user's configuration files for the run.
Managed and admin settings keep their authority: Claude's `disableSideloadFlags` makes the run fail at start, its `allowManagedPermissionRulesOnly` ignores the run's grants so a skill setting `allowed-tools`, `disallowed-tools`, or `hooks` asks and is denied unless the permission mode or an approver admits the ask, and Gemini's `admin.skills.enabled` turns discovery off.
Gemini user settings that disable skills reject a skills run rather than being overridden, because enabling discovery for the run would also load the user's other skill sources.
A run skill's `allowed-tools` frontmatter widens a Claude run's permissions while the skill is active, under the runtime's own rule.
Policy-bearing Gemini runs keep dropping the runtime's other policy sources, so a configured rule never widens an explicit restriction; only a skills-only policy file carries them.
DR-030's confinement holds because the Claude plugin skips MCP discovery, and Codex's home keeps its authentication and session state because the plugin cache entry is a run-scoped artifact rather than configuration.
Copying costs time proportional to the skill directories' size on every run.
Runtime-specific frontmatter stays uneven: Claude's `allowed-tools` and `hooks` act only on Claude, `disable-model-invocation` hides a skill on Claude and Kimi only, Kimi skips a skill with an unsupported `type`, and Codex hides a skill whose `agents/openai.yaml` disables implicit invocation.

## References

[1]: https://agentskills.io/specification "Agent Skills specification"
[2]: https://code.claude.com/docs/en/skills "Claude Code skills"
[3]: https://learn.chatgpt.com/docs/build-skills "Codex skills"
[4]: https://geminicli.com/docs/cli/skills/ "Gemini CLI Agent Skills"
[5]: https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills "Kimi Code Agent Skills"
[6]: https://opencode.ai/docs/skills/ "OpenCode Agent Skills"
[7]: https://code.claude.com/docs/en/agent-sdk/plugins "Claude Agent SDK plugins"
[8]: https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/core/config.schema.json "Codex 0.159.0 configuration schema"
[9]: https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/core-plugins/src/store.rs#L85 "Codex 0.159.0 plugin cache under the Codex home"
[10]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/skill/index.ts#L211 "OpenCode 1.18.33 configured skill paths"
[11]: https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/features/skill/catalog/skillRoots.ts "Kimi Code 2.1.1 project skill roots"
[12]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/policy/policies/write.toml#L96-L108 "Gemini CLI 0.61.0 headless activate_skill denial"
[13]: https://code.claude.com/docs/en/agent-sdk/claude-code-features "Claude Agent SDK setting sources and the Skill tool in an explicit tool list"
