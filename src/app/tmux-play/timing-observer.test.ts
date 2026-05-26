// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';
import type { TmuxPlayRecord } from './records.js';
import {
  TimingObserver,
  TMUX_PANE_TIMER_RUNNING_OPTION,
  TMUX_PANE_TIMER_TEXT_OPTION,
  TMUX_STATUS_TIMER_RUNNING_OPTION,
  TMUX_STATUS_TIMER_TEXT_OPTION,
  type TimingScheduler,
  type TimingTmuxClient,
} from './timing-observer.js';

describe('TimingObserver', () => {
  it('pushes frozen zero timers for configured players before any player records', () => {
    const tmux = fakeTmuxClient();
    const observer = new TimingObserver({
      sessionName: 'tmux-play-test',
      captainAdapter: 'claude',
      players: [
        { id: 'coder', adapter: 'codex' },
        { id: 'reviewer', adapter: 'gemini' },
      ],
      tmux,
      scheduler: fakeScheduler().scheduler,
    });

    observer.refresh(0);

    expect(latestPaneOption(tmux, '%0', TMUX_PANE_TIMER_TEXT_OPTION)).toBe('0s');
    expect(latestPaneOption(tmux, '%0', TMUX_PANE_TIMER_RUNNING_OPTION)).toBe('0');
    expect(latestPaneOption(tmux, '%1', TMUX_PANE_TIMER_TEXT_OPTION)).toBe('0s');
    expect(latestPaneOption(tmux, '%1', TMUX_PANE_TIMER_RUNNING_OPTION)).toBe('0');
    expect(latestPaneOption(tmux, '%2', TMUX_PANE_TIMER_TEXT_OPTION)).toBe('0s');
    expect(latestPaneOption(tmux, '%2', TMUX_PANE_TIMER_RUNNING_OPTION)).toBe('0');
  });

  it('refreshes live timers at 1 Hz and settles on turn completion', () => {
    let now = 0;
    const tmux = fakeTmuxClient();
    const schedulerState = fakeScheduler();
    const observer = new TimingObserver({
      sessionName: 'tmux-play-test',
      captainAdapter: 'claude',
      players: [
        { id: 'coder', adapter: 'codex' },
        { id: 'reviewer', adapter: 'gemini' },
      ],
      now: () => now,
      tmux,
      scheduler: schedulerState.scheduler,
    });

    observer.onRecord(turnStarted(1000));
    expect(schedulerState.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      1000,
    );

    observer.onRecord(playerPrompt('coder', 2000));
    observer.onRecord(captainPrompt(4000));
    now = 7000;
    schedulerState.tick();

    expect(latestPaneOption(tmux, '%1', TMUX_PANE_TIMER_TEXT_OPTION)).toBe('5s');
    expect(latestPaneOption(tmux, '%1', TMUX_PANE_TIMER_RUNNING_OPTION)).toBe('1');
    expect(latestPaneOption(tmux, '%0', TMUX_PANE_TIMER_TEXT_OPTION)).toBe('3s');
    expect(latestPaneOption(tmux, '%0', TMUX_PANE_TIMER_RUNNING_OPTION)).toBe('1');
    expect(latestSessionOption(tmux, TMUX_STATUS_TIMER_TEXT_OPTION)).toBe('6s');
    expect(latestSessionOption(tmux, TMUX_STATUS_TIMER_RUNNING_OPTION)).toBe('1');

    observer.onRecord(playerFinished('coder', 8000));
    observer.onRecord(captainFinished(9000));
    observer.onRecord(turnFinished(11000));

    expect(latestPaneOption(tmux, '%1', TMUX_PANE_TIMER_TEXT_OPTION)).toBe('6s');
    expect(latestPaneOption(tmux, '%1', TMUX_PANE_TIMER_RUNNING_OPTION)).toBe('0');
    expect(latestPaneOption(tmux, '%0', TMUX_PANE_TIMER_TEXT_OPTION)).toBe('5s');
    expect(latestPaneOption(tmux, '%0', TMUX_PANE_TIMER_RUNNING_OPTION)).toBe('0');
    expect(latestSessionOption(tmux, TMUX_STATUS_TIMER_TEXT_OPTION)).toBe('10s');
    expect(latestSessionOption(tmux, TMUX_STATUS_TIMER_RUNNING_OPTION)).toBe('0');
    expect(schedulerState.clearInterval).toHaveBeenCalledWith('interval-1');
  });

  it('clears an active refresh interval on dispose', () => {
    const schedulerState = fakeScheduler();
    const observer = new TimingObserver({
      sessionName: 'tmux-play-test',
      captainAdapter: 'claude',
      players: [],
      tmux: fakeTmuxClient(),
      scheduler: schedulerState.scheduler,
    });

    observer.onRecord(turnStarted(1000));
    observer.dispose();

    expect(schedulerState.clearInterval).toHaveBeenCalledWith('interval-1');
  });
});

interface FakeTmuxClient extends TimingTmuxClient {
  readonly paneOptions: Array<{
    readonly paneTarget: string;
    readonly option: string;
    readonly value: string;
  }>;
  readonly sessionOptions: Array<{
    readonly sessionName: string;
    readonly option: string;
    readonly value: string;
  }>;
}

function fakeTmuxClient(): FakeTmuxClient {
  const paneTargets = new Map([
    ['Captain · claude', '%0'],
    ['Coder · codex', '%1'],
    ['Reviewer · gemini', '%2'],
  ]);
  return {
    paneOptions: [],
    sessionOptions: [],
    queryPaneTargetsByTitle: () => paneTargets,
    setPaneOption(paneTarget, option, value) {
      this.paneOptions.push({ paneTarget, option, value });
    },
    setSessionOption(sessionName, option, value) {
      this.sessionOptions.push({ sessionName, option, value });
    },
  };
}

function fakeScheduler(): {
  readonly scheduler: TimingScheduler;
  readonly setInterval: ReturnType<typeof vi.fn>;
  readonly clearInterval: ReturnType<typeof vi.fn>;
  tick(): void;
} {
  let callback: (() => void) | undefined;
  const setIntervalMock = vi.fn((nextCallback: () => void) => {
    callback = nextCallback;
    return 'interval-1';
  });
  const clearIntervalMock = vi.fn();

  return {
    scheduler: {
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    },
    setInterval: setIntervalMock,
    clearInterval: clearIntervalMock,
    tick() {
      callback?.();
    },
  };
}

function latestPaneOption(
  tmux: FakeTmuxClient,
  paneTarget: string,
  option: string,
): string | undefined {
  return tmux.paneOptions
    .filter((entry) => entry.paneTarget === paneTarget && entry.option === option)
    .at(-1)?.value;
}

function latestSessionOption(
  tmux: FakeTmuxClient,
  option: string,
): string | undefined {
  return tmux.sessionOptions
    .filter((entry) => entry.option === option)
    .at(-1)?.value;
}

function turnStarted(timestamp: number): TmuxPlayRecord {
  return {
    type: 'turn_started',
    turnId: 1,
    timestamp,
    turn: { id: 1, prompt: 'work', timestamp },
  };
}

function turnFinished(timestamp: number): TmuxPlayRecord {
  return { type: 'turn_finished', turnId: 1, timestamp };
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
