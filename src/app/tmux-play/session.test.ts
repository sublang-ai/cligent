// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Captain, RunTmuxPlayOptions } from './contract.js';
import { TMUX_PLAY_CONFIG_SNAPSHOT } from './config.js';
import { TMUX_PLAY_SESSION_MARKER } from './launcher.js';
import { ObserverDispatchError } from './records.js';
import {
  readConfigSnapshot,
  TmuxPlaySession,
  type TmuxPlaySessionOptions,
} from './session.js';

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
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('reads the config snapshot without reloading user config', async () => {
    tempDir = makeWorkDir();

    await expect(readConfigSnapshot(tempDir)).resolves.toMatchObject({
      captain: {
        from: '@sublang/cligent/captains/fanout',
      },
      roles: [{ id: 'coder' }],
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
      importCaptain: async () => ({ default: factory }),
      observers: [optInObserver],
      output,
    });

    await session.start();

    expect(readline.promptValue).toBe('boss> ');
    expect(readline.promptCount).toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        captainConfig: expect.objectContaining({
          adapter: 'claude',
          instruction: 'Coordinate roles.',
        }),
        cwd: '/repo',
        observers: expect.arrayContaining([expect.any(Object), optInObserver]),
        roles: [expect.objectContaining({ id: 'coder' })],
      }),
    );
    expect(createRuntime.mock.calls[0]?.[0].observers).toEqual([
      expect.any(Object),
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
      importCaptain: async () => ({ default: () => captain() }),
      killSession,
      removeWorkDir,
    });

    await session.start();
    readline.close();
    await session.done;

    expect(abortActiveTurn).toHaveBeenCalledWith('EOF');
    expect(dispose).toHaveBeenCalledTimes(1);
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
});

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
        instruction: 'Coordinate roles.',
        options: { tone: 'direct' },
      },
      roles: [
        {
          id: 'coder',
          adapter: 'codex',
        },
      ],
    }),
  );
  return workDir;
}

function captain(): Captain {
  return {
    async handleBossTurn() {
      // no-op
    },
  };
}
