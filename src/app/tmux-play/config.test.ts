// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EFFORT_SUPPORT } from '../../effort.js';
import {
  TMUX_PLAY_CONFIG_FILE,
  TMUX_PLAY_CONFIG_SNAPSHOT,
  TMUX_PLAY_HOME_CONFIG,
  createTmuxPlayConfigSnapshot,
  findTmuxPlayConfig,
  loadTmuxPlayConfig,
  writeTmuxPlayConfigSnapshot,
  type LegacyEffortDeprecation,
  type TmuxPlayConfig,
} from './config.js';

function validConfig(
  overrides: Partial<TmuxPlayConfig> = {},
): TmuxPlayConfig {
  return {
    captain: {
      from: '@sublang/cligent/captains/fanout',
      adapter: 'claude',
      model: 'claude-opus-4-8',
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
    notifications: {
      player_finished: 'off',
      turn_finished: 'off',
      turn_aborted: 'off',
    },
    // TMUX-064: resolved layout carries both canonical shape arrays plus the
    // active (multi-player roster) weights. writeYamlConfig emits only the
    // `columnWeights` alias, which resolves back to this same shape.
    layout: {
      window: { columns: 174, rows: 49 },
      initialVisible: ['coder', 'reviewer'],
      singlePlayerColumnWeights: [1, 1],
      multiPlayerColumnWeights: [1, 1, 1],
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
      'notifications:',
      `  player_finished: ${config.notifications.player_finished}`,
      `  turn_finished: ${config.notifications.turn_finished}`,
      `  turn_aborted: ${config.notifications.turn_aborted}`,
      'captain:',
      `  from: '${config.captain.from}'`,
      `  adapter: ${config.captain.adapter}`,
      config.captain.model ? `  model: ${config.captain.model}` : undefined,
      config.captain.instruction
        ? `  instruction: ${config.captain.instruction}`
        : undefined,
      config.captain.effort
        ? `  effort: ${config.captain.effort}`
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
        player.effort
          ? `    effort: ${player.effort}`
          : undefined,
      ]),
      '',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
  );
}

function expectNoEffortTemps(directory: string): void {
  expect(
    readdirSync(directory).filter((entry) =>
      entry.includes('.cligent-effort-'),
    ),
  ).toEqual([]);
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
    expect(loaded.config).toEqual({ ...validConfig(), theme: 'auto' });
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
    expect(loaded.config.captain.model).toBe('claude-opus-4-8');
    expect(loaded.config.captain.effort).toBe('xhigh');
    expect(loaded.config.players.map((player) => player.model)).toEqual([
      'claude-opus-4-8',
      'gpt-5.5',
    ]);
    expect(loaded.config.players.map((player) => player.effort)).toEqual([
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
    expect(loaded.config.notifications).toEqual({
      player_finished: 'bell',
      turn_finished: 'desktop',
      turn_aborted: 'off',
    });
    // TMUX-011 (amended) + TMUX-064: the shipped default home YAML carries
    // an explicit `layout` block with the canonical 174x49 grid and the
    // equal-thirds [1, 1, 1] multi-player column weights, so first-run users
    // see the knobs.
    expect(loaded.config.layout).toEqual({
      window: { columns: 174, rows: 49 },
      initialVisible: ['claude', 'codex'],
      singlePlayerColumnWeights: [1, 1],
      multiPlayerColumnWeights: [1, 1, 1],
      columnWeights: [1, 1, 1],
    });
    const homeSource = readFileSync(homeConfig, 'utf8');
    expect(homeSource).toContain('layout:');
    // TMUX-011/TTMUX-081: the authored default YAML uses the canonical
    // `multiPlayerColumnWeights` field and carries no `columnWeights` key.
    expect(homeSource).toContain('multiPlayerColumnWeights:');
    expect(homeSource).not.toMatch(/^\s*columnWeights:/m);
    expect(homeSource).toContain('notifications:');
    expect(homeSource).toContain('player_finished: bell');
    expect(homeSource).toContain('turn_finished: desktop');
    expect(homeSource).not.toContain('turn_aborted:');
  });

  it('preserves existing home config values while adding missing safe defaults', async () => {
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

    const loaded = await loadTmuxPlayConfig({ cwd, configHome });
    const after = readFileSync(homeConfig, 'utf8');

    expect(loaded.config.captain.adapter).toBe('opencode');
    expect(loaded.config.theme).toBe('auto');
    expect(after).toContain('adapter: opencode');
    expect(after).toContain('theme: auto');
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
        '    writablePaths:',
        '      - ./.git/',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '    permissions:',
        '      mode: bypass',
        '      fileWrite: allow',
        '      writablePaths:',
        '        - generated/./cache//',
        '        - dist\\assets',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ cwd: workDir });

    expect(loaded.config.captain.permissions).toEqual({
      mode: 'auto',
      writablePaths: ['.git'],
    });
    expect(loaded.config.players[0]?.permissions).toEqual({
      mode: 'bypass',
      fileWrite: 'allow',
      writablePaths: ['generated/cache', 'dist/assets'],
    });
  });

  it('rejects invalid writablePaths under permissions', async () => {
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
        '      writablePaths:',
        '        - ../cache',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ cwd: workDir })).rejects.toThrow(
      "players[0].permissions.writablePaths[0] must not contain '..'",
    );
  });

  it('rejects non-array writablePaths under permissions', async () => {
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
        '    writablePaths: .git',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ cwd: workDir })).rejects.toThrow(
      'captain.permissions.writablePaths must be an array',
    );
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

  it('accepts representative adapter-scoped effort values', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  effort: ultracode',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '    effort: ultra',
        '  - id: researcher',
        '    adapter: gemini',
        '    effort: high',
        '  - id: reviewer',
        '    adapter: opencode',
        '    effort: max',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ configPath });
    expect(loaded.config.captain.effort).toBe('ultracode');
    expect(loaded.config.players.map((player) => player.effort)).toEqual([
      'ultra',
      'high',
      'max',
    ]);
  });

  it('rejects unsupported effort values with path, adapter, and allowed values', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cases = [
      ['captain', 'claude', 'ultra', EFFORT_SUPPORT['claude-code'].values],
      ['player', 'codex', 'ultracode', EFFORT_SUPPORT.codex.values],
      ['captain', 'gemini', 'ultra', EFFORT_SUPPORT.gemini.values],
      ['player', 'opencode', 'ultracode', EFFORT_SUPPORT.opencode.values],
    ] as const;

    for (const [location, adapter, effort, allowed] of cases) {
      const configPath = join(workDir, `bad-${location}-${adapter}.yaml`);
      writeFileSync(
        configPath,
        [
          'captain:',
          "  from: '@sublang/cligent/captains/fanout'",
          `  adapter: ${adapter}`,
          ...(location === 'captain' ? [`  effort: ${effort}`] : []),
          '  options: {}',
          'players:',
          '  - id: worker',
          `    adapter: ${adapter}`,
          ...(location === 'player' ? [`    effort: ${effort}`] : []),
          '',
        ].join('\n'),
      );

      const path = location === 'captain' ? 'captain' : 'players[0]';
      await expect(loadTmuxPlayConfig({ configPath })).rejects.toThrow(
        `${path}.effort for adapter "${adapter}" must be one of: ${allowed.join(', ')}`,
      );
    }
  });

  it('updates only direct legacy effort key tokens after validation', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    const source = [
      '# reasoningEffort stays in comments',
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  "reasoningEffort": "ultracode"',
      '  options:',
      '    reasoningEffort: opaque-option',
      'players:',
      '  - id: coder',
      '    adapter: codex',
      "    reasoningEffort: 'ultra' # keep value style",
      '  - id: researcher',
      '    adapter: gemini',
      "    'reasoningEffort': high",
      '',
    ].join('\n');
    writeFileSync(configPath, source);
    const deprecations: LegacyEffortDeprecation[] = [];

    const loaded = await loadTmuxPlayConfig({
      cwd: workDir,
      configHome: join(workDir, 'unused-home'),
      onLegacyEffortDeprecated: (result) => deprecations.push(result),
    });
    const snapshot = createTmuxPlayConfigSnapshot(loaded);

    expect(loaded.path).toBe(configPath);
    expect(loaded.config.captain.effort).toBe('ultracode');
    expect(loaded.config.players.map((player) => player.effort)).toEqual([
      'ultra',
      'high',
    ]);
    expect(loaded.config.captain.options).toEqual({
      reasoningEffort: 'opaque-option',
    });
    expect(snapshot.captain).not.toHaveProperty('reasoningEffort');
    for (const player of snapshot.players) {
      expect(player).not.toHaveProperty('reasoningEffort');
    }
    expect(readFileSync(configPath, 'utf8')).toBe(
      source
        .replace('"reasoningEffort"', '"effort"')
        .replace("    reasoningEffort: 'ultra'", "    effort: 'ultra'")
        .replace("    'reasoningEffort': high", "    'effort': high"),
    );
    expect(deprecations).toEqual([
      {
        configPath,
        fieldPaths: [
          'captain.reasoningEffort',
          'players[0].reasoningEffort',
          'players[1].reasoningEffort',
        ],
        outcome: 'updated',
      },
    ]);
    expectNoEffortTemps(workDir);
  });

  it('uses legacy effort in memory when a newer source skips the update', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    const source = [
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  reasoningEffort: high',
      '  options: {}',
      'players:',
      '  - id: coder',
      '    adapter: codex',
      '',
    ].join('\n');
    const newer = source.replace('reasoningEffort: high', 'effort: low');
    writeFileSync(configPath, source);
    const deprecations: LegacyEffortDeprecation[] = [];
    const loadWithSeam = loadTmuxPlayConfig as unknown as (
      options: Parameters<typeof loadTmuxPlayConfig>[0],
      internals: { beforeLegacyEffortUpdate: () => void },
    ) => ReturnType<typeof loadTmuxPlayConfig>;

    const loaded = await loadWithSeam(
      {
        configPath,
        onLegacyEffortDeprecated: (result) => deprecations.push(result),
      },
      { beforeLegacyEffortUpdate: () => writeFileSync(configPath, newer) },
    );

    expect(loaded.config.captain.effort).toBe('high');
    expect(readFileSync(configPath, 'utf8')).toBe(newer);
    expect(deprecations).toEqual([
      {
        configPath,
        fieldPaths: ['captain.reasoningEffort'],
        outcome: 'skipped',
      },
    ]);
    expectNoEffortTemps(workDir);
  });

  it('combines home effort, safe-default, and layout migrations', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cwd = join(workDir, 'project');
    const configHome = join(workDir, 'xdg');
    const homeDirectory = join(configHome, 'tmux-play');
    const homeConfig = join(configHome, TMUX_PLAY_HOME_CONFIG);
    mkdirSync(cwd);
    mkdirSync(homeDirectory, { recursive: true });
    const source = [
      '# preserve the authored home heading',
      'layout:',
      '  # preserve the legacy layout note',
      '  columnWeights: [2, 3, 5] # preserve flow style',
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  reasoningEffort: ultracode # preserve effort note',
      'players:',
      '  - id: coder',
      '    adapter: codex',
      '    reasoningEffort: ultra',
      '',
    ].join('\n');
    writeFileSync(homeConfig, source);

    const loaded = await loadTmuxPlayConfig({ cwd, configHome });
    const migrated = readFileSync(homeConfig, 'utf8');

    expect(loaded.path).toBe(homeConfig);
    expect(loaded.config.captain.effort).toBe('ultracode');
    expect(loaded.config.players[0]?.effort).toBe('ultra');
    expect(loaded.config.captain.options).toEqual({});
    expect(loaded.config.theme).toBe('auto');
    expect(loaded.config.notifications).toEqual({
      player_finished: 'bell',
      turn_finished: 'desktop',
      turn_aborted: 'off',
    });
    expect(loaded.config.layout.window).toEqual({ columns: 174, rows: 49 });
    expect(loaded.config.layout.multiPlayerColumnWeights).toEqual([2, 3, 5]);
    expect(migrated).toContain('# preserve the authored home heading');
    expect(migrated).toContain('# preserve the legacy layout note');
    expect(migrated).toMatch(
      /multiPlayerColumnWeights: \[\s*2,\s*3,\s*5\s*\] # preserve flow style/,
    );
    expect(migrated).toContain('effort: ultracode # preserve effort note');
    expect(migrated).not.toContain('reasoningEffort:');
    expect(migrated).not.toMatch(/^\s*columnWeights:/m);
    expect(migrated).toContain('theme: auto');
    expect(migrated).toContain('options: {}');
    expect(migrated).toContain('notifications:');
    expectNoEffortTemps(homeDirectory);
  });

  it('rejects conflicts and validation failures without callback or write', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const captainPath = join(workDir, 'captain-conflict.yaml');
    const invalidPath = join(workDir, 'invalid-legacy-effort.yaml');
    const unrelatedPath = join(workDir, 'invalid-legacy-document.yaml');
    const captainSource = [
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  effort: high',
      '  reasoningEffort: high',
      '  options: {}',
      'players:',
      '  - id: coder',
      '    adapter: codex',
      '',
    ].join('\n');
    const invalidSource = [
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  reasoningEffort: ultra',
      '  options: {}',
      'players:',
      '  - id: coder',
      '    adapter: codex',
      '',
    ].join('\n');
    const unrelatedSource = [
      'unknownRoot: true',
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  reasoningEffort: ultracode',
      '  options: {}',
      'players:',
      '  - id: coder',
      '    adapter: codex',
      '',
    ].join('\n');
    writeFileSync(captainPath, captainSource);
    writeFileSync(invalidPath, invalidSource);
    writeFileSync(unrelatedPath, unrelatedSource);
    const deprecations: LegacyEffortDeprecation[] = [];
    const options = (configPath: string) => ({
      configPath,
      onLegacyEffortDeprecated: (result: LegacyEffortDeprecation) =>
        deprecations.push(result),
    });

    await expect(
      loadTmuxPlayConfig(options(captainPath)),
    ).rejects.toThrow(
      'captain.effort conflicts with deprecated captain.reasoningEffort',
    );
    await expect(
      loadTmuxPlayConfig(options(invalidPath)),
    ).rejects.toThrow(
      'captain.reasoningEffort for adapter "claude" must be one of:',
    );
    await expect(
      loadTmuxPlayConfig(options(unrelatedPath)),
    ).rejects.toThrow('Unknown config field config.unknownRoot');
    expect(readFileSync(captainPath)).toEqual(Buffer.from(captainSource));
    expect(readFileSync(invalidPath)).toEqual(Buffer.from(invalidSource));
    expect(readFileSync(unrelatedPath)).toEqual(Buffer.from(unrelatedSource));
    expect(deprecations).toEqual([]);
    expectNoEffortTemps(workDir);
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

  it('normalizes notification sinks and rejects unknown events or sinks', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'notifications:',
        '  player_finished: bell',
        '  turn_finished: desktop',
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

    expect(loaded.config.notifications).toEqual({
      player_finished: 'bell',
      turn_finished: 'desktop',
      turn_aborted: 'off',
    });

    const badEvent = join(workDir, 'bad-event.yaml');
    writeFileSync(
      badEvent,
      [
        'notifications:',
        '  runtime_error: desktop',
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
    await expect(loadTmuxPlayConfig({ configPath: badEvent })).rejects.toThrow(
      'Unknown config field notifications.runtime_error',
    );

    const badSink = join(workDir, 'bad-sink.yaml');
    writeFileSync(
      badSink,
      [
        'notifications:',
        '  turn_finished: toast',
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
    await expect(loadTmuxPlayConfig({ configPath: badSink })).rejects.toThrow(
      'notifications.turn_finished must be one of: off, bell, desktop',
    );
  });

  it('treats a missing notification block as off and snapshots the resolved map', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    const sessionWorkDir = join(workDir, 'session');
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
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ configPath });
    const snapshotPath = await writeTmuxPlayConfigSnapshot(loaded, sessionWorkDir);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as TmuxPlayConfig;

    expect(loaded.config.notifications).toEqual({
      player_finished: 'off',
      turn_finished: 'off',
      turn_aborted: 'off',
    });
    expect(snapshot.notifications).toEqual(loaded.config.notifications);
  });

  it('updates old home YAML with only missing safe defaults', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cwd = join(workDir, 'project');
    const configHome = join(workDir, 'xdg');
    const homeConfig = join(configHome, TMUX_PLAY_HOME_CONFIG);
    mkdirSync(cwd);
    mkdirSync(join(configHome, 'tmux-play'), { recursive: true });
    writeFileSync(
      homeConfig,
      [
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: codex',
        'players:',
        '  - id: solo',
        '    adapter: gemini',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ cwd, configHome });
    const migrated = readFileSync(homeConfig, 'utf8');

    expect(loaded.config.captain.adapter).toBe('codex');
    expect(loaded.config.captain.options).toEqual({});
    expect(loaded.config.players.map((player) => player.id)).toEqual(['solo']);
    expect(loaded.config.theme).toBe('auto');
    expect(loaded.config.layout).toEqual({
      window: { columns: 174, rows: 49 },
      initialVisible: ['solo'],
      singlePlayerColumnWeights: [1, 1],
      multiPlayerColumnWeights: [1, 1, 1],
      columnWeights: [1, 1],
    });
    expect(loaded.config.notifications).toEqual({
      player_finished: 'bell',
      turn_finished: 'desktop',
      turn_aborted: 'off',
    });
    expect(migrated).toContain('theme: auto');
    expect(migrated).toContain('options: {}');
    expect(migrated).toContain('layout:');
    expect(migrated).toContain('multiPlayerColumnWeights:');
    expect(migrated).toContain('notifications:');
    expect(migrated).toContain('player_finished: bell');
    expect(migrated).toContain('turn_finished: desktop');
    expect(migrated).not.toContain('model:');
    expect(migrated).not.toContain('instruction:');
    expect(migrated).not.toContain('permissions:');
    expect(migrated).not.toContain('effort:');
  });

  it('preserves an existing partial home notifications block', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cwd = join(workDir, 'project');
    const configHome = join(workDir, 'xdg');
    const homeConfig = join(configHome, TMUX_PLAY_HOME_CONFIG);
    mkdirSync(cwd);
    mkdirSync(join(configHome, 'tmux-play'), { recursive: true });
    writeFileSync(
      homeConfig,
      [
        'notifications:',
        '  player_finished: off',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        'players:',
        '  - id: solo',
        '    adapter: codex',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ cwd, configHome });
    const migrated = readFileSync(homeConfig, 'utf8');

    expect(loaded.config.notifications).toEqual({
      player_finished: 'off',
      turn_finished: 'off',
      turn_aborted: 'off',
    });
    expect(migrated).toContain('player_finished: off');
    expect(migrated).not.toContain('turn_finished: desktop');
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
      initialVisible: ['coder', 'reviewer'],
      singlePlayerColumnWeights: [1, 1],
      multiPlayerColumnWeights: [1, 1, 1],
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
      initialVisible: ['solo'],
      singlePlayerColumnWeights: [1, 1],
      multiPlayerColumnWeights: [1, 1, 1],
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
      initialVisible: ['coder', 'reviewer'],
      singlePlayerColumnWeights: [1, 1],
      multiPlayerColumnWeights: [3, 5, 5],
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

  it('accepts a two- or three-element columnWeights alias regardless of player count (TTMUX-079)', async () => {
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

    // A two-element columnWeights aliases singlePlayerColumnWeights; the
    // multi-player default still applies, so a two-player roster stays valid.
    const twoWeights = await loadTmuxPlayConfig({
      configPath: twoPlayersTwoWeights,
    });
    expect(twoWeights.config.layout.singlePlayerColumnWeights).toEqual([4, 6]);
    expect(twoWeights.config.layout.multiPlayerColumnWeights).toEqual([1, 1, 1]);
    expect(twoWeights.config.layout.columnWeights).toEqual([1, 1, 1]);

    // A three-element columnWeights aliases multiPlayerColumnWeights; a
    // one-player roster stays valid and renders the single-player default.
    const threeWeights = await loadTmuxPlayConfig({
      configPath: onePlayerThreeWeights,
    });
    expect(threeWeights.config.layout.multiPlayerColumnWeights).toEqual([4, 6, 6]);
    expect(threeWeights.config.layout.singlePlayerColumnWeights).toEqual([1, 1]);
    expect(threeWeights.config.layout.columnWeights).toEqual([1, 1]);
  });

  it('rejects a columnWeights alias whose length is not 2 or 3 (TTMUX-079)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const body = (weights: number[]): string =>
      [
        'layout:',
        '  columnWeights:',
        ...weights.map((w) => `    - ${w}`),
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '',
      ].join('\n');
    const oneWeight = join(workDir, 'one-weight.yaml');
    const fourWeights = join(workDir, 'four-weights.yaml');
    writeFileSync(oneWeight, body([4]));
    writeFileSync(fourWeights, body([1, 2, 3, 4]));

    await expect(loadTmuxPlayConfig({ configPath: oneWeight })).rejects.toThrow(
      'layout.columnWeights length must be 2',
    );
    await expect(
      loadTmuxPlayConfig({ configPath: fourWeights }),
    ).rejects.toThrow('layout.columnWeights length must be 2');
  });

  it('resolves explicit canonical column-weight fields (TTMUX-079)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    writeFileSync(
      configPath,
      [
        'layout:',
        '  singlePlayerColumnWeights:',
        '    - 2',
        '    - 3',
        '  multiPlayerColumnWeights:',
        '    - 4',
        '    - 6',
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

    const loaded = await loadTmuxPlayConfig({ configPath });
    expect(loaded.config.layout.singlePlayerColumnWeights).toEqual([2, 3]);
    expect(loaded.config.layout.multiPlayerColumnWeights).toEqual([4, 6, 6]);
    // Two players -> the active shape is multi.
    expect(loaded.config.layout.columnWeights).toEqual([4, 6, 6]);
  });

  it('rejects a columnWeights alias alongside the same-shape canonical field, accepts different shapes (TTMUX-079)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const conflict = join(workDir, 'conflict.yaml');
    const distinct = join(workDir, 'distinct.yaml');
    writeFileSync(
      conflict,
      [
        'layout:',
        '  multiPlayerColumnWeights:',
        '    - 1',
        '    - 1',
        '    - 1',
        '  columnWeights:',
        '    - 4',
        '    - 6',
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
    // A two-element alias targets the single shape, so it coexists with an
    // explicit multi-player canonical field.
    writeFileSync(
      distinct,
      [
        'layout:',
        '  multiPlayerColumnWeights:',
        '    - 4',
        '    - 6',
        '    - 6',
        '  columnWeights:',
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

    await expect(loadTmuxPlayConfig({ configPath: conflict })).rejects.toThrow(
      'layout.columnWeights conflicts with layout.multiPlayerColumnWeights',
    );
    const distinctLoaded = await loadTmuxPlayConfig({ configPath: distinct });
    expect(distinctLoaded.config.layout.singlePlayerColumnWeights).toEqual([2, 3]);
    expect(distinctLoaded.config.layout.multiPlayerColumnWeights).toEqual([4, 6, 6]);
  });

  it('rejects a canonical column-weight field of the wrong length (TTMUX-079)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const badSingle = join(workDir, 'bad-single.yaml');
    const badMulti = join(workDir, 'bad-multi.yaml');
    writeFileSync(
      badSingle,
      [
        'layout:',
        '  singlePlayerColumnWeights:',
        '    - 1',
        '    - 1',
        '    - 1',
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
    writeFileSync(
      badMulti,
      [
        'layout:',
        '  multiPlayerColumnWeights:',
        '    - 1',
        '    - 1',
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

    await expect(loadTmuxPlayConfig({ configPath: badSingle })).rejects.toThrow(
      'layout.singlePlayerColumnWeights length must be 2',
    );
    await expect(loadTmuxPlayConfig({ configPath: badMulti })).rejects.toThrow(
      'layout.multiPlayerColumnWeights length must be 3',
    );
  });

  it('migrates a legacy home columnWeights to its canonical field (TTMUX-081)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cwd = join(workDir, 'project');
    mkdirSync(cwd);
    const homeFor = (name: string, weights: number[], playerIds: string[]): string => {
      const configHome = join(workDir, name);
      const homeConfig = join(configHome, TMUX_PLAY_HOME_CONFIG);
      mkdirSync(join(configHome, 'tmux-play'), { recursive: true });
      writeFileSync(
        homeConfig,
        [
          'layout:',
          '  columnWeights:',
          ...weights.map((w) => `    - ${w}`),
          'captain:',
          "  from: '@sublang/cligent/captains/fanout'",
          '  adapter: claude',
          'players:',
          ...playerIds.flatMap((id) => [`  - id: ${id}`, '    adapter: codex']),
          '',
        ].join('\n'),
      );
      return homeConfig;
    };

    // Three-element legacy weights migrate to multiPlayerColumnWeights.
    const multiHome = homeFor('multi', [4, 6, 6], ['coder', 'reviewer']);
    const multiLoaded = await loadTmuxPlayConfig({ cwd, configHome: join(workDir, 'multi') });
    const multiOnDisk = readFileSync(multiHome, 'utf8');
    expect(multiOnDisk).toContain('multiPlayerColumnWeights:');
    expect(multiOnDisk).not.toMatch(/^\s*columnWeights:/m);
    expect(multiLoaded.config.layout.multiPlayerColumnWeights).toEqual([4, 6, 6]);

    // Two-element legacy weights migrate to singlePlayerColumnWeights.
    const singleHome = homeFor('single', [2, 3], ['solo']);
    const singleLoaded = await loadTmuxPlayConfig({ cwd, configHome: join(workDir, 'single') });
    const singleOnDisk = readFileSync(singleHome, 'utf8');
    expect(singleOnDisk).toContain('singlePlayerColumnWeights:');
    expect(singleOnDisk).not.toMatch(/^\s*columnWeights:/m);
    expect(singleLoaded.config.layout.singlePlayerColumnWeights).toEqual([2, 3]);
    expect(singleLoaded.config.layout.columnWeights).toEqual([2, 3]);
  });

  it('does not migrate a home columnWeights that conflicts with a canonical field (TTMUX-081)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const cwd = join(workDir, 'project');
    const configHome = join(workDir, 'xdg');
    const homeConfig = join(configHome, TMUX_PLAY_HOME_CONFIG);
    mkdirSync(cwd);
    mkdirSync(join(configHome, 'tmux-play'), { recursive: true });
    writeFileSync(
      homeConfig,
      [
        'layout:',
        '  multiPlayerColumnWeights:',
        '    - 1',
        '    - 1',
        '    - 1',
        '  columnWeights:',
        '    - 4',
        '    - 6',
        '    - 6',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );

    await expect(loadTmuxPlayConfig({ cwd, configHome })).rejects.toThrow(
      'layout.columnWeights conflicts with layout.multiPlayerColumnWeights',
    );
    // Migration left the conflicting file untouched: both keys still present.
    const onDisk = readFileSync(homeConfig, 'utf8');
    expect(onDisk).toContain('multiPlayerColumnWeights:');
    expect(onDisk).toMatch(/^\s*columnWeights:/m);
  });

  it('does not rewrite an explicit-path config that uses the columnWeights alias (TTMUX-081)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const configPath = join(workDir, TMUX_PLAY_CONFIG_FILE);
    const source = [
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
      '  - id: coder',
      '    adapter: codex',
      '  - id: reviewer',
      '    adapter: claude',
      '',
    ].join('\n');
    writeFileSync(configPath, source);

    const loaded = await loadTmuxPlayConfig({ configPath });
    // The explicit-path config is not mutated but still resolves via the alias.
    expect(readFileSync(configPath, 'utf8')).toBe(source);
    expect(loaded.config.layout.multiPlayerColumnWeights).toEqual([4, 6, 6]);
  });

  it('resolves layout.initialVisible as a validated, ordered subset (TTMUX-080)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const sessionWorkDir = join(workDir, 'session');
    const captain = [
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  options: {}',
    ];
    const players = [
      'players:',
      '  - id: alpha',
      '    adapter: codex',
      '  - id: beta',
      '    adapter: claude',
      '  - id: gamma',
      '    adapter: codex',
      '',
    ];
    const withLayout = (layout: string[]): string =>
      [...layout, ...captain, ...players].join('\n');
    const noLayout = (): string => [...captain, ...players].join('\n');

    // A subset in explicit order; the snapshot carries the resolved set, and
    // two visible players keep the multi-player shape active.
    const subsetPath = join(workDir, 'subset.yaml');
    writeFileSync(
      subsetPath,
      withLayout(['layout:', '  initialVisible:', '    - gamma', '    - alpha']),
    );
    const subset = await loadTmuxPlayConfig({ configPath: subsetPath });
    expect(subset.config.layout.initialVisible).toEqual(['gamma', 'alpha']);
    expect(subset.config.layout.columnWeights).toEqual([1, 1, 1]);
    const snapshotPath = await writeTmuxPlayConfigSnapshot(subset, sessionWorkDir);
    const snapshot = JSON.parse(
      readFileSync(snapshotPath, 'utf8'),
    ) as TmuxPlayConfig;
    expect(snapshot.layout.initialVisible).toEqual(['gamma', 'alpha']);

    // Omitted -> every configured player in `players` order.
    const omittedPath = join(workDir, 'omitted.yaml');
    writeFileSync(omittedPath, noLayout());
    const omitted = await loadTmuxPlayConfig({ configPath: omittedPath });
    expect(omitted.config.layout.initialVisible).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);

    // A single visible player selects the single-player column shape.
    const singlePath = join(workDir, 'single.yaml');
    writeFileSync(
      singlePath,
      withLayout(['layout:', '  initialVisible:', '    - beta']),
    );
    const single = await loadTmuxPlayConfig({ configPath: singlePath });
    expect(single.config.layout.initialVisible).toEqual(['beta']);
    expect(single.config.layout.columnWeights).toEqual([1, 1]);
  });

  it('rejects a malformed layout.initialVisible (TTMUX-080)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-'));
    const captain = [
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  options: {}',
    ];
    const players = [
      'players:',
      '  - id: alpha',
      '    adapter: codex',
      '  - id: beta',
      '    adapter: claude',
      '',
    ];
    const withInitial = (entries: string[]): string =>
      ['layout:', '  initialVisible:', ...entries, ...captain, ...players].join(
        '\n',
      );

    const emptyPath = join(workDir, 'empty.yaml');
    writeFileSync(
      emptyPath,
      ['layout:', '  initialVisible: []', ...captain, ...players].join('\n'),
    );
    const dupPath = join(workDir, 'dup.yaml');
    writeFileSync(dupPath, withInitial(['    - alpha', '    - alpha']));
    const unknownPath = join(workDir, 'unknown.yaml');
    writeFileSync(unknownPath, withInitial(['    - alpha', '    - ghost']));

    await expect(loadTmuxPlayConfig({ configPath: emptyPath })).rejects.toThrow(
      'layout.initialVisible must name at least one player',
    );
    await expect(loadTmuxPlayConfig({ configPath: dupPath })).rejects.toThrow(
      'layout.initialVisible[1] "alpha" is a duplicate player id',
    );
    await expect(
      loadTmuxPlayConfig({ configPath: unknownPath }),
    ).rejects.toThrow(
      'layout.initialVisible[1] "ghost" is not a configured player id',
    );
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
      initialVisible: ['coder', 'reviewer'],
      singlePlayerColumnWeights: [1, 1],
      multiPlayerColumnWeights: [1, 2, 3],
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
