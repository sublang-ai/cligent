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
  it('writes a raw BEL for every player_finished result status', () => {
    const output = { write: vi.fn() };
    const observer = new NotificationObserver({
      notifications: {
        player_finished: 'bell',
        turn_finished: 'off',
        turn_aborted: 'off',
      },
      output,
    });

    observer.onRecord(playerFinished('ok'));
    observer.onRecord(playerFinished('error'));
    observer.onRecord(playerFinished('aborted'));

    expect(output.write).toHaveBeenCalledTimes(3);
    expect(output.write).toHaveBeenNthCalledWith(1, '\x07');
    expect(output.write).toHaveBeenNthCalledWith(2, '\x07');
    expect(output.write).toHaveBeenNthCalledWith(3, '\x07');
  });

  it('sends one detached desktop notification for turn_finished on macOS', () => {
    const child = fakeChild();
    const spawnDetached = vi.fn(() => child);
    const observer = new NotificationObserver({
      notifications: {
        player_finished: 'off',
        turn_finished: 'desktop',
        turn_aborted: 'off',
      },
      platform: 'darwin',
      spawnDetached,
    });

    observer.onRecord({ type: 'turn_finished', turnId: 1, timestamp: 100 });

    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(spawnDetached).toHaveBeenCalledWith(
      'osascript',
      [
        '-e',
        'display notification "Boss turn finished" with title "tmux-play"',
      ],
      { detached: true, stdio: 'ignore' },
    );
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('uses notify-send for desktop notifications on Linux and no-ops elsewhere', () => {
    const linuxChild = fakeChild();
    const linuxSpawn = vi.fn(() => linuxChild);
    new NotificationObserver({
      notifications: {
        player_finished: 'off',
        turn_finished: 'desktop',
        turn_aborted: 'off',
      },
      platform: 'linux',
      spawnDetached: linuxSpawn,
    }).onRecord({ type: 'turn_finished', turnId: 1, timestamp: 100 });

    expect(linuxSpawn).toHaveBeenCalledWith(
      'notify-send',
      ['tmux-play', 'Boss turn finished'],
      { detached: true, stdio: 'ignore' },
    );

    const otherSpawn = vi.fn(() => fakeChild());
    new NotificationObserver({
      notifications: {
        player_finished: 'off',
        turn_finished: 'desktop',
        turn_aborted: 'off',
      },
      platform: 'win32',
      spawnDetached: otherSpawn,
    }).onRecord({ type: 'turn_finished', turnId: 1, timestamp: 100 });

    expect(otherSpawn).not.toHaveBeenCalled();
  });

  it('silences configured turn_aborted notifications for user cancellations', () => {
    const output = { write: vi.fn() };
    const observer = new NotificationObserver({
      notifications: {
        player_finished: 'off',
        turn_finished: 'off',
        turn_aborted: 'bell',
      },
      output,
    });

    for (const reason of ['ESC', 'SIGINT', 'SIGTERM', 'EOF', 'runtime disposed']) {
      observer.onRecord(turnAborted(reason));
    }
    observer.onRecord(turnAborted('captain failed'));

    expect(output.write).toHaveBeenCalledTimes(1);
    expect(output.write).toHaveBeenCalledWith('\x07');
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
      platform: 'linux',
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
