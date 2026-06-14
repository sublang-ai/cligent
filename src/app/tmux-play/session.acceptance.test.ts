// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isGlowAvailable } from '../shared/glow.js';
import { shellQuote } from '../shared/shell.js';
import { isTmuxAvailable } from '../shared/tmux.js';
import { TMUX_PLAY_CONFIG_SNAPSHOT } from './config.js';

// TTMUX-074 (real-tmux clause), verifying TMUX-075: with a real tmux server,
// an attached client, and a Boss turn in flight, pane 0 shows no fresh
// `boss> ` readline prompt line after the turn's streamed Captain output
// between `turn_started` and the turn's terminal record. The session-level
// probe in session.test.ts pins the suspend/restore mechanism over a real
// `createInterface` against a TTY-like pair; this probe closes the
// end-to-end seam — real readline in a real pty inside real tmux, captured
// via `capture-pane`. It self-skips when `tmux`, `glow`, or the
// attached-client driver (`expect`) is unavailable, per the spec.
const TMUX_AVAILABLE = isTmuxAvailable();
const TMUX_SERVER_AVAILABLE = TMUX_AVAILABLE && canCreateTmuxServer();
const GLOW_AVAILABLE = isGlowAvailable();
const EXPECT_AVAILABLE = isCommandAvailable('expect', ['-v']);
// `expect` alone is not enough: a headless CI runner cannot host an attached
// client, so verify a client can actually attach before running the
// attached-client probes — otherwise they fail with "no client attached"
// instead of self-skipping.
const ATTACHED_CLIENT_SUPPORTED = EXPECT_AVAILABLE && canAttachClient();
const probeIt =
  TMUX_SERVER_AVAILABLE && GLOW_AVAILABLE && ATTACHED_CLIENT_SUPPORTED
    ? it
    : it.skip;
const macBellProbeIt =
  process.platform === 'darwin' &&
  TMUX_SERVER_AVAILABLE &&
  GLOW_AVAILABLE &&
  ATTACHED_CLIENT_SUPPORTED
    ? it
    : it.skip;

const BUILT_SESSION_PATH = join(
  process.cwd(),
  'dist/app/tmux-play/session.js',
);

describe('TmuxPlaySession real-tmux prompt-suspension acceptance', () => {
  let sessionName: string | undefined;
  let cwd: string | undefined;
  let workDir: string | undefined;
  let client: ChildProcess | undefined;

  afterEach(() => {
    if (client) {
      client.kill('SIGKILL');
      client = undefined;
    }
    if (sessionName) {
      spawnSync('tmux', ['kill-session', '-t', sessionName], {
        stdio: 'ignore',
      });
      sessionName = undefined;
    }
    for (const dir of [cwd, workDir]) {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    cwd = undefined;
    workDir = undefined;
  });

  probeIt(
    'paints no fresh boss> prompt on pane 0 while a Boss turn is in flight, restoring it once the turn ends (TTMUX-074)',
    async () => {
      if (!existsSync(BUILT_SESSION_PATH)) {
        throw new Error(
          `Missing ${BUILT_SESSION_PATH}; run \`npm run build\` before the acceptance suite.`,
        );
      }

      cwd = mkdtempSync(join(tmpdir(), 'tmux-play-suspend-cwd-'));
      workDir = mkdtempSync(join(tmpdir(), 'tmux-play-suspend-work-'));
      const sessionId = `suspend-${randomBytes(4).toString('hex')}`;
      sessionName = `tmux-play-${sessionId}`;
      const marker = `INFLIGHT${randomBytes(3).toString('hex').toUpperCase()}`;
      const startedPath = join(cwd, 'turn-started');
      const releasePath = join(cwd, 'turn-release');
      const driverPath = join(cwd, 'driver.mjs');

      // The session reads its config from the workDir snapshot. Players are
      // empty (no adapter is ever run) and the Captain is supplied by the
      // driver via importCaptain, so the snapshot's captain.from is a stub.
      writeFileSync(
        join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT),
        JSON.stringify({
          theme: 'mocha',
          layout: { window: { columns: 120, rows: 40 }, columnWeights: [1, 1] },
          captain: { from: 'stub-captain', adapter: 'claude', options: {} },
          players: [],
        }),
      );
      writeFileSync(
        driverPath,
        driverSource({
          sessionUrl: pathToFileURL(BUILT_SESSION_PATH).href,
          sessionId,
          workDir,
          marker,
          startedPath,
          releasePath,
        }),
      );

      // Pane 0 runs the real session over the pane's pty (a real TTY), so the
      // readline runs in terminal mode and echoes the colored `boss> ` chrome.
      runTmux([
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-x',
        '120',
        '-y',
        '40',
        `node ${shellQuote(driverPath)}`,
      ]);
      // Pin the grid so the attached client cannot resize pane 0 out from
      // under the capture assertions.
      runTmux(['set-window-option', '-t', sessionName, 'window-size', 'manual']);
      runTmux(['resize-window', '-t', sessionName, '-x', '120', '-y', '40']);

      // The spec scenario is "with an attached client"; expect is the
      // attached-client driver the skip condition gates on. It holds the
      // client until the session is killed in afterEach.
      client = spawn('expect', ['-c', attachScript(sessionName)], {
        stdio: 'ignore',
      });
      await waitForAttachedClient(sessionName, 5_000);

      // The ready (between-turns) `boss> ` prompt is live on pane 0.
      await waitForPaneContains(sessionName, 0, 'boss>', 5_000);

      // Submit a Boss prompt to open a turn. readline echoes `boss> go`
      // (the submitted-prompt input line per TMUX-037).
      runTmux(['send-keys', '-t', `${sessionName}:0.0`, 'go', 'Enter']);

      // The turn is now in flight: the Captain streamed its status marker to
      // pane 0 and is blocked until the release file appears.
      await waitForNonEmptyFile(startedPath, 5_000);
      await waitForPaneContains(sessionName, 0, marker, 5_000);

      // Buffer type-ahead during the active turn, then force a full readline
      // line refresh — the only path that repaints the prompt chrome. Plain
      // end-of-line insertion just echoes the typed bytes (readline's
      // `_writeToOutput`, not `_refreshLine`), so it never repaints `boss> `
      // and would not discriminate. A trailing sentinel byte deleted with
      // Backspace drives `_refreshLine`, which redraws `<prompt> + <buffer>`:
      // without TMUX-075 that is `boss> <buffer>` amid the streamed output;
      // with the prompt suspended it is just `<buffer>`, so no fresh `boss> `
      // line reaches the pane.
      const typeahead = `TYPED${randomBytes(3).toString('hex').toUpperCase()}`;
      runTmux(['send-keys', '-t', `${sessionName}:0.0`, `${typeahead}X`]);
      await waitForPaneContains(sessionName, 0, `${typeahead}X`, 5_000);
      runTmux(['send-keys', '-t', `${sessionName}:0.0`, 'BSpace']);
      const inflight = await waitForPaneMatch(
        sessionName,
        0,
        (text) => {
          const plain = stripAnsi(text);
          return plain.includes(typeahead) && !plain.includes(`${typeahead}X`);
        },
        5_000,
      );

      // TMUX-075: after the streamed Captain output, no fresh `boss> ` prompt
      // line is painted while the turn is active. The submitted-prompt echo
      // line that opened the turn sits before the marker and is unaffected.
      const inflightPlain = stripAnsi(inflight);
      const afterMarker = inflightPlain.slice(inflightPlain.indexOf(marker));
      expect(afterMarker).not.toContain('boss>');
      expect(inflightPlain).toContain('boss> go');

      // End the turn; the suspended prompt is restored exactly once, with the
      // type-ahead preserved per TMUX-057 and surfaced on the restored prompt.
      writeFileSync(releasePath, 'release');
      const restored = await waitForPaneMatch(
        sessionName,
        0,
        (text) => {
          const plain = stripAnsi(text);
          const index = plain.indexOf(marker);
          return index !== -1 && plain.slice(index).includes('boss>');
        },
        5_000,
      );
      const restoredPlain = stripAnsi(restored);
      const restoredAfterMarker = restoredPlain.slice(
        restoredPlain.indexOf(marker),
      );
      // Exactly one restored prompt after the marker, carrying the type-ahead
      // buffered during the turn on the same line per TMUX-057.
      expect(restoredAfterMarker.match(/boss>/g) ?? []).toHaveLength(1);
      expect(restoredAfterMarker).toContain(`boss> ${typeahead}`);
    },
    60_000,
  );

  macBellProbeIt(
    'raises a real tmux bell when the macOS turn-finished desktop notification fires (TTMUX-076)',
    async () => {
      if (!existsSync(BUILT_SESSION_PATH)) {
        throw new Error(
          `Missing ${BUILT_SESSION_PATH}; run \`npm run build\` before the acceptance suite.`,
        );
      }

      cwd = mkdtempSync(join(tmpdir(), 'tmux-play-bell-cwd-'));
      workDir = mkdtempSync(join(tmpdir(), 'tmux-play-bell-work-'));
      const sessionId = `bell-${randomBytes(4).toString('hex')}`;
      sessionName = `tmux-play-${sessionId}`;
      const marker = `BELL${randomBytes(3).toString('hex').toUpperCase()}`;
      const startedPath = join(cwd, 'turn-started');
      const releasePath = join(cwd, 'turn-release');
      const bellPath = join(cwd, 'tmux-alert-bell');
      const fakeBin = join(cwd, 'bin');
      const driverPath = join(cwd, 'driver.mjs');

      mkdirSync(fakeBin);
      writeExecutable(join(fakeBin, 'osascript'), '#!/bin/sh\nexit 0\n');
      writeFileSync(
        join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT),
        JSON.stringify({
          theme: 'mocha',
          layout: { window: { columns: 120, rows: 40 }, columnWeights: [1, 1] },
          notifications: {
            player_finished: 'off',
            turn_finished: 'desktop',
            turn_aborted: 'off',
          },
          captain: { from: 'stub-captain', adapter: 'claude', options: {} },
          players: [],
        }),
      );
      writeFileSync(
        driverPath,
        driverSource({
          sessionUrl: pathToFileURL(BUILT_SESSION_PATH).href,
          sessionId,
          workDir,
          marker,
          startedPath,
          releasePath,
        }),
      );

      runTmux([
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-x',
        '120',
        '-y',
        '40',
        `PATH=${shellQuote(`${fakeBin}:${process.env.PATH ?? ''}`)} node ${shellQuote(driverPath)}`,
      ]);
      runTmux(['set-window-option', '-t', sessionName, 'window-size', 'manual']);
      runTmux(['resize-window', '-t', sessionName, '-x', '120', '-y', '40']);
      runTmux(['set-window-option', '-t', sessionName, 'monitor-bell', 'on']);
      runTmux(['set-option', '-t', sessionName, 'visual-bell', 'off']);
      runTmux(['set-option', '-t', sessionName, 'bell-action', 'any']);
      runTmux([
        'set-hook',
        '-t',
        sessionName,
        'alert-bell',
        `run-shell ${shellQuote(`printf bell > ${shellQuote(bellPath)}`)}`,
      ]);

      client = spawn('expect', ['-c', attachScript(sessionName)], {
        stdio: 'ignore',
      });
      await waitForAttachedClient(sessionName, 5_000);
      await waitForPaneContains(sessionName, 0, 'boss>', 5_000);

      runTmux(['send-keys', '-t', `${sessionName}:0.0`, 'go', 'Enter']);
      await waitForNonEmptyFile(startedPath, 5_000);
      await waitForPaneContains(sessionName, 0, marker, 5_000);

      writeFileSync(releasePath, 'release');
      await waitForNonEmptyFile(bellPath, 5_000);
    },
    60_000,
  );
});

interface DriverParams {
  readonly sessionUrl: string;
  readonly sessionId: string;
  readonly workDir: string;
  readonly marker: string;
  readonly startedPath: string;
  readonly releasePath: string;
}

// A standalone ESM driver run as the pane-0 process. It constructs the real
// TmuxPlaySession with a stub Captain that emits one `captain_status` marker
// (rendered to the Boss pane as `captain> [status] <marker>`) and then blocks
// the turn until the release file appears, holding the turn in flight while
// the test captures pane 0.
function driverSource(params: DriverParams): string {
  return [
    `import { TmuxPlaySession } from ${JSON.stringify(params.sessionUrl)};`,
    `import fs from 'node:fs';`,
    ``,
    `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));`,
    `let captainSession;`,
    `const captain = {`,
    `  async init(session) {`,
    `    captainSession = session;`,
    `  },`,
    `  async handleBossTurn() {`,
    `    await captainSession.emitStatus(${JSON.stringify(params.marker)});`,
    `    fs.writeFileSync(${JSON.stringify(params.startedPath)}, 'started');`,
    `    while (!fs.existsSync(${JSON.stringify(params.releasePath)})) {`,
    `      await sleep(50);`,
    `    }`,
    `  },`,
    `};`,
    `class StubAdapter {`,
    `  agent = 'claude-code';`,
    `  async *run() {}`,
    `  async isAvailable() {`,
    `    return true;`,
    `  }`,
    `}`,
    `const adapterImports = {`,
    `  claude: async () => StubAdapter,`,
    `  codex: async () => StubAdapter,`,
    `  gemini: async () => StubAdapter,`,
    `  opencode: async () => StubAdapter,`,
    `};`,
    `const session = new TmuxPlaySession({`,
    `  sessionId: ${JSON.stringify(params.sessionId)},`,
    `  workDir: ${JSON.stringify(params.workDir)},`,
    `  importCaptain: async () => ({ default: () => captain }),`,
    `  adapterImports,`,
    `  queryPaneWidths: () => new Map(),`,
    `  killSession: () => {},`,
    `  removeWorkDir: () => {},`,
    `});`,
    `await session.run();`,
    ``,
  ].join('\n');
}

function attachScript(session: string): string {
  return [
    `spawn tmux attach-session -t ${session}`,
    'set timeout -1',
    'expect eof',
  ].join('\n');
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
}

function runTmux(args: readonly string[]): void {
  const result = spawnSync('tmux', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`tmux ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function capturePane(session: string, paneIndex: number): string {
  const result = spawnSync(
    'tmux',
    ['capture-pane', '-t', `${session}:0.${paneIndex}`, '-p'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tmux capture-pane failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function isCommandAvailable(cmd: string, args: readonly string[]): boolean {
  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

function canCreateTmuxServer(): boolean {
  const session = `tmux-play-probe-${randomBytes(4).toString('hex')}`;
  const created = spawnSync(
    'tmux',
    ['new-session', '-d', '-s', session, 'sleep 2'],
    { encoding: 'utf8' },
  );
  if (
    created.error ||
    created.status !== 0 ||
    created.stderr.trim().length > 0
  ) {
    spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
    return false;
  }

  const controlled = spawnSync(
    'tmux',
    ['set-window-option', '-t', session, 'window-size', 'manual'],
    { encoding: 'utf8' },
  );
  spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  return (
    controlled.error === undefined &&
    controlled.status === 0 &&
    controlled.stderr.trim().length === 0
  );
}

// Whether an interactive tmux client can actually attach in this environment.
// `expect` being installed is necessary but not sufficient: a headless CI
// runner has no controlling terminal for a client, so the `expect`-driven
// attach never registers a client (`list-clients` stays empty) and the
// attached-client probes would FAIL with "no client attached" rather than
// meaningfully run. Drive a throwaway `expect` attach against a private-socket
// session and confirm a client registers, polling briefly so a slow-but-
// working attach is not mistaken for an unattachable one. Skip the
// attached-client probes when this returns false.
function canAttachClient(): boolean {
  const name = `tmux-play-attach-${randomBytes(4).toString('hex')}`;
  const env = process.env;
  const create = spawnSync(
    'tmux',
    ['-L', name, '-f', '/dev/null', 'new-session', '-d', '-s', name, 'sleep 10'],
    { encoding: 'utf8', env },
  );
  if (create.error || create.status !== 0) {
    spawnSync('tmux', ['-L', name, 'kill-server'], { stdio: 'ignore', env });
    return false;
  }
  try {
    const script = [
      `spawn -noecho tmux -L ${name} attach-session -t ${name}`,
      'set ok 0',
      'for {set i 0} {$i < 30} {incr i} {',
      '  after 100',
      `  if {![catch {exec tmux -L ${name} list-clients -t ${name} -F connected} out] && [string match *connected* $out]} {`,
      '    set ok 1',
      '    break',
      '  }',
      '}',
      'send_user "ATTACH_PROBE=$ok\\n"',
      `catch {exec tmux -L ${name} detach-client -s ${name}}`,
      'expect eof',
    ].join('\n');
    const result = spawnSync('expect', ['-c', script], {
      encoding: 'utf8',
      timeout: 8_000,
    });
    return !result.error && /ATTACH_PROBE=1/.test(result.stdout ?? '');
  } catch {
    return false;
  } finally {
    spawnSync('tmux', ['-L', name, 'kill-server'], { stdio: 'ignore', env });
  }
}

async function waitForAttachedClient(
  session: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = spawnSync(
      'tmux',
      ['list-clients', '-t', session, '-F', '#{client_tty}'],
      { encoding: 'utf8' },
    );
    if (result.status === 0 && result.stdout.trim().length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no client attached to ${session} within ${timeoutMs}ms`);
}

async function waitForPaneContains(
  session: string,
  paneIndex: number,
  needle: string,
  timeoutMs: number,
): Promise<string> {
  return waitForPaneMatch(
    session,
    paneIndex,
    (text) => stripAnsi(text).includes(needle),
    timeoutMs,
    `pane ${paneIndex} did not show ${needle}`,
  );
}

async function waitForPaneMatch(
  session: string,
  paneIndex: number,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  describePredicate = `pane ${paneIndex} did not reach the expected state`,
): Promise<string> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = capturePane(session, paneIndex);
    if (predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `${describePredicate} within ${timeoutMs}ms; last capture:\n${last}`,
  );
}

async function waitForNonEmptyFile(
  path: string,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf8');
      if (content.length > 0) {
        return content;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${path} was not written within ${timeoutMs}ms`);
}
