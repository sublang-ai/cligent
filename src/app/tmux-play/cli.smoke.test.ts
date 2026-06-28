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

    const result = spawnSync(builtBinPath(), ['--help'], {
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
      players: ['coder', 'reviewer'],
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
      players: Array<{ id: string }>;
    };

    expect(snapshot.captain.from).toBe(
      pathToFileURL(join(cwd, 'captains/router.js')).href,
    );
    expect(snapshot.players.map((player) => player.id)).toEqual(['coder', 'reviewer']);
    expect(newSession).toContain('-x');
    expect(valueAfter(newSession, '-x')).toBe('174');
    expect(newSession).toContain('-y');
    expect(valueAfter(newSession, '-y')).toBe('49');
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

  // TTMUX-054: invalid YAML permissions.mode aborts the launcher at the
  // CLI boundary — stderr names the offending path, exit code is nonzero,
  // and the runtime never starts, so no `runtime_error` record can be
  // observable. Uses the fake tmux + glow harness so the test does not
  // depend on real binaries.
  it('rejects invalid permissions.mode with stderr and nonzero exit', () => {
    harness = createHarness();
    const cwd = join(harness.root, 'project');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, 'tmux-play.config.yaml'),
      [
        'captain:',
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

    const result = runCli(['--cwd', cwd], harness);

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain(
      'players[0].permissions.mode must be one of: auto, bypass',
    );
    expect(result.stderr.startsWith('Error: ')).toBe(true);
    // The runtime never starts, so no tmux session is constructed and no
    // runtime_error record is written to stdout.
    expect(readTmuxCalls(harness).some((call) => call[0] === 'new-session')).toBe(
      false,
    );
    expect(result.stdout).not.toContain('runtime_error');
  });

  // TTMUX-064: invalid YAML layout — a decimal columnWeights value — aborts
  // the launcher at the CLI boundary. The TMUX-044 resize hook would
  // interpolate the weight verbatim into POSIX integer-only shell
  // arithmetic, so loader-time rejection prevents a broken `$((…))`
  // expression from ever being emitted. Uses the fake tmux + glow harness
  // so the test does not depend on real binaries.
  it('rejects decimal layout.columnWeights with stderr and nonzero exit', () => {
    harness = createHarness();
    const cwd = join(harness.root, 'project');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, 'tmux-play.config.yaml'),
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

    const result = runCli(['--cwd', cwd], harness);

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain(
      'layout.columnWeights[1] must be a positive integer',
    );
    expect(result.stderr.startsWith('Error: ')).toBe(true);
    expect(readTmuxCalls(harness).some((call) => call[0] === 'new-session')).toBe(
      false,
    );
    expect(result.stdout).not.toContain('runtime_error');
  });

  // TTMUX-058: invalid YAML reasoningEffort aborts the launcher at the
  // CLI boundary before the runtime exists.
  it('rejects invalid reasoningEffort with stderr and nonzero exit', () => {
    harness = createHarness();
    const cwd = join(harness.root, 'project');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, 'tmux-play.config.yaml'),
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

    const result = runCli(['--cwd', cwd], harness);

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain(
      'players[0].reasoningEffort must be one of: minimal, low, medium, high, xhigh, max',
    );
    expect(result.stderr.startsWith('Error: ')).toBe(true);
    expect(readTmuxCalls(harness).some((call) => call[0] === 'new-session')).toBe(
      false,
    );
    expect(result.stdout).not.toContain('runtime_error');
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
          players: [{ id: 'coder', adapter: 'codex' }],
          layout: {
            window: { columns: 174, rows: 49 },
            initialVisible: ['coder'],
            singlePlayerColumnWeights: [1, 1],
            multiPlayerColumnWeights: [1, 1, 1],
            columnWeights: [1, 1],
          },
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

  // TMUX-051 launcher gate now probes glow before loading config. Stub it
  // alongside the fake tmux so launcher-mode smoke flows don't depend on a
  // real glow on the runner; session-mode rendering isn't exercised here.
  const fakeGlow = join(binDir, 'glow');
  writeFileSync(
    fakeGlow,
    [
      '#!/usr/bin/env node',
      "console.log('glow stub');",
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  chmodSync(fakeGlow, 0o755);

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
  return spawnSync(process.execPath, [builtBinPath(), ...args], {
    encoding: 'utf8',
    env: {
      ...harness.env,
      ...env,
    },
    input,
    timeout: 10_000,
  });
}

function builtBinPath(): string {
  const binPath = join(process.cwd(), 'bin/tmux-play.mjs');
  if (!existsSync(binPath)) {
    throw new Error('Missing bin/tmux-play.mjs');
  }
  // The wrapper dynamically imports the compiled CLI; surface a clear error
  // when the build artifact is missing rather than a runtime module-not-found.
  const cliPath = join(process.cwd(), 'dist/app/tmux-play/cli.js');
  if (!existsSync(cliPath)) {
    throw new Error('Missing dist/app/tmux-play/cli.js; run npm run build first');
  }
  return binPath;
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
    readonly players?: readonly string[];
  },
): void {
  const players = options.players ?? ['coder'];
  writeFileSync(
    path,
    [
      'captain:',
      `  from: '${options.captainFrom}'`,
      '  adapter: claude',
      '  model: claude-opus-4-8',
      '  instruction: Coordinate players.',
      '  options: {}',
      'players:',
      ...players.flatMap((player) => [
        `  - id: ${player}`,
        player === 'reviewer' ? '    adapter: claude' : '    adapter: codex',
        `    instruction: ${player} work.`,
      ]),
      '',
    ].join('\n'),
  );
}
