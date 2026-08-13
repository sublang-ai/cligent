// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect } from 'vitest';

import { Cligent } from '../cligent.js';
import type {
  AgentAdapter,
  AgentEvent,
  DonePayload,
  TokenBreakdown,
} from '../types.js';
import { createEvent } from '../events.js';

/**
 * TENG-020: the partition identities are a property of every terminal a
 * caller can observe, so they are asserted through `Cligent.run()` rather
 * than against an adapter's internals.
 */
function assertBreakdownInvariants(usage: DonePayload['usage']): void {
  const breakdown = usage.breakdown;
  if (!breakdown) return;

  expect(usage.tokenAvailability).toBe('reported');
  for (const value of Object.values(breakdown)) {
    if (value === undefined) continue;
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }

  const inputSide: (keyof TokenBreakdown)[] = [
    'input',
    'cacheRead',
    'cacheWrite',
  ];
  const outputSide: (keyof TokenBreakdown)[] = ['output', 'reasoning'];

  const sumSide = (members: (keyof TokenBreakdown)[]): number | undefined => {
    const present = members.filter((m) => breakdown[m] !== undefined);
    if (present.length === 0) return undefined;
    return present.reduce((total, m) => total + (breakdown[m] ?? 0), 0);
  };

  const inputSum = sumSide(inputSide);
  if (inputSum !== undefined) expect(inputSum).toBe(usage.inputTokens);
  const outputSum = sumSide(outputSide);
  if (outputSum !== undefined) expect(outputSum).toBe(usage.outputTokens);
}

/**
 * TENG-021: the decomposition identities, likewise asserted on what a caller
 * observes. The per-adapter record shapes are covered by TADAPT-039 in each
 * adapter suite; here the concern is the contract every terminal must satisfy.
 */
function assertRecordInvariants(usage: DonePayload['usage']): void {
  const records = usage.records;
  if (!records) return;

  expect(usage.tokenAvailability).toBe('reported');
  const members: (keyof TokenBreakdown)[] = [
    'input',
    'cacheRead',
    'cacheWrite',
    'output',
    'reasoning',
  ];
  const totals: Partial<Record<keyof TokenBreakdown, number>> = {};
  for (const record of records) {
    expect(record.model).not.toBe('unknown');
    if (record.requests !== undefined) {
      expect(Number.isSafeInteger(record.requests)).toBe(true);
      expect(record.requests).toBeGreaterThanOrEqual(0);
    }
    for (const member of members) {
      const value = record.tokens[member];
      if (value === undefined) continue;
      totals[member] = (totals[member] ?? 0) + value;
    }
  }

  for (const member of members) {
    expect(totals[member]).toBe(usage.breakdown?.[member]);
  }
}

/** Minimal adapter that emits one terminal `done` with the given usage. */
function stubAdapter(usage: DonePayload['usage']): AgentAdapter {
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

async function terminalUsage(
  adapter: AgentAdapter,
): Promise<DonePayload['usage']> {
  const agent = new Cligent(adapter);
  let usage: DonePayload['usage'] | undefined;
  for await (const event of agent.run('prompt')) {
    if (event.type === 'done') usage = (event.payload as DonePayload).usage;
  }
  expect(usage).toBeDefined();
  return usage!;
}

describe('token breakdown invariants through Cligent (TENG-020)', () => {
  it('holds for a full five-component partition', async () => {
    const usage = await terminalUsage(
      stubAdapter({
        tokenAvailability: 'reported',
        inputTokens: 100,
        outputTokens: 50,
        toolUses: 0,
        breakdown: {
          input: 30,
          cacheRead: 60,
          cacheWrite: 10,
          output: 45,
          reasoning: 5,
        },
      }),
    );
    assertBreakdownInvariants(usage);
  });

  it('holds when only one side is published', async () => {
    const usage = await terminalUsage(
      stubAdapter({
        tokenAvailability: 'reported',
        inputTokens: 12,
        outputTokens: 7,
        toolUses: 0,
        breakdown: { input: 12 },
      }),
    );
    assertBreakdownInvariants(usage);
    expect(usage.breakdown).not.toHaveProperty('output');
  });

  it('keeps a measured zero distinct from an omitted component', async () => {
    const usage = await terminalUsage(
      stubAdapter({
        tokenAvailability: 'reported',
        inputTokens: 5,
        outputTokens: 0,
        toolUses: 0,
        breakdown: { input: 5, cacheRead: 0 },
      }),
    );
    assertBreakdownInvariants(usage);
    expect(usage.breakdown).toHaveProperty('cacheRead', 0);
    expect(usage.breakdown).not.toHaveProperty('cacheWrite');
  });

  it('carries no breakdown on an engine-synthesized terminal', async () => {
    // An adapter that ends without a terminal event forces synthesis.
    const adapter: AgentAdapter = {
      agent: 'stub',
      async isAvailable() {
        return true;
      },
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield createEvent('text', 'stub', { content: 'hi' }, 'stub-session');
      },
    };

    const usage = await terminalUsage(adapter);
    expect(usage.tokenAvailability).toBe('unavailable');
    expect(usage).not.toHaveProperty('breakdown');
    assertBreakdownInvariants(usage);
  });

  it('carries no breakdown on an aborted terminal', async () => {
    const controller = new AbortController();
    const adapter: AgentAdapter = {
      agent: 'stub',
      async isAvailable() {
        return true;
      },
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield createEvent('text', 'stub', { content: 'late' }, 'stub-session');
      },
    };

    const agent = new Cligent(adapter);
    let usage: DonePayload['usage'] | undefined;
    for await (const event of agent.run('prompt', {
      abortSignal: controller.signal,
    })) {
      if (event.type === 'done') usage = (event.payload as DonePayload).usage;
    }
    expect(usage?.tokenAvailability).toBe('unavailable');
    expect(usage).not.toHaveProperty('breakdown');
  });
});

describe('billable record invariants through Cligent (TENG-021)', () => {
  it('decomposes a published breakdown exactly', async () => {
    const usage = await terminalUsage(
      stubAdapter({
        tokenAvailability: 'reported',
        inputTokens: 100,
        outputTokens: 50,
        toolUses: 0,
        breakdown: {
          input: 30,
          cacheRead: 60,
          cacheWrite: 10,
          output: 45,
          reasoning: 5,
        },
        records: [
          {
            model: 'model-a',
            requests: 1,
            tokens: {
              input: 20,
              cacheRead: 60,
              cacheWrite: 4,
              output: 40,
              reasoning: 5,
            },
          },
          {
            model: 'model-b',
            requests: 1,
            tokens: {
              input: 10,
              cacheRead: 0,
              cacheWrite: 6,
              output: 5,
              reasoning: 0,
            },
          },
        ],
      }),
    );
    assertBreakdownInvariants(usage);
    assertRecordInvariants(usage);
  });

  it('omits the model rather than naming an unknown one', async () => {
    const usage = await terminalUsage(
      stubAdapter({
        tokenAvailability: 'reported',
        inputTokens: 12,
        outputTokens: 0,
        toolUses: 0,
        breakdown: { input: 12 },
        records: [{ requests: 1, tokens: { input: 12 } }],
      }),
    );
    assertRecordInvariants(usage);
    expect(usage.records![0]).not.toHaveProperty('model');
  });

  it('carries no records on an engine-synthesized terminal', async () => {
    const adapter: AgentAdapter = {
      agent: 'stub',
      async isAvailable() {
        return true;
      },
      async *run(): AsyncGenerator<AgentEvent, void, void> {
        yield createEvent('text', 'stub', { content: 'hi' }, 'stub-session');
      },
    };

    const usage = await terminalUsage(adapter);
    expect(usage.tokenAvailability).toBe('unavailable');
    expect(usage).not.toHaveProperty('records');
    assertRecordInvariants(usage);
  });
});
