// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defineConfig,
  findTmuxPlayConfig,
  loadTmuxPlayConfig,
  type TmuxPlayConfig,
} from './config.js';

function validConfig(overrides: Partial<TmuxPlayConfig> = {}): TmuxPlayConfig {
  return {
    captain: {
      from: '@sublang/cligent/captains/fanout',
      adapter: 'claude',
      model: 'claude-opus-4-7',
      instruction: 'Coordinate roles.',
      options: { summaryExcerptChars: 4000 },
    },
    roles: [
      {
        id: 'coder',
        adapter: 'codex',
        model: 'gpt-test',
        instruction: 'Implement changes.',
      },
      {
        id: 'reviewer',
        adapter: 'claude',
        instruction: 'Review changes.',
      },
    ],
    ...overrides,
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe('tmux-play config loading', () => {
  let workDir: string | undefined;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  it('returns defineConfig input unchanged', () => {
    const config = validConfig();

    expect(defineConfig(config)).toBe(config);
  });

  it('discovers configs in mjs, js, json order', () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    writeFileSync(join(workDir, 'tmux-play.config.json'), '{}');
    writeFileSync(join(workDir, 'tmux-play.config.js'), 'export default {};');
    writeFileSync(join(workDir, 'tmux-play.config.mjs'), 'export default {};');

    expect(basename(findTmuxPlayConfig(workDir)!)).toBe(
      'tmux-play.config.mjs',
    );
  });

  it('loads and normalizes an explicit json config', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const path = join(workDir, 'custom.json');
    writeJson(path, validConfig());

    const loaded = await loadTmuxPlayConfig({
      cwd: workDir,
      configPath: 'custom.json',
    });

    expect(loaded.path).toBe(path);
    expect(loaded.config.captain).toEqual({
      from: '@sublang/cligent/captains/fanout',
      adapter: 'claude',
      model: 'claude-opus-4-7',
      instruction: 'Coordinate roles.',
      options: { summaryExcerptChars: 4000 },
    });
    expect(loaded.config.roles).toEqual([
      {
        id: 'coder',
        adapter: 'codex',
        model: 'gpt-test',
        instruction: 'Implement changes.',
      },
      {
        id: 'reviewer',
        adapter: 'claude',
        instruction: 'Review changes.',
      },
    ]);
  });

  it('loads default mjs configs through dynamic import', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    writeFileSync(
      join(workDir, 'tmux-play.config.mjs'),
      `
export default {
  captain: {
    from: '@sublang/cligent/captains/fanout',
    adapter: 'gemini',
    options: { rounds: 1 },
  },
  roles: [{ id: 'coder', adapter: 'codex' }],
};
`,
    );

    const loaded = await loadTmuxPlayConfig({ cwd: workDir });

    expect(loaded.config).toEqual({
      captain: {
        from: '@sublang/cligent/captains/fanout',
        adapter: 'gemini',
        options: { rounds: 1 },
      },
      roles: [{ id: 'coder', adapter: 'codex' }],
    });
  });

  it('loads js configs when the config directory is ESM', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    writeJson(join(workDir, 'package.json'), { type: 'module' });
    writeFileSync(
      join(workDir, 'tmux-play.config.js'),
      `
export default {
  captain: {
    from: '@sublang/cligent/captains/fanout',
    adapter: 'opencode',
    options: {},
  },
  roles: [{ id: 'coder', adapter: 'claude' }],
};
`,
    );

    const loaded = await loadTmuxPlayConfig({ cwd: workDir });

    expect(loaded.config.captain.adapter).toBe('opencode');
    expect(loaded.config.roles[0]?.adapter).toBe('claude');
  });

  it('lets an explicit config path override default discovery', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    writeJson(
      join(workDir, 'tmux-play.config.json'),
      validConfig({
        captain: {
          from: '@sublang/cligent/captains/fanout',
          adapter: 'claude',
          options: {},
        },
      }),
    );
    writeJson(
      join(workDir, 'custom.json'),
      validConfig({
        captain: {
          from: '@sublang/cligent/captains/fanout',
          adapter: 'codex',
          options: {},
        },
      }),
    );

    const loaded = await loadTmuxPlayConfig({
      cwd: workDir,
      configPath: 'custom.json',
    });

    expect(loaded.config.captain.adapter).toBe('codex');
  });

  it('rejects unsupported config extensions', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    writeFileSync(join(workDir, 'tmux-play.config.yaml'), 'captain: {}');

    await expect(
      loadTmuxPlayConfig({
        cwd: workDir,
        configPath: 'tmux-play.config.yaml',
      }),
    ).rejects.toThrow('Unsupported tmux-play config extension ".yaml"');
  });

  it('rejects missing required fields', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    writeJson(join(workDir, 'missing-captain.json'), {
      roles: [{ id: 'coder', adapter: 'codex' }],
    });
    writeJson(join(workDir, 'missing-from.json'), {
      captain: { adapter: 'claude', options: {} },
      roles: [{ id: 'coder', adapter: 'codex' }],
    });

    await expect(
      loadTmuxPlayConfig({
        cwd: workDir,
        configPath: 'missing-captain.json',
      }),
    ).rejects.toThrow('captain must be an object');
    await expect(
      loadTmuxPlayConfig({
        cwd: workDir,
        configPath: 'missing-from.json',
      }),
    ).rejects.toThrow('captain.from must be a non-empty string');
  });

  it('rejects unknown adapters for Captain and roles', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    writeJson(join(workDir, 'bad-captain.json'), {
      captain: {
        from: '@sublang/cligent/captains/fanout',
        adapter: 'unknown',
        options: {},
      },
      roles: [{ id: 'coder', adapter: 'codex' }],
    });
    writeJson(join(workDir, 'bad-role.json'), {
      captain: {
        from: '@sublang/cligent/captains/fanout',
        adapter: 'claude',
        options: {},
      },
      roles: [{ id: 'coder', adapter: 'unknown' }],
    });

    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: 'bad-captain.json' }),
    ).rejects.toThrow('Unknown adapter "unknown" at captain.adapter');
    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: 'bad-role.json' }),
    ).rejects.toThrow('Unknown adapter "unknown" at roles[0].adapter');
  });

  it('rejects invalid role ids', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    writeJson(join(workDir, 'bad-role-id.json'), {
      captain: {
        from: '@sublang/cligent/captains/fanout',
        adapter: 'claude',
        options: {},
      },
      roles: [{ id: 'captain', adapter: 'codex' }],
    });

    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: 'bad-role-id.json' }),
    ).rejects.toThrow('reserved for the Captain');
  });

  it('rejects non-serializable values from js configs', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    writeFileSync(
      join(workDir, 'tmux-play.config.mjs'),
      `
export default {
  captain: {
    from: '@sublang/cligent/captains/fanout',
    adapter: 'claude',
    options: { createActor() {} },
  },
  roles: [{ id: 'coder', adapter: 'codex' }],
};
`,
    );

    await expect(loadTmuxPlayConfig({ cwd: workDir })).rejects.toThrow(
      'config.captain.options.createActor contains non-serializable function',
    );
  });
});
