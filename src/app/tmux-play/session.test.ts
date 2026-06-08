// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
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
import { TmuxPresenter } from './presenter-tmux.js';
import { FollowObserver } from './follow-observer.js';
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
    // Order: presenter, then the TMUX-069 follow observer (constructed
    // internally), then the timing observer, then any opt-in observers. The
    // first two slots are pinned by concrete type (not `expect.any(Object)`),
    // so the presenter-before-follow ordering is actually asserted: the follow
    // observer must run after the presenter has written a record's bytes to a
    // pane, so swapping the two slots fails here.
    expect(createRuntime.mock.calls[0]?.[0].observers).toEqual([
      expect.any(TmuxPresenter),
      expect.any(FollowObserver),
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

  it('colors the boss> prompt with the snapshot-resolved Latte blue', async () => {
    // TMUX-038 + TMUX-047: when the snapshot's `theme` is `latte` the
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

    // Per TMUX-039 the bracketed tag is `[runtime error]` with the message
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

    // Per TMUX-039 unified grammar: bracketed tag is `[runtime error]` with
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
    // Per TMUX-039 unified grammar: bracketed tag `[turn aborted]` carries
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

  // TTMUX-074: while a Boss turn is in flight, the live readline prompt is
  // suspended so type-ahead paints no fresh `boss> ` line into the pane amid
  // the streamed Captain output; the colored prompt is restored exactly once
  // at turn end and the buffered type-ahead surfaces as one runBossTurn on the
  // next Enter. A stubbed readline does not echo prompt chrome and would pass
  // vacuously, so the probe drives a real `createInterface` over a TTY pair (as
  // the TTMUX-059 ESC probe does), wrapping only `prompt` with a call-through
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
      // captain_status line bypasses glow (TMUX-050) yet still routes to the
      // boss writer per TMUX-040, standing in for streamed Captain output.
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
    // the embedded newline per TMUX-058.
    input.write('\n');
    await waitUntil(() => runBossTurn.mock.calls.length === 2);
    expect(runBossTurn.mock.calls.map((call) => call[0])).toEqual([
      'first',
      'Alpha\nBravo',
    ]);

    input.end();
    await session.done;
  });

  // TTMUX-074: a fresh ready `boss> ` prompt is painted only once the queue of
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

function makeWorkDir(
  overrides: { theme?: 'mocha' | 'latte' } = {},
): string {
  const workDir = mkdtempSync(join(tmpdir(), 'cligent-session-'));
  writeFileSync(join(workDir, TMUX_PLAY_SESSION_MARKER), 'abc123');
  const snapshot: Record<string, unknown> = {
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
  };
  if (overrides.theme !== undefined) {
    snapshot.theme = overrides.theme;
  }
  writeFileSync(join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT), JSON.stringify(snapshot));
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

function stripAnsi(value: string): string {
  // Drop CSI escape sequences (SGR color, cursor moves, line clears, bracketed
  // paste toggles) so a colored `boss> ` prompt collapses to literal `boss> `
  // and is detectable by substring search.
  return value.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
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
