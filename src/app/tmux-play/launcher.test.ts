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

const { attachTmuxSessionMock, isTmuxAvailableMock, runTmuxMock } =
  vi.hoisted(() => ({
    attachTmuxSessionMock: vi.fn(),
    isTmuxAvailableMock: vi.fn(),
    runTmuxMock: vi.fn(),
  }));

vi.mock('../shared/tmux.js', () => ({
  attachTmuxSession: attachTmuxSessionMock,
  isTmuxAvailable: isTmuxAvailableMock,
  runTmux: runTmuxMock,
}));

import {
  launchTmuxPlay,
  TMUX_PLAY_SESSION_MARKER,
} from './launcher.js';
import { TMUX_PLAY_CONFIG_SNAPSHOT } from './config.js';
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
      '-s',
      'tmux-play-abc123',
      expect.stringContaining('--session abc123'),
    );
    expect(runTmuxMock.mock.calls[0]?.[4]).toContain(
      "--work-dir '" + workDir + "'",
    );
    expect(runTmuxMock.mock.calls[0]?.[4]).toContain(
      "'/tmp/tmux play/cli.js'",
    );
    expect(runTmuxMock).toHaveBeenNthCalledWith(
      2,
      'split-window',
      '-h',
      '-p',
      '40',
      '-t',
      'tmux-play-abc123',
      tailCommand(workDir, 'coder'),
    );
    expect(runTmuxMock).toHaveBeenNthCalledWith(
      3,
      'split-window',
      '-h',
      '-p',
      '50',
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
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.0',
      '-T',
      'Boss/Captain',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.1',
      '-T',
      'Role: coder',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.3',
      '-T',
      'Role: reviewer',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.2',
      '-T',
      'Role: analyst',
    );
    expect(attachTmuxSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      count: 4,
      roles: ['r1', 'r2', 'r3', 'r4'],
      expected: [
        ['split-window', '-h', '-p', '40', '-t', 'tmux-play-grid4', 'r1'],
        ['split-window', '-h', '-p', '50', '-t', 'tmux-play-grid4:0.1', 'r3'],
        ['split-window', '-v', '-t', 'tmux-play-grid4:0.1', 'r2'],
        ['split-window', '-v', '-t', 'tmux-play-grid4:0.2', 'r4'],
      ],
    },
    {
      count: 5,
      roles: ['r1', 'r2', 'r3', 'r4', 'r5'],
      expected: [
        ['split-window', '-h', '-p', '40', '-t', 'tmux-play-grid5', 'r1'],
        ['split-window', '-h', '-p', '50', '-t', 'tmux-play-grid5:0.1', 'r4'],
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
