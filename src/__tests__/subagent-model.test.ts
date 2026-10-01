// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';

import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import { KimiAdapter } from '../adapters/kimi.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { Cligent } from '../cligent.js';
import { runAgent, runParallel } from '../engine.js';
import { createEvent } from '../events.js';
import {
  AdapterRegistry,
  SUBAGENT_MODEL_SUPPORT,
  assertSubagentModelSupported,
  getSubagentModelSupport,
  isSubagentModelSupported,
} from '../index.js';
import type {
  AgentAdapter,
  AgentEvent,
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

function successQuery(requests: unknown[]) {
  return vi.fn((request: unknown) => {
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
}

function doneEvent(agent: string): AgentEvent {
  return createEvent('done', agent, {
    status: 'success',
    usage: { toolUses: 0 },
    durationMs: 1,
  });
}

// engine-95
describe('built-in subagent-model metadata', () => {
  it('publishes the exact frozen transport matrix', () => {
    expect(SUBAGENT_MODEL_SUPPORT).toEqual({
      'claude-code': { requestSupported: true, notes: expect.any(String) },
      codex: { requestSupported: false, notes: expect.any(String) },
      gemini: { requestSupported: false, notes: expect.any(String) },
      opencode: { requestSupported: false, notes: expect.any(String) },
      kimi: { requestSupported: false, notes: expect.any(String) },
    });
    expect(Object.isFrozen(SUBAGENT_MODEL_SUPPORT)).toBe(true);
    for (const descriptor of Object.values(SUBAGENT_MODEL_SUPPORT)) {
      expect(Object.isFrozen(descriptor)).toBe(true);
    }
    expect(() => {
      (SUBAGENT_MODEL_SUPPORT.codex as { notes: string }).notes = 'mutated';
    }).toThrow();
  });

  it('qualifies request delivery and names the Claude mechanism', () => {
    const claude = SUBAGENT_MODEL_SUPPORT['claude-code'].notes;
    expect(claude).toContain('native-request delivery');
    expect(claude).toContain('CLAUDE_CODE_SUBAGENT_MODEL');
    expect(claude).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1');
    expect(claude).toContain('delegation directive');
    expect(claude).toContain('subagentEffort');
    expect(claude).toContain('subagent definitions');
    expect(claude).toContain('replacing general-purpose by name');
    expect(claude).toContain(
      "Explore and Plan keep their own definitions and the agent's effort",
    );
    for (const adapter of ['codex', 'gemini', 'opencode', 'kimi'] as const) {
      expect(SUBAGENT_MODEL_SUPPORT[adapter].notes).toContain(
        'no per-run subagent-model or subagent-effort surface',
      );
    }
  });

  it('resolves aliases and selects known, unsupported, and unknown outcomes', () => {
    expect(getSubagentModelSupport('claude')).toBe(
      SUBAGENT_MODEL_SUPPORT['claude-code'],
    );
    expect(getSubagentModelSupport('codex')).toBe(SUBAGENT_MODEL_SUPPORT.codex);
    expect(isSubagentModelSupported('claude')).toBe(true);
    expect(isSubagentModelSupported('claude-code')).toBe(true);
    for (const adapter of ['codex', 'gemini', 'opencode', 'kimi']) {
      expect(isSubagentModelSupported(adapter)).toBe(false);
    }
    expect(() => assertSubagentModelSupported('claude')).not.toThrow();
    expect(() =>
      assertSubagentModelSupported('codex', 'players[0].subagentModel'),
    ).toThrow('players[0].subagentModel is not supported for adapter "codex"');
    expect(() => assertSubagentModelSupported('gemini')).toThrow(
      'subagentModel is not supported for adapter "gemini"',
    );

    expect(getSubagentModelSupport('custom-agent')).toBeUndefined();
    expect(isSubagentModelSupported('custom-agent')).toBe(false);
    expect(() =>
      assertSubagentModelSupported('custom-agent', 'captain.subagentModel'),
    ).toThrow(
      'captain.subagentModel cannot be validated for unknown adapter "custom-agent"',
    );
  });
});

// engine-96
describe('supported built-in subagent-model requests', () => {
  it('forwards instance defaults and parallel overrides to the Claude query', async () => {
    const requests: unknown[] = [];
    const query = successQuery(requests);
    const cligent = new Cligent(
      new ClaudeCodeAdapter({ loadSdk: async () => ({ query }) }),
      { subagentModel: 'claude-haiku-4-5' },
    );

    const defaultEvents = await collect(cligent.run('default'));
    const overrideEvents = await collect(
      Cligent.parallel([
        {
          agent: cligent,
          prompt: 'override',
          overrides: { subagentModel: 'claude-sonnet-5-5' },
        },
      ]),
    );

    expect(requests).toMatchObject([
      {
        prompt: 'default',
        options: {
          env: {
            CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5',
            CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
          },
          systemPrompt: {
            type: 'custom',
            prompt: expect.stringContaining('run on claude-haiku-4-5;'),
            snapshot: false,
          },
        },
      },
      {
        prompt: 'override',
        options: {
          env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5' },
          systemPrompt: {
            prompt: expect.stringContaining('run on claude-sonnet-5-5;'),
          },
        },
      },
    ]);
    expect(defaultEvents.at(-1)?.payload).toMatchObject({ status: 'success' });
    expect(overrideEvents.at(-1)?.payload).toMatchObject({ status: 'success' });
  });

  it('forwards inherit and a subagent effort with per-run precedence', async () => {
    const requests: Array<{
      prompt: string;
      options: {
        env: Record<string, string | undefined>;
        agents?: Record<string, { model?: string; effort?: string }>;
        systemPrompt?: { prompt: string };
      };
    }> = [];
    const query = successQuery(requests);
    const cligent = new Cligent(
      new ClaudeCodeAdapter({ loadSdk: async () => ({ query }) }),
      { subagentModel: 'inherit', subagentEffort: 'low' },
    );

    await collect(cligent.run('default'));
    await collect(cligent.run('effort', { subagentEffort: 'max' }));
    await collect(
      Cligent.parallel([
        {
          agent: cligent,
          prompt: 'model',
          overrides: { subagentModel: 'claude-haiku-4-5' },
        },
      ]),
    );

    const [byDefault, byEffort, byModel] = requests;
    expect(byDefault?.options.env).not.toHaveProperty(
      'CLAUDE_CODE_SUBAGENT_MODEL',
    );
    expect(byDefault?.options.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBe('1');
    expect(byDefault?.options.agents?.delegate).toMatchObject({
      model: 'inherit',
      effort: 'low',
    });
    expect(byDefault?.options.systemPrompt?.prompt).toContain(
      'run on your own model at low effort.',
    );
    expect(byEffort?.options.agents?.delegate?.effort).toBe('max');
    expect(byModel?.options.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe(
      'claude-haiku-4-5',
    );
    expect(byModel?.options.agents?.delegate).toMatchObject({
      model: 'claude-haiku-4-5',
      effort: 'low',
    });
  });

  it('rejects a subagent effort without a model or outside the vocabulary', async () => {
    const query = vi.fn(() => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {},
    }));
    const adapter = new ClaudeCodeAdapter({ loadSdk: async () => ({ query }) });

    const alone = await collect(
      new Cligent(adapter, { subagentEffort: 'low' }).run('prompt'),
    );
    expect(
      alone.find((event) => event.type === 'error')?.payload,
    ).toMatchObject({
      message:
        'subagentEffort for adapter "claude-code" requires subagentModel',
    });

    const cligent = new Cligent(adapter, { subagentModel: 'claude-haiku-4-5' });
    for (const subagentEffort of ['ultracode', '', null, 3]) {
      const invalid = {
        subagentEffort,
      } as unknown as AgentOptions<ClaudeEffort, boolean, string>;
      const events = await collect(cligent.run('prompt', invalid));
      expect(
        events.find((event) => event.type === 'error')?.payload,
      ).toMatchObject({
        message:
          'subagentEffort for adapter "claude-code" must be one of: ' +
          'minimal, low, medium, high, xhigh, max',
      });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('adds no override when omitted on every path', async () => {
    const requests: Array<{ options: Record<string, unknown> }> = [];
    const query = successQuery(requests);
    const adapter = new ClaudeCodeAdapter({ loadSdk: async () => ({ query }) });

    await collect(new Cligent(adapter).run('instance'));
    await collect(
      runParallel([{ adapter, prompt: 'parallel', options: { model: 'x' } }]),
    );

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.options).not.toHaveProperty('systemPrompt');
      expect(request.options).not.toHaveProperty('agents');
      expect(
        (request.options.env as Record<string, string | undefined>)
          .CLAUDE_CODE_SUBAGENT_MODEL,
      ).toBe(process.env.CLAUDE_CODE_SUBAGENT_MODEL);
    }
  });

  it('surfaces one upstream refusal without substituting a model', async () => {
    const requests: unknown[] = [];
    const query = vi.fn((request: unknown) => {
      requests.push(request);
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {
          throw new Error('model claude-nonexistent is not available');
        },
      };
    });
    const cligent = new Cligent(
      new ClaudeCodeAdapter({ loadSdk: async () => ({ query }) }),
      { subagentModel: 'claude-nonexistent' },
    );

    const events = await collect(cligent.run('prompt'));

    expect(query).toHaveBeenCalledTimes(1);
    expect(requests).toMatchObject([
      {
        options: { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-nonexistent' } },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual(['error', 'done']);
    expect(events[0]?.payload).toMatchObject({
      code: 'SDK_STREAM_ERROR',
      message: 'model claude-nonexistent is not available',
      recoverable: false,
    });
    expect(events[1]?.payload).toMatchObject({ status: 'error' });
  });

  it('forwards malformed per-run values to supported built-in validation', async () => {
    const query = vi.fn(() => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {},
    }));
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({ query }),
    });
    const cligent = new Cligent(adapter, { subagentModel: 'claude-haiku-4-5' });

    for (const subagentModel of ['', '  ', null, 7]) {
      const invalid = {
        subagentModel,
      } as unknown as AgentOptions<ClaudeEffort, boolean, string>;
      const events = await collect(cligent.run('prompt', invalid));
      expect(
        events.find((event) => event.type === 'error')?.payload,
      ).toMatchObject({
        message:
          'subagentModel for adapter "claude-code" must be a non-blank string',
      });
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe('unsupported built-in subagent-model requests', () => {
  it.each([
    [
      'codex',
      () => {
        const backend = vi.fn(async () => {
          throw new Error('unexpected Codex backend invocation');
        });
        return { backend, adapter: new CodexAdapter({ loadSdk: backend }) };
      },
    ],
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
    'rejects any value for %s before backend invocation',
    async (name, create) => {
      for (const subagentModel of ['claude-haiku-4-5', '', null]) {
        const { adapter, backend } = create();
        const options = { subagentModel } as unknown as AgentOptions;
        const dynamicAdapter = adapter as AgentAdapter;
        await expect(
          collect(dynamicAdapter.run('prompt', options)),
        ).rejects.toThrow(
          `subagentModel is not supported for adapter "${name}"`,
        );
        expect(backend).not.toHaveBeenCalled();
      }
      for (const subagentEffort of ['low', 'ultracode', null]) {
        const { adapter, backend } = create();
        const options = { subagentEffort } as unknown as AgentOptions;
        const dynamicAdapter = adapter as AgentAdapter;
        await expect(
          collect(dynamicAdapter.run('prompt', options)),
        ).rejects.toThrow(
          `subagentEffort is not supported for adapter "${name}"`,
        );
        expect(backend).not.toHaveBeenCalled();
      }
    },
  );

  it('rejects an unsupported instance default and per-run override', async () => {
    const spawnProcess = vi.fn(() => {
      throw new Error('unexpected Gemini backend invocation');
    });
    const adapter = new GeminiAdapter({ spawnProcess });
    const invalidDefault = {
      subagentModel: 'claude-haiku-4-5',
    } as unknown as CligentOptions<GeminiEffort>;
    const withDefault = new Cligent(adapter, invalidDefault);
    const defaultEvents = await collect(withDefault.run('prompt'));
    expect(
      defaultEvents.find((event) => event.type === 'error')?.payload,
    ).toMatchObject({
      message: 'subagentModel is not supported for adapter "gemini"',
    });

    const perRun = new Cligent(adapter);
    const invalidOverride = {
      subagentModel: 'claude-haiku-4-5',
    } as unknown as AgentOptions<GeminiEffort>;
    const overrideEvents = await collect(perRun.run('prompt', invalidOverride));
    expect(
      overrideEvents.find((event) => event.type === 'error')?.payload,
    ).toMatchObject({
      message: 'subagentModel is not supported for adapter "gemini"',
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('rejects an unsupported parallel option before backend invocation', async () => {
    const loadSdk = vi.fn(async () => {
      throw new Error('unexpected Codex backend invocation');
    });
    const adapter = new CodexAdapter({ loadSdk });
    const events = await collect(
      runParallel([
        {
          adapter: adapter as AgentAdapter<string, boolean, string>,
          prompt: 'prompt',
          options: { subagentModel: 'claude-haiku-4-5' },
        },
      ]),
    );

    expect(
      events.find((event) => event.type === 'error')?.payload,
    ).toMatchObject({
      message: 'subagentModel is not supported for adapter "codex"',
    });
    expect(loadSdk).not.toHaveBeenCalled();
  });
});

describe('custom subagent-model adapters', () => {
  it('lets an opted-in adapter validate its own value on the registry path', async () => {
    let captured: AgentOptions<'quick', never, string> | undefined;
    const adapter: AgentAdapter<'quick', never, string> = {
      agent: 'custom-agent',
      async *run(_prompt, options) {
        if (
          options?.subagentModel !== undefined &&
          !options.subagentModel.startsWith('custom-')
        ) {
          throw new Error('custom subagentModel must name a custom model');
        }
        captured = options;
        yield doneEvent('custom-agent');
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    await collect(
      runAgent(
        'custom-agent',
        'prompt',
        { subagentModel: 'custom-small' },
        registry,
      ),
    );
    expect(captured?.subagentModel).toBe('custom-small');

    const events = await collect(
      runAgent(
        'custom-agent',
        'prompt',
        { subagentModel: 'claude-haiku-4-5' },
        registry,
      ),
    );
    expect(
      events.find((event) => event.type === 'error')?.payload,
    ).toMatchObject({
      message: 'custom subagentModel must name a custom model',
    });
  });

  it('lets an opted-in adapter validate its own subagent effort', async () => {
    let captured: AgentOptions<'quick' | 'deep', never, string> | undefined;
    const adapter: AgentAdapter<'quick' | 'deep', never, string> = {
      agent: 'custom-agent',
      async *run(_prompt, options) {
        if (options?.subagentEffort === 'deep') {
          throw new Error('custom subagentEffort must be quick');
        }
        captured = options;
        yield doneEvent('custom-agent');
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    // A custom adapter receives the effort even without a subagent model;
    // its own capability decides (engine-97).
    await collect(
      runAgent('custom-agent', 'prompt', { subagentEffort: 'quick' }, registry),
    );
    expect(captured?.subagentEffort).toBe('quick');

    const events = await collect(
      new Cligent(adapter, { subagentModel: 'm' }).run('prompt', {
        subagentEffort: 'deep',
      }),
    );
    expect(
      events.find((event) => event.type === 'error')?.payload,
    ).toMatchObject({ message: 'custom subagentEffort must be quick' });
  });

  it('forwards each parallel adapter value independently', async () => {
    const captured = new Map<string, string | undefined>();
    const capturedEffort = new Map<string, string | undefined>();
    const makeAdapter = (
      agent: string,
    ): AgentAdapter<'quick', never, string> => ({
      agent,
      async *run(_prompt, options) {
        captured.set(agent, options?.subagentModel);
        capturedEffort.set(agent, options?.subagentEffort);
        yield doneEvent(agent);
      },
      async isAvailable() {
        return true;
      },
    });

    await collect(
      runParallel([
        {
          adapter: makeAdapter('custom-small'),
          prompt: 'small',
          options: { subagentModel: 'small', subagentEffort: 'quick' },
        },
        {
          adapter: makeAdapter('custom-large'),
          prompt: 'large',
          options: { subagentModel: 'large' },
        },
        { adapter: makeAdapter('custom-default'), prompt: 'default' },
      ]),
    );

    expect(Object.fromEntries(captured)).toEqual({
      'custom-small': 'small',
      'custom-large': 'large',
      'custom-default': undefined,
    });
    expect(Object.fromEntries(capturedEffort)).toEqual({
      'custom-small': 'quick',
      'custom-large': undefined,
      'custom-default': undefined,
    });
  });
});
