// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Captain, RunTmuxPlayOptions } from './contract.js';
import { TMUX_PLAY_CONFIG_SNAPSHOT } from './config.js';
import { TMUX_PLAY_WORK_DIR_OWNER_MARKER } from './launcher.js';
import { ObserverDispatchError, type TmuxPlayRecord } from './records.js';
import {
  readConfigSnapshot,
  runManagedTmuxPlaySession,
  runTmuxPlaySession,
  TmuxPlaySession,
  type ManagedTmuxPlayLifecycle,
  type TmuxPlaySessionOptions,
} from './session.js';
import { TmuxPresenter } from './presenter-tmux.js';
import { FollowObserver } from './follow-observer.js';
import { NotificationObserver } from './notification-observer.js';
import { LayoutObserver } from './layout-observer.js';
import type { TimingObserverHandle } from './timing-observer.js';
import {
  isOrchestratorInTmux,
  setOrchestratorTmuxEnv,
} from '../shared/tmux.js';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

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
    event: 'SIGHUP' | 'SIGINT' | 'SIGTERM',
    listener: () => void,
  ): this {
    return super.on(event, listener);
  }

  override off(
    event: 'SIGHUP' | 'SIGINT' | 'SIGTERM',
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
    tempDir = makeWorkDir({ captainFastMode: false, playerFastMode: true });
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

    // tmux-play-37: boss> prefix wrapped in blue SGR (#89b4fa) and reset.
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
          effort: 'ultracode',
          fastMode: false,
        }),
        cwd: '/repo',
        observers: expect.arrayContaining([
          expect.any(Object),
          timingObserver,
          optInObserver,
        ]),
        players: [
          expect.objectContaining({
            id: 'coder',
            effort: 'ultra',
            fastMode: true,
          }),
        ],
      }),
    );
    // Order: the tmux-play-83 layout observer first, then the presenter, the
    // tmux-play-69 follow observer (constructed internally), timing, notifications,
    // and finally any opt-in observers. The concrete-type slots are pinned (not
    // `expect.any(Object)`), so swapping these display-side observers fails
    // here.
    expect(createRuntime.mock.calls[0]?.[0].observers).toEqual([
      expect.any(LayoutObserver),
      expect.any(TmuxPresenter),
      expect.any(FollowObserver),
      timingObserver,
      expect.any(NotificationObserver),
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

  it('colors the boss> prompt with the snapshot-resolved Latte blue', async () => {
    // tmux-play-37 + tmux-play-194: when the snapshot's `theme` is `latte` the
    // readline prompt shall render in Latte `speakerBoss` (#1e66f5 / RGB
    // 30,102,245), not the Mocha default. Mirrors the Mocha assertion
    // above so a regression in either direction surfaces here.
    tempDir = makeWorkDir({ theme: 'latte' });
    const readline = new FakeReadline();
    const output = new MemoryOutput();
    const runBossTurn = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const abortActiveTurn = vi.fn();
    const timingObserver = noopTimingObserver();
    const createTimingObserver = vi.fn(() => timingObserver);
    const createRuntime = vi.fn(async (_options: RunTmuxPlayOptions) => ({
      abortActiveTurn,
      dispose,
      runBossTurn,
    }));
    const factory = vi.fn((): Captain => ({
      async handleBossTurn() {
        // no-op
      },
    }));

    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      createReadline: () => readline,
      createRuntime,
      createTimingObserver,
      importCaptain: async () => ({ default: factory }),
      output,
    });

    await session.start();

    expect(readline.promptValue).toBe('\x1b[1;38;2;30;102;245mboss> \x1b[0m');
    expect(readline.promptCount).toBe(1);

    readline.close();
    await session.done;
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

    // Per tmux-play-39 the bracketed tag is `[runtime error]` with the message
    // outside the brackets; assert the new form doesn't appear either so a
    // regression that re-emits a runtime_error via the bypass path is caught.
    expect(output.text()).not.toContain('[runtime error] captain failed');
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

    // Per tmux-play-39 unified grammar: bracketed tag is `[runtime error]` with
    // the message in the body outside the brackets.
    expect(output.text()).toContain(
      'captain> [runtime error] Record observer 0 failed while handling turn_started: observer failed',
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

  it.each(['SIGHUP', 'SIGINT'] as const)(
    'handles %s by closing the readline session',
    async (signal) => {
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
      signals.emit(signal);
      await session.done;

      expect(abortActiveTurn).toHaveBeenCalledWith(signal);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(killSession).toHaveBeenCalledWith('tmux-play-abc123');
      expect(signals.listenerCount('SIGHUP')).toBe(0);
      expect(signals.listenerCount('SIGINT')).toBe(0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    },
  );

  it.each([
    ['not authorized', false, 'abc123'],
    ['missing marker', true, undefined],
    ['mismatched marker', true, 'another-session'],
  ] as const)(
    'preserves a caller-owned work directory when ownership is %s',
    async (_label, authorized, owner) => {
      tempDir = makeWorkDir();
      const ownerPath = join(tempDir, TMUX_PLAY_WORK_DIR_OWNER_MARKER);
      if (owner === undefined) {
        rmSync(ownerPath);
      } else {
        writeFileSync(ownerPath, owner);
      }
      const sentinelPath = join(tempDir, 'caller-sentinel');
      writeFileSync(sentinelPath, 'keep');
      const readline = new FakeReadline();
      const removeWorkDir = vi.fn();
      const session = new TmuxPlaySession({
        ...baseOptions(tempDir),
        workDirOwnedByLauncher: authorized,
        createReadline: () => readline,
        createRuntime: async () => ({
          abortActiveTurn: vi.fn(),
          dispose: vi.fn(),
          runBossTurn: vi.fn(),
        }),
        importCaptain: async () => ({ default: () => captain() }),
        removeWorkDir,
      });

      await session.start();
      readline.close();
      await session.done;

      expect(removeWorkDir).not.toHaveBeenCalled();
      expect(existsSync(sentinelPath)).toBe(true);
    },
  );

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
    await waitUntil(() =>
      records.some((record) => record.type === 'turn_aborted'),
    );

    expect(abortActiveTurn).toHaveBeenCalledTimes(1);
    expect(abortActiveTurn).toHaveBeenCalledWith('ESC');
    expect(records).toEqual([
      expect.objectContaining({ type: 'turn_aborted', reason: 'ESC' }),
    ]);
    // Per tmux-play-39 unified grammar: bracketed tag `[turn aborted]` carries
    // the yellow outcome SGR span, then a `\x1b[0m` reset, then the reason
    // `ESC` sits outside the brackets unstyled. The reset bytes separate
    // the closing `]` from the space + `ESC`, so we strip ANSI before
    // asserting the visible content is contiguous.
    const visible = output.text().replace(/\x1B\[[0-9;]*m/g, '');
    expect(visible).toContain('[turn aborted] ESC');
    expect(visible).not.toContain('[runtime error]');
    expect(visible).not.toContain('[turn aborted:');

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

  // tmux-play-174: while a Boss turn is in flight, the live readline prompt is
  // suspended so type-ahead paints no fresh `boss> ` line into the pane amid
  // the streamed Captain output; the colored prompt is restored exactly once
  // at turn end and the buffered type-ahead surfaces as one runBossTurn on the
  // next Enter. A stubbed readline does not echo prompt chrome and would pass
  // vacuously, so the probe drives a real `createInterface` over a TTY pair (as
  // the tmux-play-159 ESC probe does), wrapping only `prompt` with a call-through
  // spy to count restorations.
  it('suspends the boss> prompt during an active turn and restores it once for typed type-ahead', async () => {
    tempDir = makeWorkDir();
    const input = new TtyInput();
    const output = new TtyOutput();
    const turnBlock = deferred<void>();
    const runBossTurn = vi.fn(async (prompt: string) => {
      if (prompt !== 'first') {
        return;
      }
      // Stream a Captain `captain> ` line into the Boss/Captain pane. A
      // captain_status line bypasses glow (tmux-play-50) yet still routes to the
      // boss writer per tmux-play-40, standing in for streamed Captain output.
      const runtimeOptions = createRuntime.mock.calls[0]?.[0];
      for (const observer of runtimeOptions?.observers ?? []) {
        await observer.onRecord({
          type: 'captain_status',
          turnId: 1,
          timestamp: 100,
          message: 'WORKING',
        });
      }
      await turnBlock.promise;
    });
    const createRuntime = vi.fn(async (_options: RunTmuxPlayOptions) => ({
      abortActiveTurn: vi.fn(),
      dispose: vi.fn(async () => undefined),
      runBossTurn,
    }));
    let promptSpy: ReturnType<typeof vi.spyOn> | undefined;
    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      input,
      output,
      createRuntime,
      importCaptain: async () => ({ default: () => captain() }),
      createReadline: (options) => {
        const realInterface = createInterface(options);
        promptSpy = vi.spyOn(realInterface, 'prompt');
        return realInterface;
      },
    });

    await session.start();
    // The ready prompt is painted once at start; no further prompt while the
    // turn is pending.
    expect(promptSpy?.mock.calls.length).toBe(1);

    input.write('first\n');
    await waitUntil(() => runBossTurn.mock.calls.length === 1);
    await waitUntil(() => stripAnsi(output.text()).includes('WORKING'));

    const afterCaptainStart = stripAnsi(output.text()).indexOf('WORKING');
    input.write('queued');
    await delay(READLINE_ESCAPE_CODE_TIMEOUT_MS + 20);

    // No fresh `boss> ` prompt line follows the streamed Captain output while
    // the turn is active, even though the Boss typed type-ahead.
    const duringTurn = stripAnsi(output.text()).slice(afterCaptainStart);
    expect(duringTurn).not.toContain('boss>');
    expect(promptSpy?.mock.calls.length).toBe(1);

    // Turn ends: the colored prompt is restored exactly once.
    turnBlock.resolve();
    await waitUntil(() => (promptSpy?.mock.calls.length ?? 0) === 2);
    expect(promptSpy?.mock.calls.length).toBe(2);

    // The preserved type-ahead submits as one runBossTurn on the next Enter.
    input.write('\n');
    await waitUntil(() => runBossTurn.mock.calls.length === 2);
    expect(runBossTurn.mock.calls.map((call) => call[0])).toEqual([
      'first',
      'queued',
    ]);

    input.end();
    await session.done;
  });

  it('suspends the boss> prompt during an active turn and preserves pasted type-ahead newlines', async () => {
    tempDir = makeWorkDir();
    const input = new TtyInput();
    const output = new TtyOutput();
    const turnBlock = deferred<void>();
    const runBossTurn = vi.fn(async (prompt: string) => {
      if (prompt !== 'first') {
        return;
      }
      const runtimeOptions = createRuntime.mock.calls[0]?.[0];
      for (const observer of runtimeOptions?.observers ?? []) {
        await observer.onRecord({
          type: 'captain_status',
          turnId: 1,
          timestamp: 100,
          message: 'WORKING',
        });
      }
      await turnBlock.promise;
    });
    const createRuntime = vi.fn(async (_options: RunTmuxPlayOptions) => ({
      abortActiveTurn: vi.fn(),
      dispose: vi.fn(async () => undefined),
      runBossTurn,
    }));
    let promptSpy: ReturnType<typeof vi.spyOn> | undefined;
    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      input,
      output,
      createRuntime,
      importCaptain: async () => ({ default: () => captain() }),
      createReadline: (options) => {
        const realInterface = createInterface(options);
        promptSpy = vi.spyOn(realInterface, 'prompt');
        return realInterface;
      },
    });

    await session.start();
    input.write('first\n');
    await waitUntil(() => runBossTurn.mock.calls.length === 1);
    await waitUntil(() => stripAnsi(output.text()).includes('WORKING'));

    const afterCaptainStart = stripAnsi(output.text()).indexOf('WORKING');
    // Paste multi-line text during the active turn (no submit Enter yet).
    input.write('\x1b[200~Alpha\nBravo\x1b[201~');
    await delay(READLINE_ESCAPE_CODE_TIMEOUT_MS + 20);

    const duringTurn = stripAnsi(output.text()).slice(afterCaptainStart);
    expect(duringTurn).not.toContain('boss>');
    expect(promptSpy?.mock.calls.length).toBe(1);

    turnBlock.resolve();
    await waitUntil(() => (promptSpy?.mock.calls.length ?? 0) === 2);
    expect(promptSpy?.mock.calls.length).toBe(2);

    // The pasted type-ahead submits as one runBossTurn whose prompt preserves
    // the embedded newline per tmux-play-58.
    input.write('\n');
    await waitUntil(() => runBossTurn.mock.calls.length === 2);
    expect(runBossTurn.mock.calls.map((call) => call[0])).toEqual([
      'first',
      'Alpha\nBravo',
    ]);

    input.end();
    await session.done;
  });

  // tmux-play-174: a fresh ready `boss> ` prompt is painted only once the queue of
  // submitted Boss lines drains. When the Boss types Enter ahead and a second
  // line queues behind the active turn, releasing the first turn must not
  // repaint the prompt while the second is still queued; exactly one repaint
  // follows the last queued turn. An empty submission amid an active turn must
  // not repaint either. A stubbed readline faithfully counts `prompt()` calls,
  // so this property is observable without real prompt chrome.
  it('paints no ready prompt between consecutive queued Boss turns', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const output = new MemoryOutput();
    const firstBlock = deferred<void>();
    const secondBlock = deferred<void>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const runBossTurn = vi.fn(async (prompt: string) => {
      if (prompt === 'first') {
        firstStarted.resolve();
        await firstBlock.promise;
      } else if (prompt === 'second') {
        secondStarted.resolve();
        await secondBlock.promise;
      }
    });
    const session = new TmuxPlaySession({
      ...baseOptions(tempDir),
      createReadline: () => readline,
      createRuntime: async () => ({
        abortActiveTurn: vi.fn(),
        dispose: async () => undefined,
        runBossTurn,
      }),
      importCaptain: async () => ({ default: () => captain() }),
      output,
    });

    await session.start();
    expect(readline.promptCount).toBe(1);

    // Turn 1 starts and blocks.
    readline.emitLine('first');
    await firstStarted.promise;

    // An empty submission while the turn is active does not repaint boss>.
    readline.emitLine('   ');
    expect(readline.promptCount).toBe(1);

    // Turn 2 queues behind the active turn.
    readline.emitLine('second');

    // Releasing turn 1 must not repaint while turn 2 is still queued.
    firstBlock.resolve();
    await secondStarted.promise;
    expect(readline.promptCount).toBe(1);

    // Once the queue drains, exactly one fresh ready prompt is painted.
    secondBlock.resolve();
    await waitUntil(() => readline.promptCount === 2);
    expect(readline.promptCount).toBe(2);
    expect(runBossTurn.mock.calls.map((call) => call[0])).toEqual([
      'first',
      'second',
    ]);
  });

  it('rejects an unsafe managed session id before child mutation', async () => {
    tempDir = makeWorkDir();
    const paths = managedPaths(tempDir);
    const initializeRuntime = vi.fn(async () => ({
      abortActiveTurn: vi.fn(),
      dispose: vi.fn(),
      runBossTurn: vi.fn(),
    }));

    await expect(
      runManagedTmuxPlaySession({
        ...baseOptions(tempDir),
        ...paths,
        sessionId: 'unsafe.id',
        lifecycle: {
          initializeRuntime,
          async beforeNonEmptyTurn() {},
          async afterTurn() {},
          async shutdown() {},
        },
      }),
    ).rejects.toThrow(
      'managed tmux-play sessionId must match ^[A-Za-z0-9][A-Za-z0-9_-]*$',
    );

    expect(initializeRuntime).not.toHaveBeenCalled();
    expect(existsSync(paths.readinessPath)).toBe(false);
    expect(existsSync(tempDir)).toBe(true);
  });

  it('gates managed input and releases buffered replies only after the settled-turn hook', async () => {
    tempDir = makeWorkDir({ emptyPlayers: true });
    const readinessPath = join(tempDir, 'managed-ready.json');
    const inputGatePath = join(tempDir, 'managed-input-ready');
    const inputActivePath = join(tempDir, 'managed-input-active');
    const shutdownRequestPath = join(tempDir, 'managed-shutdown-request');
    const shutdownCompletePath = join(tempDir, 'managed-shutdown-complete');
    const readline = new FakeReadline();
    const initialized = deferred<void>();
    const releaseInitialization = deferred<void>();
    const order: string[] = [];
    const visibleRecords: TmuxPlayRecord[] = [];
    const activationSeenAtBefore: boolean[] = [];
    let runtimeObserver!: { onRecord(record: TmuxPlayRecord): unknown };
    const dispose = vi.fn(async () => {
      order.push('runtime.dispose');
    });
    const lifecycle: ManagedTmuxPlayLifecycle = {
      async initializeRuntime(context) {
        order.push('initialize');
        expect(context.config.players).toEqual([]);
        expect(context.config.layout.initialVisible).toEqual([]);
        expect(context.config.layout.columnWeights).toEqual([1]);
        runtimeObserver = context.observers[0]!;
        initialized.resolve();
        await releaseInitialization.promise;
        return {
          abortActiveTurn: vi.fn(),
          dispose,
          async runBossTurn() {
            order.push('run');
            await runtimeObserver.onRecord({
              type: 'captain_reply',
              turnId: 1,
              timestamp: 1,
              text: 'durable reply',
            });
            await runtimeObserver.onRecord({
              type: 'turn_finished',
              turnId: 1,
              timestamp: 2,
            });
            order.push('runtime fence');
          },
        };
      },
      async beforeNonEmptyTurn() {
        order.push('before');
        activationSeenAtBefore.push(existsSync(inputActivePath));
      },
      async afterTurn(context) {
        order.push('after');
        expect(context.replies).toMatchObject([
          { type: 'captain_reply', text: 'durable reply' },
        ]);
        expect(
          visibleRecords.some((record) => record.type === 'captain_reply'),
        ).toBe(false);
        expect(context.terminal).toEqual({
          type: 'turn_finished',
          turnId: 1,
          timestamp: 2,
        });
      },
      async shutdown() {
        order.push('shutdown');
      },
    };

    const running = runManagedTmuxPlaySession({
      ...baseOptions(tempDir),
      readinessPath,
      inputGatePath,
      inputActivePath,
      shutdownRequestPath,
      shutdownCompletePath,
      lifecycle,
      createReadline: () => readline,
      observers: [
        {
          onRecord(record) {
            visibleRecords.push(record);
            if (record.type === 'captain_reply') order.push('reply visible');
          },
        },
      ],
    });

    await initialized.promise;
    releaseInitialization.resolve();
    await waitUntil(() => existsSync(readinessPath));
    expect(order).toEqual(['initialize']);

    // A line received after initialized readiness but before the embedding
    // frontend activates input is queued, not lost or run prematurely.
    readline.emitLine('work');
    await Promise.resolve();
    expect(order).toEqual(['initialize']);
    writeFileSync(inputGatePath, 'ready\n', { mode: 0o600 });
    await waitUntil(() => existsSync(inputActivePath));
    await waitUntil(() => order.includes('reply visible'));
    expect(order).toEqual([
      'initialize',
      'before',
      'run',
      'runtime fence',
      'after',
      'reply visible',
    ]);
    expect(activationSeenAtBefore).toEqual([true]);

    readline.close();
    await running;
    expect(order.slice(-2)).toEqual(['runtime.dispose', 'shutdown']);
  });

  it('isolates agents before managed runtime initialization (tmux-play-74)', async () => {
    tempDir = makeWorkDir({ emptyPlayers: true });
    const paths = managedPaths(tempDir);
    const readline = new FakeReadline();
    const savedTmux = process.env.TMUX;
    const savedPane = process.env.TMUX_PANE;
    const savedTmpDir = process.env.TMUX_TMPDIR;
    process.env.TMUX = '/private/tmp/tmux-501/default,456,0';
    process.env.TMUX_PANE = '%7';
    delete process.env.TMUX_TMPDIR;
    let observed:
      | {
          tmux: string | undefined;
          pane: string | undefined;
          tmpDir: string | undefined;
          orchestratorInTmux: boolean;
        }
      | undefined;
    try {
      const running = runManagedTmuxPlaySession({
        ...baseOptions(tempDir),
        ...paths,
        createReadline: () => readline,
        lifecycle: {
          async initializeRuntime() {
            observed = {
              tmux: process.env.TMUX,
              pane: process.env.TMUX_PANE,
              tmpDir: process.env.TMUX_TMPDIR,
              orchestratorInTmux: isOrchestratorInTmux(),
            };
            return {
              abortActiveTurn: vi.fn(),
              dispose: vi.fn(),
              runBossTurn: vi.fn(),
            };
          },
          async beforeNonEmptyTurn() {},
          async afterTurn() {},
          async shutdown() {},
        },
      });

      await waitUntil(() => existsSync(paths.readinessPath));
      expect(observed?.tmux).toBeUndefined();
      expect(observed?.pane).toBeUndefined();
      expect(observed?.tmpDir).toBeDefined();
      expect(observed?.tmpDir).not.toBe('/private/tmp/tmux-501');
      expect(observed?.orchestratorInTmux).toBe(true);
      readline.close();
      await running;
    } finally {
      setOrchestratorTmuxEnv(undefined);
      const sandbox = process.env.TMUX_TMPDIR;
      restoreEnv('TMUX', savedTmux);
      restoreEnv('TMUX_PANE', savedPane);
      restoreEnv('TMUX_TMPDIR', savedTmpDir);
      if (sandbox && sandbox !== savedTmpDir) {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  it('isolates agents before stock runtime construction (tmux-play-74)', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const savedTmux = process.env.TMUX;
    const savedPane = process.env.TMUX_PANE;
    const savedTmpDir = process.env.TMUX_TMPDIR;
    process.env.TMUX = '/private/tmp/tmux-501/default,456,0';
    process.env.TMUX_PANE = '%7';
    delete process.env.TMUX_TMPDIR;
    let observed:
      | {
          tmux: string | undefined;
          pane: string | undefined;
          tmpDir: string | undefined;
          orchestratorInTmux: boolean;
        }
      | undefined;
    try {
      const running = runTmuxPlaySession({
        ...baseOptions(tempDir),
        createReadline: () => readline,
        createRuntime: async () => {
          observed = {
            tmux: process.env.TMUX,
            pane: process.env.TMUX_PANE,
            tmpDir: process.env.TMUX_TMPDIR,
            orchestratorInTmux: isOrchestratorInTmux(),
          };
          return {
            abortActiveTurn: vi.fn(),
            dispose: vi.fn(),
            runBossTurn: vi.fn(),
          };
        },
        importCaptain: async () => ({
          default: () => ({ async handleBossTurn() {} }),
        }),
      });

      await waitUntil(() => observed !== undefined);
      expect(observed?.tmux).toBeUndefined();
      expect(observed?.pane).toBeUndefined();
      expect(observed?.tmpDir).toBeDefined();
      expect(observed?.tmpDir).not.toBe('/private/tmp/tmux-501');
      expect(observed?.orchestratorInTmux).toBe(true);
      readline.close();
      await running;
    } finally {
      setOrchestratorTmuxEnv(undefined);
      const sandbox = process.env.TMUX_TMPDIR;
      restoreEnv('TMUX', savedTmux);
      restoreEnv('TMUX_PANE', savedPane);
      restoreEnv('TMUX_TMPDIR', savedTmpDir);
      if (sandbox && sandbox !== savedTmpDir) {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  it.each(['before', 'after'] as const)(
    'withholds managed replies and awaits shutdown when the %s hook fails',
    async (failingHook) => {
      tempDir = makeWorkDir();
      const readline = new FakeReadline();
      const visibleRecords: TmuxPlayRecord[] = [];
      const order: string[] = [];
      let runtimeObserver!: { onRecord(record: TmuxPlayRecord): unknown };
      const lifecycle: ManagedTmuxPlayLifecycle = {
        async initializeRuntime(context) {
          runtimeObserver = context.observers[0]!;
          return {
            abortActiveTurn: vi.fn(),
            async dispose() {
              order.push('dispose');
            },
            async runBossTurn() {
              order.push('run');
              await runtimeObserver.onRecord({
                type: 'captain_reply',
                turnId: 1,
                timestamp: 1,
                text: 'must stay hidden',
              });
              await runtimeObserver.onRecord({
                type: 'turn_finished',
                turnId: 1,
                timestamp: 2,
              });
              order.push('fence');
            },
          };
        },
        async beforeNonEmptyTurn() {
          order.push('before');
          if (failingHook === 'before') throw new Error('write-ahead failed');
        },
        async afterTurn() {
          order.push('after');
          if (failingHook === 'after') throw new Error('settlement failed');
        },
        async shutdown(context) {
          order.push(`shutdown:${testErrorMessage(context.error)}`);
        },
      };
      const readinessPath = join(tempDir, 'managed-ready.json');
      const inputGatePath = join(tempDir, 'managed-input-ready');
      const inputActivePath = join(tempDir, 'managed-input-active');
      const shutdownRequestPath = join(tempDir, 'managed-shutdown-request');
      const shutdownCompletePath = join(tempDir, 'managed-shutdown-complete');
      const running = runManagedTmuxPlaySession({
        ...baseOptions(tempDir),
        readinessPath,
        inputGatePath,
        inputActivePath,
        shutdownRequestPath,
        shutdownCompletePath,
        lifecycle,
        createReadline: () => readline,
        observers: [{ onRecord: (record) => visibleRecords.push(record) }],
      });

      await waitUntil(() => existsSync(readinessPath));
      writeFileSync(inputGatePath, 'ready\n', { mode: 0o600 });
      await waitUntil(() => existsSync(inputActivePath));
      readline.emitLine('work');

      await expect(running).rejects.toThrow(
        failingHook === 'before' ? 'write-ahead failed' : 'settlement failed',
      );
      expect(
        visibleRecords.some((record) => record.type === 'captain_reply'),
      ).toBe(false);
      expect(order).toEqual(
        failingHook === 'before'
          ? ['before', 'dispose', 'shutdown:write-ahead failed']
          : [
              'before',
              'run',
              'fence',
              'after',
              'dispose',
              'shutdown:settlement failed',
            ],
      );
    },
  );

  it('aggregates a turn failure with lifecycle shutdown failure in order', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const primaryFailure = new Error('write-ahead failed');
    const cleanupFailure = new Error('lease retirement failed');
    const paths = managedPaths(tempDir);
    const running = runManagedTmuxPlaySession({
      ...baseOptions(tempDir),
      ...paths,
      createReadline: () => readline,
      lifecycle: {
        async initializeRuntime() {
          return {
            abortActiveTurn: vi.fn(),
            dispose: vi.fn(),
            runBossTurn: vi.fn(),
          };
        },
        async beforeNonEmptyTurn() {
          throw primaryFailure;
        },
        async afterTurn() {},
        async shutdown(context) {
          expect(context.error).toBe(primaryFailure);
          throw cleanupFailure;
        },
      },
    });

    await activateManagedSession(paths);
    readline.emitLine('work');
    const failure = await running.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      primaryFailure,
      cleanupFailure,
    ]);
    expect((failure as Error).message).toContain(
      'write-ahead failed; lease retirement failed',
    );
  });

  it('preserves the exact identity of one managed shutdown failure', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const primaryFailure = new AggregateError([], 'write-ahead failed');
    const paths = managedPaths(tempDir);
    const running = runManagedTmuxPlaySession({
      ...baseOptions(tempDir),
      ...paths,
      createReadline: () => readline,
      lifecycle: {
        async initializeRuntime() {
          return {
            abortActiveTurn: vi.fn(),
            dispose: vi.fn(),
            runBossTurn: vi.fn(),
          };
        },
        async beforeNonEmptyTurn() {
          throw primaryFailure;
        },
        async afterTurn() {},
        async shutdown() {},
      },
    });

    await activateManagedSession(paths);
    readline.emitLine('work');
    const failure = await running.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBe(primaryFailure);
  });

  it('continues cleanup after synchronous abort failure and flattens aggregates', async () => {
    tempDir = makeWorkDir();
    const paths = managedPaths(tempDir);
    const readline = new FakeReadline();
    const abortFailure = new Error('active turn abort failed');
    const disposeFailureA = new Error('runtime cleanup one failed');
    const disposeFailureB = new Error('runtime cleanup two failed');
    const leaseFailure = new Error('lease retirement failed');
    const order: string[] = [];
    const running = runManagedTmuxPlaySession({
      ...baseOptions(tempDir),
      ...paths,
      createReadline: () => readline,
      removeWorkDir() {
        order.push('workdir cleanup');
      },
      killSession() {
        order.push('pane cleanup');
      },
      lifecycle: {
        async initializeRuntime() {
          return {
            abortActiveTurn() {
              order.push('abort');
              throw abortFailure;
            },
            async dispose() {
              order.push('runtime dispose');
              throw new AggregateError([
                disposeFailureA,
                disposeFailureB,
              ]);
            },
            runBossTurn: vi.fn(),
          };
        },
        async beforeNonEmptyTurn() {},
        async afterTurn() {},
        async shutdown(context) {
          order.push('lifecycle shutdown');
          expect(context.error).toBe(abortFailure);
          throw leaseFailure;
        },
      },
    });

    await waitUntil(() => existsSync(paths.readinessPath));
    writeFileSync(paths.shutdownRequestPath, 'shutdown\n', { mode: 0o600 });
    const failure = await running.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      abortFailure,
      disposeFailureA,
      disposeFailureB,
      leaseFailure,
    ]);
    expect(order).toEqual([
      'abort',
      'runtime dispose',
      'lifecycle shutdown',
      'workdir cleanup',
      'pane cleanup',
    ]);
    expect(existsSync(paths.shutdownCompletePath)).toBe(true);
  });

  it('joins an active managed turn and preserves the embedding shutdown reason', async () => {
    tempDir = makeWorkDir();
    const paths = managedPaths(tempDir);
    const readline = new FakeReadline();
    const turnStarted = deferred<void>();
    const turnBarrier = deferred<void>();
    const order: string[] = [];
    let shutdownReason = '';
    let runtimeObserver!: { onRecord(record: TmuxPlayRecord): unknown };
    const running = runManagedTmuxPlaySession({
      ...baseOptions(tempDir),
      ...paths,
      createReadline: () => readline,
      lifecycle: {
        async initializeRuntime(context) {
          runtimeObserver = context.observers[0]!;
          return {
            abortActiveTurn(reason) {
              shutdownReason = reason ?? '';
              order.push(`abort:${shutdownReason}`);
            },
            async dispose() {
              order.push('runtime dispose');
            },
            async runBossTurn() {
              order.push('turn start');
              turnStarted.resolve();
              await turnBarrier.promise;
              await runtimeObserver.onRecord({
                type: 'turn_aborted',
                turnId: 1,
                timestamp: 1,
                reason: shutdownReason,
              });
              order.push('turn complete');
            },
          };
        },
        async beforeNonEmptyTurn() {},
        async afterTurn(context) {
          order.push(
            `settlement:${
              context.terminal.type === 'turn_aborted'
                ? context.terminal.reason
                : context.terminal.type
            }`,
          );
        },
        async shutdown(context) {
          order.push(`lifecycle shutdown:${context.reason}`);
        },
      },
    });

    await activateManagedSession(paths);
    readline.emitLine('work');
    await turnStarted.promise;
    writeFileSync(paths.shutdownRequestPath, 'shutdown\n', { mode: 0o600 });
    await waitUntil(() =>
      order.includes('abort:embedding shutdown request'),
    );

    expect(order).toEqual([
      'turn start',
      'abort:embedding shutdown request',
    ]);
    turnBarrier.resolve();
    await running;

    expect(order).toEqual([
      'turn start',
      'abort:embedding shutdown request',
      'turn complete',
      'settlement:embedding shutdown request',
      'runtime dispose',
      'lifecycle shutdown:embedding shutdown request',
    ]);
  });

  it('joins managed startup before lifecycle and work cleanup', async () => {
    tempDir = makeWorkDir();
    const paths = managedPaths(tempDir);
    const signalTarget = new SignalHub();
    const startupEntered = deferred<void>();
    const startupBarrier = deferred<void>();
    const startupFailure = new Error('managed startup failed');
    const order: string[] = [];
    const running = runManagedTmuxPlaySession({
      ...baseOptions(tempDir),
      ...paths,
      signalTarget,
      removeWorkDir() {
        order.push('workdir cleanup');
      },
      killSession() {
        order.push('pane cleanup');
      },
      lifecycle: {
        async initializeRuntime() {
          order.push('startup');
          startupEntered.resolve();
          await startupBarrier.promise;
          throw startupFailure;
        },
        async beforeNonEmptyTurn() {},
        async afterTurn() {},
        async shutdown(context) {
          order.push('lifecycle shutdown');
          expect(context.error).toBe(startupFailure);
        },
      },
    });

    await startupEntered.promise;
    signalTarget.emit('SIGTERM');
    await delay(0);
    expect(order).toEqual(['startup']);

    startupBarrier.resolve();
    const failure = await running.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBe(startupFailure);
    expect(order).toEqual([
      'startup',
      'lifecycle shutdown',
      'workdir cleanup',
      'pane cleanup',
    ]);
  });

  it('passes an aborted terminal outcome to settlement and never releases its buffered reply', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const visibleRecords: TmuxPlayRecord[] = [];
    let runtimeObserver!: { onRecord(record: TmuxPlayRecord): unknown };
    const afterTurn = vi.fn();
    const paths = managedPaths(tempDir);
    const running = runManagedTmuxPlaySession({
      ...baseOptions(tempDir),
      ...paths,
      createReadline: () => readline,
      observers: [{ onRecord: (record) => visibleRecords.push(record) }],
      lifecycle: {
        async initializeRuntime(context) {
          runtimeObserver = context.observers[0]!;
          return {
            abortActiveTurn: vi.fn(),
            dispose: vi.fn(),
            async runBossTurn() {
              await runtimeObserver.onRecord({
                type: 'captain_reply',
                turnId: 7,
                timestamp: 1,
                text: 'partial reply',
              });
              await runtimeObserver.onRecord({
                type: 'turn_aborted',
                turnId: 7,
                timestamp: 2,
                reason: 'ESC',
              });
            },
          };
        },
        async beforeNonEmptyTurn() {},
        async afterTurn(context) {
          afterTurn(context);
        },
        async shutdown() {},
      },
    });

    await activateManagedSession(paths);
    readline.emitLine('work');
    await waitUntil(() => afterTurn.mock.calls.length === 1);

    expect(afterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: {
          type: 'turn_aborted',
          turnId: 7,
          timestamp: 2,
          reason: 'ESC',
        },
      }),
    );
    expect(
      visibleRecords.some((record) => record.type === 'captain_reply'),
    ).toBe(false);

    readline.close();
    await running;
  });

  it('preserves a fenced runtime failure when terminal settlement also rejects', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const visibleRecords: TmuxPlayRecord[] = [];
    const order: string[] = [];
    let runtimeObserver!: { onRecord(record: TmuxPlayRecord): unknown };
    const paths = managedPaths(tempDir);
    const running = runManagedTmuxPlaySession({
      ...baseOptions(tempDir),
      ...paths,
      createReadline: () => readline,
      observers: [{ onRecord: (record) => visibleRecords.push(record) }],
      lifecycle: {
        async initializeRuntime(context) {
          runtimeObserver = context.observers[0]!;
          return {
            abortActiveTurn: vi.fn(),
            async dispose() {
              order.push('dispose');
            },
            async runBossTurn() {
              order.push('run');
              await runtimeObserver.onRecord({
                type: 'captain_reply',
                turnId: 11,
                timestamp: 1,
                text: 'withheld partial reply',
              });
              await runtimeObserver.onRecord({
                type: 'turn_aborted',
                turnId: 11,
                timestamp: 2,
                reason: 'captain failed',
              });
              throw new Error('captain failed');
            },
          };
        },
        async beforeNonEmptyTurn() {
          order.push('before');
        },
        async afterTurn(context) {
          order.push(`after:${context.terminal.type}`);
          expect(context.replies).toEqual([
            expect.objectContaining({ text: 'withheld partial reply' }),
          ]);
          expect(context.terminal).toEqual(
            expect.objectContaining({
              type: 'turn_aborted',
              turnId: 11,
              reason: 'captain failed',
            }),
          );
          throw new Error('settlement also failed');
        },
        async shutdown(context) {
          order.push(`shutdown:${testErrorMessage(context.error)}`);
        },
      },
    });

    await activateManagedSession(paths);
    readline.emitLine('work');

    await expect(running).rejects.toThrow('captain failed');
    expect(order).toEqual([
      'before',
      'run',
      'after:turn_aborted',
      'dispose',
      'shutdown:captain failed',
    ]);
    expect(
      visibleRecords.some((record) => record.type === 'captain_reply'),
    ).toBe(false);
  });

  it('queues a pre-activation bracketed paste as one newline-preserving prompt', async () => {
    tempDir = makeWorkDir();
    const input = new TtyInput();
    const output = new TtyOutput();
    const runBossTurn = vi.fn(async () => undefined);
    let runtimeObserver!: { onRecord(record: TmuxPlayRecord): unknown };
    const paths = managedPaths(tempDir);
    const running = runManagedTmuxPlaySession({
      ...baseOptions(tempDir),
      ...paths,
      input,
      output,
      lifecycle: {
        async initializeRuntime(context) {
          runtimeObserver = context.observers[0]!;
          return {
            abortActiveTurn: vi.fn(),
            dispose: vi.fn(),
            async runBossTurn(prompt) {
              await runBossTurn(prompt);
              await runtimeObserver.onRecord({
                type: 'turn_finished',
                turnId: 1,
                timestamp: 1,
              });
            },
          };
        },
        async beforeNonEmptyTurn() {},
        async afterTurn() {},
        async shutdown() {},
      },
    });

    await waitUntil(() => existsSync(paths.readinessPath));
    input.write('\x1b[200~Alpha\nBravo\nCharlie\x1b[201~\n');
    await delay(READLINE_ESCAPE_CODE_TIMEOUT_MS + 20);
    expect(runBossTurn).not.toHaveBeenCalled();

    writeFileSync(paths.inputGatePath, 'ready\n', { mode: 0o600 });
    await waitUntil(() => existsSync(paths.inputActivePath));
    await waitUntil(() => runBossTurn.mock.calls.length === 1);
    expect(runBossTurn).toHaveBeenCalledWith('Alpha\nBravo\nCharlie');

    input.end();
    await running;
  });

  it.each(['before', 'after'] as const)(
    'awaits the active managed %s hook before lifecycle shutdown and settles replies transactionally',
    async (blockedHook) => {
      tempDir = makeWorkDir();
      const readline = new FakeReadline();
      const signalTarget = new SignalHub();
      const entered = deferred<void>();
      const release = deferred<void>();
      const order: string[] = [];
      const visibleRecords: TmuxPlayRecord[] = [];
      let runtimeObserver!: { onRecord(record: TmuxPlayRecord): unknown };
      const paths = managedPaths(tempDir);
      const running = runManagedTmuxPlaySession({
        ...baseOptions(tempDir),
        ...paths,
        signalTarget,
        createReadline: () => readline,
        observers: [
          {
            onRecord(record) {
              visibleRecords.push(record);
              if (record.type === 'captain_reply') order.push('reply visible');
            },
          },
        ],
        lifecycle: {
          async initializeRuntime(context) {
            runtimeObserver = context.observers[0]!;
            return {
              abortActiveTurn() {
                order.push('abort');
              },
              async dispose() {
                order.push('dispose');
              },
              async runBossTurn() {
                order.push('run');
                await runtimeObserver.onRecord({
                  type: 'captain_reply',
                  turnId: 3,
                  timestamp: 1,
                  text: 'withhold during shutdown',
                });
                await runtimeObserver.onRecord({
                  type: 'turn_finished',
                  turnId: 3,
                  timestamp: 2,
                });
              },
            };
          },
          async beforeNonEmptyTurn() {
            order.push('before:start');
            if (blockedHook === 'before') {
              entered.resolve();
              await release.promise;
            }
            order.push('before:end');
          },
          async afterTurn() {
            order.push('after:start');
            if (blockedHook === 'after') {
              entered.resolve();
              await release.promise;
            }
            order.push('after:end');
          },
          async shutdown() {
            order.push('shutdown');
          },
        },
      });

      await activateManagedSession(paths);
      readline.emitLine('work');
      await entered.promise;
      signalTarget.emit('SIGTERM');
      await Promise.resolve();
      expect(order).not.toContain('shutdown');

      release.resolve();
      await running;

      expect(order.indexOf('shutdown')).toBeGreaterThan(
        order.indexOf(`${blockedHook}:end`),
      );
      expect(order.indexOf('shutdown')).toBeGreaterThan(
        order.indexOf('dispose'),
      );
      expect(order.filter((entry) => entry === 'shutdown')).toHaveLength(1);
      expect(order.at(-1)).toBe('shutdown');
      expect(
        visibleRecords.some((record) => record.type === 'captain_reply'),
      ).toBe(blockedHook === 'after');
      if (blockedHook === 'before') {
        expect(order).not.toContain('run');
      } else {
        expect(order.indexOf('reply visible')).toBeGreaterThan(
          order.indexOf('after:end'),
        );
        expect(order.indexOf('reply visible')).toBeLessThan(
          order.indexOf('dispose'),
        );
      }
    },
  );

  it('publishes no managed readiness or activation after shutdown starts during initialization', async () => {
    tempDir = makeWorkDir();
    const readline = new FakeReadline();
    const signalTarget = new SignalHub();
    const initializeEntered = deferred<void>();
    const releaseInitialization = deferred<void>();
    const paths = managedPaths(tempDir);
    const shutdown = vi.fn();
    const running = runManagedTmuxPlaySession({
      ...baseOptions(tempDir),
      ...paths,
      signalTarget,
      createReadline: () => readline,
      lifecycle: {
        async initializeRuntime() {
          initializeEntered.resolve();
          await releaseInitialization.promise;
          return {
            abortActiveTurn: vi.fn(),
            dispose: vi.fn(),
            runBossTurn: vi.fn(),
          };
        },
        async beforeNonEmptyTurn() {},
        async afterTurn() {},
        async shutdown(context) {
          shutdown(context);
        },
      },
    });

    await initializeEntered.promise;
    signalTarget.emit('SIGHUP');
    releaseInitialization.resolve();
    await running;

    expect(existsSync(paths.readinessPath)).toBe(false);
    expect(existsSync(paths.inputActivePath)).toBe(false);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a managed shutdown request only after ordered one-time cleanup', async () => {
    tempDir = makeWorkDir();
    const paths = managedPaths(tempDir);
    const readline = new FakeReadline();
    const order: string[] = [];
    const abortActiveTurn = vi.fn((reason?: string) => {
      order.push(`abort:${reason}`);
    });
    const lifecycleShutdown = vi.fn(async (context) => {
      expect(existsSync(paths.shutdownCompletePath)).toBe(false);
      order.push(`lifecycle:${context.reason}`);
    });
    const running = runManagedTmuxPlaySession({
      ...baseOptions(tempDir),
      ...paths,
      createReadline: () => readline,
      removeWorkDir() {
        expect(existsSync(paths.shutdownCompletePath)).toBe(false);
        order.push('workdir');
      },
      lifecycle: {
        async initializeRuntime() {
          return {
            abortActiveTurn,
            async dispose() {
              order.push('runtime.dispose');
            },
            runBossTurn: vi.fn(),
          };
        },
        async beforeNonEmptyTurn() {},
        async afterTurn() {},
        shutdown: lifecycleShutdown,
      },
    });

    await waitUntil(() => existsSync(paths.readinessPath));
    writeFileSync(paths.shutdownRequestPath, 'shutdown\n', { mode: 0o600 });
    await running;

    expect(order).toEqual([
      'abort:embedding shutdown request',
      'runtime.dispose',
      'lifecycle:embedding shutdown request',
      'workdir',
    ]);
    expect(lifecycleShutdown).toHaveBeenCalledTimes(1);
    expect(existsSync(paths.shutdownCompletePath)).toBe(true);
  });
});

const READLINE_ESCAPE_CODE_TIMEOUT_MS = 100;
const BRACKETED_PASTE_ENABLE = '\x1b[?2004h';
const BRACKETED_PASTE_DISABLE = '\x1b[?2004l';

function baseOptions(
  workDir: string,
): TmuxPlaySessionOptions & { readonly workDirOwnedByLauncher: true } {
  return {
    sessionId: 'abc123',
    workDir,
    workDirOwnedByLauncher: true,
    cwd: '/repo',
    input: process.stdin,
    output: new MemoryOutput(),
    killSession: vi.fn(),
    removeWorkDir: vi.fn(),
    signalTarget: new SignalHub(),
    createTimingObserver: () => noopTimingObserver(),
  };
}

function managedPaths(workDir: string): {
  readinessPath: string;
  inputGatePath: string;
  inputActivePath: string;
  shutdownRequestPath: string;
  shutdownCompletePath: string;
} {
  return {
    readinessPath: join(workDir, 'managed-ready.json'),
    inputGatePath: join(workDir, 'managed-input-ready'),
    inputActivePath: join(workDir, 'managed-input-active'),
    shutdownRequestPath: join(workDir, 'managed-shutdown-request'),
    shutdownCompletePath: join(workDir, 'managed-shutdown-complete'),
  };
}

async function activateManagedSession(paths: {
  readinessPath: string;
  inputGatePath: string;
  inputActivePath: string;
}): Promise<void> {
  await waitUntil(() => existsSync(paths.readinessPath));
  writeFileSync(paths.inputGatePath, 'ready\n', { mode: 0o600 });
  await waitUntil(() => existsSync(paths.inputActivePath));
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

function makeWorkDir(
  overrides: {
    theme?: 'mocha' | 'latte';
    emptyPlayers?: boolean;
    captainFastMode?: boolean;
    playerFastMode?: boolean;
  } = {},
): string {
  const workDir = mkdtempSync(join(tmpdir(), 'cligent-session-'));
  writeFileSync(join(workDir, TMUX_PLAY_WORK_DIR_OWNER_MARKER), 'abc123');
  const emptyPlayers = overrides.emptyPlayers === true;
  const snapshot: Record<string, unknown> = {
    captain: {
      from: '@sublang/cligent/captains/fanout',
      adapter: 'claude',
      instruction: 'Coordinate players.',
      effort: 'ultracode',
      ...(overrides.captainFastMode === undefined
        ? {}
        : { fastMode: overrides.captainFastMode }),
      options: { tone: 'direct' },
    },
    players: emptyPlayers
      ? []
      : [
          {
            id: 'coder',
            adapter: 'codex',
            effort: 'ultra',
            ...(overrides.playerFastMode === undefined
              ? {}
              : { fastMode: overrides.playerFastMode }),
          },
        ],
    layout: {
      window: { columns: 174, rows: 49 },
      initialVisible: emptyPlayers ? [] : ['coder'],
      singlePlayerColumnWeights: [1, 1],
      multiPlayerColumnWeights: [1, 1, 1],
      columnWeights: emptyPlayers ? [1] : [1, 1],
    },
  };
  if (overrides.theme !== undefined) {
    snapshot.theme = overrides.theme;
  }
  writeFileSync(
    join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT),
    JSON.stringify(snapshot),
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
    await delay(0);
  }
  throw new Error('condition was not met');
}

function stripAnsi(value: string): string {
  // Drop CSI escape sequences (SGR color, cursor moves, line clears, bracketed
  // paste toggles) so a colored `boss> ` prompt collapses to literal `boss> `
  // and is detectable by substring search.
  return value.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
}

function testErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
