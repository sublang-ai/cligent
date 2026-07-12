// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { Cligent } from '../../cligent.js';
import type {
  AgentAdapter,
  PermissionPolicy,
  PortableEffort,
} from '../../types.js';

export const KNOWN_PLAYER_ADAPTERS = [
  'claude',
  'codex',
  'gemini',
  'opencode',
] as const;

export type PlayerAdapterName = (typeof KNOWN_PLAYER_ADAPTERS)[number];

export interface PlayerConfig {
  id: string;
  adapter: string;
  model?: string;
  instruction?: string;
  permissions?: PermissionPolicy;
  reasoningEffort?: PortableEffort;
}

export interface ResolvedPlayer {
  id: string;
  adapter: PlayerAdapterName;
  model?: string;
  instruction?: string;
  cligent: Cligent;
}

export interface CreatePlayerCligentOptions {
  cwd?: string;
  model?: string;
  role?: string;
  permissions?: PermissionPolicy;
  reasoningEffort?: PortableEffort;
  adapterImports?: PlayerAdapterImports;
}

export interface ResolvePlayersOptions {
  cwd?: string;
  adapterImports?: PlayerAdapterImports;
}

type AdapterConstructor = new () => AgentAdapter;

export type PlayerAdapterImports = Record<
  PlayerAdapterName,
  () => Promise<AdapterConstructor>
>;

const PLAYER_ID_RE = /^[a-z][a-z0-9_-]*$/;

const DEFAULT_ADAPTER_IMPORTS: PlayerAdapterImports = {
  claude: async () =>
    (await import('../../adapters/claude-code.js')).ClaudeCodeAdapter,
  codex: async () =>
    (await import('../../adapters/codex.js')).CodexAdapter,
  gemini: async () =>
    (await import('../../adapters/gemini.js')).GeminiAdapter,
  opencode: async () =>
    (await import('../../adapters/opencode.js')).OpenCodeAdapter,
};

export function isKnownPlayerAdapter(name: string): name is PlayerAdapterName {
  return (KNOWN_PLAYER_ADAPTERS as readonly string[]).includes(name);
}

export function validatePlayerConfigs(configs: readonly PlayerConfig[]): void {
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

export async function createPlayerCligent(
  adapterName: PlayerAdapterName,
  options: CreatePlayerCligentOptions = {},
): Promise<Cligent> {
  const adapterImports = options.adapterImports ?? DEFAULT_ADAPTER_IMPORTS;
  const AdapterClass = await adapterImports[adapterName]();
  return new Cligent(new AdapterClass(), {
    cwd: options.cwd,
    model: options.model,
    role: options.role,
    permissions: options.permissions,
    effort: options.reasoningEffort,
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
    const adapterName = config.adapter as PlayerAdapterName;
    const cligent = await createPlayerCligent(adapterName, {
      adapterImports,
      cwd: options.cwd,
      model: config.model,
      role: config.id,
      permissions: config.permissions,
      reasoningEffort: config.reasoningEffort,
    });

    players.push({
      id: config.id,
      adapter: adapterName,
      model: config.model,
      instruction: config.instruction,
      cligent,
    });
  }

  return players;
}
