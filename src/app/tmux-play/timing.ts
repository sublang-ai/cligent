// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { TmuxPlayRecord } from './records.js';

export interface TimerValue {
  readonly elapsedMs: number;
  readonly running: boolean;
}

export interface TimingSnapshot {
  readonly roles: ReadonlyMap<string, TimerValue>;
  readonly captain: TimerValue;
  readonly total: TimerValue;
}

export class TmuxPlayTiming {
  private readonly roleTotals = new Map<string, number>();
  private readonly roleOpenStarts = new Map<string, number[]>();
  private captainTotal = 0;
  private readonly captainOpenStarts: number[] = [];
  private total = 0;
  private readonly turnOpenStarts: number[] = [];

  apply(record: TmuxPlayRecord): void {
    switch (record.type) {
      case 'role_prompt':
        this.openRole(record.roleId, record.timestamp);
        break;
      case 'role_finished':
        this.closeRole(record.roleId, record.timestamp);
        break;
      case 'captain_prompt':
        this.captainOpenStarts.push(record.timestamp);
        break;
      case 'captain_finished':
        this.captainTotal += closeOne(this.captainOpenStarts, record.timestamp);
        break;
      case 'turn_started':
        this.turnOpenStarts.push(record.timestamp);
        break;
      case 'turn_finished':
      case 'turn_aborted':
        this.total += closeOne(this.turnOpenStarts, record.timestamp);
        break;
      default:
        break;
    }
  }

  snapshot(now: number): TimingSnapshot {
    const roles = new Map<string, TimerValue>();
    for (const roleId of this.roleIds()) {
      roles.set(roleId, {
        elapsedMs: this.roleElapsedMs(roleId, now),
        running: (this.roleOpenStarts.get(roleId)?.length ?? 0) > 0,
      });
    }

    return {
      roles,
      captain: {
        elapsedMs: elapsedMs(this.captainTotal, this.captainOpenStarts, now),
        running: this.captainOpenStarts.length > 0,
      },
      total: {
        elapsedMs: elapsedMs(this.total, this.turnOpenStarts, now),
        running: this.turnOpenStarts.length > 0,
      },
    };
  }

  private openRole(roleId: string, timestamp: number): void {
    this.ensureRole(roleId);
    this.roleOpenStarts.get(roleId)?.push(timestamp);
  }

  private closeRole(roleId: string, timestamp: number): void {
    this.ensureRole(roleId);
    const openStarts = this.roleOpenStarts.get(roleId) ?? [];
    const priorTotal = this.roleTotals.get(roleId) ?? 0;
    this.roleTotals.set(roleId, priorTotal + closeOne(openStarts, timestamp));
  }

  private roleElapsedMs(roleId: string, now: number): number {
    return elapsedMs(
      this.roleTotals.get(roleId) ?? 0,
      this.roleOpenStarts.get(roleId) ?? [],
      now,
    );
  }

  private ensureRole(roleId: string): void {
    if (!this.roleTotals.has(roleId)) {
      this.roleTotals.set(roleId, 0);
    }
    if (!this.roleOpenStarts.has(roleId)) {
      this.roleOpenStarts.set(roleId, []);
    }
  }

  private roleIds(): string[] {
    return [
      ...new Set([...this.roleTotals.keys(), ...this.roleOpenStarts.keys()]),
    ].sort();
  }
}

export function formatTimerDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h${pad2(minutes)}m`;
  }
  if (totalMinutes > 0) {
    return `${totalMinutes}m${pad2(seconds)}s`;
  }
  return `${seconds}s`;
}

function closeOne(openStarts: number[], end: number): number {
  const start = openStarts.shift();
  return start === undefined ? 0 : intervalMs(start, end);
}

function elapsedMs(closed: number, openStarts: readonly number[], now: number): number {
  return openStarts.reduce((sum, start) => sum + intervalMs(start, now), closed);
}

function intervalMs(start: number, end: number): number {
  return Math.max(0, end - start);
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}
