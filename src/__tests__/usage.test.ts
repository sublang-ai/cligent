// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect } from 'vitest';

import { buildTokenBreakdown, exclusiveBase } from '../adapters/usage.js';

describe('exclusiveBase', () => {
  it('subtracts included components from a cache-inclusive total', () => {
    expect(exclusiveBase(100, 40, 60)).toBe(0);
    expect(exclusiveBase(100, 40)).toBe(60);
    expect(exclusiveBase(100)).toBe(100);
  });

  it('ignores absent components without treating them as zero counters', () => {
    expect(exclusiveBase(100, undefined, 25)).toBe(75);
  });

  it('omits rather than clamps when the subtraction goes negative', () => {
    // Clamping would make the components sum above their aggregate, which is
    // the double count the partition identity exists to prevent.
    expect(exclusiveBase(10, 7, 8)).toBeUndefined();
  });

  it('rejects malformed counters on either side of the subtraction', () => {
    expect(exclusiveBase(1.5, 1)).toBeUndefined();
    expect(exclusiveBase(10, 2.5)).toBeUndefined();
    expect(exclusiveBase(10, -1)).toBeUndefined();
    expect(exclusiveBase(Number.NaN, 0)).toBeUndefined();
    expect(exclusiveBase(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('buildTokenBreakdown', () => {
  const aggregates = { inputTokens: 100, outputTokens: 50 };

  it('publishes both sides when each partitions its aggregate exactly', () => {
    expect(
      buildTokenBreakdown(aggregates, {
        input: 30,
        cacheRead: 60,
        cacheWrite: 10,
        output: 45,
        reasoning: 5,
      }),
    ).toEqual({
      input: 30,
      cacheRead: 60,
      cacheWrite: 10,
      output: 45,
      reasoning: 5,
    });
  });

  it('keeps a measured zero component distinct from an absent one', () => {
    const built = buildTokenBreakdown(aggregates, {
      input: 100,
      cacheRead: 0,
      output: 50,
    });
    expect(built).toEqual({ input: 100, cacheRead: 0, output: 50 });
    expect(built).toHaveProperty('cacheRead', 0);
    expect(built).not.toHaveProperty('cacheWrite');
    expect(built).not.toHaveProperty('reasoning');
  });

  it('drops only the side that fails its partition identity', () => {
    expect(
      buildTokenBreakdown(aggregates, {
        input: 30,
        cacheRead: 60,
        // 30 + 60 = 90, not 100 — the input side is inexact and is dropped.
        output: 45,
        reasoning: 5,
      }),
    ).toEqual({ output: 45, reasoning: 5 });
  });

  it('drops a side carrying a malformed component', () => {
    expect(
      buildTokenBreakdown(aggregates, {
        input: 40.5,
        cacheRead: 59.5,
        output: 50,
      }),
    ).toEqual({ output: 50 });
  });

  it('omits the breakdown entirely when no side survives', () => {
    expect(buildTokenBreakdown(aggregates, {})).toBeUndefined();
    expect(
      buildTokenBreakdown(aggregates, { input: 1, output: 2 }),
    ).toBeUndefined();
  });

  it('accepts a single-member side that already equals its aggregate', () => {
    expect(
      buildTokenBreakdown({ inputTokens: 7, outputTokens: 0 }, { input: 7 }),
    ).toEqual({ input: 7 });
  });

  it('treats a zero aggregate with zero components as an exact partition', () => {
    expect(
      buildTokenBreakdown(
        { inputTokens: 0, outputTokens: 0 },
        { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      ),
    ).toEqual({
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
    });
  });
});
