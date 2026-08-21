// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import {
  buildTokenUsage,
  buildTokenUsageReport,
  buildUsageCost,
  exclusiveBase,
  readUsageCounter,
  sumTokenUsage,
} from '../adapters/usage.js';

describe('exclusiveBase', () => {
  it('subtracts inclusive subsets without clamping', () => {
    expect(exclusiveBase(100, 40, 60)).toBe(0);
    expect(exclusiveBase(100, 40)).toBe(60);
    expect(exclusiveBase(10, 7, 8)).toBeUndefined();
  });

  it('rejects malformed counters', () => {
    expect(exclusiveBase(1.5, 1)).toBeUndefined();
    expect(exclusiveBase(10, -1)).toBeUndefined();
    expect(exclusiveBase(Number.NaN, 0)).toBeUndefined();
  });
});

describe('readUsageCounter', () => {
  it('distinguishes absent, zero, malformed, and conflicting aliases', () => {
    expect(readUsageCounter({}, ['value'], false)).toEqual({
      value: 0,
      valid: true,
      present: false,
    });
    expect(readUsageCounter({ value: 0 }, ['value'], true)).toEqual({
      value: 0,
      valid: true,
      present: true,
    });
    expect(readUsageCounter({ value: -1 }, ['value'], true).valid).toBe(false);
    expect(
      readUsageCounter({ value: Number.MAX_SAFE_INTEGER + 1 }, ['value'], true)
        .valid,
    ).toBe(false);
    expect(
      readUsageCounter({ value: 1, value_alias: 2 }, ['value', 'value_alias'], true)
        .valid,
    ).toBe(false);
  });
});

describe('authentic usage builders (engine-55 through engine-63)', () => {
  const complete = buildTokenUsage(
    { total: 100, uncached: 30, cacheRead: 60, cacheWrite: 10 },
    { total: 50, visible: 45, reasoning: 5 },
  )!;

  it('keeps inclusive totals and exact measured subsets', () => {
    expect(complete).toEqual({
      input: { total: 100, uncached: 30, cacheRead: 60, cacheWrite: 10 },
      output: { total: 50, visible: 45, reasoning: 5 },
    });
    expect(
      buildTokenUsage(
        { total: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 },
        { total: 0, visible: 0, reasoning: 0 },
      ),
    ).toBeDefined();
  });

  it('allows absent details but rejects invalid complete partitions', () => {
    expect(
      buildTokenUsage({ total: 100, cacheRead: 60 }, { total: 50 }),
    ).toEqual({
      input: { total: 100, cacheRead: 60 },
      output: { total: 50 },
    });
    expect(
      buildTokenUsage(
        { total: 100, uncached: 30, cacheRead: 60, cacheWrite: 20 },
        { total: 50 },
      ),
    ).toBeUndefined();
    expect(
      buildTokenUsage(
        { total: 100 },
        { total: 50, visible: 46, reasoning: 5 },
      ),
    ).toBeUndefined();
  });

  it('sums records and publishes only a reconciling decomposition', () => {
    const records = [
      {
        model: 'model-a',
        requests: 1,
        tokens: {
          input: { total: 84, uncached: 20, cacheRead: 60, cacheWrite: 4 },
          output: { total: 45, visible: 40, reasoning: 5 },
        },
      },
      {
        model: 'model-b',
        requests: 1,
        tokens: {
          input: { total: 16, uncached: 10, cacheRead: 0, cacheWrite: 6 },
          output: { total: 5, visible: 5, reasoning: 0 },
        },
      },
    ];
    expect(sumTokenUsage(records)).toEqual(complete);
    expect(buildTokenUsageReport('complete', complete, records)).toEqual({
      coverage: 'complete',
      totals: complete,
      records,
    });

    const mismatched = [
      {
        ...records[0],
        tokens: {
          input: { total: 99 },
          output: { total: 50 },
        },
      },
    ];
    expect(buildTokenUsageReport('partial', complete, mismatched)).toEqual({
      coverage: 'partial',
      totals: complete,
    });
  });

  it('validates request counts, costs, and priced units', () => {
    expect(buildUsageCost(0, 'agent-estimate')).toEqual({
      amount: 0,
      currency: 'USD',
      source: 'agent-estimate',
    });
    expect(buildUsageCost(-1, 'agent-estimate')).toBeUndefined();

    const invalidRecord = {
      requests: 0,
      tokens: complete,
      pricedUnits: [{ name: 'web_search_request', quantity: 1 }],
    };
    expect(buildTokenUsageReport('complete', complete, [invalidRecord])).toEqual({
      coverage: 'complete',
      totals: complete,
    });
  });
});
