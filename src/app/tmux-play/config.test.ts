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
      model: 'claude-opus-4-8-1m',
      instruction: 'Coordinate players.',
      options: {},
    },
    players: [
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
    // TMUX-064: multi-player default — equal thirds [1, 1, 1] on the
    // canonical 174x49 grid (174 / 3 = 58 per column).
    layout: {
      window: { columns: 174, rows: 49 },
      columnWeights: [1, 1, 1],
    },
    ...overrides,
  };
}

function writeYamlConfig(path: string, config = validConfig()): void {
  writeFileSync(
    path,
    [
      'layout:',
      '  window:',
      `    columns: ${config.layout.window.columns}`,
      `    rows: ${config.layout.window.rows}`,
      '  columnWeights:',
      ...config.layout.columnWeights.map((weight) => `    - ${weight}`),
      'captain:',
      `  from: '${config.captain.from}'`,
      `  adapter: ${config.captain.adapter}`,
      config.captain.model ? `  model: ${config.captain.model}` : undefined,
      config.captain.instruction
        ? `  instruction: ${config.captain.instruction}`
        : undefined,
      config.captain.reasoningEffort
        ? `  reasoningEffort: ${config.captain.reasoningEffort}`
        : undefined,
      ...(Object.keys(config.captain.options as Record<string, unknown>).length
        ? [
            '  options:',
            ...Object.entries(config.captain.options as Record<string, unknown>).map(
              ([key, value]) => `    ${key}: ${JSON.stringify(value)}`,
            ),
          ]
        : ['  options: {}']),
      'players:',
      ...config.players.flatMap((player) => [
        `  - id: ${player.id}`,
        `    adapter: ${player.adapter}`,
        player.model ? `    model: ${player.model}` : undefined,
        player.instruction ? `    instruction: ${player.instruction}` : undefined,
        player.reasoningEffort
          ? `    reasoningEffort: ${player.reasoningEffort}`
          : undefined,
      ]),
      '',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
  );
}

describe('tmux-play config loading', () => {
  let workDir: string | undefined;
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    restoreEnv('HOME', originalHome);
    restoreEnv('XDG_CONFIG_HOME', originalXdgConfigHome);
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

  it('treats an empty XDG_CONFIG_HOME as unset', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cwd = join(workDir, 'project');
    mkdirSync(cwd);
    process.env.HOME = workDir;
    process.env.XDG_CONFIG_HOME = '';

    const loaded = await loadTmuxPlayConfig({ cwd });
    const fallbackConfig = join(workDir, '.config', TMUX_PLAY_HOME_CONFIG);

    expect(loaded.path).toBe(fallbackConfig);
    expect(readFileSync(fallbackConfig, 'utf8')).toContain(
      '@sublang/cligent/captains/fanout',
    );
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
    expect(loaded.config.players.map((player) => player.id)).toEqual([
      'claude',
      'codex',
    ]);
    expect(loaded.config.captain.model).toBe('claude-opus-4-8-1m');
    expect(loaded.config.captain.reasoningEffort).toBe('xhigh');
    expect(loaded.config.players.map((player) => player.model)).toEqual([
      'claude-opus-4-8-1m',
      'gpt-5.5',
    ]);
    expect(loaded.config.players.map((player) => player.reasoningEffort)).toEqual([
      'xhigh',
      'xhigh',
    ]);
    expect(loaded.config.players.map((player) => player.instruction)).toEqual([
      'You are the claude player in a fanout Captain session. Provide an independent answer.',
      'You are the codex player in a fanout Captain session. Provide an independent answer.',
    ]);
    expect(loaded.config.captain.permissions).toEqual({ mode: 'auto' });
    expect(loaded.config.players.map((player) => player.permissions)).toEqual([
      { mode: 'auto' },
      { mode: 'auto' },
    ]);
    // TMUX-011 (amended) + TMUX-064: the shipped default home YAML carries
    // an explicit `layout` block with the canonical 174x49 grid and the
    // equal-thirds [1, 1, 1] multi-player column weights, so first-run users
    // see the knobs.
    expect(loaded.config.layout).toEqual({
      window: { columns: 174, rows: 49 },
      columnWeights: [1, 1, 1],
    });
    expect(readFileSync(homeConfig, 'utf8')).toContain('layout:');
    expect(readFileSync(homeConfig, 'utf8')).toContain('columnWeights:');
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

  it('reports legacy cwd configs when no yaml cwd config exists', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cwd = join(workDir, 'project');
    const configHome = join(workDir, 'xdg');
    const ignored: string[] = [];
    mkdirSync(cwd);
    const legacyConfig = join(cwd, 'tmux-play.config.json');
    writeFileSync(legacyConfig, '{}');

    await loadTmuxPlayConfig({
      cwd,
      configHome,
      onLegacyConfigIgnored: (path) => ignored.push(path),
    });

    expect(ignored).toEqual([legacyConfig]);
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
    writeFileSync(missingCaptain, 'players:\n  - id: coder\n    adapter: codex\n');
    writeFileSync(
      missingFrom,
      'captain:\n  adapter: claude\n  options: {}\nplayers:\n  - id: coder\n    adapter: codex\n',
    );

    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: missingCaptain }),
    ).rejects.toThrow('captain must be an object');
    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: missingFrom }),
    ).rejects.toThrow('captain.from must be a non-empty string');
  });

  it('rejects unknown adapters for Captain and players', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const badCaptain = join(workDir, 'bad-captain.yaml');
    const badPlayer = join(workDir, 'bad-player.yaml');
    writeFileSync(
      badCaptain,
      "captain:\n  from: '@sublang/cligent/captains/fanout'\n  adapter: unknown\n  options: {}\nplayers:\n  - id: coder\n    adapter: codex\n",
    );
    writeFileSync(
      badPlayer,
      "captain:\n  from: '@sublang/cligent/captains/fanout'\n  adapter: claude\n  options: {}\nplayers:\n  - id: coder\n    adapter: unknown\n",
    );

    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: badCaptain }),
    ).rejects.toThrow('Unknown adapter "unknown" at captain.adapter');
    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: badPlayer }),
    ).rejects.toThrow('Unknown adapter "unknown" at players[0].adapter');
  });

  it('rejects invalid player ids', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, 'bad-player-id.yaml');
    writeFileSync(
      configPath,
      "captain:\n  from: '@sublang/cligent/captains/fanout'\n  adapter: claude\n  options: {}\nplayers:\n  - id: captain\n    adapter: codex\n",
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
      "captain:\n  from: '@sublang/cligent/captains/fanout'\n  adapter: claude\n  options:\n    bad: .nan\nplayers:\n  - id: coder\n    adapter: codex\n",
    );

    await expect(loadTmuxPlayConfig({ cwd: workDir })).rejects.toThrow(
      'config.captain.options.bad must be a finite number',
    );
  });

  it('accepts a typed permissions block on captain and players', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        "captain:",
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        '  permissions:',
        '    mode: auto',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '    permissions:',
        '      mode: bypass',
        '      fileWrite: allow',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ cwd: workDir });

    expect(loaded.config.captain.permissions).toEqual({ mode: 'auto' });
    expect(loaded.config.players[0]?.permissions).toEqual({
      mode: 'bypass',
      fileWrite: 'allow',
    });
  });

  it('rejects unknown sub-fields under permissions', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        "captain:",
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        '  permissions:',
        '    bogus: allow',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ cwd: workDir })).rejects.toThrow(
      'Unknown config field captain.permissions.bogus',
    );
  });

  it('rejects invalid permission mode values', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        "captain:",
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '    permissions:',
        '      mode: turbo',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ cwd: workDir })).rejects.toThrow(
      'players[0].permissions.mode must be one of: auto, bypass',
    );
  });

  it('rejects invalid permission level values', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        "captain:",
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        '  permissions:',
        '    fileWrite: maybe',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ cwd: workDir })).rejects.toThrow(
      'captain.permissions.fileWrite must be one of: allow, ask, deny',
    );
  });

  it('rejects non-object permissions', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        "captain:",
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        '  permissions: auto',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ cwd: workDir })).rejects.toThrow(
      'captain.permissions must be an object',
    );
  });

  it('accepts reasoningEffort closed-set values on captain and players', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    const values = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
    writeFileSync(
      configPath,
      [
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  reasoningEffort: minimal',
        '  options: {}',
        'players:',
        ...values.flatMap((value, index) => [
          `  - id: player-${index}`,
          '    adapter: codex',
          `    reasoningEffort: ${value}`,
        ]),
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ cwd: workDir });

    expect(loaded.config.captain.reasoningEffort).toBe('minimal');
    expect(loaded.config.players.map((player) => player.reasoningEffort)).toEqual(
      values,
    );
  });

  it('rejects invalid reasoningEffort values with the offending path', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const badCaptain = join(workDir, 'bad-captain-effort.yaml');
    const badPlayer = join(workDir, 'bad-player-effort.yaml');
    writeFileSync(
      badCaptain,
      [
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  reasoningEffort: turbo',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );
    writeFileSync(
      badPlayer,
      [
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '    reasoningEffort: turbo',
        '',
      ].join('\n'),
    );

    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: badCaptain }),
    ).rejects.toThrow(
      'captain.reasoningEffort must be one of: minimal, low, medium, high, xhigh, max',
    );
    await expect(
      loadTmuxPlayConfig({ cwd: workDir, configPath: badPlayer }),
    ).rejects.toThrow(
      'players[0].reasoningEffort must be one of: minimal, low, medium, high, xhigh, max',
    );
  });

  it('accepts theme: mocha | latte | auto and rejects other values', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    for (const value of ['mocha', 'latte', 'auto'] as const) {
      const configPath = join(workDir, `${value}-${TMUX_PLAY_CONFIG_FILE}`);
      writeFileSync(
        configPath,
        [
          `theme: ${value}`,
          'captain:',
          "  from: '@sublang/cligent/captains/fanout'",
          '  adapter: claude',
          '  options: {}',
          'players:',
          '  - id: coder',
          '    adapter: codex',
          '',
        ].join('\n'),
      );
      const loaded = await loadTmuxPlayConfig({ configPath });
      expect(loaded.config.theme).toBe(value);
    }

    const bad = join(workDir, `bad-${TMUX_PLAY_CONFIG_FILE}`);
    writeFileSync(
      bad,
      [
        'theme: solarized',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );
    await expect(
      loadTmuxPlayConfig({ configPath: bad }),
    ).rejects.toThrow('theme must be one of: mocha, latte, auto');
  });

  it('defaults the layout block when YAML omits it (multi-player)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ configPath });

    expect(loaded.config.layout).toEqual({
      window: { columns: 174, rows: 49 },
      columnWeights: [1, 1, 1],
    });
  });

  it('defaults the layout block when YAML omits it (single-player)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: solo',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ configPath });

    expect(loaded.config.layout).toEqual({
      window: { columns: 174, rows: 49 },
      columnWeights: [1, 1],
    });
  });

  it('preserves a fully concrete layout verbatim', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'layout:',
        '  window:',
        '    columns: 200',
        '    rows: 50',
        '  columnWeights:',
        '    - 3',
        '    - 5',
        '    - 5',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ configPath });

    expect(loaded.config.layout).toEqual({
      window: { columns: 200, rows: 50 },
      columnWeights: [3, 5, 5],
    });
  });

  it('defaults each layout.window sub-field independently when partial', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'layout:',
        '  window:',
        '    columns: 200',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ configPath });

    // Supplied sub-field preserved; missing sub-field defaulted independently.
    // Wholesale fallback (which would yield {columns:174,rows:49}) is forbidden.
    expect(loaded.config.layout.window).toEqual({ columns: 200, rows: 49 });
    // columnWeights still default since the multi-default applies to 2 players.
    expect(loaded.config.layout.columnWeights).toEqual([1, 1, 1]);
  });

  it('rejects non-positive layout.window.columns with the offending path', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'layout:',
        '  window:',
        '    columns: 0',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ configPath })).rejects.toThrow(
      'layout.window.columns must be a positive integer',
    );
  });

  it('rejects non-integer layout.window.rows with the offending path', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'layout:',
        '  window:',
        '    rows: 67.5',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ configPath })).rejects.toThrow(
      'layout.window.rows must be a positive integer',
    );
  });

  it('rejects non-array layout.columnWeights', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'layout:',
        '  columnWeights: 4',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ configPath })).rejects.toThrow(
      'layout.columnWeights must be an array of positive integers',
    );
  });

  it('rejects a non-positive weight with the offending index', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'layout:',
        '  columnWeights:',
        '    - 4',
        '    - 6',
        '    - 0',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ configPath })).rejects.toThrow(
      'layout.columnWeights[2] must be a positive integer',
    );
  });

  it('rejects length-mismatched layout.columnWeights against the visible column count', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const twoPlayersTwoWeights = join(workDir, 'two-players-two-weights.yaml');
    const onePlayerThreeWeights = join(workDir, 'one-player-three-weights.yaml');
    writeFileSync(
      twoPlayersTwoWeights,
      [
        'layout:',
        '  columnWeights:',
        '    - 4',
        '    - 6',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );
    writeFileSync(
      onePlayerThreeWeights,
      [
        'layout:',
        '  columnWeights:',
        '    - 4',
        '    - 6',
        '    - 6',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: solo',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(
      loadTmuxPlayConfig({ configPath: twoPlayersTwoWeights }),
    ).rejects.toThrow('layout.columnWeights length must be 3');
    await expect(
      loadTmuxPlayConfig({ configPath: onePlayerThreeWeights }),
    ).rejects.toThrow('layout.columnWeights length must be 2');
  });

  it('rejects unknown sub-fields under layout and layout.window', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const bogusUnderLayout = join(workDir, 'bogus-layout.yaml');
    const bogusUnderWindow = join(workDir, 'bogus-window.yaml');
    writeFileSync(
      bogusUnderLayout,
      [
        'layout:',
        '  bogus: 1',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );
    writeFileSync(
      bogusUnderWindow,
      [
        'layout:',
        '  window:',
        '    columns: 200',
        '    bogus: 1',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ configPath: bogusUnderLayout })).rejects.toThrow(
      'Unknown config field layout.bogus',
    );
    await expect(loadTmuxPlayConfig({ configPath: bogusUnderWindow })).rejects.toThrow(
      'Unknown config field layout.window.bogus',
    );
  });

  it('rejects unknown top-level config fields (e.g. typo of layout)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'layoutt:',
        '  window:',
        '    columns: 200',
        '    rows: 50',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ configPath })).rejects.toThrow(
      'Unknown config field config.layoutt',
    );
  });

  it('rejects a non-object layout (e.g. layout: 1)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'layout: 1',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ configPath })).rejects.toThrow(
      'layout must be an object',
    );
  });

  it('rejects a non-object layout.window (e.g. layout.window: 1)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'layout:',
        '  window: 1',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ configPath })).rejects.toThrow(
      'layout.window must be an object',
    );
  });

  it('rejects non-finite or non-number weight values with the offending index', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const nanWeight = join(workDir, 'nan-weight.yaml');
    const stringWeight = join(workDir, 'string-weight.yaml');
    // YAML special value `.nan` lands as JS NaN through `yaml.parse`; both
    // sub-conditions of the weight check (`!Number.isFinite` and
    // `typeof !== 'number'`) must reject.
    writeFileSync(
      nanWeight,
      [
        'layout:',
        '  columnWeights:',
        '    - 4',
        '    - .nan',
        '    - 6',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );
    writeFileSync(
      stringWeight,
      [
        'layout:',
        '  columnWeights:',
        '    - 4',
        '    - "six"',
        '    - 6',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ configPath: nanWeight })).rejects.toThrow(
      'layout.columnWeights[1] must be a positive integer',
    );
    await expect(loadTmuxPlayConfig({ configPath: stringWeight })).rejects.toThrow(
      'layout.columnWeights[1] must be a positive integer',
    );
  });

  it('rejects decimal layout.columnWeights with the offending index', async () => {
    // TMUX-064: weights are restricted to positive integers because the
    // TMUX-044 resize hook interpolates each weight into POSIX shell
    // arithmetic (`$((W * w_i / sum - 1))`), which is integer-only. A
    // decimal like `0.5` would emit a malformed `$((…))` expression and
    // silently break the post-creation resize invariant; loader-time
    // rejection prevents that path from ever being taken.
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'layout:',
        '  columnWeights:',
        '    - 4',
        '    - 0.5',
        '    - 6',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ configPath })).rejects.toThrow(
      'layout.columnWeights[1] must be a positive integer',
    );
  });

  it('snapshot preserves the resolved layout values', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    const sessionWorkDir = join(workDir, 'session');
    writeFileSync(
      configPath,
      [
        'layout:',
        '  window:',
        '    columns: 200',
        '    rows: 50',
        '  columnWeights:',
        '    - 1',
        '    - 2',
        '    - 3',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ configPath });
    const snapshotPath = await writeTmuxPlayConfigSnapshot(
      loaded,
      sessionWorkDir,
    );
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as TmuxPlayConfig;

    expect(snapshot.layout).toEqual({
      window: { columns: 200, rows: 50 },
      columnWeights: [1, 2, 3],
    });
  });

  it('snapshot stores the resolved Catppuccin flavor when supplied', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'theme: auto',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );
    const loaded = await loadTmuxPlayConfig({ configPath });
    expect(loaded.config.theme).toBe('auto');
    const snapshot = createTmuxPlayConfigSnapshot(loaded, 'latte');
    expect(snapshot.theme).toBe('latte');
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
        options: { tone: 'direct' },
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
