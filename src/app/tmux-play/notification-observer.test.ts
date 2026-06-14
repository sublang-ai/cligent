// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';
import {
  NotificationObserver,
  type ChildProcessLike,
  type DetachedNotificationSpawner,
} from './notification-observer.js';
import type { TmuxPlayRecord } from './records.js';

describe('NotificationObserver', () => {
  it('plays a sound cue only for every player_finished result status', () => {
    const output = { write: vi.fn() };
    const child = fakeChild();
    const spawnDetached = vi.fn(() => child);
    const observer = new NotificationObserver({
      notifications: {
        player_finished: 'bell',
        turn_finished: 'off',
        turn_aborted: 'off',
      },
      output,
      platform: 'darwin',
      spawnDetached,
    });

    observer.onRecord(playerFinished('ok'));
    observer.onRecord(playerFinished('error'));
    observer.onRecord(playerFinished('aborted'));

    expect(output.write).not.toHaveBeenCalled();
    expect(spawnDetached).toHaveBeenCalledTimes(3);
    expect(spawnDetached).toHaveBeenNthCalledWith(
      1,
      'afplay',
      ['/System/Library/Sounds/Hero.aiff'],
      { detached: true, stdio: 'ignore' },
    );
    expect(spawnDetached).toHaveBeenNthCalledWith(
      2,
      'afplay',
      ['/System/Library/Sounds/Hero.aiff'],
      { detached: true, stdio: 'ignore' },
    );
    expect(spawnDetached).toHaveBeenNthCalledWith(
      3,
      'afplay',
      ['/System/Library/Sounds/Hero.aiff'],
      { detached: true, stdio: 'ignore' },
    );
    expect(spawnDetached).not.toHaveBeenCalledWith(
      'osascript',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('sends one detached desktop notification for turn_finished on macOS', () => {
    const output = { write: vi.fn() };
    const child = fakeChild();
    const spawnDetached = vi.fn(() => child);
    const observer = new NotificationObserver({
      notifications: {
        player_finished: 'off',
        turn_finished: 'desktop',
        turn_aborted: 'off',
      },
      output,
      platform: 'darwin',
      spawnDetached,
    });

    observer.onRecord({ type: 'turn_finished', turnId: 1, timestamp: 100 });

    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(spawnDetached).toHaveBeenCalledWith(
      'osascript',
      [
        '-e',
        'display notification "Boss turn finished" with title "spex"',
      ],
      { detached: true, stdio: 'ignore' },
    );
    expect(spawnDetached).not.toHaveBeenCalledWith(
      'afplay',
      expect.any(Array),
      expect.any(Object),
    );
    expect(output.write).toHaveBeenCalledTimes(1);
    expect(output.write).toHaveBeenCalledWith('\x07');
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('does not write terminal bytes for non-turn-finished desktop events on macOS', () => {
    const output = { write: vi.fn() };
    const child = fakeChild();
    const spawnDetached = vi.fn(() => child);

    new NotificationObserver({
      notifications: {
        player_finished: 'desktop',
        turn_finished: 'off',
        turn_aborted: 'off',
      },
      output,
      platform: 'darwin',
      spawnDetached,
    }).onRecord(playerFinished('ok'));

    expect(output.write).not.toHaveBeenCalled();
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(spawnDetached).toHaveBeenCalledWith(
      'osascript',
      [
        '-e',
        'display notification "coder finished: ok" with title "spex"',
      ],
      { detached: true, stdio: 'ignore' },
    );

    const abortedOutput = { write: vi.fn() };
    const abortedSpawn = vi.fn(() => fakeChild());
    new NotificationObserver({
      notifications: {
        player_finished: 'off',
        turn_finished: 'off',
        turn_aborted: 'desktop',
      },
      output: abortedOutput,
      platform: 'darwin',
      spawnDetached: abortedSpawn,
    }).onRecord(turnAborted('captain failed'));

    expect(abortedOutput.write).not.toHaveBeenCalled();
    expect(abortedSpawn).toHaveBeenCalledTimes(1);
    expect(abortedSpawn).toHaveBeenCalledWith(
      'osascript',
      [
        '-e',
        'display notification "Boss turn aborted: captain failed" with title "spex"',
      ],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('uses notify-send for desktop notifications on Linux and no-ops elsewhere', () => {
    const linuxOutput = { write: vi.fn() };
    const linuxChild = fakeChild();
    const linuxSpawn = vi.fn(() => linuxChild);
    new NotificationObserver({
      notifications: {
        player_finished: 'off',
        turn_finished: 'desktop',
        turn_aborted: 'off',
      },
      output: linuxOutput,
      platform: 'linux',
      spawnDetached: linuxSpawn,
    }).onRecord({ type: 'turn_finished', turnId: 1, timestamp: 100 });

    expect(linuxSpawn).toHaveBeenCalledWith(
      'notify-send',
      ['spex', 'Boss turn finished'],
      { detached: true, stdio: 'ignore' },
    );
    expect(linuxOutput.write).not.toHaveBeenCalled();

    const otherOutput = { write: vi.fn() };
    const otherSpawn = vi.fn(() => fakeChild());
    new NotificationObserver({
      notifications: {
        player_finished: 'off',
        turn_finished: 'desktop',
        turn_aborted: 'off',
      },
      output: otherOutput,
      platform: 'win32',
      spawnDetached: otherSpawn,
    }).onRecord({ type: 'turn_finished', turnId: 1, timestamp: 100 });

    expect(otherSpawn).not.toHaveBeenCalled();
    expect(otherOutput.write).not.toHaveBeenCalled();
  });

  it('uses native complete sound cues for bell notifications on Linux and Windows', () => {
    const linuxChild = fakeChild();
    const linuxSpawn = vi.fn(() => linuxChild);
    new NotificationObserver({
      notifications: {
        player_finished: 'bell',
        turn_finished: 'off',
        turn_aborted: 'off',
      },
      platform: 'linux',
      spawnDetached: linuxSpawn,
    }).onRecord(playerFinished('ok'));

    expect(linuxSpawn).toHaveBeenCalledWith(
      'sh',
      [
        '-c',
        expect.stringContaining('canberra-gtk-play -i complete -d cligent'),
      ],
      { detached: true, stdio: 'ignore' },
    );

    const windowsChild = fakeChild();
    const windowsSpawn = vi.fn(() => windowsChild);
    new NotificationObserver({
      notifications: {
        player_finished: 'bell',
        turn_finished: 'off',
        turn_aborted: 'off',
      },
      platform: 'win32',
      spawnDetached: windowsSpawn,
    }).onRecord(playerFinished('ok'));

    expect(windowsSpawn).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        expect.stringContaining('Windows Notify System Generic.wav'),
      ],
      { detached: true, stdio: 'ignore' },
    );

    const otherSpawn = vi.fn(() => fakeChild());
    new NotificationObserver({
      notifications: {
        player_finished: 'bell',
        turn_finished: 'off',
        turn_aborted: 'off',
      },
      platform: 'freebsd',
      spawnDetached: otherSpawn,
    }).onRecord(playerFinished('ok'));

    expect(otherSpawn).not.toHaveBeenCalled();
  });

  it('silences configured turn_aborted notifications for user cancellations', () => {
    const output = { write: vi.fn() };
    const spawnDetached = vi.fn(() => fakeChild());
    const observer = new NotificationObserver({
      notifications: {
        player_finished: 'off',
        turn_finished: 'off',
        turn_aborted: 'bell',
      },
      output,
      platform: 'darwin',
      spawnDetached,
    });

    for (const reason of ['ESC', 'SIGINT', 'SIGTERM', 'EOF', 'runtime disposed']) {
      observer.onRecord(turnAborted(reason));
    }
    observer.onRecord(turnAborted('captain failed'));

    expect(output.write).not.toHaveBeenCalled();
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(spawnDetached).toHaveBeenCalledWith(
      'afplay',
      ['/System/Library/Sounds/Hero.aiff'],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('never throws on sink failures or unrelated records', () => {
    const output = {
      write: vi.fn(() => {
        throw new Error('stdout failed');
      }),
    };
    const spawnDetached: DetachedNotificationSpawner = vi.fn(() => {
      throw new Error('spawn failed');
    });
    const observer = new NotificationObserver({
      notifications: {
        player_finished: 'bell',
        turn_finished: 'desktop',
        turn_aborted: 'off',
      },
      output,
      platform: 'darwin',
      spawnDetached,
    });

    expect(() => observer.onRecord(playerFinished('ok'))).not.toThrow();
    expect(() =>
      observer.onRecord({ type: 'turn_finished', turnId: 1, timestamp: 100 }),
    ).not.toThrow();
    expect(() =>
      observer.onRecord({
        type: 'runtime_error',
        turnId: 1,
        timestamp: 100,
        message: 'boom',
      }),
    ).not.toThrow();
  });
});

function fakeChild(): ChildProcessLike {
  return {
    on: vi.fn(),
    unref: vi.fn(),
  } as unknown as ChildProcessLike;
}

function playerFinished(
  status: 'ok' | 'error' | 'aborted',
): TmuxPlayRecord {
  return {
    type: 'player_finished',
    turnId: 1,
    timestamp: 100,
    playerId: 'coder',
    result: {
      status,
      playerId: 'coder',
      turnId: 1,
      ...(status === 'error' ? { error: 'failed' } : {}),
    },
  };
}

function turnAborted(reason: string): TmuxPlayRecord {
  return {
    type: 'turn_aborted',
    turnId: 1,
    timestamp: 100,
    reason,
  };
}
