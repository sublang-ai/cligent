// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeAdapter, wrapOpencodeClient } from '../adapters/opencode.js';
import { Cligent } from '../cligent.js';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  RunOptions,
} from '../types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function fixture() {
  const nativeRequest = {
    id: 'permission-1',
    sessionID: 'session-1',
    permission: 'bash',
    patterns: ['printf marker'],
    metadata: { command: 'printf marker' },
    tool: { messageID: 'message-1', callID: 'tool-1' },
  };
  let pending: unknown[] = [structuredClone(nativeRequest)];
  let lookupFailure: 'error' | 'timeout' | undefined;
  let restoreAfterMissingLookup = false;
  const replies: Array<{ reply: string; requestID: string }> = [];
  let executions = 0;
  const wrapped = wrapOpencodeClient(
    {
      session: {
        async create() {
          return { data: { id: 'session-1' } };
        },
        async promptAsync() {
          return {};
        },
      },
      event: {
        async subscribe() {
          return { stream: (async function* () {})() };
        },
      },
      permission: {
        async list() {
          if (lookupFailure === 'error')
            throw new Error('registry disconnected');
          if (lookupFailure === 'timeout') return new Promise<never>(() => {});
          const data = pending;
          if (restoreAfterMissingLookup && data.length === 0) {
            pending = [structuredClone(nativeRequest)];
          }
          return { data };
        },
        async reply(input: { reply: string; requestID: string }) {
          replies.push(input);
          if (input.reply === 'once') executions++;
          pending = [];
          return { data: true };
        },
      },
    },
    { apiVersion: 'v2' },
  );
  const adapter = new OpenCodeAdapter(
    { mode: 'external', serverUrl: 'http://fixture.invalid' },
    {
      loadSdk: async () => ({
        createClient: () => ({
          ...wrapped,
          async run() {
            return { sessionId: 'session-1' };
          },
          async *events() {
            yield { type: 'permission.asked', properties: nativeRequest };
            yield {
              type: 'session.idle',
              properties: { sessionID: 'session-1' },
            };
          },
          async abortSession() {},
          async close() {},
        }),
      }),
    },
  );
  const observed: AgentEvent[] = [];
  return {
    replies,
    nativeRequest,
    observed,
    wrapped,
    executions: () => executions,
    replacePending(value: unknown[]) {
      pending = value;
    },
    failLookup(mode: 'error' | 'timeout') {
      lookupFailure = mode;
    },
    reuseAfterMissingLookup() {
      pending = [];
      restoreAfterMissingLookup = true;
    },
    async run(options?: RunOptions) {
      for await (const event of new Cligent(adapter).run(
        'do the operation',
        options,
      )) {
        observed.push(event);
      }
      return observed;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('OpenCode native approval round trip', () => {
  it.each(['allow_once', 'deny'] as const)(
    'waits before %s and sends exactly one native choice',
    async (decision) => {
      const f = fixture();
      const shown = deferred<ApprovalRequest>();
      const choice = deferred<ApprovalDecision>();
      const run = f.run({
        approvalHandler: async (request) => {
          shown.resolve(request);
          return choice.promise;
        },
      });
      const request = await shown.promise;
      expect(request).toMatchObject({
        kind: 'tool',
        agent: 'opencode',
        sessionId: 'session-1',
        toolUseId: 'tool-1',
        toolName: 'bash',
        choices: ['allow_once', 'deny'],
        input: { command: 'printf marker' },
        details: {
          permission: 'bash',
          patterns: ['printf marker'],
          requestId: 'permission-1',
        },
      });
      expect(f.replies).toEqual([]);
      expect(f.executions()).toBe(0);
      choice.resolve(decision);
      const events = await run;
      expect(f.replies).toHaveLength(1);
      expect(f.replies[0]).toMatchObject({
        reply: decision === 'allow_once' ? 'once' : 'reject',
      });
      expect(f.executions()).toBe(decision === 'allow_once' ? 1 : 0);
      expect(
        events.filter((event) => event.type === 'approval_request'),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === 'approval_response'),
      ).toHaveLength(1);
      expect(
        events.some((event) => event.type === 'opencode:permission_decision'),
      ).toBe(false);
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        payload: { status: 'success' },
      });
    },
  );

  it.each([
    'removed',
    'session',
    'request',
    'call',
    'permission',
    'patterns',
    'input',
  ])('never answers a %s operation after human waiting', async (field) => {
    const f = fixture();
    const events = await f.run({
      approvalHandler: async () => {
        const changed = structuredClone(f.nativeRequest);
        if (field === 'session') changed.sessionID = 'other';
        if (field === 'request') changed.id = 'other';
        if (field === 'call') changed.tool.callID = 'other';
        if (field === 'permission') changed.permission = 'edit';
        if (field === 'patterns') changed.patterns = ['rm important'];
        if (field === 'input') changed.metadata.command = 'rm important';
        f.replacePending(field === 'removed' ? [] : [changed]);
        return 'allow_once';
      },
    });
    expect(f.replies).toEqual([]);
    expect(f.executions()).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('does not consume provider-operation time while the host decides', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const shown = deferred<void>();
    const choice = deferred<ApprovalDecision>();
    const run = f.run({
      approvalHandler: async () => {
        shown.resolve();
        return choice.promise;
      },
    });
    await shown.promise;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.replies).toEqual([]);
    choice.resolve('allow_once');
    const events = await run;
    expect(f.executions()).toBe(1);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('aborts an unanswered operation and invalidates its handler signal', async () => {
    const f = fixture();
    const shown = deferred<AbortSignal>();
    const controller = new AbortController();
    const run = f.run({
      abortSignal: controller.signal,
      approvalHandler: async (_request, { signal }) => {
        shown.resolve(signal);
        return new Promise<ApprovalDecision>(() => {});
      },
    });
    const signal = await shown.promise;
    controller.abort();
    const events = await run;
    expect(signal.aborted).toBe(true);
    expect(f.executions()).toBe(0);
    expect(f.replies).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      payload: { status: 'interrupted' },
    });
  });

  it('denies an expired operation without a persistent grant', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const shown = deferred<void>();
    const run = f.run({
      approvalHandler: async () => {
        shown.resolve();
        return new Promise<ApprovalDecision>(() => {});
      },
    });
    await shown.promise;
    await vi.advanceTimersByTimeAsync(600_001);
    await run;
    expect(f.replies[0]).toMatchObject({ reply: 'reject' });
    expect(f.executions()).toBe(0);
    expect(
      f.observed.find((event) => event.type === 'approval_response'),
    ).toMatchObject({ payload: { decision: 'deny', source: 'timeout' } });
  });

  it.each(['removed', 'reused'] as const)(
    'cancels a waiting host prompt when another client leaves its native identity %s',
    async (mode) => {
      vi.useFakeTimers();
      const f = fixture();
      const shown = deferred<AbortSignal>();
      const run = f.run({
        approvalHandler: async (_request, { signal }) => {
          shown.resolve(signal);
          return new Promise<ApprovalDecision>(() => {});
        },
      });
      const signal = await shown.promise;
      if (mode === 'reused') f.reuseAfterMissingLookup();
      else f.replacePending([]);
      await vi.advanceTimersByTimeAsync(1_001);
      const events = await run;
      expect(signal.aborted).toBe(true);
      expect(f.replies).toEqual([]);
      expect(f.executions()).toBe(0);
      expect(
        events.find((event) => event.type === 'approval_response'),
      ).toMatchObject({ payload: { decision: 'deny', source: 'cancelled' } });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['error', 'timeout'] as const)(
    'closes a host prompt on native registry %s',
    async (mode) => {
      vi.useFakeTimers();
      const f = fixture();
      const shown = deferred<AbortSignal>();
      const run = f.run({
        approvalHandler: async (_request, { signal }) => {
          shown.resolve(signal);
          return new Promise<ApprovalDecision>(() => {});
        },
      });
      const signal = await shown.promise;
      f.failLookup(mode);
      await vi.advanceTimersByTimeAsync(6_001);
      const events = await run;
      expect(signal.aborted).toBe(true);
      expect(f.replies).toEqual([]);
      expect(f.executions()).toBe(0);
      expect(events.find((event) => event.type === 'error')).toMatchObject({
        payload: { code: 'OPENCODE_PERMISSION_REPLY_FAILED' },
      });
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        payload: { status: 'error' },
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    'missing',
    'failure',
    'hard-deny',
    'auto-deny',
    'auto',
    'legacy',
  ] as const)('preserves the %s policy boundary', async (mode) => {
    const f = fixture();
    if (mode === 'legacy') f.wrapped.canApprovePermissions = false;
    const handler = vi.fn(async (): Promise<ApprovalDecision> => {
      if (mode === 'failure') throw new Error('host unavailable');
      return 'allow_once';
    });
    await f.run({
      ...(mode !== 'missing' ? { approvalHandler: handler } : {}),
      ...(mode === 'hard-deny'
        ? { permissions: { shellExecute: 'deny' } as const }
        : {}),
      ...(mode === 'auto' ? { permissions: { mode: 'auto' } as const } : {}),
      ...(mode === 'auto-deny'
        ? { permissions: { mode: 'auto', shellExecute: 'deny' } as const }
        : {}),
    });
    expect(handler).toHaveBeenCalledTimes(mode === 'failure' ? 1 : 0);
    expect(f.replies[0]).toMatchObject({
      reply: mode === 'auto' ? 'once' : 'reject',
    });
    expect(f.executions()).toBe(mode === 'auto' ? 1 : 0);
  });
});
