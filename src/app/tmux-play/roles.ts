// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { Cligent } from '../../cligent.js';
import type { AgentAdapter } from '../../types.js';

export const KNOWN_ROLE_ADAPTERS = [
  'claude',
  'codex',
  'gemini',
  'opencode',
] as const;

export type RoleAdapterName = (typeof KNOWN_ROLE_ADAPTERS)[number];

export interface RoleConfig {
  id: string;
  adapter: string;
  model?: string;
  instruction?: string;
}

export interface ResolvedRole {
  id: string;
  adapter: RoleAdapterName;
  model?: string;
  instruction?: string;
  cligent: Cligent;
}

export interface CreateRoleCligentOptions {
  cwd?: string;
  model?: string;
  role?: string;
  adapterImports?: RoleAdapterImports;
}

export interface ResolveRolesOptions {
  cwd?: string;
  adapterImports?: RoleAdapterImports;
}

type AdapterConstructor = new () => AgentAdapter;

export type RoleAdapterImports = Record<
  RoleAdapterName,
  () => Promise<AdapterConstructor>
>;

const ROLE_ID_RE = /^[a-z][a-z0-9_-]*$/;

const DEFAULT_ADAPTER_IMPORTS: RoleAdapterImports = {
  claude: async () =>
    (await import('../../adapters/claude-code.js')).ClaudeCodeAdapter,
  codex: async () =>
    (await import('../../adapters/codex.js')).CodexAdapter,
  gemini: async () =>
    (await import('../../adapters/gemini.js')).GeminiAdapter,
  opencode: async () =>
    (await import('../../adapters/opencode.js')).OpenCodeAdapter,
};

export function isKnownRoleAdapter(name: string): name is RoleAdapterName {
  return (KNOWN_ROLE_ADAPTERS as readonly string[]).includes(name);
}

export function validateRoleConfigs(configs: readonly RoleConfig[]): void {
  const seen = new Set<string>();

  for (const config of configs) {
    if (!ROLE_ID_RE.test(config.id)) {
      throw new Error(
        `Invalid role id "${config.id}". Role ids must match ${ROLE_ID_RE.source}`,
      );
    }

    if (config.id === 'captain') {
      throw new Error('Invalid role id "captain": reserved for the Captain');
    }

    if (seen.has(config.id)) {
      throw new Error(`Duplicate role id: ${config.id}`);
    }
    seen.add(config.id);

    if (!isKnownRoleAdapter(config.adapter)) {
      throw new Error(
        `Unknown adapter "${config.adapter}" for role "${config.id}". ` +
          `Valid adapters: ${KNOWN_ROLE_ADAPTERS.join(', ')}`,
      );
    }
  }
}

export async function createRoleCligent(
  adapterName: RoleAdapterName,
  options: CreateRoleCligentOptions = {},
): Promise<Cligent> {
  const adapterImports = options.adapterImports ?? DEFAULT_ADAPTER_IMPORTS;
  const AdapterClass = await adapterImports[adapterName]();
  return new Cligent(new AdapterClass(), {
    cwd: options.cwd,
    model: options.model,
    role: options.role,
  });
}

export async function resolveRoles(
  configs: readonly RoleConfig[],
  options: ResolveRolesOptions = {},
): Promise<ResolvedRole[]> {
  validateRoleConfigs(configs);

  const adapterImports = options.adapterImports ?? DEFAULT_ADAPTER_IMPORTS;
  const roles: ResolvedRole[] = [];

  for (const config of configs) {
    const adapterName = config.adapter as RoleAdapterName;
    const cligent = await createRoleCligent(adapterName, {
      adapterImports,
      cwd: options.cwd,
      model: config.model,
      role: config.id,
    });

    roles.push({
      id: config.id,
      adapter: adapterName,
      model: config.model,
      instruction: config.instruction,
      cligent,
    });
  }

  return roles;
}
