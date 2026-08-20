// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type {
  InputTokenUsage,
  OutputTokenUsage,
  TokenUsage,
  TokenUsageReport,
  UsageCost,
  UsageCostSource,
  UsageCoverage,
  UsageRecord,
} from '../types.js';

export interface UsageCounterReading {
  value: number;
  valid: boolean;
  /**
   * Whether upstream actually carried the counter. engine-28 needs this to tell
   * a measured zero from a component the runtime does not report; `value`
   * alone cannot, because an absent optional counter also reads as zero.
   */
  present: boolean;
}

const INPUT_DETAILS = ['uncached', 'cacheRead', 'cacheWrite'] as const;
const OUTPUT_DETAILS = ['visible', 'reasoning'] as const;

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
 * the subtraction would go negative — engine-19 requires omitting the side
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

function validateDetails<T extends object, K extends keyof T>(
  total: number,
  side: T,
  members: readonly K[],
): boolean {
  let present = 0;
  let sum = 0;
  for (const member of members) {
    const value = side[member] as number | undefined;
    if (value === undefined) continue;
    if (!isCounter(value)) return false;
    present += 1;
    sum += value;
    if (!Number.isSafeInteger(sum)) return false;
  }

  if (sum > total) return false;
  return present !== members.length || sum === total;
}

/**
 * Validate inclusive input/output totals and their exact optional subsets.
 * Detail omission means unreported; when a complete detail side is present it
 * must partition its inclusive total exactly.
 */
export function buildTokenUsage(
  input: InputTokenUsage,
  output: OutputTokenUsage,
): TokenUsage | undefined {
  if (!isCounter(input.total) || !isCounter(output.total)) return undefined;
  if (!validateDetails(input.total, input, INPUT_DETAILS)) return undefined;
  if (!validateDetails(output.total, output, OUTPUT_DETAILS)) return undefined;
  return { input: { ...input }, output: { ...output } };
}

export function buildUsageCost(
  amount: number | undefined,
  source: UsageCostSource,
): UsageCost | undefined {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return undefined;
  }
  return { amount, currency: 'USD', source };
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
      !Number.isSafeInteger(candidate) ||
      candidate < 0
    ) {
      return { value: 0, valid: false, present: true };
    }
    if (value !== undefined && candidate !== value) {
      return { value: 0, valid: false, present: true };
    }
    value ??= candidate;
  }

  return { value: value ?? 0, valid: true, present: true };
}

function sumInputDetail(
  records: readonly UsageRecord[],
  member: 'uncached' | 'cacheRead' | 'cacheWrite',
): number | undefined {
  let sum = 0;
  for (const record of records) {
    const value = record.tokens.input[member];
    if (value === undefined) return undefined;
    sum += value;
    if (!Number.isSafeInteger(sum)) return undefined;
  }
  return sum;
}

function sumOutputDetail(
  records: readonly UsageRecord[],
  member: 'visible' | 'reasoning',
): number | undefined {
  let sum = 0;
  for (const record of records) {
    const value = record.tokens.output[member];
    if (value === undefined) return undefined;
    sum += value;
    if (!Number.isSafeInteger(sum)) return undefined;
  }
  return sum;
}

/** Sum records without inventing a detail that any record omitted. */
export function sumTokenUsage(
  records: readonly UsageRecord[],
): TokenUsage | undefined {
  if (records.length === 0) return undefined;
  let inputTotal = 0;
  let outputTotal = 0;
  for (const record of records) {
    const tokens = buildTokenUsage(record.tokens.input, record.tokens.output);
    if (!tokens) return undefined;
    inputTotal += tokens.input.total;
    outputTotal += tokens.output.total;
    if (!Number.isSafeInteger(inputTotal) || !Number.isSafeInteger(outputTotal)) {
      return undefined;
    }
  }

  const uncached = sumInputDetail(records, 'uncached');
  const cacheRead = sumInputDetail(records, 'cacheRead');
  const cacheWrite = sumInputDetail(records, 'cacheWrite');
  const visible = sumOutputDetail(records, 'visible');
  const reasoning = sumOutputDetail(records, 'reasoning');

  return buildTokenUsage(
    {
      total: inputTotal,
      ...(uncached !== undefined ? { uncached } : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
    {
      total: outputTotal,
      ...(visible !== undefined ? { visible } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    },
  );
}

function usageMatches(left: TokenUsage, right: TokenUsage): boolean {
  return (
    left.input.total === right.input.total &&
    left.input.uncached === right.input.uncached &&
    left.input.cacheRead === right.input.cacheRead &&
    left.input.cacheWrite === right.input.cacheWrite &&
    left.output.total === right.output.total &&
    left.output.visible === right.output.visible &&
    left.output.reasoning === right.output.reasoning
  );
}

/** Build an authentic token report, dropping an invalid decomposition whole. */
export function buildTokenUsageReport(
  coverage: UsageCoverage,
  totals: TokenUsage,
  candidates: readonly UsageRecord[] = [],
): TokenUsageReport | undefined {
  const validatedTotals = buildTokenUsage(totals.input, totals.output);
  if (!validatedTotals) return undefined;

  let records: UsageRecord[] | undefined;
  if (candidates.length > 0) {
    const valid = candidates.every((record) => {
      if (!buildTokenUsage(record.tokens.input, record.tokens.output)) {
        return false;
      }
      if (
        record.requests !== undefined &&
        (!Number.isSafeInteger(record.requests) || record.requests <= 0)
      ) {
        return false;
      }
      if (record.cost && !buildUsageCost(record.cost.amount, record.cost.source)) {
        return false;
      }
      return (record.pricedUnits ?? []).every(
        (unit) =>
          unit.name.length > 0 &&
          Number.isSafeInteger(unit.quantity) &&
          unit.quantity >= 0,
      );
    });
    const summed = valid ? sumTokenUsage(candidates) : undefined;
    if (summed && usageMatches(summed, validatedTotals)) {
      records = [...candidates];
    }
  }

  return {
    coverage,
    totals: validatedTotals,
    ...(records ? { records } : {}),
  };
}
