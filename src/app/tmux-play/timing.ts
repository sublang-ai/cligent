// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { TmuxPlayRecord } from './records.js';

export interface TimerValue {
  readonly elapsedMs: number;
  readonly running: boolean;
}

export interface TimingSnapshot {
  readonly players: ReadonlyMap<string, TimerValue>;
  readonly captain: TimerValue;
  readonly total: TimerValue;
}

export class TmuxPlayTiming {
  private readonly playerTotals = new Map<string, number>();
  private readonly playerOpenStarts = new Map<string, number[]>();
  private captainTotal = 0;
  private readonly captainOpenStarts: number[] = [];
  private total = 0;
  private readonly turnOpenStarts: number[] = [];

  apply(record: TmuxPlayRecord): void {
    switch (record.type) {
      case 'player_prompt':
        this.openPlayer(record.playerId, record.timestamp);
        break;
      case 'player_finished':
        this.closePlayer(record.playerId, record.timestamp);
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
    const players = new Map<string, TimerValue>();
    for (const playerId of this.playerIds()) {
      players.set(playerId, {
        elapsedMs: this.playerElapsedMs(playerId, now),
        running: (this.playerOpenStarts.get(playerId)?.length ?? 0) > 0,
      });
    }

    return {
      players,
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

  private openPlayer(playerId: string, timestamp: number): void {
    this.ensurePlayer(playerId);
    this.playerOpenStarts.get(playerId)?.push(timestamp);
  }

  private closePlayer(playerId: string, timestamp: number): void {
    this.ensurePlayer(playerId);
    const openStarts = this.playerOpenStarts.get(playerId) ?? [];
    const priorTotal = this.playerTotals.get(playerId) ?? 0;
    this.playerTotals.set(playerId, priorTotal + closeOne(openStarts, timestamp));
  }

  private playerElapsedMs(playerId: string, now: number): number {
    return elapsedMs(
      this.playerTotals.get(playerId) ?? 0,
      this.playerOpenStarts.get(playerId) ?? [],
      now,
    );
  }

  private ensurePlayer(playerId: string): void {
    if (!this.playerTotals.has(playerId)) {
      this.playerTotals.set(playerId, 0);
    }
    if (!this.playerOpenStarts.has(playerId)) {
      this.playerOpenStarts.set(playerId, []);
    }
  }

  private playerIds(): string[] {
    return [
      ...new Set([...this.playerTotals.keys(), ...this.playerOpenStarts.keys()]),
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
