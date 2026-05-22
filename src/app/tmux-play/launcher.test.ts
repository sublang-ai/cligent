// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  attachTmuxSessionMock,
  isTmuxAvailableMock,
  runTmuxMock,
  isGlowAvailableMock,
} = vi.hoisted(() => ({
  attachTmuxSessionMock: vi.fn(),
  isTmuxAvailableMock: vi.fn(),
  runTmuxMock: vi.fn(),
  isGlowAvailableMock: vi.fn(),
}));

vi.mock('../shared/tmux.js', () => ({
  attachTmuxSession: attachTmuxSessionMock,
  isTmuxAvailable: isTmuxAvailableMock,
  runTmux: runTmuxMock,
}));

vi.mock('../shared/glow.js', () => ({
  GLOW_INSTALL_URL: 'https://github.com/charmbracelet/glow#installation',
  isGlowAvailable: isGlowAvailableMock,
}));

import {
  launchTmuxPlay,
  TMUX_PLAY_SESSION_MARKER,
} from './launcher.js';
import { TMUX_PLAY_CONFIG_SNAPSHOT } from './config.js';
import {
  TMUX_PANE_TIMER_ACCENT_OPTION,
  TMUX_PANE_TIMER_RUNNING_OPTION,
  TMUX_PANE_TIMER_TEXT_OPTION,
  TMUX_STATUS_TIMER_RUNNING_OPTION,
  TMUX_STATUS_TIMER_TEXT_OPTION,
} from './timer-options.js';
import { shellQuote } from '../shared/shell.js';

class MemoryOutput {
  chunks: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  text(): string {
    return this.chunks.join('');
  }
}

describe('launchTmuxPlay', () => {
  let tempDir: string | undefined;

  beforeEach(() => {
    isTmuxAvailableMock.mockReturnValue(true);
    isGlowAvailableMock.mockReturnValue(true);
    runTmuxMock.mockReset();
    attachTmuxSessionMock.mockReset();
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('writes logs and snapshot, then builds the tmux layout', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder', 'reviewer', 'analyst']);
    const workDir = join(tempDir, 'play work');

    const result = await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'abc123',
      workDir,
      selfBin: '/tmp/tmux play/cli.js',
      attach: false,
    });

    expect(result).toEqual({
      sessionId: 'abc123',
      sessionName: 'tmux-play-abc123',
      workDir,
      snapshotPath: join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT),
    });
    expect(readFileSync(join(workDir, TMUX_PLAY_SESSION_MARKER), 'utf8')).toBe(
      'abc123',
    );
    expect(existsSync(join(workDir, 'coder.log'))).toBe(true);
    expect(existsSync(join(workDir, 'reviewer.log'))).toBe(true);
    expect(existsSync(join(workDir, 'analyst.log'))).toBe(true);

    const snapshot = JSON.parse(
      readFileSync(join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT), 'utf8'),
    ) as { captain: { from: string } };
    expect(snapshot.captain.from).toBe('@sublang/cligent/captains/fanout');

    expect(runTmuxMock).toHaveBeenNthCalledWith(
      1,
      'new-session',
      '-d',
      '-x',
      '240',
      '-y',
      '67',
      '-s',
      'tmux-play-abc123',
      expect.stringContaining('--session abc123'),
    );
    expect(runTmuxMock.mock.calls[0]?.at(-1)).toContain(
      "--work-dir '" + workDir + "'",
    );
    expect(runTmuxMock.mock.calls[0]?.at(-1)).toContain(
      "'/tmp/tmux play/cli.js'",
    );
    expect(runTmuxMock).toHaveBeenNthCalledWith(
      2,
      'split-window',
      '-h',
      '-l',
      '75%',
      '-t',
      'tmux-play-abc123',
      tailCommand(workDir, 'coder'),
    );
    expect(runTmuxMock).toHaveBeenNthCalledWith(
      3,
      'split-window',
      '-h',
      '-l',
      '50%',
      '-t',
      'tmux-play-abc123:0.1',
      tailCommand(workDir, 'analyst'),
    );
    expect(runTmuxMock).toHaveBeenNthCalledWith(
      4,
      'split-window',
      '-v',
      '-t',
      'tmux-play-abc123:0.1',
      tailCommand(workDir, 'reviewer'),
    );
    const initialColumns = Number(
      valueAfter(runTmuxMock.mock.calls[0] ?? [], '-x'),
    );
    const roleAreaPercent = Number(
      valueAfter(runTmuxMock.mock.calls[1] ?? [], '-l').replace('%', ''),
    );
    const secondRoleColumnPercent = Number(
      valueAfter(runTmuxMock.mock.calls[2] ?? [], '-l').replace('%', ''),
    );
    const roleAreaColumns = Math.floor(
      (initialColumns * roleAreaPercent) / 100,
    );
    const secondRoleColumnColumns = Math.floor(
      (roleAreaColumns * secondRoleColumnPercent) / 100,
    );
    expect({
      bossColumns: initialColumns - roleAreaColumns,
      firstRoleColumnColumns: roleAreaColumns - secondRoleColumnColumns,
      secondRoleColumnColumns,
    }).toEqual({
      bossColumns: 60,
      firstRoleColumnColumns: 90,
      secondRoleColumnColumns: 90,
    });
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.0',
      '-T',
      'Captain · claude',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.1',
      '-T',
      'Coder · codex',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.3',
      '-T',
      'Reviewer · codex',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.2',
      '-T',
      'Analyst · codex',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.1',
      '-d',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.2',
      '-d',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.3',
      '-d',
    );
    expect(runTmuxMock).not.toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.0',
      '-d',
    );
    const expectedHookCmd =
      `run-shell -b "W=$(tmux display-message -t tmux-play-abc123 -p '#{window_width}')` +
      ` && tmux resize-pane -t tmux-play-abc123:0.0 -x $((W * 4 / 16 - 1))` +
      ` && tmux resize-pane -t tmux-play-abc123:0.1 -x $((W * 6 / 16 - 1))"`;
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-hook',
      '-t',
      'tmux-play-abc123',
      'client-resized',
      expectedHookCmd,
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-hook',
      '-t',
      'tmux-play-abc123',
      'after-resize-window',
      expectedHookCmd,
    );
    expect(runTmuxMock.mock.calls.at(-1)).toEqual([
      'select-pane',
      '-t',
      'tmux-play-abc123:0.0',
    ]);
    expect(attachTmuxSessionMock).not.toHaveBeenCalled();
  });

  it('applies the Catppuccin Mocha theme before content-bearing options', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);
    const workDir = join(tempDir, 'work');

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'theme',
      workDir,
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    const setCalls = runTmuxMock.mock.calls.filter(
      (call) => call[0] === 'set' && call[2] === 'tmux-play-theme',
    );
    const optionAt = (n: number): string | undefined => setCalls[n]?.[3];
    const indexOf = (option: string): number =>
      setCalls.findIndex((call) => call[3] === option);

    // TMUX-047 (truecolor): default-terminal scoped to this session, and
    // terminal-overrides appended on the server with the leading-comma idiom.
    expect(setCalls).toContainEqual([
      'set',
      '-t',
      'tmux-play-theme',
      'default-terminal',
      'tmux-256color',
    ]);
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set',
      '-as',
      'terminal-overrides',
      ',*:RGB',
    );

    // TMUX-047: theme options the launcher claims, each with a Mocha hex anchor.
    expect(setCalls).toContainEqual([
      'set',
      '-t',
      'tmux-play-theme',
      'status-style',
      'fg=#cdd6f4,bg=#181825',
    ]);
    expect(setCalls).toContainEqual([
      'set',
      '-t',
      'tmux-play-theme',
      'pane-active-border-style',
      'fg=#89b4fa',
    ]);
    // TMUX-048: inactive pane border dimmed to overlay0 for stronger contrast
    // with the active blue border.
    expect(setCalls).toContainEqual([
      'set',
      '-t',
      'tmux-play-theme',
      'pane-border-style',
      'fg=#6c7086',
    ]);
    expect(indexOf('window-status-style')).toBeGreaterThanOrEqual(0);
    expect(indexOf('window-status-current-style')).toBeGreaterThanOrEqual(0);
    expect(indexOf('message-style')).toBeGreaterThanOrEqual(0);
    expect(indexOf('message-command-style')).toBeGreaterThanOrEqual(0);
    expect(indexOf('display-panes-colour')).toBeGreaterThanOrEqual(0);
    expect(indexOf('display-panes-active-colour')).toBeGreaterThanOrEqual(0);
    expect(indexOf('clock-mode-colour')).toBeGreaterThanOrEqual(0);

    // Ordering invariant: every theme option precedes the content-bearing
    // options it does NOT touch, so our pane-border-format and status-left/right
    // strings remain authoritative if a future theme tries to set them.
    const themeOptions = [
      'default-terminal',
      'status-style',
      'window-status-style',
      'window-status-current-style',
      'pane-border-style',
      'pane-active-border-style',
      'message-style',
      'message-command-style',
      'display-panes-colour',
      'display-panes-active-colour',
      'clock-mode-colour',
    ];
    const lastThemeIndex = Math.max(
      ...themeOptions.map((o) => indexOf(o)),
    );
    expect(indexOf('pane-border-format')).toBeGreaterThan(lastThemeIndex);
    expect(indexOf('status-left')).toBeGreaterThan(lastThemeIndex);
    expect(indexOf('status-right')).toBeGreaterThan(lastThemeIndex);

    // First theme set still comes after the layout has been built.
    expect(optionAt(0)).toBe('default-terminal');
  });

  it('configures timer slots on the pane borders and tmux status bar', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder', 'reviewer']);

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'timers',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-option',
      '-p',
      '-t',
      'tmux-play-timers:0.0',
      TMUX_PANE_TIMER_ACCENT_OPTION,
      '#cba6f7',
    );
    for (const pane of ['tmux-play-timers:0.1', 'tmux-play-timers:0.2']) {
      expect(runTmuxMock).toHaveBeenCalledWith(
        'set-option',
        '-p',
        '-t',
        pane,
        TMUX_PANE_TIMER_ACCENT_OPTION,
        '#94e2d5',
      );
    }
    for (const pane of [
      'tmux-play-timers:0.0',
      'tmux-play-timers:0.1',
      'tmux-play-timers:0.2',
    ]) {
      expect(runTmuxMock).toHaveBeenCalledWith(
        'set-option',
        '-p',
        '-t',
        pane,
        TMUX_PANE_TIMER_TEXT_OPTION,
        '0s',
      );
      expect(runTmuxMock).toHaveBeenCalledWith(
        'set-option',
        '-p',
        '-t',
        pane,
        TMUX_PANE_TIMER_RUNNING_OPTION,
        '0',
      );
    }
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-option',
      '-t',
      'tmux-play-timers',
      TMUX_STATUS_TIMER_TEXT_OPTION,
      '0s',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-option',
      '-t',
      'tmux-play-timers',
      TMUX_STATUS_TIMER_RUNNING_OPTION,
      '0',
    );

    const paneBorderFormat = setValue('tmux-play-timers', 'pane-border-format');
    expect(paneBorderFormat).toContain('#{pane_title}');
    expect(paneBorderFormat).toContain(
      '#{?pane_active,#[fg=#1e1e2e]#[bg=#89b4fa]#[bold],#[fg=#cdd6f4]#[bg=#181825]}',
    );
    expect(paneBorderFormat).toContain(`#{${TMUX_PANE_TIMER_ACCENT_OPTION}}`);
    expect(paneBorderFormat).toContain(`#{${TMUX_PANE_TIMER_TEXT_OPTION}}`);
    expect(paneBorderFormat).toContain(
      `#{==:#{${TMUX_PANE_TIMER_RUNNING_OPTION}},1}`,
    );
    expect(paneBorderFormat).toContain(
      `#{?#{==:#{${TMUX_PANE_TIMER_RUNNING_OPTION}},1},#[fg=#{${TMUX_PANE_TIMER_ACCENT_OPTION}}],#[fg=#7f849c]}`,
    );
    expect(paneBorderFormat).toContain('⏳');
    expect(paneBorderFormat).toContain('⌛');
    expect(paneBorderFormat).toContain('#7f849c');
    expect(paneBorderFormat.indexOf('⏳')).toBeLessThan(
      paneBorderFormat.indexOf(
        `#{?#{==:#{${TMUX_PANE_TIMER_RUNNING_OPTION}},1},#[fg=`,
      ),
    );

    const statusLeft = setValue('tmux-play-timers', 'status-left');
    expect(statusLeft).toContain('tmux-play');
    expect(statusLeft).toContain('Quit: Ctrl+C');
    expect(statusLeft).toContain('d=detach');
    expect(setValue('tmux-play-timers', 'status-left-length')).toBe('96');

    const statusRight = setValue('tmux-play-timers', 'status-right');
    expect(statusRight).toContain('⏰');
    expect(statusRight).toContain(`#{${TMUX_STATUS_TIMER_TEXT_OPTION}}`);
    expect(statusRight).toContain(
      `#{==:#{${TMUX_STATUS_TIMER_RUNNING_OPTION}},1}`,
    );
    expect(statusRight).toContain(
      `#{?#{==:#{${TMUX_STATUS_TIMER_RUNNING_OPTION}},1},#[fg=#cba6f7],#[fg=#7f849c]}`,
    );
    expect(statusRight).toContain('#cba6f7');
    expect(statusRight).toContain('#7f849c');
    expect(statusRight.indexOf('⏰')).toBeLessThan(
      statusRight.indexOf(
        `#{?#{==:#{${TMUX_STATUS_TIMER_RUNNING_OPTION}},1},#[fg=`,
      ),
    );
    expect(setValue('tmux-play-timers', 'status-right-length')).toBe('32');
  });

  it('configures the resize hook for a single-role session', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['solo']);
    const workDir = join(tempDir, 'work');

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'one',
      workDir,
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    const expectedHookCmd =
      `run-shell -b "W=$(tmux display-message -t tmux-play-one -p '#{window_width}')` +
      ` && tmux resize-pane -t tmux-play-one:0.0 -x $((W * 4 / 16 - 1))"`;
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-hook',
      '-t',
      'tmux-play-one',
      'client-resized',
      expectedHookCmd,
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-hook',
      '-t',
      'tmux-play-one',
      'after-resize-window',
      expectedHookCmd,
    );
  });

  it.each([
    {
      count: 4,
      roles: ['r1', 'r2', 'r3', 'r4'],
      expected: [
        ['split-window', '-h', '-l', '75%', '-t', 'tmux-play-grid4', 'r1'],
        ['split-window', '-h', '-l', '50%', '-t', 'tmux-play-grid4:0.1', 'r3'],
        ['split-window', '-v', '-t', 'tmux-play-grid4:0.1', 'r2'],
        ['split-window', '-v', '-t', 'tmux-play-grid4:0.2', 'r4'],
      ],
    },
    {
      count: 5,
      roles: ['r1', 'r2', 'r3', 'r4', 'r5'],
      expected: [
        ['split-window', '-h', '-l', '75%', '-t', 'tmux-play-grid5', 'r1'],
        ['split-window', '-h', '-l', '50%', '-t', 'tmux-play-grid5:0.1', 'r4'],
        ['split-window', '-v', '-t', 'tmux-play-grid5:0.1', 'r2'],
        ['split-window', '-v', '-t', 'tmux-play-grid5:0.3', 'r3'],
        ['split-window', '-v', '-t', 'tmux-play-grid5:0.2', 'r5'],
      ],
    },
  ])(
    'creates columns before rows for $count roles',
    async ({ count, roles, expected }) => {
      tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
      const configPath = writeConfig(tempDir, roles);
      const workDir = join(tempDir, 'work');

      await launchTmuxPlay({
        cwd: tempDir,
        configPath,
        sessionId: `grid${count}`,
        workDir,
        selfBin: '/tmp/cli.js',
        attach: false,
      });

      expect(splitWindowCalls(workDir, roles)).toEqual(expected);
    },
  );

  it('attaches to the session by default', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'def456',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
    });

    expect(attachTmuxSessionMock).toHaveBeenCalledWith('tmux-play-def456');
  });

  it('requests a 240x67 terminal resize before attach', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);
    const stdout = new MemoryOutput();
    let stdoutAtAttach: string | undefined;
    attachTmuxSessionMock.mockImplementation(() => {
      stdoutAtAttach = stdout.text();
    });

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'resize',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      stdout,
    });

    expect(attachTmuxSessionMock).toHaveBeenCalledWith('tmux-play-resize');
    expect(stdout.text()).toContain('\x1b[8;67;240t');
    expect(stdoutAtAttach).toContain('\x1b[8;67;240t');
  });

  it('does not request a terminal resize when attach is disabled', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);
    const stdout = new MemoryOutput();

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'noattach',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      stdout,
      attach: false,
    });

    expect(attachTmuxSessionMock).not.toHaveBeenCalled();
    expect(stdout.text()).not.toContain('\x1b[8;67;240t');
  });

  it('prints a notice when creating the first-run home config', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const cwd = join(tempDir, 'project');
    const configHome = join(tempDir, 'xdg');
    const workDir = join(tempDir, 'work');
    const stdout = new MemoryOutput();
    mkdirSync(cwd);

    await launchTmuxPlay({
      cwd,
      configHome,
      sessionId: 'fresh',
      workDir,
      selfBin: '/tmp/cli.js',
      stdout,
      attach: false,
    });

    expect(stdout.text()).toContain(
      `Created tmux-play config at ${join(configHome, 'tmux-play/config.yaml')}`,
    );
    expect(existsSync(join(configHome, 'tmux-play/config.yaml'))).toBe(true);
  });

  it('warns when ignoring a legacy cwd config', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const cwd = join(tempDir, 'project');
    const configHome = join(tempDir, 'xdg');
    const workDir = join(tempDir, 'work');
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    mkdirSync(cwd);
    const legacyConfig = join(cwd, 'tmux-play.config.json');
    writeFileSync(legacyConfig, '{}');

    await launchTmuxPlay({
      cwd,
      configHome,
      sessionId: 'legacy',
      workDir,
      selfBin: '/tmp/cli.js',
      stdout,
      stderr,
      attach: false,
    });

    expect(stderr.text()).toContain(
      `Found legacy tmux-play config at ${legacyConfig}; tmux-play now requires tmux-play.config.yaml. Rename or convert it.`,
    );
  });

  it('fails before config loading when tmux is unavailable', async () => {
    isTmuxAvailableMock.mockReturnValue(false);

    await expect(
      launchTmuxPlay({ configPath: '/missing/config.yaml' }),
    ).rejects.toThrow('tmux is not installed');
    expect(runTmuxMock).not.toHaveBeenCalled();
  });

  it('fails before config loading when glow is unavailable', async () => {
    isGlowAvailableMock.mockReturnValue(false);

    await expect(
      launchTmuxPlay({ configPath: '/missing/config.yaml' }),
    ).rejects.toThrow(
      'glow is not installed — see https://github.com/charmbracelet/glow#installation',
    );
    expect(runTmuxMock).not.toHaveBeenCalled();
  });
});

function writeConfig(dir: string, roleIds: readonly string[]): string {
  const configPath = join(dir, 'tmux-play.config.yaml');
  writeFileSync(
    configPath,
    [
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  options: {}',
      'roles:',
      ...roleIds.flatMap((id) => [
        `  - id: ${id}`,
        '    adapter: codex',
      ]),
      '',
    ].join('\n'),
  );
  return configPath;
}

function tailCommand(workDir: string, roleId: string): string {
  return ['tail', '-f', join(workDir, `${roleId}.log`)]
    .map(shellQuote)
    .join(' ');
}

function splitWindowCalls(
  workDir: string,
  roleIds: readonly string[],
): unknown[][] {
  return runTmuxMock.mock.calls
    .filter((call) => call[0] === 'split-window')
    .map((call) => {
      const roleId =
        roleIds.find((id) => call.at(-1) === tailCommand(workDir, id)) ??
        call.at(-1);
      return [...call.slice(0, -1), roleId];
    });
}

function setValue(sessionName: string, option: string): string {
  const call = runTmuxMock.mock.calls.find(
    (args) => args[0] === 'set' && args[2] === sessionName && args[3] === option,
  );
  const value = call?.[4];
  if (typeof value !== 'string') {
    throw new Error(`Missing ${option} set call for ${sessionName}`);
  }
  return value;
}

function valueAfter(args: readonly unknown[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (typeof value !== 'string') {
    throw new Error(`Missing ${flag} value in tmux args: ${args.join(' ')}`);
  }
  return value;
}
