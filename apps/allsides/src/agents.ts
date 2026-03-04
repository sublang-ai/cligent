// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { Cligent } from '@sublang/cligent';

export interface AgentEntry {
  name: string;
  model?: string;
}

export interface ResolvedAgent {
  name: string;
  cligent: Cligent;
}

const KNOWN_AGENTS = ['claude', 'codex', 'gemini', 'opencode'] as const;

type KnownAgentName = (typeof KNOWN_AGENTS)[number];

const ADAPTER_IMPORTS: Record<
  KnownAgentName,
  () => Promise<{ new (): import('@sublang/cligent').AgentAdapter }>
> = {
  claude: async () =>
    (await import('@sublang/cligent/adapters/claude-code')).ClaudeCodeAdapter,
  codex: async () =>
    (await import('@sublang/cligent/adapters/codex')).CodexAdapter,
  gemini: async () =>
    (await import('@sublang/cligent/adapters/gemini')).GeminiAdapter,
  opencode: async () =>
    (await import('@sublang/cligent/adapters/opencode')).OpenCodeAdapter,
};

function isKnownAgent(name: string): name is KnownAgentName {
  return (KNOWN_AGENTS as readonly string[]).includes(name);
}

export async function resolveAgents(
  entries?: AgentEntry[],
  cwd?: string,
): Promise<ResolvedAgent[]> {
  if (entries && entries.length > 0) {
    // Validate names
    const unknown = entries.filter((e) => !isKnownAgent(e.name));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown agent(s): ${unknown.map((e) => e.name).join(', ')}. ` +
          `Valid names: ${KNOWN_AGENTS.join(', ')}`,
      );
    }

    // Reject duplicates
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.name)) {
        throw new Error(`Duplicate agent: ${e.name}`);
      }
      seen.add(e.name);
    }

    const results: ResolvedAgent[] = [];
    for (const entry of entries) {
      const AdapterClass = await ADAPTER_IMPORTS[entry.name as KnownAgentName]();
      const adapter = new AdapterClass();
      const cligent = new Cligent(adapter, {
        cwd,
        model: entry.model,
      });
      results.push({ name: entry.name, cligent });
    }
    return results;
  }

  // Auto-detect: try all agents
  const results: ResolvedAgent[] = [];
  for (const name of KNOWN_AGENTS) {
    try {
      const AdapterClass = await ADAPTER_IMPORTS[name]();
      const adapter = new AdapterClass();
      if (await adapter.isAvailable()) {
        const cligent = new Cligent(adapter, { cwd });
        results.push({ name, cligent });
      }
    } catch {
      // Adapter not loadable, skip
    }
  }

  if (results.length === 0) {
    throw new Error(
      'No agents available — install at least one agent SDK',
    );
  }

  return results;
}

export function parseAgentArg(value: string): AgentEntry {
  const eqIdx = value.indexOf('=');
  if (eqIdx === -1) {
    return { name: value };
  }
  return {
    name: value.slice(0, eqIdx),
    model: value.slice(eqIdx + 1),
  };
}

export { KNOWN_AGENTS };
