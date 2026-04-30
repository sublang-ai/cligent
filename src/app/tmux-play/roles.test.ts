// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentOptions } from '../../types.js';
import {
  KNOWN_ROLE_ADAPTERS,
  resolveRoles,
  validateRoleConfigs,
  type RoleAdapterImports,
  type RoleConfig,
} from './roles.js';

class FakeAdapter implements AgentAdapter {
  readonly agent: string;

  constructor(agent: string) {
    this.agent = agent;
  }

  async *run(
    _prompt: string,
    _options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    return;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function adapterClass(agent: string): new () => AgentAdapter {
  return class extends FakeAdapter {
    constructor() {
      super(agent);
    }
  };
}

function fakeAdapterImports(): RoleAdapterImports {
  return {
    claude: async () => adapterClass('claude-code'),
    codex: async () => adapterClass('codex'),
    gemini: async () => adapterClass('gemini'),
    opencode: async () => adapterClass('opencode'),
  };
}

describe('validateRoleConfigs', () => {
  it('accepts the supported adapter names', () => {
    const configs = KNOWN_ROLE_ADAPTERS.map((adapter, index) => ({
      id: `role-${index}`,
      adapter,
    }));

    expect(() => validateRoleConfigs(configs)).not.toThrow();
  });

  it('rejects invalid role ids', () => {
    expect(() =>
      validateRoleConfigs([{ id: 'Reviewer', adapter: 'claude' }]),
    ).toThrow('Invalid role id "Reviewer"');
    expect(() =>
      validateRoleConfigs([{ id: '1reviewer', adapter: 'claude' }]),
    ).toThrow('Invalid role id "1reviewer"');
  });

  it('rejects the reserved captain role id', () => {
    expect(() =>
      validateRoleConfigs([{ id: 'captain', adapter: 'claude' }]),
    ).toThrow('reserved for the Captain');
  });

  it('rejects duplicate role ids', () => {
    expect(() =>
      validateRoleConfigs([
        { id: 'coder', adapter: 'claude' },
        { id: 'coder', adapter: 'codex' },
      ]),
    ).toThrow('Duplicate role id: coder');
  });

  it('rejects unknown adapters with valid choices', () => {
    expect(() =>
      validateRoleConfigs([{ id: 'coder', adapter: 'unknown' }]),
    ).toThrow(
      'Unknown adapter "unknown" for role "coder". Valid adapters: claude, codex, gemini, opencode',
    );
  });
});

describe('resolveRoles', () => {
  it('creates one role-scoped Cligent per config', async () => {
    const roles = await resolveRoles(
      [
        {
          id: 'coder',
          adapter: 'codex',
          model: 'codex-test-model',
          instruction: 'Implement changes.',
        },
        {
          id: 'reviewer',
          adapter: 'claude',
          instruction: 'Review changes.',
        },
      ],
      {
        cwd: '/tmp/project',
        adapterImports: fakeAdapterImports(),
      },
    );

    expect(roles).toHaveLength(2);
    expect(roles[0]).toMatchObject({
      id: 'coder',
      adapter: 'codex',
      model: 'codex-test-model',
      instruction: 'Implement changes.',
    });
    expect(roles[0]?.cligent.role).toBe('coder');
    expect(roles[0]?.cligent.agentType).toBe('codex');
    expect(roles[1]).toMatchObject({
      id: 'reviewer',
      adapter: 'claude',
      instruction: 'Review changes.',
    });
    expect(roles[1]?.cligent.role).toBe('reviewer');
    expect(roles[1]?.cligent.agentType).toBe('claude-code');
  });

  it('allows multiple roles to use the same adapter and model', async () => {
    const configs: RoleConfig[] = [
      { id: 'coder', adapter: 'claude', model: 'same-model' },
      { id: 'reviewer', adapter: 'claude', model: 'same-model' },
    ];

    const roles = await resolveRoles(configs, {
      adapterImports: fakeAdapterImports(),
    });

    expect(roles.map((role) => role.adapter)).toEqual(['claude', 'claude']);
    expect(roles.map((role) => role.model)).toEqual([
      'same-model',
      'same-model',
    ]);
    expect(roles[0]?.cligent).not.toBe(roles[1]?.cligent);
    expect(roles.map((role) => role.cligent.role)).toEqual([
      'coder',
      'reviewer',
    ]);
  });
});
