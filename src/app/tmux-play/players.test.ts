// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentOptions } from '../../types.js';
import {
  KNOWN_PLAYER_ADAPTERS,
  resolvePlayers,
  validatePlayerConfigs,
  type PlayerAdapterImports,
  type PlayerConfig,
} from './players.js';

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

function fakeAdapterImports(): PlayerAdapterImports {
  return {
    claude: async () => adapterClass('claude-code'),
    codex: async () => adapterClass('codex'),
    gemini: async () => adapterClass('gemini'),
    opencode: async () => adapterClass('opencode'),
  };
}

describe('validatePlayerConfigs', () => {
  it('accepts the supported adapter names', () => {
    const configs = KNOWN_PLAYER_ADAPTERS.map((adapter, index) => ({
      id: `player-${index}`,
      adapter,
    }));

    expect(() => validatePlayerConfigs(configs)).not.toThrow();
  });

  it('rejects invalid player ids', () => {
    expect(() =>
      validatePlayerConfigs([{ id: 'Reviewer', adapter: 'claude' }]),
    ).toThrow('Invalid player id "Reviewer"');
    expect(() =>
      validatePlayerConfigs([{ id: '1reviewer', adapter: 'claude' }]),
    ).toThrow('Invalid player id "1reviewer"');
  });

  it('rejects the reserved captain player id', () => {
    expect(() =>
      validatePlayerConfigs([{ id: 'captain', adapter: 'claude' }]),
    ).toThrow('reserved for the Captain');
  });

  it('rejects duplicate player ids', () => {
    expect(() =>
      validatePlayerConfigs([
        { id: 'coder', adapter: 'claude' },
        { id: 'coder', adapter: 'codex' },
      ]),
    ).toThrow('Duplicate player id: coder');
  });

  it('rejects unknown adapters with valid choices', () => {
    expect(() =>
      validatePlayerConfigs([{ id: 'coder', adapter: 'unknown' }]),
    ).toThrow(
      'Unknown adapter "unknown" for player "coder". Valid adapters: claude, codex, gemini, opencode',
    );
  });
});

describe('resolvePlayers', () => {
  it('creates one player-scoped Cligent per config', async () => {
    const players = await resolvePlayers(
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

    expect(players).toHaveLength(2);
    expect(players[0]).toMatchObject({
      id: 'coder',
      adapter: 'codex',
      model: 'codex-test-model',
      instruction: 'Implement changes.',
    });
    expect(players[0]?.cligent.role).toBe('coder');
    expect(players[0]?.cligent.agentType).toBe('codex');
    expect(players[1]).toMatchObject({
      id: 'reviewer',
      adapter: 'claude',
      instruction: 'Review changes.',
    });
    expect(players[1]?.cligent.role).toBe('reviewer');
    expect(players[1]?.cligent.agentType).toBe('claude-code');
  });

  it('forwards PlayerConfig defaults into adapter run options', async () => {
    const captured: (AgentOptions | undefined)[] = [];

    class CapturingAdapter implements AgentAdapter {
      readonly agent = 'codex';
      async *run(
        _prompt: string,
        options?: AgentOptions,
      ): AsyncGenerator<AgentEvent, void, void> {
        captured.push(options);
      }
      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    const adapterImports: PlayerAdapterImports = {
      claude: async () => adapterClass('claude-code'),
      codex: async () => CapturingAdapter,
      gemini: async () => adapterClass('gemini'),
      opencode: async () => adapterClass('opencode'),
    };

    const players = await resolvePlayers(
      [
        {
          id: 'coder',
          adapter: 'codex',
          permissions: { mode: 'auto' },
          reasoningEffort: 'xhigh',
        },
      ],
      { adapterImports },
    );

    const gen = players[0]!.cligent.run('hello');
    while (!(await gen.next()).done) {
      // drain
    }

    expect(captured[0]?.permissions).toEqual({ mode: 'auto' });
    expect(captured[0]?.reasoningEffort).toBe('xhigh');
  });

  it('allows multiple players to use the same adapter and model', async () => {
    const configs: PlayerConfig[] = [
      { id: 'coder', adapter: 'claude', model: 'same-model' },
      { id: 'reviewer', adapter: 'claude', model: 'same-model' },
    ];

    const players = await resolvePlayers(configs, {
      adapterImports: fakeAdapterImports(),
    });

    expect(players.map((player) => player.adapter)).toEqual(['claude', 'claude']);
    expect(players.map((player) => player.model)).toEqual([
      'same-model',
      'same-model',
    ]);
    expect(players[0]?.cligent).not.toBe(players[1]?.cligent);
    expect(players.map((player) => player.cligent.role)).toEqual([
      'coder',
      'reviewer',
    ]);
  });
});
