// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import {
  defaultNotificationConfig,
  type NotificationConfig,
  type NotificationEvent,
  type NotificationSink,
} from './config.js';
import type { RecordObserver, TmuxPlayRecord } from './records.js';

export interface NotificationObserverOptions {
  readonly notifications?: NotificationConfig;
  readonly output?: Pick<Writable, 'write'>;
  readonly platform?: NodeJS.Platform;
  readonly spawnDetached?: DetachedNotificationSpawner;
}

export type DetachedNotificationSpawner = (
  command: string,
  args: readonly string[],
  options: { readonly detached: true; readonly stdio: 'ignore' },
) => ChildProcessLike;

export type ChildProcessLike = Pick<ChildProcess, 'on' | 'unref'>;

const USER_ABORT_REASONS = new Set([
  'ESC',
  'SIGINT',
  'SIGTERM',
  'EOF',
  'runtime disposed',
]);

export class NotificationObserver implements RecordObserver {
  private readonly notifications: NotificationConfig;
  private readonly output: Pick<Writable, 'write'>;
  private readonly platform: NodeJS.Platform;
  private readonly spawnDetached: DetachedNotificationSpawner;

  constructor(options: NotificationObserverOptions = {}) {
    this.notifications = options.notifications ?? defaultNotificationConfig();
    this.output = options.output ?? process.stdout;
    this.platform = options.platform ?? process.platform;
    this.spawnDetached = options.spawnDetached ?? spawnDetachedNotification;
  }

  onRecord(record: TmuxPlayRecord): void {
    try {
      const event = notificationEvent(record);
      if (!event) {
        return;
      }
      if (record.type === 'turn_aborted' && isUserAbort(record.reason)) {
        return;
      }

      this.notify(this.notifications[event], messageForRecord(record));
    } catch {
      // Notifications are deliberately best-effort and must not affect runtime
      // record delivery.
    }
  }

  private notify(sink: NotificationSink, message: NotificationMessage): void {
    try {
      if (sink === 'bell') {
        this.output.write('\x07');
      } else if (sink === 'desktop') {
        sendDesktopNotification({
          ...message,
          platform: this.platform,
          spawnDetached: this.spawnDetached,
        });
      }
    } catch {
      // Sink failures are swallowed so the observer never throws.
    }
  }
}

export function createNotificationObserver(
  options: NotificationObserverOptions = {},
): NotificationObserver {
  return new NotificationObserver(options);
}

interface NotificationMessage {
  readonly title: string;
  readonly body: string;
}

interface DesktopNotificationOptions extends NotificationMessage {
  readonly platform: NodeJS.Platform;
  readonly spawnDetached: DetachedNotificationSpawner;
}

function notificationEvent(
  record: TmuxPlayRecord,
): NotificationEvent | undefined {
  switch (record.type) {
    case 'player_finished':
    case 'turn_finished':
    case 'turn_aborted':
      return record.type;
    default:
      return undefined;
  }
}

function messageForRecord(record: TmuxPlayRecord): NotificationMessage {
  switch (record.type) {
    case 'player_finished':
      return {
        title: 'tmux-play',
        body: `${record.playerId} finished: ${record.result.status}`,
      };
    case 'turn_finished':
      return { title: 'tmux-play', body: 'Boss turn finished' };
    case 'turn_aborted':
      return {
        title: 'tmux-play',
        body: record.reason
          ? `Boss turn aborted: ${record.reason}`
          : 'Boss turn aborted',
      };
    default:
      return { title: 'tmux-play', body: '' };
  }
}

function isUserAbort(reason: string | undefined): boolean {
  return reason !== undefined && USER_ABORT_REASONS.has(reason);
}

function sendDesktopNotification(options: DesktopNotificationOptions): void {
  if (options.platform === 'darwin') {
    spawnBestEffort(options, 'osascript', [
      '-e',
      `display notification ${appleScriptString(options.body)} with title ${appleScriptString(options.title)}`,
    ]);
  } else if (options.platform === 'linux') {
    spawnBestEffort(options, 'notify-send', [options.title, options.body]);
  }
}

function spawnBestEffort(
  options: DesktopNotificationOptions,
  command: string,
  args: readonly string[],
): void {
  try {
    const child = options.spawnDetached(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      // Missing binaries or notification-daemon failures are ignored.
    });
    child.unref();
  } catch {
    // Synchronous spawn failures are ignored.
  }
}

function spawnDetachedNotification(
  command: string,
  args: readonly string[],
  options: { readonly detached: true; readonly stdio: 'ignore' },
): ChildProcessLike {
  return spawn(command, args, options);
}

function appleScriptString(value: string): string {
  return JSON.stringify(value);
}
