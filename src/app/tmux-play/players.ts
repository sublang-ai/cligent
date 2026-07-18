// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { Cligent } from '../../cligent.js';
import type { EffortForAgent } from '../../effort.js';
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
}

type PlayerConfigByAdapter = {
  [A in PlayerAdapterName]: PlayerConfigBase & {
    adapter: A;
    effort?: EffortForAgent<A>;
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
    cligent: Cligent<EffortForAgent<A>>;
  };
};

export type ResolvedPlayer<A extends PlayerAdapterName = PlayerAdapterName> =
  ResolvedPlayerByAdapter[A];

export interface CreatePlayerCligentOptions<
  A extends PlayerAdapterName = PlayerAdapterName,
> {
  cwd?: string;
  model?: string;
  role?: string;
  permissions?: PermissionPolicy;
  effort?: EffortForAgent<A>;
  adapterImports?: PlayerAdapterImports;
}

export interface ResolvePlayersOptions {
  cwd?: string;
  adapterImports?: PlayerAdapterImports;
}

type AdapterConstructor<A extends PlayerAdapterName> = new () => AgentAdapter<
  EffortForAgent<A>
>;

export type PlayerAdapterImports = {
  [A in PlayerAdapterName]: () => Promise<AdapterConstructor<A>>;
};

interface UnvalidatedPlayerConfig {
  id: string;
  adapter: string;
}

const PLAYER_ID_RE = /^[a-z][a-z0-9_-]*$/;

const DEFAULT_ADAPTER_IMPORTS: PlayerAdapterImports = {
  claude: async () =>
    (await import('../../adapters/claude-code.js')).ClaudeCodeAdapter,
  codex: async () =>
    (await import('../../adapters/codex.js')).CodexAdapter,
  gemini: async () =>
    (await import('../../adapters/gemini.js')).GeminiAdapter,
  kimi: async () =>
    (await import('../../adapters/kimi.js')).KimiAdapter,
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
): Promise<Cligent<EffortForAgent<A>>> {
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
    model: options.model,
    role: options.role,
    permissions: options.permissions,
    effort: options.effort,
  });
}

export async function resolvePlayers(
  configs: readonly PlayerConfig[],
  options: ResolvePlayersOptions = {},
): Promise<ResolvedPlayer[]> {
  validatePlayerConfigs(configs);

  const adapterImports = options.adapterImports ?? DEFAULT_ADAPTER_IMPORTS;
  const players: ResolvedPlayer[] = [];

  for (const config of configs) {
    players.push(await resolvePlayer(config, options.cwd, adapterImports));
  }

  return players;
}

async function resolvePlayer<A extends PlayerAdapterName>(
  config: PlayerConfig<A>,
  cwd: string | undefined,
  adapterImports: PlayerAdapterImports,
): Promise<ResolvedPlayer<A>> {
  const cligent = await createPlayerCligent(config.adapter, {
    adapterImports,
    cwd,
    model: config.model,
    role: config.id,
    permissions: config.permissions,
    effort: config.effort,
  });
  return {
    id: config.id,
    adapter: config.adapter,
    model: config.model,
    instruction: config.instruction,
    cligent,
  } as ResolvedPlayer<A>;
}
