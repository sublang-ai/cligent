<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# skills: Skill Installation

## Intent

This package defines caller-supplied skill directories, their validation, their run-scoped snapshot and removal, and transport discovery, per [DR-036](../decisions/036-cross-agent-skill-installation.md).
Its project-specific vocabulary is the public `skills` option and the `SkillSupport`, `SKILL_SUPPORT`, and `getSkillSupport` API.
It owns input validation and snapshot layout, leaving each adapter the native carrier that makes a snapshot discoverable and invocable.

## External Behavior

### skills-1

The `skills` option shall describe a readonly array of strings, each naming by path one skill directory or the `SKILL.md` file it holds, without remote sources, inline content, or a name override.

### skills-2

When a built-in adapter prepares a skill list, preparation shall select this result before any provider work, including managed-browser preparation [[mcp-4](mcp.md#mcp-4)], admitting an ASCII subset of the names [[1]] allows:

| Input | Result |
| --- | --- |
| absent or empty array | no skills |
| non-array | reject with the adapter and `skills` validation path |
| entry not a non-blank string, or containing NUL | reject with its adapter and indexed validation path |
| relative path | resolve against the effective run `cwd`, otherwise the process cwd |
| path naming a regular file named `SKILL.md` | use its parent directory as the skill directory |
| path naming neither an existing directory nor such a file, following ordinary filesystem symlinks | reject with its adapter and indexed path |
| directory without a regular `SKILL.md` | reject with its adapter and indexed path |
| `SKILL.md` not opening with a `---` YAML frontmatter block that maps `name` and `description` to strings | reject with its adapter and indexed path |
| `name` outside `^[a-z0-9]+(-[a-z0-9]+)*$` or longer than 64 characters | reject with its adapter and indexed path, naming the grammar |
| `name` differing from the basename of the skill directory's absolute path after relative resolution and lexical normalization, before any link resolution | reject with its adapter and indexed path, naming both |
| `description` empty once trimmed of whitespace, or longer than 1024 characters | reject with its adapter and indexed path |
| another `SKILL.md` anywhere below the skill directory, following symbolic links to directories, outside a carrier root an adapter of this package owns [[kimi-49](adapters/kimi.md#kimi-49)] | reject with its adapter and indexed path, naming the nested file |
| a symbolic link inside the skill directory whose target does not resolve, or resolves outside it | reject with its adapter and indexed path, naming the link |
| an entry below the skill directory that is neither a regular file, a directory, nor a symbolic link | reject with its adapter and indexed path, naming the entry |
| two entries resolving to the same `name` | reject with the adapter and the later entry's indexed path |
| accepted list | preserve order and caller strings without mutation, each skill identified by its `name` |

### skills-3

When a built-in adapter materializes an accepted list [[skills-2](#skills-2)] into a carrier root it created, or shares under its own carrier item, it shall create exactly one entry per skill not already present in that root, named by the skill's `name`, as a copy of the skill directory tree that omits any carrier root an adapter of this package owns [[kimi-49](adapters/kimi.md#kimi-49)], preserves file modes, gives each directory its mode with owner read, write, and search added once its entries are copied so the snapshot stays removable, re-expresses each symbolic link relative to its copied location through the link's resolved target so a link written through an alias of the skill still resolves inside the copy, or copies that resolved target where the host cannot create a link, writing each entry under a temporary name outside every directory the runtime scans for skills on the same filesystem and renaming it into place, and leave no other entry in that root once materialization completes except the entries its own carrier item places beside them.

### skills-4

Where an adapter's removal item binds this requirement, when a run that materialized or holds carrier entries ends, after its native process has exited or its adapter's containment has given up on that process, or before its terminal or rejection leaves the adapter where no native process started, the adapter's cleanup shall remove every carrier entry and root the run created or holds, deferring each entry or root another run of the same process still holds to the last such run's cleanup, and each parent directory it created while that parent is empty, attempting every removal, and select this outcome:

| Removal result | Outcome |
| --- | --- |
| every removal succeeds, or a parent is no longer empty | the run's ordinary outcome |
| a removal fails before terminal `done`, the caller signal has not fired, and the run's ordinary outcome carries no `error` event and is no rejection | one non-recoverable `error` with code `SKILL_CARRIER_CLEANUP_FAILED` naming the path, then `done` with `status: 'error'` keeping the run's result, resume token, and usage |
| a removal fails before terminal `done` or rejection, the caller signal has not fired, and the ordinary outcome already carries an `error` event or is a rejection | keep that outcome, appending each unremoved path to its message |
| a removal fails after terminal `done`, or after the caller signal fired | report it once through the adapter's cleanup reporter where one exists [[kimi-35](adapters/kimi.md#kimi-35)], otherwise suppress it as [[engine-8](engine.md#engine-8)] suppresses a post-terminal exception, leaving the path behind |

### skills-5

The exported `SKILL_SUPPORT` shall expose deeply frozen `SkillSupport` descriptors with readonly `carrier`, optional `namespace`, and explanatory `notes` members through this matrix, describing transport delivery without promising that a model selects a skill or that a runtime policy admits it:

| Adapter | `carrier` | `namespace` | Notes |
| --- | --- | --- | --- |
| `claude-code` | `'run-private'` | `'cligent'` | per-run local plugin [[claude-code-85](adapters/claude-code.md#claude-code-85)] checked at initialization [[claude-code-86](adapters/claude-code.md#claude-code-86)]; the `Skill` tool must stay in any explicit allowlist and out of `disallowedTools`, as must a `Skill(cligent:<name>)` or `Skill(cligent:*)` deny rule; the model lists `cligent:<name>` and resolves the bare name while it is unique; a run skill's `allowed-tools` widens the run's permissions while it is active; under a managed `allowManagedPermissionRulesOnly` the run's grants are ignored, so a skill setting `allowed-tools`, `disallowed-tools`, or `hooks` asks and is denied unless the permission mode or an approver admits the ask; a managed `disableSideloadFlags` makes the run fail at start; another enabled plugin named `cligent` collides |
| `codex` | `'run-private'` | `'cligent'` | per-run plugin under the Codex home plugin cache [[codex-75](adapters/codex.md#codex-75)]; no delivery evidence before the first model turn, so a runtime, or another Codex process sharing the home, that drops the cache entry or disables plugins leaves the skills silently absent; another enabled plugin named `cligent` collides |
| `gemini` | `'run-private'` | absent | user-tier skills in the per-run settings home [[gemini-51](adapters/gemini.md#gemini-51)] with an `activate_skill` allow rule [[gemini-52](adapters/gemini.md#gemini-52)] and the user tier's own policies beside a skills-only policy [[gemini-55](adapters/gemini.md#gemini-55)]; rejects a working directory equal to the real home, a native sandbox, user settings disabling skills, or a tool list excluding `activate_skill`; a same-named skill in the user's `.agents/skills` or a trusted workspace shadows a run skill, an extension skill whose name differs only in case captures its activation, and another settings scope's skill disables can suppress it; the carrier is removed with the settings overlay under that overlay's own cleanup contract; no delivery evidence before the first model turn |
| `kimi` | `'workspace'` | absent | a process-shared directory under the project root's `.kimi-code/skills` [[kimi-49](adapters/kimi.md#kimi-49)], visible to version control, to every concurrent Kimi run of the process whatever its own list, and to other Kimi processes, held until the process's last Kimi run with skills under any project root whose `.kimi-code/skills` resolves to that directory ends, checked through the ACP command list [[kimi-50](adapters/kimi.md#kimi-50)]; rejects a project root that is the operating-system home, a `.kimi-code/skills` resolving into the user's skill roots, a run skill containing that directory, and a run supplying another directory under a present entry's name, while a `.kimi-code/skills` aliasing a configured extra skill directory goes undetected; a worker thread of the process holds its own carrier, which the sweep leaves alone; a same-named skill registered earlier under `.kimi-code/skills` shadows a run skill, which that check catches only when the descriptions differ; a resumed session keeps its creation-time model listing |
| `opencode` | `'run-private'` | absent | managed server only, through inline configuration skill paths that replace configured `skills.paths` for the run [[opencode-67](adapters/opencode.md#opencode-67)], checked through the server's skill list [[opencode-69](adapters/opencode.md#opencode-69)], which a same-named skill discovered elsewhere can fail; external mode rejects a non-empty list |

### skills-6

When `getSkillSupport(agent)` is called, it shall return the matching frozen descriptor [[skills-5](#skills-5)], map `claude` to `claude-code`, and return `undefined` for any unknown adapter, leaving custom adapters responsible for their own skill contract.

## Verification

### skills-7

When filesystem integration tests prepare skill fixtures through accepted and rejected adapter paths, they shall verify the option shape [[skills-1](#skills-1)] and every preparation outcome [[skills-2](#skills-2)], including relative and absolute paths, a `SKILL.md` path, each frontmatter and name rejection, a nested `SKILL.md` behind a directory link, an owned carrier root below the skill accepted and left out of the copy, an escaping link, a dangling link, a whitespace-only description, a named pipe, duplicate names, and preserved ordering; verify a materialized root's entries, copied modes, relative and rewritten links, temporary-name writes outside the scanned directories and their renames, reuse of a present entry, cancellation between copied entries, and absence of other files [[skills-3](#skills-3)]; and verify removal after the native process exits and after a run that never spawned, deferral of a held entry and root to the last holding run, an empty and a non-empty created parent, and a forced removal failure before the terminal of a succeeding run, of a failing run, and of a rejected run, after the terminal, and after a caller abort, each taking its outcome [[skills-4](#skills-4)].

### skills-8

When a consumer imports skill discovery through the package entry point, the integration check shall verify the descriptor matrix and nested immutability [[skills-5](#skills-5)] and canonical, alias, and unknown lookup results [[skills-6](#skills-6)].

## References

[1]: https://agentskills.io/specification "Agent Skills specification"
