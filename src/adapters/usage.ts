// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export interface UsageCounterReading {
  value: number;
  valid: boolean;
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
    return { value: 0, valid: !required };
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
      return { value: 0, valid: false };
    }
    value ??= candidate;
  }

  return { value: value ?? 0, valid: true };
}
