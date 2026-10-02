// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createEvent } from '../../events.js';
import { ApprovalController } from '../../internal/approvals.js';
import type {
  AgentEvent,
  AgentOptions,
  ApprovalDecision,
} from '../../types.js';
import type { TmuxPlayApprovalRequest } from './index.js';
import { createTmuxPlayRuntime } from './runtime.js';
import type { TmuxPlayRecord } from './records.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function providerFixture(
  calls: Array<{
    prompt: string;
    handler: boolean;
    decision: ApprovalDecision;
  }>,
) {
  return class {
    readonly agent = 'claude-code';
    async isAvailable() {
      return true;
    }
    async *run(
      prompt: string,
      options?: AgentOptions,
    ): AsyncGenerator<AgentEvent> {
      const events: AgentEvent[] = [];
      const controller = new ApprovalController({
        agent: this.agent,
        handler: options?.approvalHandler,
        signal: options?.abortSignal,
        emit: (event) => {
          events.push(event);
        },
      });
      try {
        const pending = controller.request({
          sessionId: 'same-session',
          toolUseId: 'same-tool',
          toolName: 'browser_click',
          input: { target: prompt },
          reason: 'Native tool asks',
          choices: ['allow_once', 'deny'],
        });
        while (events.length) yield events.shift()!;
        const decision = await pending;
        while (events.length) yield events.shift()!;
        calls.push({
          prompt,
          handler: options?.approvalHandler !== undefined,
          decision,
        });
        yield createEvent(
          'done',
          this.agent,
          {
            status: options?.abortSignal?.aborted ? 'interrupted' : 'success',
            result: decision,
            usage: { toolUses: 0 },
            durationMs: 1,
          },
          'same-session',
        );
      } finally {
        controller.close();
      }
    }
  };
}

describe('live host approval forwarding', () => {
  it('attributes concurrent and repeated calls independently and excludes hidden or tool-free controls', async () => {
    const calls: Array<{
      prompt: string;
      handler: boolean;
      decision: ApprovalDecision;
    }> = [];
    const envelopes: TmuxPlayApprovalRequest[] = [];
    const records: TmuxPlayRecord[] = [];
    const bothStarted = deferred<void>();
    const Provider = providerFixture(calls);
    const runtime = await createTmuxPlayRuntime({
      captainConfig: { adapter: 'claude' },
      players: [
        { id: 'a', adapter: 'claude' },
        { id: 'b', adapter: 'claude' },
      ],
      adapterImports: { claude: async () => Provider },
      observers: [
        {
          onRecord: (record) => {
            records.push(record);
          },
        },
      ],
      approvalHandler: async (envelope, { signal }) => {
        expect(signal.aborted).toBe(false);
        envelopes.push(envelope);
        if (envelopes.length === 2) bothStarted.resolve();
        if (envelope.actorId !== 'captain') await bothStarted.promise;
        return envelope.actorId === 'b' ? 'deny' : 'allow_once';
      },
      captain: {
        async handleBossTurn(turn, context) {
          if (turn.id === 1) {
            const results = await Promise.all([
              context.callPlayer('a', 'allow a'),
              context.callPlayer('b', 'deny b'),
            ]);
            expect(results.map((result) => result.finalText)).toEqual([
              'allow_once',
              'deny',
            ]);
            await context.callCaptain('working captain');
            await context.callCaptain('hidden control', {
              visibility: 'hidden',
            });
            await context.callCaptain('tool-free control', {
              allowedTools: [],
            });
          } else await context.callPlayer('a', 'next turn');
        },
      },
    });
    try {
      await runtime.runBossTurn('first');
      await runtime.runBossTurn('second');
      expect(envelopes.map(({ actorId, turnId }) => [actorId, turnId])).toEqual(
        [
          ['a', 1],
          ['b', 1],
          ['captain', 1],
          ['a', 2],
        ],
      );
      expect(new Set(envelopes.map((value) => value.invocationId)).size).toBe(
        4,
      );
      for (const { request } of envelopes)
        expect(request).toMatchObject({
          sessionId: 'same-session',
          toolUseId: 'same-tool',
          toolName: 'browser_click',
          choices: ['allow_once', 'deny'],
        });
      expect(calls.filter((call) => call.prompt.includes('control'))).toEqual([
        { prompt: 'hidden control', handler: false, decision: 'deny' },
        { prompt: 'tool-free control', handler: false, decision: 'deny' },
      ]);
      const approvals = records.flatMap((record) =>
        'event' in record &&
        (record.event.type === 'approval_request' ||
          record.event.type === 'approval_response')
          ? [record.event]
          : [],
      );
      expect(
        approvals.filter((event) => event.type === 'approval_request'),
      ).toHaveLength(4);
      expect(
        approvals.filter((event) => event.type === 'approval_response'),
      ).toHaveLength(4);
      expect(JSON.stringify(records)).not.toContain('approvalHandler');
      expect(records.at(-1)?.type).toBe('turn_finished');
    } finally {
      await runtime.dispose();
    }
  });

  it('cancels native waits before terminal records and ignores a late allow', async () => {
    const calls: Array<{
      prompt: string;
      handler: boolean;
      decision: ApprovalDecision;
    }> = [];
    const Provider = providerFixture(calls);
    const entered = deferred<AbortSignal>();
    const reply = deferred<ApprovalDecision>();
    const records: TmuxPlayRecord[] = [];
    const runtime = await createTmuxPlayRuntime({
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'worker', adapter: 'claude' }],
      adapterImports: { claude: async () => Provider },
      approvalHandler: async (_request, { signal }) => {
        entered.resolve(signal);
        return reply.promise;
      },
      observers: [
        {
          onRecord: (record) => {
            records.push(record);
          },
        },
      ],
      captain: {
        async handleBossTurn(_turn, context) {
          await context.callPlayer('worker', 'waiting');
        },
      },
    });
    try {
      const turn = runtime.runBossTurn('start');
      const signal = await entered.promise;
      runtime.abortActiveTurn('host cancelled');
      await turn;
      expect(signal.aborted).toBe(true);
      expect(calls).toEqual([
        { prompt: 'waiting', handler: true, decision: 'deny' },
      ]);
      const index = records.findIndex(
        (record) =>
          'event' in record && record.event.type === 'approval_response',
      );
      expect(index).toBeGreaterThan(-1);
      expect(records.at(-1)?.type).toBe('turn_aborted');
      reply.resolve('allow_once');
      await Promise.resolve();
      expect(
        records.filter(
          (record) =>
            'event' in record && record.event.type === 'approval_response',
        ),
      ).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});
