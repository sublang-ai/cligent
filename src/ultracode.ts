// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AgentType } from './types.js';

/** Native request transport support, not account or model availability. */
export function isUltracodeSupported<A extends AgentType | 'claude'>(
  agent: A,
): agent is A & ('claude' | 'claude-code') {
  return agent === 'claude' || agent === 'claude-code';
}

export function assertUltracodeOption(
  agent: AgentType | 'claude',
  value: unknown,
  path = 'ultracode',
): asserts value is boolean | undefined {
  if (value === undefined) return;
  if (typeof value !== 'boolean') {
    throw new TypeError(`${path} for adapter "${agent}" must be a boolean`);
  }
  if (value && !isUltracodeSupported(agent)) {
    throw new Error(`${path} is not supported for adapter "${agent}"`);
  }
}
