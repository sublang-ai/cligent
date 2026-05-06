// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TMUX_PLAY_CONFIG_SNAPSHOT,
  TMUX_PLAY_HOME_CONFIG,
} from './config.js';
import { TMUX_PLAY_SESSION_MARKER } from './launcher.js';

interface SmokeHarness {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tmuxLog: string;
}

describe('tmux-play built CLI smoke', () => {
  let harness: SmokeHarness | undefined;

  afterEach(() => {
    if (harness) {
      rmSync(harness.root, { recursive: true, force: true });
      harness = undefined;
    }
  });

  it('executes the built bin directly on POSIX', () => {
    if (process.platform === 'win32') {
      return;
    }

    const result = spawnSync(builtCliPath(), ['--help'], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    expectSuccess(result);
    expect(result.stdout).toContain('tmux-play [--config <path>]');
  });

  it('discovers cwd YAML, writes a rewritten snapshot, and invokes tmux', () => {
    harness = createHarness();
    const cwd = join(harness.root, 'project');
    mkdirSync(join(cwd, 'captains'), { recursive: true });
    writeYamlConfig(join(cwd, 'tmux-play.config.yaml'), {
      captainFrom: './captains/router.js',
      roles: ['coder', 'reviewer'],
    });

    const result = runCli(['--cwd', cwd], harness);

    expectSuccess(result);
    expect(result.stdout).not.toContain('Created tmux-play config');
    expect(result.stderr).toBe('');

    const calls = readTmuxCalls(harness);
    const newSession = requiredCall(calls, 'new-session');
    const sessionName = valueAfter(newSession, '-s') ?? '';
    const workDir = extractWorkDir(newSession.at(-1) ?? '');
    const snapshot = JSON.parse(
      readFileSync(join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT), 'utf8'),
    ) as {
      captain: { from: string };
      roles: Array<{ id: string }>;
    };

    expect(snapshot.captain.from).toBe(
      pathToFileURL(join(cwd, 'captains/router.js')).href,
    );
    expect(snapshot.roles.map((role) => role.id)).toEqual(['coder', 'reviewer']);
    expect(newSession).toContain('-x');
    expect(valueAfter(newSession, '-x')).toBe('240');
    expect(newSession).toContain('-y');
    expect(valueAfter(newSession, '-y')).toBe('67');
    expect(requiredCall(calls, 'attach-session')).toEqual([
      'attach-session',
      '-t',
      sessionName,
    ]);
  });

  it('auto-creates the home config once from the built CLI', () => {
    harness = createHarness();
    const cwd = join(harness.root, 'project');
    const configHome = join(harness.root, 'xdg');
    const homeConfig = join(configHome, TMUX_PLAY_HOME_CONFIG);
    mkdirSync(cwd, { recursive: true });

    const first = runCli(['--cwd', cwd], harness, {
      XDG_CONFIG_HOME: configHome,
    });

    expectSuccess(first);
    expect(first.stdout).toContain(`Created tmux-play config at ${homeConfig}`);
    expect(first.stderr).toBe('');
    expect(existsSync(homeConfig)).toBe(true);
    const before = readFileSync(homeConfig, 'utf8');

    const second = runCli(['--cwd', cwd], harness, {
      XDG_CONFIG_HOME: configHome,
    });

    expectSuccess(second);
    expect(second.stdout).not.toContain('Created tmux-play config');
    expect(second.stderr).toBe('');
    expect(readFileSync(homeConfig, 'utf8')).toBe(before);
  });

  it('warns about legacy cwd configs from the built CLI', () => {
    harness = createHarness();
    const cwd = join(harness.root, 'project');
    const configHome = join(harness.root, 'xdg');
    const homeConfig = join(configHome, TMUX_PLAY_HOME_CONFIG);
    const legacyConfig = join(cwd, 'tmux-play.config.json');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(configHome, 'tmux-play'), { recursive: true });
    writeFileSync(legacyConfig, '{}');
    writeYamlConfig(homeConfig, { captainFrom: '@sublang/cligent/captains/fanout' });

    const result = runCli(['--cwd', cwd], harness, {
      XDG_CONFIG_HOME: configHome,
    });

    expectSuccess(result);
    expect(result.stdout).not.toContain('Created tmux-play config');
    expect(result.stderr).toContain(
      `Found legacy tmux-play config at ${legacyConfig}; tmux-play now requires tmux-play.config.yaml. Rename or convert it.`,
    );
  });

  it('runs session mode from a package captain specifier', () => {
    harness = createHarness();
    const cwd = join(harness.root, 'project');
    const workDir = join(harness.root, 'session-work');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, TMUX_PLAY_SESSION_MARKER), 'abc123');
    writeFileSync(
      join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT),
      JSON.stringify(
        {
          captain: {
            from: '@sublang/cligent/captains/fanout',
            adapter: 'claude',
            options: {},
          },
          roles: [{ id: 'coder', adapter: 'codex' }],
        },
        null,
        2,
      ) + '\n',
    );

    const result = runCli(
      ['--session', 'abc123', '--work-dir', workDir, '--cwd', cwd],
      harness,
      {},
      '',
    );

    expectSuccess(result);
    expect(result.stdout).toContain('boss> ');
    expect(existsSync(workDir)).toBe(false);
    expect(requiredCall(readTmuxCalls(harness), 'kill-session')).toEqual([
      'kill-session',
      '-t',
      'tmux-play-abc123',
    ]);
  });
});

function createHarness(): SmokeHarness {
  const root = mkdtempSync(join(tmpdir(), 'tmux-play-cli-smoke-'));
  const binDir = join(root, 'bin');
  const tmpRoot = join(root, 'tmp');
  const tmuxLog = join(root, 'tmux.jsonl');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });

  const fakeTmux = join(binDir, 'tmux');
  writeFileSync(
    fakeTmux,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args[0] === '-V') {",
      "  console.log('tmux 3.4');",
      '  process.exit(0);',
      '}',
      "const log = process.env.FAKE_TMUX_LOG;",
      'if (!log) {',
      "  console.error('FAKE_TMUX_LOG missing');",
      '  process.exit(1);',
      '}',
      "fs.appendFileSync(log, JSON.stringify(args) + '\\n');",
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  chmodSync(fakeTmux, 0o755);

  return {
    root,
    tmuxLog,
    env: {
      ...process.env,
      FAKE_TMUX_LOG: tmuxLog,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      TMPDIR: tmpRoot,
    },
  };
}

function runCli(
  args: readonly string[],
  harness: SmokeHarness,
  env: NodeJS.ProcessEnv = {},
  input?: string,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [builtCliPath(), ...args], {
    encoding: 'utf8',
    env: {
      ...harness.env,
      ...env,
    },
    input,
    timeout: 10_000,
  });
}

function builtCliPath(): string {
  const cliPath = join(process.cwd(), 'dist/app/tmux-play/cli.js');
  if (!existsSync(cliPath)) {
    throw new Error('Missing dist/app/tmux-play/cli.js; run npm run build first');
  }
  return cliPath;
}

function expectSuccess(result: SpawnSyncReturns<string>): void {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

function readTmuxCalls(harness: SmokeHarness): string[][] {
  if (!existsSync(harness.tmuxLog)) {
    return [];
  }
  return readFileSync(harness.tmuxLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function requiredCall(calls: readonly string[][], command: string): string[] {
  const call = calls.find((candidate) => candidate[0] === command);
  expect(call, `Expected fake tmux call for ${command}`).toBeDefined();
  return call ?? [];
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function extractWorkDir(command: string): string {
  const match = command.match(/--work-dir '?([^' ]+)'?/);
  if (!match?.[1]) {
    throw new Error(`Could not find --work-dir in session command: ${command}`);
  }
  return match[1];
}

function writeYamlConfig(
  path: string,
  options: {
    readonly captainFrom: string;
    readonly roles?: readonly string[];
  },
): void {
  const roles = options.roles ?? ['coder'];
  writeFileSync(
    path,
    [
      'captain:',
      `  from: '${options.captainFrom}'`,
      '  adapter: claude',
      '  model: claude-opus-4-7',
      '  instruction: Coordinate roles.',
      '  options:',
      '    maxRoleOutputChars: 4000',
      'roles:',
      ...roles.flatMap((role) => [
        `  - id: ${role}`,
        role === 'reviewer' ? '    adapter: claude' : '    adapter: codex',
        `    instruction: ${role} work.`,
      ]),
      '',
    ].join('\n'),
  );
}
