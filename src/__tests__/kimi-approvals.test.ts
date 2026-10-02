// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';
import { KimiAdapter } from '../adapters/kimi.js';
import { Cligent } from '../cligent.js';
import type { AgentEvent } from '../types.js';
import { FakeKimi } from './fixtures/kimi-peer.js';

async function collect(
  source: AsyncIterable<AgentEvent>,
  onEvent?: (event: AgentEvent) => void,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    onEvent?.(event);
    events.push(event);
  }
  return events;
}

describe('live host approvals through the real ACP connection', () => {
  it.each(['allow_once', 'deny', 'error', 'abort'] as const)(
    'keeps the native tool pending until the %s outcome',
    async (outcome) => {
      let sideEffects = 0;
      const fake = new FakeKimi({
        prompt: async (connection, request, state) => {
          state.permissionOutcome = await connection.requestPermission({
            sessionId: request.sessionId,
            toolCall: {
              toolCallId: 'live-tool',
              title: 'Shell',
              kind: 'execute',
              rawInput: { command: 'fixture operation' },
            },
            options: [
              { kind: 'allow_always', name: 'Always', optionId: 'always' },
              { kind: 'allow_once', name: 'Once', optionId: 'once' },
              { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
            ],
          });
          if (
            (state.permissionOutcome as { outcome: { optionId?: string } })
              .outcome.optionId === 'once'
          )
            sideEffects++;
          return { stopReason: 'end_turn' };
        },
      });
      const abort = new AbortController();
      let answer!: (value: 'allow_once' | 'deny') => void;
      let fail!: (error: Error) => void;
      let handlerSignal: AbortSignal | undefined;
      const events: AgentEvent[] = [];
      const operation = collect(
        new Cligent(new KimiAdapter({ spawnProcess: fake.spawn })).run(
          'operate',
          {
            abortSignal: abort.signal,
            approvalHandler: async (request, { signal }) => {
              handlerSignal = signal;
              expect(request).toMatchObject({
                kind: 'tool',
                agent: 'kimi',
                sessionId: 'kimi-session',
                toolUseId: 'live-tool',
                toolName: 'Shell',
                input: { command: 'fixture operation' },
                choices: ['allow_once', 'deny'],
              });
              return new Promise((resolve, reject) => {
                answer = resolve;
                fail = reject;
              });
            },
          },
        ),
        (event) => events.push(event),
      );
      await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
      expect(events.some((event) => event.type === 'approval_request')).toBe(
        true,
      );
      expect(fake.permissionOutcome).toBeUndefined();
      expect(sideEffects).toBe(0);
      if (outcome === 'error') fail(new Error('disconnected host'));
      else if (outcome === 'abort') abort.abort();
      else answer(outcome);
      await operation;
      expect(sideEffects).toBe(outcome === 'allow_once' ? 1 : 0);
      expect(
        events.filter((event) => event.type === 'approval_response'),
      ).toMatchObject([
        {
          payload: {
            decision: outcome === 'allow_once' ? 'allow_once' : 'deny',
            source:
              outcome === 'error'
                ? 'error'
                : outcome === 'abort'
                  ? 'cancelled'
                  : 'host',
          },
        },
      ]);
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(events.at(-1)?.type).toBe('done');
      if (outcome === 'abort' || outcome === 'error')
        expect(handlerSignal?.aborted).toBe(true);
      answer('allow_once');
      await Promise.resolve();
      expect(sideEffects).toBe(outcome === 'allow_once' ? 1 : 0);
    },
  );

  it('offers no persistent allow when ACP has only always options', async () => {
    const fake = new FakeKimi({
      prompt: async (connection, request, state) => {
        state.permissionOutcome = await connection.requestPermission({
          sessionId: request.sessionId,
          toolCall: { toolCallId: 'only-always', title: 'Shell' },
          options: [
            { kind: 'allow_always', name: 'Always', optionId: 'always' },
            { kind: 'reject_always', name: 'Never', optionId: 'never' },
          ],
        });
        return { stopReason: 'end_turn' };
      },
    });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('operate', {
        approvalHandler: async (request) => {
          expect(request.choices).toEqual(['deny']);
          return 'deny';
        },
      }),
    );
    expect(fake.permissionOutcome).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(
      events.filter((event) => event.type === 'approval_response'),
    ).toHaveLength(1);
  });
});

it('declines ambiguous ACP options and preserves diff/path scope for review', async () => {
  const fake = new FakeKimi({
    prompt: async (connection, request, state) => {
      state.permissionOutcome = await connection.requestPermission({
        sessionId: request.sessionId,
        toolCall: {
          toolCallId: 'ambiguous',
          title: 'Edit',
          kind: 'edit',
          locations: [{ path: '/fixture/out.txt' }],
          content: [
            {
              type: 'diff',
              path: '/fixture/out.txt',
              oldText: 'before',
              newText: 'after',
            },
          ],
        },
        options: [
          { kind: 'allow_once', name: 'Apply original', optionId: 'original' },
          { kind: 'allow_once', name: 'Apply revised', optionId: 'revised' },
          {
            kind: 'reject_once',
            name: 'Reject and continue',
            optionId: 'continue',
          },
          { kind: 'reject_once', name: 'Reject and exit', optionId: 'exit' },
        ],
      });
      return { stopReason: 'end_turn' };
    },
  });
  let received: unknown;
  const events = await collect(
    new KimiAdapter({ spawnProcess: fake.spawn }).run('edit', {
      approvalHandler: async (request) => {
        received = request;
        return 'deny';
      },
    }),
  );
  expect(received).toMatchObject({
    choices: ['deny'],
    input: {},
    details: {
      kind: 'edit',
      locations: [{ path: '/fixture/out.txt' }],
      content: [{ type: 'diff', oldText: 'before', newText: 'after' }],
    },
  });
  expect(fake.permissionOutcome).toEqual({ outcome: { outcome: 'cancelled' } });
  expect(
    events.filter((event) => event.type === 'approval_response'),
  ).toHaveLength(1);
});

it('preserves caller-admitted MCP once authorization without invoking the live handler', async () => {
  const fake = new FakeKimi({
    prompt: async (connection, request, state) => {
      const name = state.newRequests[0]!.mcpServers[0]!.name;
      state.permissionOutcome = await connection.requestPermission({
        sessionId: request.sessionId,
        toolCall: { toolCallId: 'admitted', title: `mcp__${name}__inspect` },
        options: [
          { kind: 'allow_once', name: 'Once', optionId: 'once' },
          { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
        ],
      });
      return { stopReason: 'end_turn' };
    },
  });
  const handler = vi.fn(async () => 'deny' as const);
  const events = await collect(
    new KimiAdapter({ spawnProcess: fake.spawn }).run('inspect', {
      mcpServers: { fixture: { type: 'stdio', command: 'fixture-command' } },
      approvalHandler: handler,
    }),
  );
  expect(handler).not.toHaveBeenCalled();
  expect(events.some((event) => event.type === 'approval_request')).toBe(false);
  expect(fake.permissionOutcome).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
});
