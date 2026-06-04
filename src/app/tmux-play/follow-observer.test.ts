// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import type { CligentEvent } from '../../types.js';
import {
  FollowObserver,
  type CreateFollowObserverOptions,
  type FollowTmuxClient,
} from './follow-observer.js';
import type { RunStatus } from './contract.js';
import type { TmuxPlayRecord } from './records.js';

const CAPTAIN_PANE = '%0';
const CODER_PANE = '%1';
const REVIEWER_PANE = '%2';

describe('FollowObserver', () => {
  it('follows a flushed text block, not the buffered text_delta in isolation', () => {
    const { observer, followed } = makeObserver();

    // The presenter buffers the delta into the open block (no write yet).
    observer.onRecord(captainEvent(textDelta('hello')));
    expect(followed).toEqual([]);

    // `captain_finished` flushes the block — the accumulated text reaches the
    // pane, so the follow fires once on the boss pane.
    observer.onRecord(captainFinished('ok'));
    expect(followed).toEqual([CAPTAIN_PANE]);
  });

  it('follows the boss pane on tool_use and tool_result lifecycle lines', () => {
    const { observer, followed } = makeObserver();

    observer.onRecord(captainEvent(toolUse()));
    observer.onRecord(captainEvent(toolResult()));

    expect(followed).toEqual([CAPTAIN_PANE, CAPTAIN_PANE]);
  });

  it('follows the player pane on a player-prompt echo', () => {
    const { observer, followed } = makeObserver();

    observer.onRecord(playerPrompt('coder'));

    expect(followed).toEqual([CODER_PANE]);
  });

  it('follows the boss pane on status, turn-aborted, and runtime-error lines', () => {
    const { observer, followed } = makeObserver();

    observer.onRecord(captainStatus());
    observer.onRecord(turnAborted());
    observer.onRecord(runtimeError());

    expect(followed).toEqual([CAPTAIN_PANE, CAPTAIN_PANE, CAPTAIN_PANE]);
  });

  it('does not follow on the no-op control records', () => {
    const { observer, followed } = makeObserver();

    observer.onRecord(turnStarted());
    observer.onRecord(turnFinished());
    observer.onRecord(captainPrompt());
    observer.onRecord(captainTelemetry());

    expect(followed).toEqual([]);
  });

  it('does not follow on suppressed done/error events or events that render to nothing', () => {
    const { observer, followed } = makeObserver();

    observer.onRecord(captainEvent(doneEvent()));
    observer.onRecord(captainEvent(errorEvent()));
    observer.onRecord(captainEvent(initEvent()));

    expect(followed).toEqual([]);
  });

  it('does not follow on hidden captain events or hidden finished records', () => {
    const { observer, followed } = makeObserver();

    // A hidden Captain call (TMUX-072) puts zero bytes on the boss pane — the
    // presenter skips its captain_event and captain_finished records — so none
    // of these may snap a scrolled pane to its tail, regardless of event type
    // or finished status.
    observer.onRecord(hiddenCaptainEvent(toolUse()));
    observer.onRecord(hiddenCaptainEvent(text('done')));
    observer.onRecord(hiddenCaptainEvent(errorEvent()));
    observer.onRecord(hiddenCaptainFinished('ok'));
    observer.onRecord(hiddenCaptainFinished('error'));
    observer.onRecord(hiddenCaptainFinished('aborted'));

    expect(followed).toEqual([]);
  });

  it('keeps hidden captain records from disturbing the visible block state', () => {
    const { observer, followed } = makeObserver();

    // A hidden delta must not enter the pending block, and a hidden finished
    // must not consume one: a hidden ok-finished after a hidden delta never
    // follows...
    observer.onRecord(hiddenCaptainEvent(textDelta('secret')));
    observer.onRecord(hiddenCaptainFinished('ok'));
    expect(followed).toEqual([]);

    // ...and a visible block that a hidden finished cannot flush still follows
    // exactly once when its own visible finished arrives.
    observer.onRecord(captainEvent(textDelta('hello')));
    observer.onRecord(hiddenCaptainFinished('error'));
    expect(followed).toEqual([]);

    observer.onRecord(captainFinished('ok'));
    expect(followed).toEqual([CAPTAIN_PANE]);
  });

  it('does not follow when an all-empty-delta block is flushed by its finished record', () => {
    const { observer, followed } = makeObserver();

    // An empty delta accumulates into a block the presenter flushes to
    // nothing, so the terminal flush writes no bytes and must not follow.
    observer.onRecord(captainEvent(textDelta('')));
    observer.onRecord(captainFinished('ok'));

    expect(followed).toEqual([]);
  });

  it('does not follow when an all-whitespace-delta block is flushed by its finished record', () => {
    const { observer, followed } = makeObserver();

    // The presenter renders a whitespace-only block to nothing (`applyPrefix`
    // returns '' for all-blank rendered text), so these deltas put no bytes on
    // the pane and the terminal `ok` flush must not snap a scrolled pane back.
    observer.onRecord(captainEvent(textDelta('   ')));
    observer.onRecord(captainEvent(textDelta('\n\t')));
    observer.onRecord(captainFinished('ok'));

    expect(followed).toEqual([]);
  });

  it('follows when a whitespace delta is followed by a visible delta, then flushed', () => {
    const { observer, followed } = makeObserver();

    // A leading whitespace delta carries no visible text, but the next delta
    // does, so the accumulated block renders to bytes and the finished flush
    // must follow.
    observer.onRecord(captainEvent(textDelta('  ')));
    observer.onRecord(captainEvent(textDelta('hello')));
    observer.onRecord(captainFinished('ok'));

    expect(followed).toEqual([CAPTAIN_PANE]);
  });

  it('does not follow an all-whitespace non-streaming text event', () => {
    const { observer, followed } = makeObserver();

    // A complete `text` event renders through the same glow pipeline; a
    // whitespace-only body writes no bytes, so it must not follow.
    observer.onRecord(captainEvent(text('   \n')));

    expect(followed).toEqual([]);
  });

  it('follows a visible non-streaming text event', () => {
    const { observer, followed } = makeObserver();

    observer.onRecord(captainEvent(text('done')));

    expect(followed).toEqual([CAPTAIN_PANE]);
  });

  it('follows only the pane that received output, leaving a sibling pane untouched', () => {
    const { observer, followed } = makeObserver();

    observer.onRecord(playerEvent('coder', toolUse()));

    expect(followed).toEqual([CODER_PANE]);
    expect(followed).not.toContain(REVIEWER_PANE);
  });

  it('follows a non-ok finished record even with no buffered text', () => {
    const { observer, followed } = makeObserver();

    observer.onRecord(captainFinished('error'));
    observer.onRecord(playerFinished('coder', 'aborted'));

    expect(followed).toEqual([CAPTAIN_PANE, CODER_PANE]);
  });

  it('does not follow an ok finished record with no buffered text', () => {
    const { observer, followed } = makeObserver();

    observer.onRecord(captainFinished('ok'));

    expect(followed).toEqual([]);
  });

  it('coalesces rapid writes per pane within the debounce window, then follows again after it', () => {
    let now = 1000;
    const { observer, followed } = makeObserver({
      debounceMs: 250,
      now: () => now,
    });

    observer.onRecord(captainEvent(toolUse())); // fires at 1000
    now = 1100;
    observer.onRecord(captainEvent(toolUse())); // 100ms < 250ms: suppressed
    now = 1300;
    observer.onRecord(captainEvent(toolUse())); // 300ms >= 250ms: fires

    expect(followed).toEqual([CAPTAIN_PANE, CAPTAIN_PANE]);
  });

  it('throttles each pane independently', () => {
    let now = 1000;
    const { observer, followed } = makeObserver({
      debounceMs: 250,
      now: () => now,
    });

    observer.onRecord(captainEvent(toolUse())); // boss fires
    observer.onRecord(playerEvent('coder', toolUse())); // coder fires (own window)

    expect(followed).toEqual([CAPTAIN_PANE, CODER_PANE]);
  });

  it('swallows tmux failures so a transient error does not abort the turn', () => {
    const throwingClient: FollowTmuxClient = {
      queryPaneTargetsByTitle: () => paneTargets(),
      followPane: () => {
        throw new Error('tmux gone');
      },
    };
    const observer = new FollowObserver({
      ...baseOptions(),
      debounceMs: 0,
      tmux: throwingClient,
    });

    expect(() => observer.onRecord(captainEvent(toolUse()))).not.toThrow();
  });

  it('does not issue a follow when the destination pane is absent', () => {
    const followed: string[] = [];
    const observer = new FollowObserver({
      ...baseOptions(),
      debounceMs: 0,
      tmux: {
        queryPaneTargetsByTitle: () => new Map(),
        followPane: (target) => followed.push(target),
      },
    });

    observer.onRecord(playerPrompt('coder'));

    expect(followed).toEqual([]);
  });
});

function paneTargets(): Map<string, string> {
  return new Map([
    ['Captain · claude', CAPTAIN_PANE],
    ['Coder · codex', CODER_PANE],
    ['Reviewer · gemini', REVIEWER_PANE],
  ]);
}

function baseOptions(): CreateFollowObserverOptions {
  return {
    sessionName: 'tmux-play-test',
    captainAdapter: 'claude',
    players: [
      { id: 'coder', adapter: 'codex' },
      { id: 'reviewer', adapter: 'gemini' },
    ],
  };
}

function makeObserver(
  overrides: Partial<CreateFollowObserverOptions> = {},
): { observer: FollowObserver; followed: string[] } {
  const followed: string[] = [];
  const targets = paneTargets();
  const observer = new FollowObserver({
    ...baseOptions(),
    debounceMs: 0,
    tmux: {
      queryPaneTargetsByTitle: () => targets,
      followPane: (target) => followed.push(target),
    },
    ...overrides,
  });
  return { observer, followed };
}

// --- record factories -----------------------------------------------------

function turnStarted(): TmuxPlayRecord {
  return {
    type: 'turn_started',
    turnId: 1,
    timestamp: 0,
    turn: { id: 1, prompt: 'work', timestamp: 0 },
  };
}

function turnFinished(): TmuxPlayRecord {
  return { type: 'turn_finished', turnId: 1, timestamp: 0 };
}

function turnAborted(): TmuxPlayRecord {
  return { type: 'turn_aborted', turnId: 1, timestamp: 0, reason: 'stopped' };
}

function captainPrompt(): TmuxPlayRecord {
  return { type: 'captain_prompt', turnId: 1, timestamp: 0, prompt: 'go' };
}

function captainTelemetry(): TmuxPlayRecord {
  return {
    type: 'captain_telemetry',
    turnId: 1,
    timestamp: 0,
    topic: 'usage',
    payload: {},
  };
}

function captainStatus(): TmuxPlayRecord {
  return {
    type: 'captain_status',
    turnId: 1,
    timestamp: 0,
    message: 'thinking',
  };
}

function runtimeError(): TmuxPlayRecord {
  return { type: 'runtime_error', turnId: 1, timestamp: 0, message: 'boom' };
}

function captainEvent(event: CligentEvent): TmuxPlayRecord {
  return { type: 'captain_event', turnId: 1, timestamp: 0, event };
}

function captainFinished(status: RunStatus): TmuxPlayRecord {
  return {
    type: 'captain_finished',
    turnId: 1,
    timestamp: 0,
    result: { turnId: 1, status },
  };
}

function hiddenCaptainEvent(event: CligentEvent): TmuxPlayRecord {
  return {
    type: 'captain_event',
    turnId: 1,
    timestamp: 0,
    event,
    visibility: 'hidden',
  };
}

function hiddenCaptainFinished(status: RunStatus): TmuxPlayRecord {
  return {
    type: 'captain_finished',
    turnId: 1,
    timestamp: 0,
    result: { turnId: 1, status },
    visibility: 'hidden',
  };
}

function playerPrompt(playerId: string): TmuxPlayRecord {
  return {
    type: 'player_prompt',
    turnId: 1,
    timestamp: 0,
    playerId,
    prompt: 'work',
  };
}

function playerEvent(playerId: string, event: CligentEvent): TmuxPlayRecord {
  return { type: 'player_event', turnId: 1, timestamp: 0, playerId, event };
}

function playerFinished(playerId: string, status: RunStatus): TmuxPlayRecord {
  return {
    type: 'player_finished',
    turnId: 1,
    timestamp: 0,
    playerId,
    result: { playerId, turnId: 1, status },
  };
}

// --- event factories ------------------------------------------------------

function textDelta(delta: string): CligentEvent {
  return { type: 'text_delta', payload: { delta } } as CligentEvent;
}

function text(content: string): CligentEvent {
  return { type: 'text', payload: { content } } as CligentEvent;
}

function toolUse(): CligentEvent {
  return {
    type: 'tool_use',
    payload: { toolName: 'Bash', input: { command: 'ls' } },
  } as CligentEvent;
}

function toolResult(): CligentEvent {
  return {
    type: 'tool_result',
    payload: { toolName: 'Bash', status: 'ok', output: 'out' },
  } as CligentEvent;
}

function doneEvent(): CligentEvent {
  return {
    type: 'done',
    payload: {
      status: 'success',
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  } as CligentEvent;
}

function errorEvent(): CligentEvent {
  return { type: 'error', payload: { message: 'boom' } } as CligentEvent;
}

function initEvent(): CligentEvent {
  return { type: 'init', payload: {} } as CligentEvent;
}
