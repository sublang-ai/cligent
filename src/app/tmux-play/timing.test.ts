// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import type { TmuxPlayRecord } from './records.js';
import { TmuxPlayTiming, formatTimerDuration } from './timing.js';

describe('TmuxPlayTiming', () => {
  it('accumulates active intervals and excludes idle gaps', () => {
    const timing = new TmuxPlayTiming();

    applyAll(timing, [
      turnStarted(1, 0),
      rolePrompt('coder', 100),
      roleFinished('coder', 1100),
      rolePrompt('reviewer', 2000),
      roleFinished('reviewer', 3500),
      rolePrompt('coder', 5000),
      roleFinished('coder', 8000),
      captainPrompt(9000),
      captainFinished(12000),
      turnFinished(1, 15000),
      turnStarted(2, 25000),
      turnFinished(2, 30000),
    ]);

    const snapshot = timing.snapshot(60000);

    expect(snapshot.roles.get('coder')).toEqual({
      elapsedMs: 4000,
      running: false,
    });
    expect(snapshot.roles.get('reviewer')).toEqual({
      elapsedMs: 1500,
      running: false,
    });
    expect(snapshot.captain).toEqual({ elapsedMs: 3000, running: false });
    expect(snapshot.total).toEqual({ elapsedMs: 20000, running: false });
  });

  it('computes live values for open runs using a supplied now', () => {
    const timing = new TmuxPlayTiming();

    applyAll(timing, [
      turnStarted(1, 1000),
      rolePrompt('coder', 2000),
      captainPrompt(4000),
    ]);

    expect(timing.snapshot(7000)).toEqual({
      roles: new Map([['coder', { elapsedMs: 5000, running: true }]]),
      captain: { elapsedMs: 3000, running: true },
      total: { elapsedMs: 6000, running: true },
    });

    applyAll(timing, [roleFinished('coder', 8000), captainFinished(9000)]);

    const snapshot = timing.snapshot(10000);
    expect(snapshot.roles.get('coder')).toEqual({
      elapsedMs: 6000,
      running: false,
    });
    expect(snapshot.captain).toEqual({ elapsedMs: 5000, running: false });
    expect(snapshot.total).toEqual({ elapsedMs: 9000, running: true });
  });

  it('formats timer durations for seconds, minutes, and hours', () => {
    expect(formatTimerDuration(0)).toBe('0s');
    expect(formatTimerDuration(12_999)).toBe('12s');
    expect(formatTimerDuration(187_000)).toBe('3m07s');
    expect(formatTimerDuration(3_720_000)).toBe('1h02m');
    expect(formatTimerDuration(-1)).toBe('0s');
  });
});

function applyAll(
  timing: TmuxPlayTiming,
  records: readonly TmuxPlayRecord[],
): void {
  for (const record of records) {
    timing.apply(record);
  }
}

function turnStarted(turnId: number, timestamp: number): TmuxPlayRecord {
  return {
    type: 'turn_started',
    turnId,
    timestamp,
    turn: { id: turnId, prompt: `turn ${turnId}`, timestamp },
  };
}

function turnFinished(turnId: number, timestamp: number): TmuxPlayRecord {
  return { type: 'turn_finished', turnId, timestamp };
}

function rolePrompt(roleId: string, timestamp: number): TmuxPlayRecord {
  return {
    type: 'role_prompt',
    turnId: 1,
    timestamp,
    roleId,
    prompt: 'work',
  };
}

function roleFinished(roleId: string, timestamp: number): TmuxPlayRecord {
  return {
    type: 'role_finished',
    turnId: 1,
    timestamp,
    roleId,
    result: { roleId, turnId: 1, status: 'ok' },
  };
}

function captainPrompt(timestamp: number): TmuxPlayRecord {
  return {
    type: 'captain_prompt',
    turnId: 1,
    timestamp,
    prompt: 'summarize',
  };
}

function captainFinished(timestamp: number): TmuxPlayRecord {
  return {
    type: 'captain_finished',
    turnId: 1,
    timestamp,
    result: { turnId: 1, status: 'ok' },
  };
}
