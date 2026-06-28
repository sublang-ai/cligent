// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runTmuxMock } = vi.hoisted(() => ({ runTmuxMock: vi.fn() }));

// `buildPlayerArea` (reused from the launcher) drives the rebuild through the
// shared `runTmux`, so mocking the module captures the observer's kill /
// recreate / focus command sequence without a real tmux server.
vi.mock('../shared/tmux.js', () => ({
  attachTmuxSession: vi.fn(),
  isTmuxAvailable: vi.fn(() => true),
  runTmux: runTmuxMock,
}));

import { createLayoutObserver } from './layout-observer.js';
import type { LayoutObserverOptions } from './layout-observer.js';
import type { LayoutConfig } from './config.js';
import type { PlayerConfig } from './players.js';
import type { PlayerViewChangedRecord, TmuxPlayRecord } from './records.js';

const SESSION = 'tmux-play-x';
const WORK_DIR = '/wd';

const PLAYERS: PlayerConfig[] = [
  { id: 'coder', adapter: 'codex' },
  { id: 'reviewer', adapter: 'codex' },
  { id: 'analyst', adapter: 'codex' },
];

const LAYOUT: LayoutConfig = {
  window: { columns: 174, rows: 49 },
  initialVisible: ['coder', 'reviewer'],
  singlePlayerColumnWeights: [1, 1],
  multiPlayerColumnWeights: [1, 1, 1],
  columnWeights: [1, 1, 1],
};

function makeObserver(overrides: Partial<LayoutObserverOptions> = {}) {
  return createLayoutObserver({
    sessionName: SESSION,
    workDir: WORK_DIR,
    players: PLAYERS,
    layout: LAYOUT,
    captainAdapter: 'claude',
    themeFlavor: 'mocha',
    initialVisible: ['coder', 'reviewer'],
    ...overrides,
  });
}

function viewChanged(visiblePlayerIds: string[]): PlayerViewChangedRecord {
  return {
    type: 'player_view_changed',
    turnId: 1,
    timestamp: 0,
    visiblePlayerIds,
  };
}

function splitCalls(): unknown[][] {
  return runTmuxMock.mock.calls.filter((call) => call[0] === 'split-window');
}

describe('LayoutObserver', () => {
  beforeEach(() => {
    runTmuxMock.mockReset();
    runTmuxMock.mockReturnValue(undefined);
  });

  it('rebuilds the player area for an accepted change: kill non-Boss panes, recreate in order with a bounded tail, restore Boss focus (TTMUX-085)', () => {
    const observer = makeObserver();
    observer.onRecord(viewChanged(['analyst', 'coder']));

    const calls = runTmuxMock.mock.calls;
    // First command kills every pane except the Boss/Captain pane.
    expect(calls[0]).toEqual(['kill-pane', '-a', '-t', `${SESSION}:0.0`]);
    // Last command restores Boss focus.
    expect(calls.at(-1)).toEqual(['select-pane', '-t', `${SESSION}:0.0`]);

    // Two visible players -> two splits, in `visiblePlayerIds` order, each a
    // bounded `tail -n 200 -f` recent-log view.
    const splits = splitCalls();
    expect(splits).toHaveLength(2);
    expect(String(splits[0]?.at(-1))).toContain('tail -n 200 -f');
    expect(String(splits[0]?.at(-1))).toContain('analyst.log');
    expect(String(splits[1]?.at(-1))).toContain('tail -n 200 -f');
    expect(String(splits[1]?.at(-1))).toContain('coder.log');

    // Titles reapplied for the recreated visible panes.
    expect(runTmuxMock.mock.calls).toContainEqual(
      expect.arrayContaining(['Analyst · codex']),
    );
    expect(runTmuxMock.mock.calls).toContainEqual(
      expect.arrayContaining(['Coder · codex']),
    );
  });

  it('treats a record repeating the tracked visible set as a no-op (TTMUX-085)', () => {
    const observer = makeObserver();
    // Same ids in the same order as the initial visible set.
    observer.onRecord(viewChanged(['coder', 'reviewer']));
    expect(runTmuxMock).not.toHaveBeenCalled();
  });

  it('treats a reordering of the same players as a change', () => {
    const observer = makeObserver();
    observer.onRecord(viewChanged(['reviewer', 'coder']));
    expect(runTmuxMock).toHaveBeenCalledWith(
      'kill-pane',
      '-a',
      '-t',
      `${SESSION}:0.0`,
    );
  });

  it('reconstructs a re-shown hidden player as a single-player pane', () => {
    const observer = makeObserver();
    // Show only `analyst` (hidden at startup) -> single-player column shape.
    observer.onRecord(viewChanged(['analyst']));
    const splits = splitCalls();
    expect(splits).toHaveLength(1);
    expect(String(splits[0]?.at(-1))).toContain('tail -n 200 -f');
    expect(String(splits[0]?.at(-1))).toContain('analyst.log');
  });

  it('ignores records other than player_view_changed', () => {
    const observer = makeObserver();
    const turnStarted: TmuxPlayRecord = {
      type: 'turn_started',
      turnId: 1,
      timestamp: 0,
      turn: { id: 1, prompt: 'p', timestamp: 0 },
    };
    observer.onRecord(turnStarted);
    observer.onRecord({ type: 'turn_finished', turnId: 1, timestamp: 0 });
    expect(runTmuxMock).not.toHaveBeenCalled();
  });

  it('swallows a tmux failure without throwing and leaves the tracked set unchanged (TTMUX-085)', () => {
    const errors: unknown[] = [];
    runTmuxMock.mockImplementation((...args: unknown[]) => {
      if (args[0] === 'kill-pane') {
        throw new Error('boom');
      }
    });
    const observer = makeObserver({ onError: (error) => errors.push(error) });

    // The rebuild fails at the kill step; onRecord must not throw into dispatch.
    expect(() => observer.onRecord(viewChanged(['analyst']))).not.toThrow();
    expect(errors).toHaveLength(1);

    // The tracked set is unchanged: a record repeating the INITIAL set is now a
    // no-op, proving the failed change did not advance the tracked list.
    runTmuxMock.mockReset();
    runTmuxMock.mockReturnValue(undefined);
    observer.onRecord(viewChanged(['coder', 'reviewer']));
    expect(runTmuxMock).not.toHaveBeenCalled();
  });

  it('swallows a throwing onError so the failure reporter cannot abort dispatch (TMUX-083)', () => {
    runTmuxMock.mockImplementation((...args: unknown[]) => {
      if (args[0] === 'kill-pane') {
        throw new Error('boom');
      }
    });
    const observer = makeObserver({
      onError: () => {
        throw new Error('reporter exploded');
      },
    });
    // The rebuild fails and the onError reporter also throws; neither may
    // escape onRecord into the dispatcher.
    expect(() => observer.onRecord(viewChanged(['analyst']))).not.toThrow();
  });
});
