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
  /**
   * Used only for silent terminal notification escapes. Bell notifications
   * are native sound cues and no longer write to stdout.
   */
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
const MACOS_HERO_SOUND = '/System/Library/Sounds/Hero.aiff';
const LINUX_COMPLETE_SOUND_SCRIPT =
  'if command -v canberra-gtk-play >/dev/null 2>&1; then ' +
  'canberra-gtk-play -i complete -d cligent >/dev/null 2>&1 && exit 0; ' +
  'fi; ' +
  'for sound in ' +
  '/usr/share/sounds/freedesktop/stereo/complete.oga ' +
  '/usr/share/sounds/sound-theme-freedesktop/stereo/complete.oga; do ' +
  '[ -r "$sound" ] || continue; ' +
  'if command -v paplay >/dev/null 2>&1; then exec paplay "$sound"; ' +
  'elif command -v pw-play >/dev/null 2>&1; then exec pw-play "$sound"; ' +
  'fi; ' +
  'done';
const WINDOWS_COMPLETE_SOUND_SCRIPT =
  "$path = Join-Path $env:WINDIR 'Media\\Windows Notify System Generic.wav'; " +
  'if (Test-Path $path) { ' +
  '$player = New-Object System.Media.SoundPlayer $path; ' +
  '$player.PlaySync(); ' +
  '} else { ' +
  '[System.Media.SystemSounds]::Asterisk.Play(); ' +
  'Start-Sleep -Milliseconds 300; ' +
  '}';

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

      this.notify(event, this.notifications[event], messageForRecord(record));
    } catch {
      // Notifications are deliberately best-effort and must not affect runtime
      // record delivery.
    }
  }

  private notify(
    event: NotificationEvent,
    sink: NotificationSink,
    message: NotificationMessage,
  ): void {
    try {
      if (sink === 'bell') {
        playSoundCue({
          platform: this.platform,
          spawnDetached: this.spawnDetached,
        });
      } else if (sink === 'desktop') {
        if (event === 'turn_finished') {
          sendSilentTerminalTurnFinishedNotification({
            message,
            output: this.output,
            platform: this.platform,
          });
        }
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

interface SoundCueOptions {
  readonly platform: NodeJS.Platform;
  readonly spawnDetached: DetachedNotificationSpawner;
}

interface SilentTerminalNotificationOptions {
  readonly message: NotificationMessage;
  readonly output: Pick<Writable, 'write'>;
  readonly platform: NodeJS.Platform;
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

function sendSilentTerminalTurnFinishedNotification(
  options: SilentTerminalNotificationOptions,
): void {
  if (options.platform !== 'darwin') {
    return;
  }

  try {
    const message = terminalOscPayload(
      `${options.message.title}: ${options.message.body}`,
    );
    options.output.write(`\x1b]9;${message}\x1b\\`);
  } catch {
    // Terminal notification escapes are best-effort like OS notifications.
  }
}

function playSoundCue(options: SoundCueOptions): void {
  if (options.platform === 'darwin') {
    spawnBestEffort(options, 'afplay', [MACOS_HERO_SOUND]);
  } else if (options.platform === 'linux') {
    spawnBestEffort(options, 'sh', ['-c', LINUX_COMPLETE_SOUND_SCRIPT]);
  } else if (options.platform === 'win32') {
    spawnBestEffort(options, 'powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      WINDOWS_COMPLETE_SOUND_SCRIPT,
    ]);
  }
}

function spawnBestEffort(
  options: { readonly spawnDetached: DetachedNotificationSpawner },
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

function terminalOscPayload(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ');
}
