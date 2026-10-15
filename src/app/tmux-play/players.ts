// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { Cligent } from '../../cligent.js';
import type { EffortForAgent } from '../../effort.js';
import type { FastModeForAgent } from '../../fast-mode.js';
import type {
  SubagentEffortForAgent,
  SubagentModelForAgent,
} from '../../subagent-model.js';
import { normalizeMcpServers, type McpServers } from '../../mcp.js';
import type { AgentAdapter, PermissionPolicy } from '../../types.js';

export const KNOWN_PLAYER_ADAPTERS = [
  'claude',
  'codex',
  'gemini',
  'kimi',
  'opencode',
] as const;

export type PlayerAdapterName = (typeof KNOWN_PLAYER_ADAPTERS)[number];

interface PlayerConfigBase {
  id: string;
  model?: string;
  instruction?: string;
  permissions?: PermissionPolicy;
  browser?: boolean;
  mcpServers?: McpServers;
  /** tmux-play-226: skill directories replacing the top-level list. */
  skills?: readonly string[];
}

type PlayerConfigByAdapter = {
  [A in PlayerAdapterName]: PlayerConfigBase & {
    adapter: A;
    effort?: EffortForAgent<A>;
    fastMode?: FastModeForAgent<A>;
    subagentModel?: SubagentModelForAgent<A>;
    subagentEffort?: SubagentEffortForAgent<A>;
  };
};

export type PlayerConfig<A extends PlayerAdapterName = PlayerAdapterName> =
  PlayerConfigByAdapter[A];

type ResolvedPlayerByAdapter = {
  [A in PlayerAdapterName]: {
    id: string;
    adapter: A;
    model?: string;
    instruction?: string;
    permissions?: PermissionPolicy;
    browser?: boolean;
    mcpServers?: McpServers;
    /** The player's own skill list, a detached frozen copy; absent inherits. */
    skills?: readonly string[];
    effort?: EffortForAgent<A>;
    fastMode?: FastModeForAgent<A>;
    subagentModel?: SubagentModelForAgent<A>;
    subagentEffort?: SubagentEffortForAgent<A>;
    cligent: PlayerCligent<A>;
  };
};

export type ResolvedPlayer<A extends PlayerAdapterName = PlayerAdapterName> =
  ResolvedPlayerByAdapter[A];

/** A `Cligent` bound to one built-in adapter's effort, fast-mode,
 * subagent-model, and subagent-effort capabilities. */
type PlayerCligent<A extends PlayerAdapterName> = Cligent<
  EffortForAgent<A>,
  FastModeForAgent<A>,
  SubagentModelForAgent<A>,
  SubagentEffortForAgent<A>
>;

export interface CreatePlayerCligentOptions<
  A extends PlayerAdapterName = PlayerAdapterName,
> {
  cwd?: string;
  model?: string;
  role?: string;
  permissions?: PermissionPolicy;
  browser?: boolean;
  mcpServers?: McpServers;
  skills?: readonly string[];
  effort?: EffortForAgent<A>;
  fastMode?: FastModeForAgent<A>;
  subagentModel?: SubagentModelForAgent<A>;
  subagentEffort?: SubagentEffortForAgent<A>;
  adapterImports?: PlayerAdapterImports;
}

export interface ResolvePlayersOptions {
  cwd?: string;
  adapterImports?: PlayerAdapterImports;
}

type AdapterConstructor<A extends PlayerAdapterName> = new () => AgentAdapter<
  EffortForAgent<A>,
  FastModeForAgent<A>,
  SubagentModelForAgent<A>,
  SubagentEffortForAgent<A>
>;

export type PlayerAdapterImports = {
  [A in PlayerAdapterName]: () => Promise<AdapterConstructor<A>>;
};

interface UnvalidatedPlayerConfig {
  id: string;
  adapter: string;
}

const PLAYER_ID_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;

export const DEFAULT_ADAPTER_IMPORTS: PlayerAdapterImports = {
  claude: async () =>
    (await import('../../adapters/claude-code.js')).ClaudeCodeAdapter,
  codex: async () => (await import('../../adapters/codex.js')).CodexAdapter,
  gemini: async () => (await import('../../adapters/gemini.js')).GeminiAdapter,
  kimi: async () => (await import('../../adapters/kimi.js')).KimiAdapter,
  opencode: async () =>
    (await import('../../adapters/opencode.js')).OpenCodeAdapter,
};

export function isKnownPlayerAdapter(name: string): name is PlayerAdapterName {
  return (KNOWN_PLAYER_ADAPTERS as readonly string[]).includes(name);
}

export function validatePlayerConfigs(
  configs: readonly UnvalidatedPlayerConfig[],
): void {
  const seen = new Set<string>();

  for (const config of configs) {
    if (!PLAYER_ID_RE.test(config.id)) {
      throw new Error(
        `Invalid player id "${config.id}". Player ids must match ${PLAYER_ID_RE.source}`,
      );
    }

    if (config.id === 'captain') {
      throw new Error('Invalid player id "captain": reserved for the Captain');
    }

    if (seen.has(config.id)) {
      throw new Error(`Duplicate player id: ${config.id}`);
    }
    seen.add(config.id);

    if (!isKnownPlayerAdapter(config.adapter)) {
      throw new Error(
        `Unknown adapter "${config.adapter}" for player "${config.id}". ` +
          `Valid adapters: ${KNOWN_PLAYER_ADAPTERS.join(', ')}`,
      );
    }
  }
}

export async function createPlayerCligent<A extends PlayerAdapterName>(
  adapterName: A,
  options: CreatePlayerCligentOptions<NoInfer<A>> = {},
): Promise<PlayerCligent<A>> {
  return createPlayerCligentInternal(adapterName, options, true);
}

/** @internal tmux-play keeps call defaults outside runtime-owned Cligent. */
export async function createRuntimePlayerCligent<A extends PlayerAdapterName>(
  adapterName: A,
  options: CreatePlayerCligentOptions<NoInfer<A>> = {},
): Promise<PlayerCligent<A>> {
  return createPlayerCligentInternal(adapterName, options, false);
}

async function createPlayerCligentInternal<A extends PlayerAdapterName>(
  adapterName: A,
  options: CreatePlayerCligentOptions<NoInfer<A>>,
  inheritCallDefaults: boolean,
): Promise<PlayerCligent<A>> {
  if (!isKnownPlayerAdapter(adapterName)) {
    throw new Error(
      `Unknown adapter "${adapterName}". ` +
        `Valid adapters: ${KNOWN_PLAYER_ADAPTERS.join(', ')}`,
    );
  }
  const adapterImports = options.adapterImports ?? DEFAULT_ADAPTER_IMPORTS;
  const AdapterClass = await adapterImports[adapterName]();
  return new Cligent(new AdapterClass(), {
    cwd: options.cwd,
    role: options.role,
    ...(inheritCallDefaults
      ? {
          browser: options.browser,
          mcpServers: normalizeMcpServers(options.mcpServers),
          skills: options.skills,
          model: options.model,
          permissions: options.permissions,
          effort: options.effort,
          fastMode: options.fastMode,
          subagentModel: options.subagentModel,
          subagentEffort: options.subagentEffort,
        }
      : {}),
  });
}

export async function resolvePlayers(
  configs: readonly PlayerConfig[],
  options: ResolvePlayersOptions = {},
): Promise<ResolvedPlayer[]> {
  return resolvePlayersInternal(configs, options, true);
}

/** @internal tmux-play keeps call defaults outside runtime-owned Cligent. */
export async function resolveRuntimePlayers(
  configs: readonly PlayerConfig[],
  options: ResolvePlayersOptions = {},
): Promise<ResolvedPlayer[]> {
  return resolvePlayersInternal(configs, options, false);
}

async function resolvePlayersInternal(
  configs: readonly PlayerConfig[],
  options: ResolvePlayersOptions,
  inheritCallDefaults: boolean,
): Promise<ResolvedPlayer[]> {
  validatePlayerConfigs(configs);

  const adapterImports = options.adapterImports ?? DEFAULT_ADAPTER_IMPORTS;
  const players: ResolvedPlayer[] = [];

  for (const config of configs) {
    players.push(
      await resolvePlayer(
        config,
        options.cwd,
        adapterImports,
        inheritCallDefaults,
      ),
    );
  }

  return players;
}

async function resolvePlayer<A extends PlayerAdapterName>(
  config: PlayerConfig<A>,
  cwd: string | undefined,
  adapterImports: PlayerAdapterImports,
  inheritCallDefaults: boolean,
): Promise<ResolvedPlayer<A>> {
  const cligent = await createPlayerCligentInternal(
    config.adapter,
    {
      adapterImports,
      cwd,
      model: config.model,
      role: config.id,
      permissions: config.permissions,
      browser: config.browser,
      mcpServers: config.mcpServers,
      skills: config.skills,
      effort: config.effort,
      fastMode: config.fastMode,
      subagentModel: config.subagentModel,
      subagentEffort: config.subagentEffort,
    },
    inheritCallDefaults,
  );
  return {
    id: config.id,
    adapter: config.adapter,
    model: config.model,
    instruction: config.instruction,
    permissions: config.permissions,
    browser: config.browser,
    mcpServers: normalizeMcpServers(config.mcpServers),
    skills: frozenSkillList(config.skills),
    effort: config.effort,
    fastMode: config.fastMode,
    subagentModel: config.subagentModel,
    subagentEffort: config.subagentEffort,
    cligent,
  } as ResolvedPlayer<A>;
}

// ---------------------------------------------------------------------------
// Skills (tmux-play-226)

/**
 * Validate a top-level or role `skills` value's shape, naming `path` and the
 * offending index. Directory validation is the adapter's (skills-2).
 */
export function validateSkillList(
  value: unknown,
  path: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of skill directory paths`);
  }
  const entries: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index];
    if (
      typeof entry !== 'string' ||
      entry.trim().length === 0 ||
      entry.includes('\0')
    ) {
      throw new Error(
        `${path}[${index}] must be a non-blank skill directory path without NUL`,
      );
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * tmux-play-226: a programmatic `skills` value as a detached frozen copy,
 * validated after it is taken, so a caller mutating its own array once the
 * factory has been called cannot change the list the runtime admitted.
 */
export function admitSkillList(
  value: unknown,
  path: string,
): readonly string[] | undefined {
  const copy: unknown = Array.isArray(value)
    ? Object.freeze([...(value as unknown[])])
    : value;
  validateSkillList(copy, path);
  return copy as readonly string[] | undefined;
}

/** A detached frozen copy of a skill list, or undefined when absent. */
export function frozenSkillList(
  skills: readonly string[] | undefined,
): readonly string[] | undefined {
  return skills === undefined ? undefined : Object.freeze([...skills]);
}

/** One role's effective skill list and the path its entries are named by. */
export interface SkillRole {
  /** `captain` or `players[i]`. */
  readonly role: string;
  readonly adapter: string;
  readonly skills?: readonly string[];
  /** The list's own path: the role's `skills`, or top-level `skills` when inherited. */
  readonly path: string;
}

/**
 * tmux-play-226: each role's effective list, its own `skills` replacing the
 * top-level default.
 */
export function skillRoles(
  topLevel: readonly string[] | undefined,
  captain: { readonly adapter: string; readonly skills?: readonly string[] },
  players: readonly {
    readonly adapter: string;
    readonly skills?: readonly string[];
  }[],
): SkillRole[] {
  const role = (
    label: string,
    entry: { readonly adapter: string; readonly skills?: readonly string[] },
  ): SkillRole =>
    entry.skills !== undefined
      ? {
          role: label,
          adapter: entry.adapter,
          skills: entry.skills,
          path: `${label}.skills`,
        }
      : {
          role: label,
          adapter: entry.adapter,
          skills: topLevel,
          path: 'skills',
        };
  return [
    role('captain', captain),
    ...players.map((player, index) => role(`players[${index}]`, player)),
  ];
}

/**
 * tmux-play-226: reject two Kimi roles whose lists map one skill name to
 * different directories, because their concurrent runs share one carrier per
 * project root and kimi-49 rejects the later run. Each entry resolves against
 * `cwd` to its skill directory, a `SKILL.md` file naming its parent, with
 * links followed as kimi-49 records a source; the name is the lexical
 * directory's basename, which skills-2 requires the skill's own name to equal.
 * An entry that cannot be resolved is left to the adapter's validation.
 */
export async function assertKimiSkillsUndisputed(
  roles: readonly SkillRole[],
  cwd: string,
): Promise<void> {
  const byName = new Map<
    string,
    {
      readonly role: string;
      readonly entry: string;
      readonly directory: string;
    }
  >();
  for (const role of roles) {
    if (role.adapter !== 'kimi' || role.skills === undefined) continue;
    for (const [index, entry] of role.skills.entries()) {
      const { name, directory } = await kimiSkillDirectory(entry, cwd);
      const entryPath = `${role.path}[${index}]`;
      const earlier = byName.get(name);
      if (earlier === undefined) {
        byName.set(name, { role: role.role, entry: entryPath, directory });
        continue;
      }
      if (earlier.role === role.role || earlier.directory === directory) {
        continue;
      }
      throw new Error(
        `${earlier.entry} for ${earlier.role} and ${entryPath} for ${role.role} ` +
          `map skill name "${name}" to different directories on adapter "kimi": ` +
          `${earlier.directory} and ${directory}; their concurrent Kimi runs ` +
          'would dispute the name',
      );
    }
  }
}

async function kimiSkillDirectory(
  entry: string,
  cwd: string,
): Promise<{ readonly name: string; readonly directory: string }> {
  const given = resolve(cwd, entry);
  let directory = given;
  try {
    const stats = await stat(given);
    if (stats.isFile() && basename(given) === 'SKILL.md') {
      directory = dirname(given);
    }
  } catch {
    // A missing path keeps its lexical form; the adapter rejects it.
  }
  let resolved = directory;
  try {
    resolved = await realpath(directory);
  } catch {
    // Unresolvable: compare lexically; the adapter rejects it.
  }
  return { name: basename(directory), directory: resolved };
}
