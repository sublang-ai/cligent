// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import { Cligent } from '../cligent.js';
import { createEvent } from '../events.js';
import type {
  AgentAdapter,
  AgentEvent,
  DonePayload,
  DoneUsage,
  TokenUsage,
} from '../types.js';

function assertTokenInvariants(usage: DoneUsage): void {
  const report = usage.tokens;
  if (!report) return;

  const counters: number[] = [
    report.totals.input.total,
    report.totals.output.total,
    ...Object.values(report.totals.input).filter(
      (value): value is number => typeof value === 'number',
    ),
    ...Object.values(report.totals.output).filter(
      (value): value is number => typeof value === 'number',
    ),
  ];
  for (const value of counters) {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }

  const input = report.totals.input;
  if (
    input.uncached !== undefined &&
    input.cacheRead !== undefined &&
    input.cacheWrite !== undefined
  ) {
    expect(input.uncached + input.cacheRead + input.cacheWrite).toBe(input.total);
  }
  const output = report.totals.output;
  if (output.visible !== undefined && output.reasoning !== undefined) {
    expect(output.visible + output.reasoning).toBe(output.total);
  }

  if (!report.records) return;
  const summed = report.records.reduce<TokenUsage>(
    (total, record) => {
      expect(record.model).not.toBe('unknown');
      if (record.requests !== undefined) {
        expect(Number.isSafeInteger(record.requests)).toBe(true);
        expect(record.requests).toBeGreaterThan(0);
      }
      total.input.total += record.tokens.input.total;
      total.output.total += record.tokens.output.total;
      return total;
    },
    { input: { total: 0 }, output: { total: 0 } },
  );
  expect(summed.input.total).toBe(report.totals.input.total);
  expect(summed.output.total).toBe(report.totals.output.total);
}

function stubAdapter(usage: DoneUsage): AgentAdapter {
  return {
    agent: 'stub',
    async isAvailable() {
      return true;
    },
    async *run(): AsyncGenerator<AgentEvent, void, void> {
      yield createEvent(
        'done',
        'stub',
        { status: 'success', usage, durationMs: 1 },
        'stub-session',
      );
    },
  };
}

async function terminalUsage(adapter: AgentAdapter): Promise<DoneUsage> {
  const agent = new Cligent(adapter);
  let usage: DoneUsage | undefined;
  for await (const event of agent.run('prompt')) {
    if (event.type === 'done') usage = (event.payload as DonePayload).usage;
  }
  expect(usage).toBeDefined();
  return usage!;
}

describe('authentic usage invariants through Cligent (engine-69 through engine-72)', () => {
  it('preserves complete inclusive totals, details, and records', async () => {
    const usage = await terminalUsage(
      stubAdapter({
        toolUses: 2,
        tokens: {
          coverage: 'complete',
          totals: {
            input: { total: 100, uncached: 30, cacheRead: 60, cacheWrite: 10 },
            output: { total: 50, visible: 45, reasoning: 5 },
          },
          records: [
            {
              model: 'model-a',
              requests: 1,
              tokens: {
                input: { total: 100, uncached: 30, cacheRead: 60, cacheWrite: 10 },
                output: { total: 50, visible: 45, reasoning: 5 },
              },
            },
          ],
        },
      }),
    );
    assertTokenInvariants(usage);
    expect(usage.tokens?.coverage).toBe('complete');
  });

  it('keeps measured zero distinct from an absent detail', async () => {
    const usage = await terminalUsage(
      stubAdapter({
        toolUses: 0,
        tokens: {
          coverage: 'partial',
          totals: {
            input: { total: 5, cacheRead: 0 },
            output: { total: 0 },
          },
        },
      }),
    );
    assertTokenInvariants(usage);
    expect(usage.tokens?.totals.input).toHaveProperty('cacheRead', 0);
    expect(usage.tokens?.totals.input).not.toHaveProperty('cacheWrite');
  });

  it('synthesizes no token or cost placeholder and preserves tools', async () => {
    const adapter: AgentAdapter = {
      agent: 'stub',
      async isAvailable() {
        return true;
      },
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield createEvent(
          'tool_use',
          'stub',
          { toolName: 'read', toolUseId: 'call-1', input: {} },
          'stub-session',
        );
      },
    };

    const usage = await terminalUsage(adapter);
    expect(usage).toEqual({ toolUses: 1 });
  });

  it('allows independently reported cost without tokens', async () => {
    const usage = await terminalUsage(
      stubAdapter({
        toolUses: 0,
        cost: { amount: 0, currency: 'USD', source: 'agent-estimate' },
      }),
    );
    expect(usage.tokens).toBeUndefined();
    expect(usage.cost).toEqual({
      amount: 0,
      currency: 'USD',
      source: 'agent-estimate',
    });
  });
});
