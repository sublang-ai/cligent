// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect } from 'vitest';
import { Cligent } from '../cligent.js';
import { createEvent } from '../events.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  CligentEvent,
  DonePayload,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  agent: string,
  events: AgentEvent[],
  opts?: { throwAfter?: number; throwError?: Error },
): AgentAdapter {
  return {
    agent,
    async *run(
      _prompt: string,
      _options?: AgentOptions,
    ): AsyncGenerator<AgentEvent, void, void> {
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

function createCapturingAdapter(
  agent: string,
  events: AgentEvent[],
): { adapter: AgentAdapter; captured: () => AgentOptions | undefined } {
  let capturedOptions: AgentOptions | undefined;
  const adapter: AgentAdapter = {
    agent,
    async *run(
      _prompt: string,
      options?: AgentOptions,
    ): AsyncGenerator<AgentEvent, void, void> {
      capturedOptions = options;
      for (const event of events) {
        yield event;
      }
    },
    async isAvailable() {
      return true;
    },
  };
  return { adapter, captured: () => capturedOptions };
}

async function collectEvents(
  gen: AsyncGenerator<CligentEvent, void, void>,
): Promise<CligentEvent[]> {
  const result: CligentEvent[] = [];
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
  status: DonePayload['status'] = 'success',
  sid = 'test-sid',
  extra?: Partial<DonePayload>,
): AgentEvent {
  return createEvent(
    'done',
    agent,
    {
      status,
      usage: { inputTokens: 10, outputTokens: 20, toolUses: 1 },
      durationMs: 100,
      ...extra,
    },
    sid,
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('Cligent lifecycle', () => {
  // TENG-001: Role injection
  it('injects role into every event when role is set', async () => {
    const adapter = createMockAdapter('claude-code', [
      textEvent('claude-code', 'hello'),
      doneEvent('claude-code'),
    ]);
    const agent = new Cligent(adapter, { role: 'coder' });
    const events = await collectEvents(agent.run('hi'));

    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.role).toBe('coder');
    }
  });

  it('omits role when not set', async () => {
    const adapter = createMockAdapter('claude-code', [
      textEvent('claude-code', 'hello'),
      doneEvent('claude-code'),
    ]);
    const agent = new Cligent(adapter);
    const events = await collectEvents(agent.run('hi'));

    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.role).toBeUndefined();
    }
  });

  // TENG-002: Single-flight
  it('throws when run() is called while already active', async () => {
    const adapter: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield textEvent('claude-code', 'start');
        await new Promise(() => {}); // stall forever
      },
      async isAvailable() {
        return true;
      },
    };
    const agent = new Cligent(adapter);
    const gen = agent.run('first');
    await gen.next(); // start consuming

    // async generator body runs on .next(), so we need to start the second
    // generator and trigger its body to observe the throw
    const gen2 = agent.run('second');
    await expect(gen2.next()).rejects.toThrow(
      'Cligent.run() is already active on this instance',
    );

    // Cleanup
    await gen.return(undefined as never);
  });

  it('allows run() after previous run completes', async () => {
    const adapter = createMockAdapter('claude-code', [
      textEvent('claude-code', 'hello'),
      doneEvent('claude-code'),
    ]);
    const agent = new Cligent(adapter);

    const events1 = await collectEvents(agent.run('first'));
    expect(events1).toHaveLength(2);

    const events2 = await collectEvents(agent.run('second'));
    expect(events2).toHaveLength(2);
  });

  // TENG-003: Option merging
  it('merges options: per-call overrides scalars, deep-merges permissions', async () => {
    const { adapter, captured } = createCapturingAdapter('claude-code', [
      textEvent('claude-code', 'hi'),
      doneEvent('claude-code'),
    ]);

    const agent = new Cligent(adapter, {
      cwd: '/default',
      model: 'default-model',
      permissions: { fileWrite: 'allow', shellExecute: 'ask' },
      maxTurns: 5,
      allowedTools: ['tool-a'],
    });

    await collectEvents(
      agent.run('hi', {
        model: 'override-model',
        permissions: { shellExecute: 'allow' },
        allowedTools: ['tool-b'],
      }),
    );

    const opts = captured()!;
    expect(opts.cwd).toBe('/default');
    expect(opts.model).toBe('override-model');
    expect(opts.permissions).toEqual({
      fileWrite: 'allow',
      shellExecute: 'allow',
    });
    expect(opts.maxTurns).toBe(5);
    expect(opts.allowedTools).toEqual(['tool-b']);
  });

  it('role always comes from defaults, not overrides', async () => {
    const adapter = createMockAdapter('claude-code', [
      textEvent('claude-code', 'hello'),
      doneEvent('claude-code'),
    ]);
    const agent = new Cligent(adapter, { role: 'coder' });

    const events = await collectEvents(
      agent.run('hi', { role: 'reviewer' } as never),
    );

    // Role comes from constructor defaults
    for (const e of events) {
      expect(e.role).toBe('coder');
    }
  });
});

// ---------------------------------------------------------------------------
// Session continuity
// ---------------------------------------------------------------------------

describe('Cligent session continuity', () => {
  // TENG-004: resumeToken capture and auto-inject
  it('captures resumeToken from done and auto-injects on next run', async () => {
    const SID_NEW = 'new-session-from-backend';
    const { adapter, captured } = createCapturingAdapter('claude-code', [
      textEvent('claude-code', 'hello', SID_NEW),
      doneEvent('claude-code', 'success', SID_NEW, {
        resumeToken: 'token-abc',
      }),
    ]);

    const agent = new Cligent(adapter);

    // First run: adapter provides resumeToken
    await collectEvents(agent.run('first'));
    expect(agent.resumeToken).toBe('token-abc');

    // Second run: should auto-inject resume
    await collectEvents(agent.run('second'));
    const opts = captured()!;
    expect(opts.resume).toBe('token-abc');
  });

  it('explicit resume string overrides stored token', async () => {
    const { adapter, captured } = createCapturingAdapter('claude-code', [
      textEvent('claude-code', 'hello'),
      doneEvent('claude-code', 'success', 'test-sid', {
        resumeToken: 'stored-token',
      }),
    ]);

    const agent = new Cligent(adapter);
    await collectEvents(agent.run('first'));

    // Override with explicit token
    await collectEvents(agent.run('second', { resume: 'explicit-token' }));
    const opts = captured()!;
    expect(opts.resume).toBe('explicit-token');
  });

  it('resume: false forces fresh session', async () => {
    const { adapter, captured } = createCapturingAdapter('claude-code', [
      textEvent('claude-code', 'hello'),
      doneEvent('claude-code', 'success', 'test-sid', {
        resumeToken: 'stored-token',
      }),
    ]);

    const agent = new Cligent(adapter);
    await collectEvents(agent.run('first'));

    await collectEvents(agent.run('second', { resume: false }));
    const opts = captured()!;
    expect(opts.resume).toBeUndefined();
  });

  // TENG-005: no token, no auto-inject
  it('no resume injected when adapter omits resumeToken', async () => {
    const { adapter, captured } = createCapturingAdapter('claude-code', [
      textEvent('claude-code', 'hello'),
      doneEvent('claude-code'),
    ]);

    const agent = new Cligent(adapter);

    await collectEvents(agent.run('first'));
    expect(agent.resumeToken).toBeUndefined();

    await collectEvents(agent.run('second'));
    const opts = captured()!;
    expect(opts.resume).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Protocol hardening
// ---------------------------------------------------------------------------

describe('Cligent protocol hardening', () => {
  // TENG-006: event ordering
  it('yields events in order with exactly one done', async () => {
    const adapter = createMockAdapter('claude-code', [
      textEvent('claude-code', 'hello'),
      textEvent('claude-code', 'world'),
      doneEvent('claude-code'),
    ]);
    const agent = new Cligent(adapter);
    const events = await collectEvents(agent.run('hi'));

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('text');
    expect(events[1].type).toBe('text');
    expect(events[2].type).toBe('done');
  });

  // TENG-007: abort
  it('yields done(interrupted) on abort', async () => {
    const controller = new AbortController();
    const adapter: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield textEvent('claude-code', 'start');
        await new Promise(() => {}); // stall
      },
      async isAvailable() {
        return true;
      },
    };
    const agent = new Cligent(adapter);
    const gen = agent.run('hi', { abortSignal: controller.signal });
    const events: CligentEvent[] = [];

    const first = await gen.next();
    if (!first.done) events.push(first.value);
    controller.abort();
    const rest = await gen.next();
    if (!rest.done) events.push(rest.value);
    for await (const e of gen) events.push(e);

    expect(events.length).toBeGreaterThanOrEqual(2);
    const last = events[events.length - 1];
    expect(last.type).toBe('done');
    expect((last.payload as DonePayload).status).toBe('interrupted');
  });

  it('pre-aborted signal yields done(interrupted) without calling adapter', async () => {
    let adapterRan = false;
    const adapter: AgentAdapter = {
      agent: 'claude-code',
      run(): AsyncGenerator<AgentEvent, void, void> {
        adapterRan = true;
        return (async function* () {
          yield textEvent('claude-code', 'hi');
          yield doneEvent('claude-code');
        })();
      },
      async isAvailable() {
        return true;
      },
    };

    const controller = new AbortController();
    controller.abort();

    const agent = new Cligent(adapter);
    const events = await collectEvents(
      agent.run('hi', { abortSignal: controller.signal }),
    );

    expect(adapterRan).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
    expect((events[0].payload as DonePayload).status).toBe('interrupted');
  });

  // TENG-008: adapter throw
  it('yields error + done on adapter throw', async () => {
    const adapter = createMockAdapter(
      'claude-code',
      [textEvent('claude-code', 'hello')],
      { throwAfter: 1, throwError: new Error('boom') },
    );
    const agent = new Cligent(adapter);
    const events = await collectEvents(agent.run('hi'));

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('text');
    expect(events[1].type).toBe('error');
    expect((events[1].payload as { code: string }).code).toBe('ADAPTER_ERROR');
    expect(events[2].type).toBe('done');
    expect((events[2].payload as DonePayload).status).toBe('error');
  });

  it('synthesized done has zeroed usage', async () => {
    const adapter = createMockAdapter('claude-code', [], {
      throwAfter: 0,
      throwError: new Error('fail'),
    });
    const agent = new Cligent(adapter);
    const events = await collectEvents(agent.run('hi'));

    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as DonePayload;
    expect(payload.usage.inputTokens).toBe(0);
    expect(payload.usage.outputTokens).toBe(0);
    expect(payload.usage.toolUses).toBe(0);
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  // TENG-009: missing done
  it('synthesizes MISSING_DONE on exhaustion without done', async () => {
    const adapter = createMockAdapter('claude-code', [
      textEvent('claude-code', 'hello'),
    ]);
    const agent = new Cligent(adapter);
    const events = await collectEvents(agent.run('hi'));

    expect(events).toHaveLength(3);
    expect(events[1].type).toBe('error');
    expect((events[1].payload as { code: string }).code).toBe('MISSING_DONE');
    expect(events[2].type).toBe('done');
    expect((events[2].payload as DonePayload).status).toBe('error');
  });

  // TENG-010: done-cardinality race
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

    controller.abort();
    const agent = new Cligent(adapter);
    const events = await collectEvents(
      agent.run('hi', { abortSignal: controller.signal }),
    );
    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
  });

  it('suppresses post-done events', async () => {
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
    const agent = new Cligent(adapter);
    const events = await collectEvents(agent.run('hi'));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('text');
    expect(events[1].type).toBe('done');
  });

  it('running flag resets after error', async () => {
    const adapter = createMockAdapter('claude-code', [], {
      throwAfter: 0,
      throwError: new Error('fail'),
    });
    const agent = new Cligent(adapter);

    await collectEvents(agent.run('first'));
    // Should not throw — running flag was reset
    const events = await collectEvents(agent.run('second'));
    expect(events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Parallel
// ---------------------------------------------------------------------------

describe('Cligent.parallel', () => {
  // TENG-011: interleaving
  it('interleaves events from multiple agents', async () => {
    const a1 = createMockAdapter('claude-code', [
      textEvent('claude-code', 'a1'),
      doneEvent('claude-code'),
    ]);
    const a2 = createMockAdapter('codex', [
      textEvent('codex', 'a2'),
      doneEvent('codex'),
    ]);

    const agent1 = new Cligent(a1, { role: 'coder' });
    const agent2 = new Cligent(a2, { role: 'reviewer' });

    const events = await collectEvents(
      Cligent.parallel([
        { agent: agent1, prompt: 'hi' },
        { agent: agent2, prompt: 'hi' },
      ]),
    );

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'done')).toHaveLength(2);
    expect(types.filter((t) => t === 'text')).toHaveLength(2);
    expect(events.some((e) => e.agent === 'claude-code')).toBe(true);
    expect(events.some((e) => e.agent === 'codex')).toBe(true);
    expect(events.some((e) => e.role === 'coder')).toBe(true);
    expect(events.some((e) => e.role === 'reviewer')).toBe(true);
  });

  // TENG-012: error isolation
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

    const agent1 = new Cligent(failing);
    const agent2 = new Cligent(healthy);

    const events = await collectEvents(
      Cligent.parallel([
        { agent: agent1, prompt: 'hi' },
        { agent: agent2, prompt: 'hi' },
      ]),
    );

    // Healthy completes
    expect(events.some((e) => e.agent === 'codex' && e.type === 'done')).toBe(true);
    // Failing gets error + done
    const failEvents = events.filter((e) => e.agent === 'claude-code');
    expect(failEvents.some((e) => e.type === 'error')).toBe(true);
    expect(
      failEvents.some(
        (e) =>
          e.type === 'done' &&
          (e.payload as DonePayload).status === 'error',
      ),
    ).toBe(true);
  });

  // TENG-013: missing-done isolation
  it('missing-done on one agent does not affect others', async () => {
    const noDone = createMockAdapter('claude-code', [
      textEvent('claude-code', 'hi'),
    ]);
    const healthy = createMockAdapter('codex', [
      textEvent('codex', 'ok'),
      doneEvent('codex'),
    ]);

    const agent1 = new Cligent(noDone);
    const agent2 = new Cligent(healthy);

    const events = await collectEvents(
      Cligent.parallel([
        { agent: agent1, prompt: 'hi' },
        { agent: agent2, prompt: 'hi' },
      ]),
    );

    const ccEvents = events.filter((e) => e.agent === 'claude-code');
    expect(
      ccEvents.some(
        (e) =>
          e.type === 'error' &&
          (e.payload as { code: string }).code === 'MISSING_DONE',
      ),
    ).toBe(true);

    const codexEvents = events.filter((e) => e.agent === 'codex');
    expect(
      codexEvents.some(
        (e) =>
          e.type === 'done' &&
          (e.payload as DonePayload).status === 'success',
      ),
    ).toBe(true);
  });

  // TENG-014: per-task and shared abort
  it('per-task abort only affects that task', async () => {
    const controller = new AbortController();
    const stalling: AgentAdapter = {
      agent: 'claude-code',
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield textEvent('claude-code', 'start');
        await new Promise(() => {}); // stall
      },
      async isAvailable() {
        return true;
      },
    };
    const healthy = createMockAdapter('codex', [
      textEvent('codex', 'ok'),
      doneEvent('codex'),
    ]);

    const agent1 = new Cligent(stalling);
    const agent2 = new Cligent(healthy);

    setTimeout(() => controller.abort(), 10);

    const events = await collectEvents(
      Cligent.parallel([
        { agent: agent1, prompt: 'hi', overrides: { abortSignal: controller.signal } },
        { agent: agent2, prompt: 'hi' },
      ]),
    );

    // claude-code got interrupted
    expect(
      events.some(
        (e) =>
          e.agent === 'claude-code' &&
          e.type === 'done' &&
          (e.payload as DonePayload).status === 'interrupted',
      ),
    ).toBe(true);

    // codex still completed
    expect(
      events.some(
        (e) =>
          e.agent === 'codex' &&
          e.type === 'done' &&
          (e.payload as DonePayload).status === 'success',
      ),
    ).toBe(true);
  });

  it('shared abort cancels all tasks', async () => {
    const controller = new AbortController();
    const stalling1: AgentAdapter = {
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

    const agent1 = new Cligent(stalling1);
    const agent2 = new Cligent(stalling2);

    setTimeout(() => controller.abort(), 10);

    const events = await collectEvents(
      Cligent.parallel([
        { agent: agent1, prompt: 'hi', overrides: { abortSignal: controller.signal } },
        { agent: agent2, prompt: 'hi', overrides: { abortSignal: controller.signal } },
      ]),
    );

    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents.length).toBeGreaterThanOrEqual(2);
    for (const d of doneEvents) {
      expect((d.payload as DonePayload).status).toBe('interrupted');
    }
  });

  it('empty tasks yields nothing', async () => {
    const events = await collectEvents(Cligent.parallel([]));
    expect(events).toHaveLength(0);
  });
});
