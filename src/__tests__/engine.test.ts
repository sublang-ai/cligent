// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect } from 'vitest';
import { runAgent, runParallel } from '../engine.js';
import { createEvent } from '../events.js';
import { AdapterRegistry } from '../registry.js';
import type { AgentAdapter, AgentEvent, AgentOptions } from '../types.js';

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
      usage: { inputTokens: 10, outputTokens: 20, toolUses: 1 },
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
    let captured: AgentOptions<CustomEffort> | undefined;
    const adapter: AgentAdapter<CustomEffort> = {
      agent: 'custom-agent',
      async *run(_prompt, options) {
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
        { effort: 'exhaustive' },
        registry,
      ),
    );

    expect(captured?.effort).toBe('exhaustive');
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

  it('synthesized done has zeroed usage and measured durationMs', async () => {
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
    const payload = (done as AgentEvent & { payload: { usage: { inputTokens: number; outputTokens: number; toolUses: number }; durationMs: number } }).payload;
    expect(payload.usage.inputTokens).toBe(0);
    expect(payload.usage.outputTokens).toBe(0);
    expect(payload.usage.toolUses).toBe(0);
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
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
