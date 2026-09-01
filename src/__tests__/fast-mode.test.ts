// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';

import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import { KimiAdapter } from '../adapters/kimi.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { Cligent } from '../cligent.js';
import { runParallel } from '../engine.js';
import {
  FAST_MODE_SUPPORT,
  assertFastModeSupported,
  getFastModeSupport,
  isFastModeSupported,
} from '../index.js';
import type {
  AgentEvent,
  AgentAdapter,
  AgentOptions,
  ClaudeEffort,
  CligentOptions,
  GeminiEffort,
} from '../types.js';

async function collect(
  events: AsyncGenerator<AgentEvent, void, void>,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('built-in fast-mode metadata', () => {
  it('publishes the exact frozen transport and observation matrix', () => {
    expect(FAST_MODE_SUPPORT).toEqual({
      'claude-code': {
        requestSupported: true,
        observation: 'init-and-done',
        modelDependent: true,
        accountDependent: true,
        notes: expect.any(String),
      },
      codex: {
        requestSupported: true,
        observation: 'none',
        modelDependent: true,
        accountDependent: true,
        notes: expect.any(String),
      },
      gemini: {
        requestSupported: false,
        observation: 'none',
        modelDependent: false,
        accountDependent: false,
        notes: expect.any(String),
      },
      opencode: {
        requestSupported: false,
        observation: 'none',
        modelDependent: false,
        accountDependent: false,
        notes: expect.any(String),
      },
      kimi: {
        requestSupported: false,
        observation: 'none',
        modelDependent: false,
        accountDependent: false,
        notes: expect.any(String),
      },
    });
    expect(Object.isFrozen(FAST_MODE_SUPPORT)).toBe(true);
    for (const descriptor of Object.values(FAST_MODE_SUPPORT)) {
      expect(Object.isFrozen(descriptor)).toBe(true);
    }
    expect(() => {
      (FAST_MODE_SUPPORT.codex as { notes: string }).notes = 'mutated';
    }).toThrow();
  });

  it('qualifies request delivery and authentic observation support', () => {
    expect(FAST_MODE_SUPPORT['claude-code'].notes).toContain(
      'native-request delivery',
    );
    expect(FAST_MODE_SUPPORT['claude-code'].notes).toContain(
      'authentic initialization and terminal observations',
    );
    expect(FAST_MODE_SUPPORT.codex.notes).toContain(
      'no effective-tier event',
    );
    for (const adapter of ['gemini', 'opencode', 'kimi'] as const) {
      expect(FAST_MODE_SUPPORT[adapter].notes).toContain(
        'no native fast-mode request surface',
      );
    }
  });

  it('resolves aliases and selects known, unsupported, and unknown outcomes', () => {
    expect(getFastModeSupport('claude')).toBe(
      FAST_MODE_SUPPORT['claude-code'],
    );
    expect(getFastModeSupport('codex')).toBe(FAST_MODE_SUPPORT.codex);
    expect(isFastModeSupported('claude')).toBe(true);
    expect(isFastModeSupported('codex')).toBe(true);
    expect(isFastModeSupported('gemini')).toBe(false);
    expect(() =>
      assertFastModeSupported('gemini', 'players[0].fastMode'),
    ).toThrow(
      'players[0].fastMode is not supported for adapter "gemini"',
    );

    expect(getFastModeSupport('custom-agent')).toBeUndefined();
    expect(isFastModeSupported('custom-agent')).toBe(false);
    expect(() =>
      assertFastModeSupported('custom-agent', 'captain.fastMode'),
    ).toThrow(
      'captain.fastMode cannot be validated for unknown adapter "custom-agent"',
    );
  });
});

describe('supported built-in fast-mode requests', () => {
  it('forwards instance defaults and parallel overrides to native settings', async () => {
    const requests: unknown[] = [];
    const query = vi.fn((request: unknown) => {
      requests.push(request);
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            status: 'success',
            result: 'ok',
            usage: { input_tokens: 1, output_tokens: 1 },
            duration_ms: 1,
          };
        },
      };
    });
    const cligent = new Cligent(
      new ClaudeCodeAdapter({ loadSdk: async () => ({ query }) }),
      { fastMode: true },
    );

    const defaultEvents = await collect(cligent.run('default'));
    const overrideEvents = await collect(
      Cligent.parallel([
        {
          agent: cligent,
          prompt: 'override',
          overrides: { fastMode: false },
        },
      ]),
    );

    expect(requests).toMatchObject([
      { prompt: 'default', options: { settings: { fastMode: true } } },
      { prompt: 'override', options: { settings: { fastMode: false } } },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(defaultEvents.at(-1)?.payload).toMatchObject({ status: 'success' });
    expect(overrideEvents.at(-1)?.payload).toMatchObject({ status: 'success' });
  });

  it('surfaces one upstream refusal without substituting a request', async () => {
    const requests: unknown[] = [];
    const query = vi.fn((request: unknown) => {
      requests.push(request);
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {
          throw new Error('fast mode is unavailable for this account');
        },
      };
    });
    const cligent = new Cligent(
      new ClaudeCodeAdapter({ loadSdk: async () => ({ query }) }),
      { fastMode: true },
    );

    const events = await collect(cligent.run('prompt'));

    expect(query).toHaveBeenCalledTimes(1);
    expect(requests).toMatchObject([
      { prompt: 'prompt', options: { settings: { fastMode: true } } },
    ]);
    expect(events.map((event) => event.type)).toEqual(['error', 'done']);
    expect(events[0]?.payload).toMatchObject({
      code: 'SDK_STREAM_ERROR',
      message: 'fast mode is unavailable for this account',
      recoverable: false,
    });
    expect(events[1]?.payload).toMatchObject({ status: 'error' });
    expect(events[1]?.payload).not.toHaveProperty('fastMode');
  });
});

describe('unsupported built-in fast-mode requests', () => {
  it.each([
    [
      'gemini',
      () => {
        const backend = vi.fn(() => {
          throw new Error('unexpected Gemini backend invocation');
        });
        return {
          backend,
          adapter: new GeminiAdapter({ spawnProcess: backend }),
        };
      },
    ],
    [
      'kimi',
      () => {
        const backend = vi.fn(() => {
          throw new Error('unexpected Kimi backend invocation');
        });
        return {
          backend,
          adapter: new KimiAdapter({ spawnProcess: backend }),
        };
      },
    ],
    [
      'opencode',
      () => {
        const backend = vi.fn(async () => {
          throw new Error('unexpected OpenCode backend invocation');
        });
        return {
          backend,
          adapter: new OpenCodeAdapter(
            { mode: 'external' },
            { loadSdk: backend },
          ),
        };
      },
    ],
  ] as const)(
    'rejects even false for %s before backend invocation',
    async (name, create) => {
      const { adapter, backend } = create();
      const options = { fastMode: false } as unknown as AgentOptions;
      const dynamicAdapter = adapter as AgentAdapter;
      await expect(collect(dynamicAdapter.run('prompt', options))).rejects.toThrow(
        `fastMode is not supported for adapter "${name}"`,
      );
      expect(backend).not.toHaveBeenCalled();
    },
  );

  it('rejects an unsupported instance default and per-run override', async () => {
    const spawnProcess = vi.fn(() => {
      throw new Error('unexpected Gemini backend invocation');
    });
    const adapter = new GeminiAdapter({ spawnProcess });
    const invalidDefault = {
      fastMode: true,
    } as unknown as CligentOptions<GeminiEffort>;
    const withDefault = new Cligent(adapter, invalidDefault);
    const defaultEvents = await collect(withDefault.run('prompt'));
    expect(defaultEvents.find((event) => event.type === 'error')?.payload).toMatchObject({
      message: 'fastMode is not supported for adapter "gemini"',
    });

    const perRun = new Cligent(adapter);
    const invalidOverride = {
      fastMode: false,
    } as unknown as AgentOptions<GeminiEffort>;
    const overrideEvents = await collect(perRun.run('prompt', invalidOverride));
    expect(overrideEvents.find((event) => event.type === 'error')?.payload).toMatchObject({
      message: 'fastMode is not supported for adapter "gemini"',
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('rejects an unsupported parallel option before backend invocation', async () => {
    const spawnProcess = vi.fn(() => {
      throw new Error('unexpected Gemini backend invocation');
    });
    const adapter = new GeminiAdapter({ spawnProcess });
    const events = await collect(
      runParallel([
        {
          adapter: adapter as AgentAdapter<GeminiEffort, boolean>,
          prompt: 'prompt',
          options: { fastMode: false },
        },
      ]),
    );

    expect(events.find((event) => event.type === 'error')?.payload).toMatchObject({
      message: 'fastMode is not supported for adapter "gemini"',
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('forwards malformed per-run values to supported built-in validation', async () => {
    const query = vi.fn(() => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {},
    }));
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({ query }),
    });
    const cligent = new Cligent(adapter, { fastMode: true });
    const invalidOverride = {
      fastMode: null,
    } as unknown as AgentOptions<ClaudeEffort, boolean>;

    const events = await collect(cligent.run('prompt', invalidOverride));

    expect(events.find((event) => event.type === 'error')?.payload).toMatchObject({
      message: 'fastMode for adapter "claude-code" must be a boolean',
    });
    expect(query).not.toHaveBeenCalled();
  });
});
