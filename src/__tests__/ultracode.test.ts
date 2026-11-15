// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  CodexAdapter,
  mapAgentOptionsToCodexOptions,
} from '../adapters/codex.js';
import {
  GeminiAdapter,
  mapAgentOptionsToGeminiCommand,
} from '../adapters/gemini.js';
import { KimiAdapter, mapAgentOptionsToKimiOptions } from '../adapters/kimi.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
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
    expect(() => assertUltracodeOption(agent, true)).toThrow(
      'is not supported',
    );
    expect(() => assertUltracodeOption(agent, false)).not.toThrow();
    expect(() => assertUltracodeOption(agent, 'true')).toThrow(
      'must be a boolean',
    );
  }
});

it.each([
  new CodexAdapter(),
  new GeminiAdapter(),
  new KimiAdapter(),
  new OpenCodeAdapter(),
])(
  'refuses Ultracode activation at the $agent adapter boundary',
  async (adapter) => {
    const run = adapter.run('check', { ultracode: true });
    await expect(run.next()).rejects.toThrow(
      `ultracode is not supported for adapter "${adapter.agent}"`,
    );
  },
);

it('leaves Codex, Gemini and Kimi native options unchanged for explicit false', () => {
  const off = { ultracode: false };
  expect(mapAgentOptionsToCodexOptions(off)).toEqual({
    ...mapAgentOptionsToCodexOptions(undefined),
    cleanupAbort: expect.any(Function),
  });
  expect(mapAgentOptionsToGeminiCommand('work', off)).toEqual(
    mapAgentOptionsToGeminiCommand('work', undefined),
  );
  expect(mapAgentOptionsToKimiOptions(off)).toEqual(
    mapAgentOptionsToKimiOptions(undefined),
  );
});
