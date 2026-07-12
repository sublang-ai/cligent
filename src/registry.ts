// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AgentType, AgentAdapter } from './types.js';

type DynamicAgentAdapter = AgentAdapter<string>;

export class AdapterRegistry {
  private readonly adapters = new Map<AgentType, DynamicAgentAdapter>();

  register<E extends string>(adapter: AgentAdapter<E>): void {
    if (this.adapters.has(adapter.agent)) {
      throw new Error(`Adapter already registered for agent: ${adapter.agent}`);
    }
    // Registration is intentionally erased to the dynamic string boundary:
    // runAgent() cannot correlate a mutable name with a vocabulary after an
    // adapter is unregistered and rebound.
    this.adapters.set(adapter.agent, adapter);
  }

  get(agent: AgentType): DynamicAgentAdapter | undefined {
    return this.adapters.get(agent);
  }

  list(): AgentType[] {
    return [...this.adapters.keys()];
  }

  unregister(agent: AgentType): boolean {
    return this.adapters.delete(agent);
  }
}
