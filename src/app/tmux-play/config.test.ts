// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TMUX_PLAY_CONFIG_FILE,
  TMUX_PLAY_CONFIG_SNAPSHOT,
  TMUX_PLAY_HOME_CONFIG,
  createTmuxPlayConfigSnapshot,
  findTmuxPlayConfig,
  loadTmuxPlayConfig,
  writeTmuxPlayConfigSnapshot,
  type TmuxPlayConfig,
} from './config.js';

function validConfig(
  overrides: Partial<TmuxPlayConfig> = {},
): TmuxPlayConfig {
  return {
    captain: {
      from: '@sublang/cligent/captains/fanout',
      adapter: 'claude',
      model: 'claude-opus-4-7',
      instruction: 'Coordinate roles.',
      options: { maxRoleOutputChars: 4000 },
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

function writeYamlConfig(path: string, config = validConfig()): void {
  writeFileSync(
    path,
    [
      'captain:',
      `  from: '${config.captain.from}'`,
      `  adapter: ${config.captain.adapter}`,
      config.captain.model ? `  model: ${config.captain.model}` : undefined,
      config.captain.instruction
        ? `  instruction: ${config.captain.instruction}`
        : undefined,
      '  options:',
      ...Object.entries(config.captain.options as Record<string, unknown>).map(
        ([key, value]) => `    ${key}: ${JSON.stringify(value)}`,
      ),
      'roles:',
      ...config.roles.flatMap((role) => [
        `  - id: ${role.id}`,
        `    adapter: ${role.adapter}`,
        role.model ? `    model: ${role.model}` : undefined,
        role.instruction ? `    instruction: ${role.instruction}` : undefined,
      ]),
      '',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
  );
}

describe('tmux-play config loading', () => {
  let workDir: string | undefined;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  it('discovers cwd yaml configs before the home fallback', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configHome = join(workDir, 'xdg');
    const cwdConfig = join(workDir, TMUX_PLAY_CONFIG_FILE);
    const homeConfig = join(configHome, TMUX_PLAY_HOME_CONFIG);
    mkdirSync(join(configHome, 'tmux-play'), { recursive: true });
    writeYamlConfig(homeConfig, validConfig({
      captain: {
        from: '@sublang/cligent/captains/fanout',
        adapter: 'codex',
        options: {},
      },
    }));
    writeYamlConfig(cwdConfig);

    expect(findTmuxPlayConfig(workDir, configHome)).toBe(cwdConfig);

    const loaded = await loadTmuxPlayConfig({ cwd: workDir, configHome });

    expect(loaded.path).toBe(cwdConfig);
    expect(loaded.config.captain.adapter).toBe('claude');
  });

  it('uses the home fallback when no cwd config exists', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cwd = join(workDir, 'project');
    const configHome = join(workDir, 'xdg');
    const homeConfig = join(configHome, TMUX_PLAY_HOME_CONFIG);
    mkdirSync(cwd);
    mkdirSync(join(configHome, 'tmux-play'), { recursive: true });
    writeYamlConfig(homeConfig);

    const loaded = await loadTmuxPlayConfig({ cwd, configHome });

    expect(loaded.path).toBe(homeConfig);
    expect(loaded.config).toEqual(validConfig());
  });

  it('auto-creates a home default on first run', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cwd = join(workDir, 'project');
    const configHome = join(workDir, 'xdg');
    const notices: string[] = [];
    mkdirSync(cwd);

    const loaded = await loadTmuxPlayConfig({
      cwd,
      configHome,
      onDefaultConfigCreated: (path) => notices.push(path),
    });
    const homeConfig = join(configHome, TMUX_PLAY_HOME_CONFIG);

    expect(loaded.path).toBe(homeConfig);
    expect(notices).toEqual([homeConfig]);
    expect(readFileSync(homeConfig, 'utf8')).toContain(
      "@sublang/cligent/captains/fanout",
    );
    expect(loaded.config.roles.map((role) => role.id)).toEqual([
      'coder',
      'reviewer',
    ]);
  });

  it('preserves an existing home config across runs', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cwd = join(workDir, 'project');
    const configHome = join(workDir, 'xdg');
    const homeConfig = join(configHome, TMUX_PLAY_HOME_CONFIG);
    mkdirSync(cwd);
    mkdirSync(join(configHome, 'tmux-play'), { recursive: true });
    writeYamlConfig(homeConfig, validConfig({
      captain: {
        from: '@sublang/cligent/captains/fanout',
        adapter: 'opencode',
        options: {},
      },
    }));
    const before = readFileSync(homeConfig, 'utf8');

    const loaded = await loadTmuxPlayConfig({ cwd, configHome });

    expect(loaded.config.captain.adapter).toBe('opencode');
    expect(readFileSync(homeConfig, 'utf8')).toBe(before);
  });

  it('lets an explicit yaml config path override discovery', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cwdConfig = join(workDir, TMUX_PLAY_CONFIG_FILE);
    const customConfig = join(workDir, 'custom.yaml');
    writeYamlConfig(cwdConfig);
    writeYamlConfig(customConfig, validConfig({
      captain: {
        from: '@sublang/cligent/captains/fanout',
        adapter: 'gemini',
        options: {},
      },
    }));

    const loaded = await loadTmuxPlayConfig({
      cwd: workDir,
      configPath: 'custom.yaml',
    });

    expect(loaded.path).toBe(customConfig);
    expect(loaded.config.captain.adapter).toBe('gemini');
  });

  it('rejects unsupported config extensions', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    writeFileSync(join(workDir, 'tmux-play.config.json'), '{}');

    await expect(
      loadTmuxPlayConfig({
        cwd: workDir,
        configPath: 'tmux-play.config.json',
      }),
    ).rejects.toThrow('Unsupported tmux-play config extension ".json"');
  });

  it('rejects malformed yaml with file context', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(configPath, 'captain: [unterminated\n');

    await expect(
      loadTmuxPlayConfig({ cwd: workDir }),
    ).rejects.toThrow(`Failed to parse tmux-play config ${configPath}:`);
  });

  it('rejects missing required fields', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const missingCaptain = join(workDir, 'missing-captain.yaml');
    const missingFrom = join(workDir, 'missing-from.yaml');
    writeFileSync(missingCaptain, 'roles:\n  - id: coder\n    adapter: codex\n');
    writeFileSync(
      missingFrom,
      'captain:\n  adapter: claude\n  options: {}\nroles:\n  - id: coder\n    adapter: codex\n',
    );

    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: missingCaptain }),
    ).rejects.toThrow('captain must be an object');
    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: missingFrom }),
    ).rejects.toThrow('captain.from must be a non-empty string');
  });

  it('rejects unknown adapters for Captain and roles', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const badCaptain = join(workDir, 'bad-captain.yaml');
    const badRole = join(workDir, 'bad-role.yaml');
    writeFileSync(
      badCaptain,
      "captain:\n  from: '@sublang/cligent/captains/fanout'\n  adapter: unknown\n  options: {}\nroles:\n  - id: coder\n    adapter: codex\n",
    );
    writeFileSync(
      badRole,
      "captain:\n  from: '@sublang/cligent/captains/fanout'\n  adapter: claude\n  options: {}\nroles:\n  - id: coder\n    adapter: unknown\n",
    );

    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: badCaptain }),
    ).rejects.toThrow('Unknown adapter "unknown" at captain.adapter');
    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: badRole }),
    ).rejects.toThrow('Unknown adapter "unknown" at roles[0].adapter');
  });

  it('rejects invalid role ids', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, 'bad-role-id.yaml');
    writeFileSync(
      configPath,
      "captain:\n  from: '@sublang/cligent/captains/fanout'\n  adapter: claude\n  options: {}\nroles:\n  - id: captain\n    adapter: codex\n",
    );

    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath }),
    ).rejects.toThrow('reserved for the Captain');
  });

  it('rejects non-serializable yaml values', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      "captain:\n  from: '@sublang/cligent/captains/fanout'\n  adapter: claude\n  options:\n    bad: .nan\nroles:\n  - id: coder\n    adapter: codex\n",
    );

    await expect(loadTmuxPlayConfig({ cwd: workDir })).rejects.toThrow(
      'config.captain.options.bad must be a finite number',
    );
  });

  it('rewrites relative local captain modules against the config directory', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configDir = join(workDir, 'configs');
    const configPath = join(configDir, TMUX_PLAY_CONFIG_FILE);
    mkdirSync(configDir);
    writeYamlConfig(configPath, validConfig({
      captain: {
        from: './captains/fanout.js',
        adapter: 'claude',
        options: {},
      },
    }));

    const loaded = await loadTmuxPlayConfig({ configPath });
    const snapshot = createTmuxPlayConfigSnapshot(loaded);

    expect(snapshot.captain.from).toBe(
      pathToFileURL(join(configDir, 'captains/fanout.js')).href,
    );
    expect(loaded.config.captain.from).toBe('./captains/fanout.js');
  });

  it('passes package captain specifiers through unchanged', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeYamlConfig(configPath, validConfig({
      captain: {
        from: 'my-captain-pkg/subpath',
        adapter: 'claude',
        options: {},
      },
    }));

    const loaded = await loadTmuxPlayConfig({ configPath });
    const snapshot = createTmuxPlayConfigSnapshot(loaded);

    expect(snapshot.captain.from).toBe('my-captain-pkg/subpath');
  });

  it('converts absolute local captain paths to file URLs', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const captainPath = join(workDir, 'captains/fanout.js');
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeYamlConfig(configPath, validConfig({
      captain: {
        from: captainPath,
        adapter: 'claude',
        options: {},
      },
    }));

    const loaded = await loadTmuxPlayConfig({ configPath });
    const snapshot = createTmuxPlayConfigSnapshot(loaded);

    expect(snapshot.captain.from).toBe(pathToFileURL(captainPath).href);
  });

  it('writes the rewritten config snapshot to the work directory', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    const sessionWorkDir = join(workDir, 'session');
    writeYamlConfig(configPath, validConfig({
      captain: {
        from: './captains/fanout.js',
        adapter: 'claude',
        options: { maxRoleOutputChars: 5000 },
      },
    }));

    const loaded = await loadTmuxPlayConfig({ configPath });
    const snapshotPath = await writeTmuxPlayConfigSnapshot(
      loaded,
      sessionWorkDir,
    );

    expect(snapshotPath).toBe(join(sessionWorkDir, TMUX_PLAY_CONFIG_SNAPSHOT));
    expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toEqual({
      ...loaded.config,
      captain: {
        ...loaded.config.captain,
        from: pathToFileURL(join(workDir, 'captains/fanout.js')).href,
      },
    });
  });
});
