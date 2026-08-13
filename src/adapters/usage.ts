// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { TokenBreakdown, UsageRecord } from '../types.js';

export interface UsageCounterReading {
  value: number;
  valid: boolean;
  /**
   * Whether upstream actually carried the counter. ENG-028 needs this to tell
   * a measured zero from a component the runtime does not report; `value`
   * alone cannot, because an absent optional counter also reads as zero.
   */
  present: boolean;
}

/** Aggregates a breakdown must partition exactly (ENG-019). */
export interface TokenAggregates {
  inputTokens: number;
  outputTokens: number;
}

const INPUT_SIDE = ['input', 'cacheRead', 'cacheWrite'] as const;
const OUTPUT_SIDE = ['output', 'reasoning'] as const;

function isCounter(value: number | undefined): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

/**
 * Subtract known components from a provider total that includes them,
 * yielding the exclusive base for the disjoint frame. Returns undefined when
 * the subtraction would go negative — ENG-019 requires omitting the side
 * rather than clamping, since a clamped base would exceed its aggregate.
 */
export function exclusiveBase(
  inclusiveTotal: number,
  ...included: (number | undefined)[]
): number | undefined {
  if (!isCounter(inclusiveTotal)) return undefined;

  let base = inclusiveTotal;
  for (const part of included) {
    if (part === undefined) continue;
    if (!isCounter(part)) return undefined;
    base -= part;
  }

  return base >= 0 ? base : undefined;
}

function retainSide(
  members: readonly (keyof TokenBreakdown)[],
  candidate: TokenBreakdown,
  aggregate: number,
): TokenBreakdown | undefined {
  const present = members.filter((member) => candidate[member] !== undefined);
  if (present.length === 0) return undefined;

  let sum = 0;
  const side: TokenBreakdown = {};
  for (const member of present) {
    const value = candidate[member];
    if (!isCounter(value)) return undefined;
    sum += value;
    side[member] = value;
  }

  // ENG-019: a published side partitions its aggregate exactly. A side that
  // cannot is dropped, never reconciled by adjusting a component.
  return sum === aggregate ? side : undefined;
}

/**
 * Build the optional `DoneUsage.breakdown` from components already expressed
 * in the disjoint frame, enforcing ENG-028 side atomicity and the ENG-019
 * partition identities. Each side survives only if every present member is a
 * finite non-negative integer and the side sums to its aggregate; a breakdown
 * with no surviving side is omitted rather than emitted empty.
 */
export function buildTokenBreakdown(
  aggregates: TokenAggregates,
  components: TokenBreakdown,
): TokenBreakdown | undefined {
  const input = retainSide(INPUT_SIDE, components, aggregates.inputTokens);
  const output = retainSide(OUTPUT_SIDE, components, aggregates.outputTokens);
  if (!input && !output) return undefined;

  return { ...input, ...output };
}

export function isUsageRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readUsageCounter(
  source: Record<string, unknown>,
  aliases: readonly string[],
  required: boolean,
): UsageCounterReading {
  const presentAliases = aliases.filter((alias) =>
    Object.prototype.hasOwnProperty.call(source, alias),
  );
  if (presentAliases.length === 0) {
    return { value: 0, valid: !required, present: false };
  }

  let value: number | undefined;
  for (const alias of presentAliases) {
    const candidate = source[alias];
    if (
      typeof candidate !== 'number' ||
      !Number.isFinite(candidate) ||
      !Number.isInteger(candidate) ||
      candidate < 0
    ) {
      return { value: 0, valid: false, present: true };
    }
    value ??= candidate;
  }

  return { value: value ?? 0, valid: true, present: true };
}

/**
 * Build the optional `DoneUsage.records` billable decomposition per ENG-030.
 * A record survives only if its own components satisfy the ENG-019 partition
 * identities against its own totals, and the surviving set survives only if it
 * sums to the run's published `breakdown` — otherwise the decomposition would
 * describe work the aggregates do not, and is dropped whole rather than
 * published partial.
 */
export function buildUsageRecords(
  breakdown: TokenBreakdown | undefined,
  candidates: readonly UsageRecord[],
): UsageRecord[] | undefined {
  if (!breakdown || candidates.length === 0) return undefined;

  const members: (keyof TokenBreakdown)[] = [
    'input',
    'cacheRead',
    'cacheWrite',
    'output',
    'reasoning',
  ];

  const totals: Partial<Record<keyof TokenBreakdown, number>> = {};
  for (const record of candidates) {
    for (const member of members) {
      const value = record.tokens[member];
      if (value === undefined) continue;
      if (!isCounter(value)) return undefined;
      totals[member] = (totals[member] ?? 0) + value;
    }
    if (record.requests !== undefined && !isCounter(record.requests)) {
      return undefined;
    }
  }

  // Every component the run published must be accounted for by the records,
  // and the records must not claim a component the run did not publish.
  for (const member of members) {
    if ((breakdown[member] ?? undefined) !== (totals[member] ?? undefined)) {
      return undefined;
    }
  }

  return [...candidates];
}
