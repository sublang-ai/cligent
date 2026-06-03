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
      playerPrompt('coder', 100),
      playerFinished('coder', 1100),
      playerPrompt('reviewer', 2000),
      playerFinished('reviewer', 3500),
      playerPrompt('coder', 5000),
      playerFinished('coder', 8000),
      captainPrompt(9000),
      captainFinished(12000),
      turnFinished(1, 15000),
      turnStarted(2, 25000),
      turnFinished(2, 30000),
    ]);

    const snapshot = timing.snapshot(60000);

    expect(snapshot.players.get('coder')).toEqual({
      elapsedMs: 4000,
      running: false,
    });
    expect(snapshot.players.get('reviewer')).toEqual({
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
      playerPrompt('coder', 2000),
      captainPrompt(4000),
    ]);

    expect(timing.snapshot(7000)).toEqual({
      players: new Map([['coder', { elapsedMs: 5000, running: true }]]),
      captain: { elapsedMs: 3000, running: true },
      total: { elapsedMs: 6000, running: true },
    });

    applyAll(timing, [playerFinished('coder', 8000), captainFinished(9000)]);

    const snapshot = timing.snapshot(10000);
    expect(snapshot.players.get('coder')).toEqual({
      elapsedMs: 6000,
      running: false,
    });
    expect(snapshot.captain).toEqual({ elapsedMs: 5000, running: false });
    expect(snapshot.total).toEqual({ elapsedMs: 9000, running: true });
  });

  it('formats timer durations in hh:mm:ss form per TMUX-071', () => {
    // Every magnitude renders as three colon-separated, 2-digit-padded
    // components so the column width stays stable across consecutive
    // seconds.
    expect(formatTimerDuration(0)).toBe('00:00:00');
    expect(formatTimerDuration(12_999)).toBe('00:00:12');
    expect(formatTimerDuration(59_000)).toBe('00:00:59');
    expect(formatTimerDuration(60_000)).toBe('00:01:00');
    expect(formatTimerDuration(187_000)).toBe('00:03:07');
    expect(formatTimerDuration(3_600_000)).toBe('01:00:00');
    expect(formatTimerDuration(3_723_000)).toBe('01:02:03');
    // The hour boundary surfaces with seconds intact (no `1h02m` rollup
    // that would drop the seconds component).
    expect(formatTimerDuration(3_720_000)).toBe('01:02:00');
    // The hours field expands beyond two digits past 100 h so the
    // format stays monotonic across every magnitude.
    expect(formatTimerDuration(100 * 3_600_000)).toBe('100:00:00');
    // Negative input clamps to zero rather than rendering a negative
    // duration.
    expect(formatTimerDuration(-1)).toBe('00:00:00');
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

function playerPrompt(playerId: string, timestamp: number): TmuxPlayRecord {
  return {
    type: 'player_prompt',
    turnId: 1,
    timestamp,
    playerId,
    prompt: 'work',
  };
}

function playerFinished(playerId: string, timestamp: number): TmuxPlayRecord {
  return {
    type: 'player_finished',
    turnId: 1,
    timestamp,
    playerId,
    result: { playerId, turnId: 1, status: 'ok' },
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
