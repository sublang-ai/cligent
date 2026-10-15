// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import { KimiAdapter } from '../adapters/kimi.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { Cligent } from '../cligent.js';
import { runAgent, runParallel } from '../engine.js';
import { createEvent } from '../events.js';
import { AdapterRegistry } from '../registry.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  DonePayload,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockAdapterOptions {
  throwAfter?: number; // throw after yielding this many events
  throwError?: Error;
}

function createMockAdapter(
  agent: string,
  events: AgentEvent[],
  opts?: MockAdapterOptions,
): AgentAdapter {
  return {
    agent,
    async *run(): AsyncGenerator<AgentEvent, void, void> {
      for (let i = 0; i < events.length; i++) {
        if (opts?.throwAfter !== undefined && i === opts.throwAfter) {
          throw opts.throwError ?? new Error('adapter exploded');
        }
        yield events[i];
      }
      if (
        opts?.throwAfter !== undefined &&
        opts.throwAfter >= events.length
      ) {
        throw opts.throwError ?? new Error('adapter exploded');
      }
    },
    async isAvailable() {
      return true;
    },
  };
}

async function collectEvents(
  gen: AsyncGenerator<AgentEvent, void, void>,
): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of gen) {
    result.push(event);
  }
  return result;
}

function textEvent(agent: string, content: string, sid = 'test-sid'): AgentEvent {
  return createEvent('text', agent, { content }, sid);
}

function toolUseEvent(
  agent: string,
  toolUseId: string,
  sid = 'test-sid',
): AgentEvent {
  return createEvent(
    'tool_use',
    agent,
    { toolName: 'Bash', toolUseId, input: { command: 'true' } },
    sid,
  );
}

function doneEvent(
  agent: string,
  status: 'success' | 'error' | 'interrupted' = 'success',
  sid = 'test-sid',
  extra?: Record<string, unknown>,
): AgentEvent {
  return createEvent(
    'done',
    agent,
    {
      status,
      ...extra,
      usage: {
        toolUses: 1,
        tokens: {
          coverage: 'complete',
          totals: { input: { total: 10 }, output: { total: 20 } },
        },
      },
      durationMs: 100,
    },
    sid,
  );
}

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

describe('runAgent', () => {
  it('yields events in order', async () => {
    const adapter = createMockAdapter('claude-code', [
      textEvent('claude-code', 'hello'),
      textEvent('claude-code', 'world'),
      doneEvent('claude-code'),
    ]);
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const events = await collectEvents(
      runAgent('claude-code', 'hi', undefined, registry),
    );
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('text');
    expect(events[1].type).toBe('text');
    expect(events[2].type).toBe('done');
  });

  it('forwards an exact custom effort string through the mutable registry', async () => {
    type CustomEffort = 'quick' | 'deep' | 'exhaustive';
    let captured: AgentOptions<CustomEffort, boolean> | undefined;
    const adapter: AgentAdapter<CustomEffort, boolean> = {
      agent: 'custom-agent',
      async *run(_prompt, options) {
        if (
          options?.fastMode !== undefined &&
          typeof options.fastMode !== 'boolean'
        ) {
          throw new Error('custom fastMode must be boolean');
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

    await collectEvents(
      runAgent(
        'custom-agent',
        'prompt',
        { effort: 'exhaustive', fastMode: false },
        registry,
      ),
    );

    expect(captured?.effort).toBe('exhaustive');
    expect(captured?.fastMode).toBe(false);

    const invalid = {
      fastMode: 'turbo',
    } as unknown as AgentOptions<string, boolean>;
    const events = await collectEvents(
      runAgent('custom-agent', 'prompt', invalid, registry),
    );
    expect(events.find((event) => event.type === 'error')?.payload).toMatchObject(
      { message: 'custom fastMode must be boolean' },
    );
  });

  it('throws on missing adapter', async () => {
    const registry = new AdapterRegistry();
    await expect(
      collectEvents(runAgent('codex', 'hi', undefined, registry)),
    ).rejects.toThrow('No adapter registered for agent: codex');
  });

  it('yields error + done on adapter throw', async () => {
    const adapter = createMockAdapter(
      'claude-code',
      [textEvent('claude-code', 'hello')],
      { throwAfter: 1, throwError: new Error('boom') },
    );
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const events = await collectEvents(
      runAgent('claude-code', 'hi', undefined, registry),
    );
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('text');
    expect(events[1].type).toBe('error');
    expect((events[1] as AgentEvent & { payload: { code: string } }).payload.code).toBe(
      'ADAPTER_ERROR',
    );
    expect(events[2].type).toBe('done');
    expect(
      (events[2] as AgentEvent & { payload: { status: string } }).payload.status,
    ).toBe('error');
  });

  it('synthesized done marks zeroed token placeholders unavailable', async () => {
    const adapter = createMockAdapter('claude-code', [], {
      throwAfter: 0,
      throwError: new Error('fail'),
    });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const events = await collectEvents(
      runAgent('claude-code', 'hi', undefined, registry),
    );
    const done = events.find((e) => e.type === 'done')!;
    const payload = (done as AgentEvent & {
      payload: {
        usage: DonePayload['usage'];
        durationMs: number;
      };
    }).payload;
    expect(payload.usage.tokens).toBeUndefined();
    expect(payload.usage.cost).toBeUndefined();
    expect(payload.usage.toolUses).toBe(0);
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps observed tool uses when done must be synthesized', async () => {
    const adapter = createMockAdapter(
      'claude-code',
      [toolUseEvent('claude-code', 'observed-before-error')],
      { throwAfter: 1, throwError: new Error('fail after tool') },
    );
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const events = await collectEvents(
      runAgent('claude-code', 'hi', undefined, registry),
    );
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage).toEqual({
      toolUses: 1,
    });
  });

  it('suppresses post-done events', async () => {
    // Adapter that yields done then more events — engine should only return up to done
    const adapter: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield textEvent('claude-code', 'before');
        yield doneEvent('claude-code');
        yield textEvent('claude-code', 'after-done');
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const events = await collectEvents(
      runAgent('claude-code', 'hi', undefined, registry),
    );
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('text');
    expect(events[1].type).toBe('done');
  });

  it('yields done(interrupted) on abort', async () => {
    const controller = new AbortController();
    // Adapter that stalls until aborted
    const adapter: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield textEvent('claude-code', 'start');
        // Stall forever
        await new Promise(() => {});
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const gen = runAgent('claude-code', 'hi', { abortSignal: controller.signal }, registry);
    const events: AgentEvent[] = [];

    // Collect first event then abort
    const first = await gen.next();
    if (!first.done) events.push(first.value);
    controller.abort();
    const rest = await gen.next();
    if (!rest.done) events.push(rest.value);
    // Drain remaining
    for await (const e of gen) events.push(e);

    expect(events.length).toBeGreaterThanOrEqual(2);
    const last = events[events.length - 1];
    expect(last.type).toBe('done');
    expect(
      (last as AgentEvent & { payload: { status: string } }).payload.status,
    ).toBe('interrupted');
  });

  it('prefers an adapter-emitted interrupted done when abort wins the race', async () => {
    const controller = new AbortController();
    const adapter: AgentAdapter = {
      agent: 'claude-code',
      async *run(
        _prompt: string,
        options?: AgentOptions,
      ): AsyncGenerator<AgentEvent, void, void> {
        const abortSeen = options?.abortSignal?.aborted
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              options?.abortSignal?.addEventListener('abort', resolve, {
                once: true,
              });
        });
        yield textEvent('claude-code', 'start', 'adapter-session-A');
        await abortSeen;
        yield createEvent(
          'text_delta',
          'claude-code',
          { delta: 'flush-after-abort' },
          'adapter-session-A',
        );
        yield doneEvent('claude-code', 'interrupted', 'adapter-session-A', {
          resumeToken: 'adapter-session-A',
        });
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const gen = runAgent(
      'claude-code',
      'hi',
      { abortSignal: controller.signal },
      registry,
    );
    const events: AgentEvent[] = [];
    const first = await gen.next();
    if (!first.done) events.push(first.value);
    controller.abort();
    for await (const event of gen) events.push(event);

    const done = events[events.length - 1];
    expect(done.type).toBe('done');
    expect(done.sessionId).toBe('adapter-session-A');
    expect(
      events.some(
        (event) =>
          event.type === 'text_delta' &&
          (event as AgentEvent & { payload: { delta: string } }).payload
            .delta === 'flush-after-abort',
      ),
    ).toBe(false);
    expect(
      (done as AgentEvent & { payload: { status: string; resumeToken?: string } })
        .payload,
    ).toMatchObject({
      status: 'interrupted',
      resumeToken: 'adapter-session-A',
    });
  });

  it('yields MISSING_DONE on exhaustion without done', async () => {
    const adapter = createMockAdapter('claude-code', [
      textEvent('claude-code', 'hello'),
    ]);
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const events = await collectEvents(
      runAgent('claude-code', 'hi', undefined, registry),
    );
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('text');
    expect(events[1].type).toBe('error');
    expect(
      (events[1] as AgentEvent & { payload: { code: string } }).payload.code,
    ).toBe('MISSING_DONE');
    expect(events[2].type).toBe('done');
    expect(
      (events[2] as AgentEvent & { payload: { status: string } }).payload.status,
    ).toBe('error');
  });

  it('pre-aborted signal does not execute adapter body', async () => {
    let adapterBodyRan = false;
    const adapter: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        adapterBodyRan = true;
        yield textEvent('claude-code', 'should not happen');
        yield doneEvent('claude-code');
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(
      runAgent('claude-code', 'hi', { abortSignal: controller.signal }, registry),
    );

    expect(adapterBodyRan).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
    expect(
      (events[0] as AgentEvent & { payload: { status: string } }).payload.status,
    ).toBe('interrupted');
  });

  it('pre-aborted signal does not call adapter.run()', async () => {
    let runCalled = false;
    const adapter: AgentAdapter = {
      agent: 'claude-code',
      run(): AsyncGenerator<AgentEvent, void, void> {
        runCalled = true;
        return (async function* () {
          yield textEvent('claude-code', 'hi');
          yield doneEvent('claude-code');
        })();
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(
      runAgent('claude-code', 'hi', { abortSignal: controller.signal }, registry),
    );

    expect(runCalled).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
  });

  it('no unhandled rejection with pre-aborted signal and throwing adapter', async () => {
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', handler);

    const adapter: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        throw new Error('boom-first-next');
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(
      runAgent('claude-code', 'hi', { abortSignal: controller.signal }, registry),
    );
    await new Promise((r) => setTimeout(r, 50));

    process.removeListener('unhandledRejection', handler);

    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(rejections).toHaveLength(0);
  });

  it('synthesized events preserve adapter sessionId', async () => {
    const SID = 'adapter-session-abc';
    const adapter: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield createEvent('text', 'claude-code', { content: 'hi' }, SID);
        throw new Error('crash');
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const events = await collectEvents(
      runAgent('claude-code', 'hi', undefined, registry),
    );
    for (const e of events) {
      expect(e.sessionId).toBe(SID);
    }
  });

  it('synthesized MISSING_DONE preserves adapter sessionId', async () => {
    const SID = 'adapter-session-xyz';
    const adapter: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield createEvent('text', 'claude-code', { content: 'hi' }, SID);
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const events = await collectEvents(
      runAgent('claude-code', 'hi', undefined, registry),
    );
    for (const e of events) {
      expect(e.sessionId).toBe(SID);
    }
  });

  it('yields exactly one done when abort races adapter done', async () => {
    const controller = new AbortController();
    const adapter: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield doneEvent('claude-code');
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);

    // Abort immediately
    controller.abort();
    const events = await collectEvents(
      runAgent('claude-code', 'hi', { abortSignal: controller.signal }, registry),
    );
    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// runParallel
// ---------------------------------------------------------------------------

describe('runParallel', () => {
  it('forwards each adapter fast-mode option independently', async () => {
    const captured = new Map<string, boolean | undefined>();
    const makeAdapter = (agent: string): AgentAdapter<'quick', boolean> => ({
      agent,
      async *run(_prompt, options) {
        captured.set(agent, options?.fastMode);
        yield doneEvent(agent);
      },
      async isAvailable() {
        return true;
      },
    });

    await collectEvents(
      runParallel([
        {
          adapter: makeAdapter('custom-fast'),
          prompt: 'fast',
          options: { fastMode: true },
        },
        {
          adapter: makeAdapter('custom-standard'),
          prompt: 'standard',
          options: { fastMode: false },
        },
        { adapter: makeAdapter('custom-default'), prompt: 'default' },
      ]),
    );

    expect(Object.fromEntries(captured)).toEqual({
      'custom-fast': true,
      'custom-standard': false,
      'custom-default': undefined,
    });
  });

  it('merges events from multiple adapters', async () => {
    const a1 = createMockAdapter('claude-code', [
      textEvent('claude-code', 'a1'),
      doneEvent('claude-code'),
    ]);
    const a2 = createMockAdapter('codex', [
      textEvent('codex', 'a2'),
      doneEvent('codex'),
    ]);

    const events = await collectEvents(
      runParallel([
        { adapter: a1, prompt: 'hi' },
        { adapter: a2, prompt: 'hi' },
      ]),
    );

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'done')).toHaveLength(2);
    expect(types.filter((t) => t === 'text')).toHaveLength(2);
    expect(events.some((e) => e.agent === 'claude-code')).toBe(true);
    expect(events.some((e) => e.agent === 'codex')).toBe(true);
  });

  it('isolates errors: one fails, other continues', async () => {
    const failing = createMockAdapter(
      'claude-code',
      [textEvent('claude-code', 'before-error')],
      { throwAfter: 1, throwError: new Error('fail') },
    );
    const healthy = createMockAdapter('codex', [
      textEvent('codex', 'ok'),
      doneEvent('codex'),
    ]);

    const events = await collectEvents(
      runParallel([
        { adapter: failing, prompt: 'hi' },
        { adapter: healthy, prompt: 'hi' },
      ]),
    );

    // Healthy adapter events present
    expect(events.some((e) => e.agent === 'codex' && e.type === 'done')).toBe(true);
    // Failing adapter got error + done
    const failEvents = events.filter((e) => e.agent === 'claude-code');
    expect(failEvents.some((e) => e.type === 'error')).toBe(true);
    expect(
      failEvents.some(
        (e) =>
          e.type === 'done' &&
          (e as AgentEvent & { payload: { status: string } }).payload.status ===
            'error',
      ),
    ).toBe(true);
  });

  it('abort yields done(interrupted) for all active adapters', async () => {
    const controller = new AbortController();
    const stalling: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield textEvent('claude-code', 'start');
        await new Promise(() => {});
      },
      async isAvailable() {
        return true;
      },
    };
    const stalling2: AgentAdapter = {
      agent: 'codex',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield textEvent('codex', 'start');
        await new Promise(() => {});
      },
      async isAvailable() {
        return true;
      },
    };

    const opts: AgentOptions = { abortSignal: controller.signal };

    // Abort after a tick
    setTimeout(() => controller.abort(), 10);

    const events = await collectEvents(
      runParallel([
        { adapter: stalling, prompt: 'hi', options: opts },
        { adapter: stalling2, prompt: 'hi', options: opts },
      ]),
    );

    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents.length).toBeGreaterThanOrEqual(2);
    for (const d of doneEvents) {
      expect(
        (d as AgentEvent & { payload: { status: string } }).payload.status,
      ).toBe('interrupted');
    }
  });

  it('MISSING_DONE per-adapter does not affect others', async () => {
    const noDone = createMockAdapter('claude-code', [
      textEvent('claude-code', 'hi'),
    ]);
    const healthy = createMockAdapter('codex', [
      textEvent('codex', 'ok'),
      doneEvent('codex'),
    ]);

    const events = await collectEvents(
      runParallel([
        { adapter: noDone, prompt: 'hi' },
        { adapter: healthy, prompt: 'hi' },
      ]),
    );

    // claude-code gets MISSING_DONE error + done(error)
    const ccEvents = events.filter((e) => e.agent === 'claude-code');
    expect(ccEvents.some((e) => e.type === 'error')).toBe(true);
    expect(
      ccEvents.some(
        (e) =>
          e.type === 'error' &&
          (e as AgentEvent & { payload: { code: string } }).payload.code ===
            'MISSING_DONE',
      ),
    ).toBe(true);

    // codex still completes normally
    const codexEvents = events.filter((e) => e.agent === 'codex');
    expect(codexEvents.some((e) => e.type === 'done')).toBe(true);
    expect(
      codexEvents.some(
        (e) =>
          e.type === 'done' &&
          (e as AgentEvent & { payload: { status: string } }).payload.status ===
            'success',
      ),
    ).toBe(true);
  });

  it('synthesized events preserve per-adapter sessionId', async () => {
    const SID = 'parallel-adapter-sid';
    const noDone: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield createEvent('text', 'claude-code', { content: 'hi' }, SID);
      },
      async isAvailable() {
        return true;
      },
    };

    const events = await collectEvents(
      runParallel([{ adapter: noDone, prompt: 'hi' }]),
    );
    const ccEvents = events.filter((e) => e.agent === 'claude-code');
    for (const e of ccEvents) {
      expect(e.sessionId).toBe(SID);
    }
  });

  it('pre-aborted signal does not call adapter.run()', async () => {
    let runCalled = 0;
    function makeAdapter(agent: string): AgentAdapter {
      return {
        agent,
        run(): AsyncGenerator<AgentEvent, void, void> {
          runCalled++;
          return (async function* () {
            yield textEvent(agent, 'hi');
            yield doneEvent(agent);
          })();
        },
        async isAvailable() {
          return true;
        },
      };
    }

    const controller = new AbortController();
    controller.abort();
    const opts: AgentOptions = { abortSignal: controller.signal };

    const events = await collectEvents(
      runParallel([
        { adapter: makeAdapter('claude-code'), prompt: 'hi', options: opts },
        { adapter: makeAdapter('codex'), prompt: 'hi', options: opts },
      ]),
    );

    expect(runCalled).toBe(0);
    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(2);
    for (const d of doneEvents) {
      expect(
        (d as AgentEvent & { payload: { status: string } }).payload.status,
      ).toBe('interrupted');
    }
  });

  it('any pre-aborted signal cancels all tasks (global cancel)', async () => {
    let runCalled = 0;
    function makeAdapter(agent: string): AgentAdapter {
      return {
        agent,
        run(): AsyncGenerator<AgentEvent, void, void> {
          runCalled++;
          return (async function* () {
            yield textEvent(agent, 'hi');
            yield doneEvent(agent);
          })();
        },
        async isAvailable() {
          return true;
        },
      };
    }

    const aborted = new AbortController();
    aborted.abort();

    const events = await collectEvents(
      runParallel([
        { adapter: makeAdapter('claude-code'), prompt: 'hi', options: { abortSignal: aborted.signal } },
        { adapter: makeAdapter('codex'), prompt: 'hi' }, // no signal
      ]),
    );

    expect(runCalled).toBe(0);
    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(2);
    expect(doneEvents.some((e) => e.agent === 'claude-code')).toBe(true);
    expect(doneEvents.some((e) => e.agent === 'codex')).toBe(true);
    for (const d of doneEvents) {
      expect(
        (d as AgentEvent & { payload: { status: string } }).payload.status,
      ).toBe('interrupted');
    }
  });

  it('empty tasks yields nothing', async () => {
    const events = await collectEvents(runParallel([]));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

describe('skills forwarding', () => {
  function createSkillsRecorder(agent: string): {
    adapter: AgentAdapter;
    received: unknown[];
  } {
    const received: unknown[] = [];
    const adapter: AgentAdapter = {
      agent,
      async *run(_prompt, options) {
        received.push(options?.skills);
        yield doneEvent(agent);
      },
      async isAvailable() {
        return true;
      },
    };
    return { adapter, received };
  }

  // engine-131: the legacy registry path forwards the list unchanged
  // [engine-124], and a custom adapter receives any value [engine-130].
  it('forwards the skill list unchanged through the legacy registry', async () => {
    const skills = Object.freeze(['skills/review', 'skills/lint/SKILL.md']);
    const empty: readonly string[] = Object.freeze([]);
    const dynamic = { review: 'skills/review' };
    const { adapter, received } = createSkillsRecorder('custom-skills');
    const registry = new AdapterRegistry();
    registry.register(adapter);

    for (const options of [
      { skills },
      { skills: empty },
      {},
      undefined,
      { skills: dynamic as never },
    ]) {
      await collectEvents(runAgent('custom-skills', 'p', options, registry));
    }

    expect(received).toHaveLength(5);
    expect(received[0]).toBe(skills);
    expect(received[1]).toBe(empty);
    expect(received[2]).toBeUndefined();
    expect(received[3]).toBeUndefined();
    expect(received[4]).toBe(dynamic);
  });

  it('forwards each parallel task list independently', async () => {
    const skills = Object.freeze(['skills/review']);
    const empty: readonly string[] = Object.freeze([]);
    const listed = createSkillsRecorder('custom-listed');
    const emptied = createSkillsRecorder('custom-empty');
    const omitted = createSkillsRecorder('custom-omitted');

    await collectEvents(
      runParallel([
        { adapter: listed.adapter, prompt: 'a', options: { skills } },
        { adapter: emptied.adapter, prompt: 'b', options: { skills: empty } },
        { adapter: omitted.adapter, prompt: 'c' },
      ]),
    );

    expect(listed.received).toHaveLength(1);
    expect(listed.received[0]).toBe(skills);
    expect(emptied.received).toHaveLength(1);
    expect(emptied.received[0]).toBe(empty);
    expect(omitted.received).toEqual([undefined]);
  });
});

// engine-131: every real built-in adapter class rejects a malformed `skills`
// value through its own preparation [engine-130], and that validation
// precedes any SDK load or process spawn, so no backend is needed: each
// adapter here gets a loader or spawner that records a reach and fails.
// That a list adding no skill configuration creates no carrier is verified
// against each adapter's own backend fixture, not repeated here: the run
// without skills in claude-skills.test.ts, codex-skills.test.ts,
// kimi-skills.test.ts, and opencode-skills.test.ts, and both the omitted and
// the empty list in gemini-skills.test.ts and, for an external server,
// opencode-skills.test.ts.
describe('malformed skills through the real built-in adapters', () => {
  beforeEach(() => {
    vi.stubEnv('CLIGENT_RUNTIME_GATE', 'off');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const BUILT_IN_AGENTS = [
    'claude-code',
    'codex',
    'gemini',
    'kimi',
    'opencode',
  ] as const;
  type BuiltInAgent = (typeof BUILT_IN_AGENTS)[number];

  const notAnArray = (agent: string): string =>
    `skills for adapter "${agent}" must be an array`;
  const MALFORMED: ReadonlyArray<
    readonly [label: string, value: unknown, message: (agent: string) => string]
  > = [
    ['a string', 'skills/review', notAnArray],
    ['an object', { review: 'skills/review' }, notAnArray],
    [
      '[42]',
      [42],
      (agent) =>
        `skills[0] for adapter "${agent}" must be a non-blank skill directory path`,
    ],
  ];

  function builtIn(agent: BuiltInAgent): {
    adapter:
      | ClaudeCodeAdapter
      | CodexAdapter
      | GeminiAdapter
      | KimiAdapter
      | OpenCodeAdapter;
    backend: string[];
  } {
    const backend: string[] = [];
    const reach = (what: string) => (): never => {
      backend.push(what);
      throw new Error(`${agent} ${what} reached`);
    };
    switch (agent) {
      case 'claude-code':
        return {
          adapter: new ClaudeCodeAdapter({ loadSdk: reach('SDK load') }),
          backend,
        };
      case 'codex':
        return {
          adapter: new CodexAdapter({ loadSdk: reach('SDK load') }),
          backend,
        };
      case 'gemini':
        return {
          adapter: new GeminiAdapter({ spawnProcess: reach('spawn') }),
          backend,
        };
      case 'kimi':
        return {
          adapter: new KimiAdapter({ spawnProcess: reach('spawn') }),
          backend,
        };
      case 'opencode':
        return {
          adapter: new OpenCodeAdapter(
            {},
            { loadSdk: reach('SDK load'), spawnProcess: reach('spawn') },
          ),
          backend,
        };
    }
  }

  // The adapter's own error terminal, or the one Cligent and the engine
  // synthesize from its rejection [engine-8], is the agent's only error and
  // precedes its only, final, error `done`.
  function expectRejection(
    events: readonly AgentEvent[],
    agent: string,
    message: string,
  ): void {
    const own = events.filter((event) => event.agent === agent);
    expect(
      own
        .filter((event) => event.type === 'error')
        .map((event) => (event.payload as { message: string }).message),
    ).toEqual([message]);
    expect(own.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(own.at(-1)).toMatchObject({
      type: 'done',
      payload: { status: 'error' },
    });
  }

  async function settle(
    run: AsyncGenerator<AgentEvent, void, void>,
  ): Promise<{ events: AgentEvent[]; thrown?: unknown }> {
    const events: AgentEvent[] = [];
    try {
      for await (const event of run) events.push(event);
    } catch (thrown) {
      return { events, thrown };
    }
    return { events };
  }

  it.each(BUILT_IN_AGENTS)(
    'rejects each malformed value on the direct %s adapter and through Cligent.run before any backend',
    async (agent) => {
      for (const [, value, message] of MALFORMED) {
        // Direct adapter: the generator rejects, or ends with its own error
        // terminal, naming the adapter's skills.
        const direct = builtIn(agent);
        const outcome = await settle(
          direct.adapter.run('p', { skills: value as never }) as AsyncGenerator<
            AgentEvent,
            void,
            void
          >,
        );
        if (outcome.thrown === undefined) {
          expectRejection(outcome.events, agent, message(agent));
        } else {
          expect(outcome.thrown).toMatchObject({ message: message(agent) });
        }
        expect(direct.backend).toEqual([]);

        // Instance default [engine-1] and per-run override: Cligent ends the
        // run with an error terminal naming the adapter's skills.
        const instance = builtIn(agent);
        expectRejection(
          await collectEvents(
            new Cligent(instance.adapter, { skills: value as never }).run('p'),
          ),
          agent,
          message(agent),
        );
        const perRun = builtIn(agent);
        expectRejection(
          await collectEvents(
            new Cligent(perRun.adapter).run('p', { skills: value as never }),
          ),
          agent,
          message(agent),
        );
        expect([...instance.backend, ...perRun.backend]).toEqual([]);
      }
    },
  );

  it('rejects each malformed value through the legacy registry', async () => {
    for (const [, value, message] of MALFORMED) {
      const { adapter, backend } = builtIn('kimi');
      const registry = new AdapterRegistry();
      registry.register(adapter);
      expectRejection(
        await collectEvents(
          runAgent('kimi', 'p', { skills: value as never }, registry),
        ),
        'kimi',
        message('kimi'),
      );
      expect(backend).toEqual([]);
    }
  });

  it('rejects each malformed value on every parallel built-in while a custom adapter receives it unchanged', async () => {
    for (const [, value, message] of MALFORMED) {
      const builtIns = BUILT_IN_AGENTS.map((agent) => ({
        agent,
        ...builtIn(agent),
      }));
      const received: unknown[] = [];
      const custom: AgentAdapter = {
        agent: 'custom-skills',
        async *run(_prompt, options) {
          received.push(options?.skills);
          yield doneEvent('custom-skills');
        },
        async isAvailable() {
          return true;
        },
      };

      const events = await collectEvents(
        runParallel([
          ...builtIns.map(({ adapter }) => ({
            adapter: adapter as AgentAdapter,
            prompt: 'p',
            options: { skills: value as never },
          })),
          { adapter: custom, prompt: 'p', options: { skills: value as never } },
        ]),
      );

      for (const { agent, backend } of builtIns) {
        expectRejection(events, agent, message(agent));
        expect(backend).toEqual([]);
      }
      expect(received).toHaveLength(1);
      expect(received[0]).toBe(value);
      expect(
        events.find(
          (event) => event.type === 'done' && event.agent === 'custom-skills',
        )?.payload,
      ).toMatchObject({ status: 'success' });
    }
  });
});
