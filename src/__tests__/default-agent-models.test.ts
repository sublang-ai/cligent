// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultAgentModels } from '../index.js';

const claude = { model: 'claude-fable-5-2', subagentModel: 'claude-opus-5-5' };
const codex = { model: 'gpt-6-astra', subagentModel: 'gpt-6.1-sol' };

it('offers the runtime-owned model pairs only on direct provider routes', () => {
  for (const path of ['', '/', '/v1', '/v1/']) {
    expect(
      defaultAgentModels('claude-code', {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com' + path,
      }),
    ).toEqual(claude);
    expect(
      defaultAgentModels('codex', {
        OPENAI_BASE_URL: 'https://api.openai.com' + path,
      }),
    ).toEqual(codex);
  }
  expect(defaultAgentModels('claude', {})).toEqual(claude);
  expect(defaultAgentModels('codex', {})).toEqual(codex);
  expect(defaultAgentModels('gemini', {})).toEqual({});
  for (const endpoint of [
    'https://gateway.example',
    'bad-url',
    'http://api.anthropic.com',
    'https://api.anthropic.com/proxy',
    'https://api.anthropic.com:444',
    'https://user@api.anthropic.com',
    'https://api.anthropic.com/v1?',
    'https://api.anthropic.com/v1/#',
  ]) {
    expect(
      defaultAgentModels('claude', { ANTHROPIC_BASE_URL: endpoint }),
    ).toEqual({});
  }
  expect(
    defaultAgentModels('codex', { OPENAI_BASE_URL: 'https://gateway.example' }),
  ).toEqual({});
});

it('leaves provider-specific model IDs to the configured cloud service', () => {
  for (const key of [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_MANTLE',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  ]) {
    expect(defaultAgentModels('claude', { [key]: ' On ' })).toEqual({});
    expect(defaultAgentModels('claude', { [key]: '0' })).toEqual(claude);
  }
});

it("applies user settings over inherited provider variables only for a supplied user's home", () => {
  const home = mkdtempSync(join(tmpdir(), 'cligent-models-'));
  try {
    const config = join(home, '.claude');
    mkdirSync(config);
    writeFileSync(
      join(config, 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }),
    );
    expect(defaultAgentModels('claude', {}, home)).toEqual({});
    // A seat can contain inherited HOME and CLAUDE_CONFIG_DIR in its process.
    expect(
      defaultAgentModels('claude', { HOME: home, CLAUDE_CONFIG_DIR: config }),
    ).toEqual(claude);
    const other = join(home, 'other');
    mkdirSync(other);
    writeFileSync(
      join(other, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
          CLAUDE_CODE_USE_VERTEX: 'false',
        },
      }),
    );
    const env = {
      CLAUDE_CONFIG_DIR: other,
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
    };
    expect(defaultAgentModels('claude', env, home)).toEqual(claude);
    writeFileSync(
      join(other, 'settings.json'),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://gateway.example' },
      }),
    );
    expect(
      defaultAgentModels('claude', { CLAUDE_CONFIG_DIR: other }, home),
    ).toEqual({});
    expect(defaultAgentModels('codex', env, home)).toEqual(codex);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
