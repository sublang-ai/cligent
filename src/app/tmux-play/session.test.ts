// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Captain, RunTmuxPlayOptions } from './contract.js';
import { TMUX_PLAY_CONFIG_SNAPSHOT } from './config.js';
import { TMUX_PLAY_SESSION_MARKER } from './launcher.js';
import { ObserverDispatchError, type TmuxPlayRecord } from './records.js';
import {
  readConfigSnapshot,
  TmuxPlaySession,
  type TmuxPlaySessionOptions,
} from './session.js';
import type { TimingObserverHandle } from './timing-observer.js';

class FakeReadline extends EventEmitter {
  promptCount = 0;
  promptValue = '';

  setPrompt(prompt: string): void {
    this.promptValue = prompt;
  }

  prompt(): void {
    this.promptCount += 1;
  }

  close(): void {
    this.emit('close');
  }

  emitLine(line: string): void {
    this.emit('line', line);
  }
}

class MemoryOutput extends Writable {
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(String(chunk));
    callback();
  }

  text(): string {
    return this.chunks.join('');
  }
}

class TtyInput extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }
}

class TtyOutput extends MemoryOutput {
  isTTY = true;
  columns = 80;
}

class SignalHub extends EventEmitter {
  override on(
    event: 'SIGINT' | 'SIGTERM',
    listener: () => void,
  ): this {
    return super.on(event, listener);
  }

  override off(
    event: 'SIGINT' | 'SIGTERM',
    listener: () => void,
  ): this {
    return super.off(event, listener);
  }
}

describe('TmuxPlaySession', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.useRealTimers();
    if (tempDir) {
      removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('reads the config snapshot without reloading user config', async () => {
    tempDir = makeWorkDir();

    await expect(readConfigSnapshot(tempDir)).resolves.toMatchObject({
      captain: {
        from: '@sublang/cligent/captains/fanout',
      },
      players: [{ id: 'coder' }],
    });
  });

  it('imports the Captain, registers tmux presenter, and runs lines', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const output = new MemoryOutput();
    const runBossTurn = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const abortActiveTurn = vi.fn();
    const optInObserver = { onRecord: vi.fn() };
    const timingObserver = noopTimingObserver();
    const createTimingObserver = vi.fn(() => timingObserver);
    const createRuntime = vi.fn(async (_options: RunTmuxPlayOptions) => ({
      abortActiveTurn,
      dispose,
      runBossTurn,
    }));
    const factory = vi.fn((options: unknown): Captain => {
      expect(options).toEqual({ tone: 'direct' });
      return {
        async handleBossTurn() {
          // no-op
        },
      };
    });

    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      createReadline: () => readline,
      createRuntime,
      createTimingObserver,
      importCaptain: async () => ({ default: factory }),
      observers: [optInObserver],
      output,
    });

    await session.start();

    // TMUX-038: boss> prefix wrapped in blue SGR (#89b4fa) and reset.
    expect(readline.promptValue).toBe('\x1b[1;38;2;137;180;250mboss> \x1b[0m');
    expect(readline.promptCount).toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(createTimingObserver).toHaveBeenCalledWith({
      sessionName: 'tmux-play-abc123',
      captainAdapter: 'claude',
      players: [expect.objectContaining({ id: 'coder', adapter: 'codex' })],
    });
    expect(timingObserver.refresh).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        captainConfig: expect.objectContaining({
          adapter: 'claude',
          instruction: 'Coordinate players.',
          reasoningEffort: 'high',
        }),
        cwd: '/repo',
        observers: expect.arrayContaining([
          expect.any(Object),
          timingObserver,
          optInObserver,
        ]),
        players: [expect.objectContaining({ id: 'coder', reasoningEffort: 'low' })],
      }),
    );
    expect(createRuntime.mock.calls[0]?.[0].observers).toEqual([
      expect.any(Object),
      timingObserver,
      optInObserver,
    ]);

    readline.emitLine('  build it  ');
    await Promise.resolve();
    await Promise.resolve();

    expect(runBossTurn).toHaveBeenCalledWith('build it');
    expect(readline.promptCount).toBe(2);

    readline.emitLine('   ');
    expect(readline.promptCount).toBe(3);
  });

  it('cleans up runtime, work dir, and tmux session on EOF', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const dispose = vi.fn(async () => undefined);
    const abortActiveTurn = vi.fn();
    const timingObserver = noopTimingObserver();
    const killSession = vi.fn();
    const removeWorkDir = vi.fn();
    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      createReadline: () => readline,
      createRuntime: async () => ({
        abortActiveTurn,
        dispose,
        runBossTurn: async () => undefined,
      }),
      createTimingObserver: () => timingObserver,
      importCaptain: async () => ({ default: () => captain() }),
      killSession,
      removeWorkDir,
    });

    await session.start();
    readline.close();
    await session.done;

    expect(abortActiveTurn).toHaveBeenCalledWith('EOF');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(timingObserver.dispose).toHaveBeenCalledTimes(1);
    expect(removeWorkDir).toHaveBeenCalledWith(tempDir);
    expect(killSession).toHaveBeenCalledWith('tmux-play-abc123');
  });

  it('continues cleanup when runtime disposal fails', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const dispose = vi.fn(async () => {
      throw new Error('dispose failed');
    });
    const killSession = vi.fn();
    const removeWorkDir = vi.fn();
    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      createReadline: () => readline,
      createRuntime: async () => ({
        abortActiveTurn: vi.fn(),
        dispose,
        runBossTurn: async () => undefined,
      }),
      importCaptain: async () => ({ default: () => captain() }),
      killSession,
      removeWorkDir,
    });

    await session.start();
    readline.close();
    await expect(session.done).rejects.toThrow('dispose failed');

    expect(removeWorkDir).toHaveBeenCalledWith(tempDir);
    expect(killSession).toHaveBeenCalledWith('tmux-play-abc123');
  });

  it('does not duplicate non-observer runtime errors in the Boss pane', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const output = new MemoryOutput();
    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      createReadline: () => readline,
      createRuntime: async () => ({
        abortActiveTurn: vi.fn(),
        dispose: async () => undefined,
        runBossTurn: async () => {
          throw new Error('captain failed');
        },
      }),
      importCaptain: async () => ({ default: () => captain() }),
      output,
    });

    await session.start();
    readline.emitLine('fail');
    await Promise.resolve();
    await Promise.resolve();

    expect(output.text()).not.toContain('[runtime error: captain failed]');
  });

  it('renders observer dispatch failures that bypass tmux presenter records', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const output = new MemoryOutput();
    const error = new ObserverDispatchError(
      {
        type: 'turn_started',
        turnId: 1,
        timestamp: 100,
        turn: {
          id: 1,
          prompt: 'fail',
          timestamp: 100,
        },
      },
      0,
      new Error('observer failed'),
    );
    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      createReadline: () => readline,
      createRuntime: async () => ({
        abortActiveTurn: vi.fn(),
        dispose: async () => undefined,
        runBossTurn: async () => {
          throw error;
        },
      }),
      importCaptain: async () => ({ default: () => captain() }),
      output,
    });

    await session.start();
    readline.emitLine('fail');
    await Promise.resolve();
    await Promise.resolve();

    expect(output.text()).toContain(
      'captain> [runtime error: Record observer 0 failed while handling turn_started: observer failed]',
    );
  });

  it('refreshes player pane widths on terminal resize and unsubscribes on shutdown', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const output = new MemoryOutput();
    const queryPaneWidths = vi.fn(
      () => new Map<string, number>([['Coder · codex', 40]]),
    );
    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      createReadline: () => readline,
      createRuntime: async () => ({
        abortActiveTurn: vi.fn(),
        dispose: async () => undefined,
        runBossTurn: async () => undefined,
      }),
      importCaptain: async () => ({ default: () => captain() }),
      output,
      queryPaneWidths,
    });

    await session.start();
    expect(queryPaneWidths).toHaveBeenCalledTimes(1);

    output.emit('resize');
    expect(queryPaneWidths).toHaveBeenCalledTimes(2);

    readline.close();
    await session.done;

    output.emit('resize');
    expect(queryPaneWidths).toHaveBeenCalledTimes(2);
  });

  it('handles SIGINT by closing the readline session', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const signals = new SignalHub();
    const dispose = vi.fn(async () => undefined);
    const abortActiveTurn = vi.fn();
    const killSession = vi.fn();
    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      createReadline: () => readline,
      createRuntime: async () => ({
        abortActiveTurn,
        dispose,
        runBossTurn: async () => undefined,
      }),
      importCaptain: async () => ({ default: () => captain() }),
      killSession,
      removeWorkDir: vi.fn(),
      signalTarget: signals,
    });

    await session.start();
    signals.emit('SIGINT');
    await session.done;

    expect(abortActiveTurn).toHaveBeenCalledWith('SIGINT');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(killSession).toHaveBeenCalledWith('tmux-play-abc123');
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('aborts an active turn on bare ESC without treating arrow keys as aborts', async () => {
    tempDir = makeWorkDir();
    const input = new TtyInput();
    const output = new TtyOutput();
    const records: TmuxPlayRecord[] = [];
    const firstAbort = deferred<void>();
    const abortActiveTurn = vi.fn((reason?: string) => {
      if (reason === 'ESC') {
        firstAbort.resolve();
      }
    });
    const runBossTurn = vi.fn(async (prompt: string) => {
      if (prompt !== 'first') {
        return;
      }

      await firstAbort.promise;
      const record: TmuxPlayRecord = {
        type: 'turn_aborted',
        turnId: 1,
        timestamp: 100,
        reason: 'ESC',
      };
      records.push(record);
      const runtimeOptions = createRuntime.mock.calls[0]?.[0];
      for (const observer of runtimeOptions?.observers ?? []) {
        await observer.onRecord(record);
      }
    });
    const createRuntime = vi.fn(async (_options: RunTmuxPlayOptions) => ({
      abortActiveTurn,
      dispose: vi.fn(async () => undefined),
      runBossTurn,
    }));
    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      input,
      output,
      createRuntime,
      importCaptain: async () => ({ default: () => captain() }),
    });

    await session.start();
    input.write('\x1b[A');
    await delay(READLINE_ESCAPE_CODE_TIMEOUT_MS + 20);
    expect(abortActiveTurn).not.toHaveBeenCalled();

    input.write('first\n');
    await waitUntil(() => runBossTurn.mock.calls.length === 1);
    input.write('retained');
    input.write('\x1b');
    await delay(READLINE_ESCAPE_CODE_TIMEOUT_MS + 20);
    await waitUntil(() => records.some((record) => record.type === 'turn_aborted'));

    expect(abortActiveTurn).toHaveBeenCalledTimes(1);
    expect(abortActiveTurn).toHaveBeenCalledWith('ESC');
    expect(records).toEqual([
      expect.objectContaining({ type: 'turn_aborted', reason: 'ESC' }),
    ]);
    expect(output.text()).toContain('[turn aborted: ESC]');
    expect(output.text()).not.toContain('[runtime error:');

    input.write('\n');
    await waitUntil(() => runBossTurn.mock.calls.length === 2);
    expect(runBossTurn.mock.calls.map((call) => call[0])).toEqual([
      'first',
      'retained',
    ]);

    input.end();
    await session.done;
  });

  it('submits bracketed multi-line paste as one prompt and toggles paste mode only for TTY output', async () => {
    tempDir = makeWorkDir();
    const input = new TtyInput();
    const output = new TtyOutput();
    const runBossTurn = vi.fn(async () => undefined);
    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      input,
      output,
      createRuntime: async () => ({
        abortActiveTurn: vi.fn(),
        dispose: vi.fn(async () => undefined),
        runBossTurn,
      }),
      importCaptain: async () => ({ default: () => captain() }),
    });

    await session.start();
    expect(output.text()).toContain(BRACKETED_PASTE_ENABLE);

    input.write('\x1b[200~Alpha\nBravo\nCharlie\x1b[201~\n');
    await waitUntil(() => runBossTurn.mock.calls.length === 1);
    input.write('\x1b[200~Alpha\nBravo\n\x1b[201~\n');
    await waitUntil(() => runBossTurn.mock.calls.length === 2);
    input.write('\x1b[200~Alpha\nBravo\x1b[201~-extra\n');
    await waitUntil(() => runBossTurn.mock.calls.length === 3);

    expect(runBossTurn.mock.calls.map((call) => call[0])).toEqual([
      'Alpha\nBravo\nCharlie',
      'Alpha\nBravo',
      'Alpha\nBravo-extra',
    ]);

    input.end();
    await session.done;
    expect(output.text()).toContain(BRACKETED_PASTE_DISABLE);
    removeTempDir(tempDir);
    tempDir = undefined;

    tempDir = makeWorkDir();
    const nonTtyInput = new TtyInput();
    const nonTtyOutput = new MemoryOutput();
    const nonTtyRunBossTurn = vi.fn(async () => undefined);
    const nonTtySession = new TmuxPlaySession({
      ...baseOptions(tempDir),
      input: nonTtyInput,
      output: nonTtyOutput,
      createRuntime: async () => ({
        abortActiveTurn: vi.fn(),
        dispose: vi.fn(async () => undefined),
        runBossTurn: nonTtyRunBossTurn,
      }),
      importCaptain: async () => ({ default: () => captain() }),
    });

    await nonTtySession.start();
    nonTtyInput.write('Alpha\nBravo\n');
    await waitUntil(() => nonTtyRunBossTurn.mock.calls.length === 2);

    expect(nonTtyOutput.text()).not.toContain(BRACKETED_PASTE_ENABLE);
    expect(nonTtyRunBossTurn.mock.calls.map((call) => call[0])).toEqual([
      'Alpha',
      'Bravo',
    ]);

    nonTtyInput.end();
    await nonTtySession.done;
    expect(nonTtyOutput.text()).not.toContain(BRACKETED_PASTE_DISABLE);
  });
});

const READLINE_ESCAPE_CODE_TIMEOUT_MS = 100;
const BRACKETED_PASTE_ENABLE = '\x1b[?2004h';
const BRACKETED_PASTE_DISABLE = '\x1b[?2004l';

function baseOptions(workDir: string): TmuxPlaySessionOptions {
  return {
    sessionId: 'abc123',
    workDir,
    cwd: '/repo',
    input: process.stdin,
    output: new MemoryOutput(),
    killSession: vi.fn(),
    removeWorkDir: vi.fn(),
    signalTarget: new SignalHub(),
    createTimingObserver: () => noopTimingObserver(),
  };
}

function removeTempDir(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  });
}

function noopTimingObserver(): TimingObserverHandle {
  return {
    onRecord: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeWorkDir(): string {
  const workDir = mkdtempSync(join(tmpdir(), 'cligent-session-'));
  writeFileSync(join(workDir, TMUX_PLAY_SESSION_MARKER), 'abc123');
  writeFileSync(
    join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT),
    JSON.stringify({
      captain: {
        from: '@sublang/cligent/captains/fanout',
        adapter: 'claude',
        instruction: 'Coordinate players.',
        reasoningEffort: 'high',
        options: { tone: 'direct' },
      },
      players: [
        {
          id: 'coder',
          adapter: 'codex',
          reasoningEffort: 'low',
        },
      ],
    }),
  );
  return workDir;
}

async function waitUntil(
  predicate: () => boolean,
  attempts = 20,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('condition was not met');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function captain(): Captain {
  return {
    async handleBossTurn() {
      // no-op
    },
  };
}
