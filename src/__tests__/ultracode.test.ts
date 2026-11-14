// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { expect, it } from 'vitest';
import { isUltracodeSupported } from '../index.js';
import { assertUltracodeOption } from '../ultracode.js';

it('advertises native transport and rejects unsupported activation', () => {
  for (const agent of ['claude', 'claude-code']) {
    expect(isUltracodeSupported(agent)).toBe(true);
    expect(() => assertUltracodeOption(agent, true)).not.toThrow();
  }
  for (const agent of ['codex', 'gemini', 'kimi', 'opencode', 'custom']) {
    expect(isUltracodeSupported(agent)).toBe(false);
    expect(() => assertUltracodeOption(agent, true)).toThrow('is not supported');
    expect(() => assertUltracodeOption(agent, false)).not.toThrow();
    expect(() => assertUltracodeOption(agent, 'true')).toThrow('must be a boolean');
  }
});
