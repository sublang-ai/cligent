// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverAgentModelsWithDeps } from '../model-discovery.js';

// The installed Agent SDK fixes Claude's configuration home the first time a
// process resolves settings, so point it at fixtures before any discovery.
const root = mkdtempSync(join(tmpdir(), 'cligent-claude-settings-'));
const configHome = join(root, 'config');
const project = join(root, 'project');
mkdirSync(configHome);
mkdirSync(join(project, '.claude'), { recursive: true });
const original = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
};
process.env.CLAUDE_CONFIG_DIR = configHome;
delete process.env.ANTHROPIC_MODEL;

afterAll(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function settings(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value));
}
const userSettings = join(configHome, 'settings.json');
const projectSettings = join(project, '.claude', 'settings.json');

// Initialization responses are fixtures; settings resolution is the SDK's own.
const deps = {
  checkRuntime: () => {},
  claudeQuery: () => ({
    supportedModels: async () => [
      {
        value: 'default',
        resolvedModel: 'claude-fable-5-1',
        displayName: 'Default (recommended)',
        description: 'Fable 5.1',
      },
    ],
    close() {},
  }),
};

describe('engine-19: Claude default through the installed settings resolver', () => {
  it('resolves project settings for a cwd and user settings without one', async () => {
    settings(userSettings, { model: 'opus[1m]' });
    settings(projectSettings, { model: 'sonnet' });
    const previous = process.cwd();
    // Discovery without a cwd must ignore the host process's project.
    process.chdir(project);
    try {
      expect(await discoverAgentModelsWithDeps('claude', {}, deps)).toEqual({
        status: 'available',
        unreportedEffortValues: ['ultracode'],
        defaultModel: 'opus[1m]',
        models: [
          {
            id: 'default',
            name: 'Default (recommended)',
            description: 'Fable 5.1',
            resolvedModel: 'claude-fable-5-1',
          },
        ],
      });
    } finally {
      process.chdir(previous);
    }
    expect(
      await discoverAgentModelsWithDeps('claude', { cwd: project }, deps),
    ).toMatchObject({ status: 'available', defaultModel: 'sonnet' });
  });

  it('places ANTHROPIC_MODEL in the discovery environment above settings', async () => {
    settings(userSettings, { model: 'opus[1m]' });
    settings(projectSettings, { model: 'sonnet' });
    expect(
      await discoverAgentModelsWithDeps(
        'claude',
        { cwd: project, env: { ANTHROPIC_MODEL: 'haiku' } },
        deps,
      ),
    ).toMatchObject({ status: 'available', defaultModel: 'haiku' });
  });

  it('reports the runtime default alias when no model is configured', async () => {
    settings(userSettings, {});
    settings(projectSettings, {});
    expect(
      await discoverAgentModelsWithDeps('claude', { cwd: project }, deps),
    ).toMatchObject({ status: 'available', defaultModel: 'default' });
  });

  it('omits the default when settings set ANTHROPIC_MODEL in their environment', async () => {
    settings(userSettings, { model: 'opus[1m]' });
    settings(projectSettings, { env: { ANTHROPIC_MODEL: 'sonnet' } });
    const result = await discoverAgentModelsWithDeps(
      'claude',
      { cwd: project },
      deps,
    );
    expect(result.status).toBe('available');
    expect(result).not.toHaveProperty('defaultModel');
  });
});
