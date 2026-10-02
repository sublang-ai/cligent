// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { Cligent } from '../cligent.js';
import type { AgentEvent, ApprovalRequest } from '../types.js';

function fixture(input: Record<string, unknown>) {
  let nativeDecision: unknown;
  let effects = 0;
  const adapter = new ClaudeCodeAdapter({
    loadSdk: async () => ({
      async *query({ options }) {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'approval-input-session',
          tools: ['Bash'],
        };
        nativeDecision = await options!.canUseTool!('Bash', input, {
          signal: options!.abortController!.signal,
          toolUseID: 'approval-input-tool',
          title: undefined,
          blockedPath: '/fixture/scope',
        });
        if (
          typeof nativeDecision === 'object' &&
          nativeDecision !== null &&
          'behavior' in nativeDecision &&
          nativeDecision.behavior === 'allow'
        )
          effects++;
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'approval-input-session',
          result: 'complete',
        };
      },
    }),
  });
  return {
    agent: new Cligent(adapter),
    decision: () => nativeDecision,
    effects: () => effects,
  };
}

async function collect(source: AsyncIterable<AgentEvent>) {
  const result: AgentEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

describe('lossless native approval input admission (approvals-2, approvals-7)', () => {
  const malformed: [string, () => Record<string, unknown>][] = [
    ['non-finite number', () => ({ nested: { amount: Number.NaN } })],
    ['infinite number', () => ({ amount: Number.POSITIVE_INFINITY })],
    ['undefined member', () => ({ command: undefined })],
    ['function member', () => ({ command: () => 'hidden' })],
    ['symbol value', () => ({ command: Symbol('hidden') })],
    ['bigint', () => ({ amount: 1n })],
    ['sparse array', () => ({ paths: new Array(2) })],
    [
      'array with hidden member',
      () => ({ paths: Object.assign(['a'], { hidden: 'b' }) }),
    ],
    ['custom object', () => ({ timestamp: new Date(0) })],
    ['symbol key', () => ({ command: 'a', [Symbol('hidden')]: 'b' })],
    [
      'non-enumerable member',
      () => Object.defineProperty({ command: 'a' }, 'hidden', { value: 'b' }),
    ],
    [
      'cycle',
      () => {
        const input: Record<string, unknown> = {};
        input.self = input;
        return input;
      },
    ],
  ];

  it.each(malformed)(
    'declines %s before host admission or native execution',
    async (_name, makeInput) => {
      const native = fixture(makeInput());
      const handler = vi.fn(async () => 'allow_once' as const);
      const events = await collect(
        native.agent.run('operate', { approvalHandler: handler }),
      );
      expect(handler).not.toHaveBeenCalled();
      expect(native.decision()).toMatchObject({ behavior: 'deny' });
      expect(native.effects()).toBe(0);
      expect(
        events.filter((event) => event.type.startsWith('approval_')),
      ).toEqual([]);
      expect(events.at(-1)?.type).toBe('done');
    },
  );

  it.each(['accessor', 'serializer', 'array serializer'] as const)(
    'does not invoke an input %s to prepare a request',
    async (kind) => {
      const evaluate = vi.fn(() => 'different action');
      const input =
        kind === 'accessor'
          ? Object.defineProperty({}, 'command', {
              get: evaluate,
              enumerable: true,
            })
          : kind === 'serializer'
            ? { command: 'original', toJSON: evaluate }
            : {
                paths: Object.setPrototypeOf(['original'], {
                  toJSON: evaluate,
                }),
              };
      const native = fixture(input);
      const handler = vi.fn(async () => 'allow_once' as const);
      await collect(native.agent.run('operate', { approvalHandler: handler }));
      expect(evaluate).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(native.decision()).toMatchObject({ behavior: 'deny' });
      expect(native.effects()).toBe(0);
    },
  );

  it('admits detached nested JSON exactly and normalizes absent SDK detail fields', async () => {
    const input: Record<string, unknown> = JSON.parse(
      '{"command":"fixture","nested":{"__proto__":{"safe":true},"values":[null,false,0,"x"]}}',
    );
    const native = fixture(input);
    let request: ApprovalRequest | undefined;
    const events = await collect(
      native.agent.run('operate', {
        approvalHandler: async (value) => {
          request = value;
          expect(value.input).toEqual(input);
          expect(value.input).not.toBe(input);
          expect(value.input.nested).not.toBe(input.nested);
          expect(Object.isFrozen(value.input.nested)).toBe(true);
          expect(value.details).toEqual({ blockedPath: '/fixture/scope' });
          expect(native.effects()).toBe(0);
          return 'allow_once';
        },
      }),
    );
    expect(request).toBeDefined();
    expect(native.effects()).toBe(1);
    expect(
      events.filter((event) => event.type === 'approval_response'),
    ).toMatchObject([
      {
        payload: {
          requestId: request!.id,
          decision: 'allow_once',
          source: 'host',
        },
      },
    ]);
  });
});
