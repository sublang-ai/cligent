// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import {
  attachTmuxSession,
  isOrchestratorInTmux,
  isolateOrchestratorFromAgents,
  isTmuxAvailable,
  killTmuxSession,
  queryPaneTargetsByTitle,
  runTmux,
  setOrchestratorTmuxEnv,
} from './tmux.js';

describe('tmux helpers', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it('checks tmux availability through tmux -V', () => {
    spawnSyncMock.mockReturnValue({});

    expect(isTmuxAvailable()).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith('tmux', ['-V'], {
      stdio: 'pipe',
    });
  });

  it('returns false when tmux probe cannot spawn', () => {
    spawnSyncMock.mockReturnValue({ error: new Error('spawn ENOENT') });

    expect(isTmuxAvailable()).toBe(false);
  });

  it('runs tmux commands with piped stdio', () => {
    spawnSyncMock.mockReturnValue({ status: 0 });

    runTmux('new-session', '-d', '-s', 'fanout-123');

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'tmux',
      ['new-session', '-d', '-s', 'fanout-123'],
      { stdio: 'pipe' },
    );
  });

  it('maps tmux spawn errors to command-specific errors', () => {
    spawnSyncMock.mockReturnValue({ error: new Error('spawn ENOENT') });

    expect(() => runTmux('new-session')).toThrow(
      'tmux new-session failed: spawn ENOENT',
    );
  });

  it('includes stderr when tmux exits nonzero', () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stderr: Buffer.from('bad target\n'),
    });

    expect(() => runTmux('split-window')).toThrow(
      'tmux split-window failed: bad target',
    );
  });

  it('falls back to exit status when tmux has no stderr', () => {
    spawnSyncMock.mockReturnValue({ status: 2, stderr: Buffer.from('') });

    expect(() => runTmux('select-layout')).toThrow(
      'tmux select-layout failed: exit 2',
    );
  });

  it('attaches with inherited stdio', () => {
    spawnSyncMock.mockReturnValue({ status: 0 });

    attachTmuxSession('fanout-123');

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'tmux',
      ['attach-session', '-t', 'fanout-123'],
      { stdio: 'inherit' },
    );
  });

  it('maps attach failures', () => {
    spawnSyncMock.mockReturnValue({ status: 1 });

    expect(() => attachTmuxSession('fanout-123')).toThrow(
      'tmux attach-session failed: exit 1',
    );
  });

  it('kills sessions without surfacing tmux failures', () => {
    spawnSyncMock.mockReturnValue({ status: 1 });

    killTmuxSession('fanout-123');

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'tmux',
      ['kill-session', '-t', 'fanout-123'],
      { stdio: 'ignore' },
    );
  });

  it('queries pane targets by title', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from('Captain · claude\t%0\nCoder · codex\t%1\n'),
    });

    expect(queryPaneTargetsByTitle('tmux-play-123')).toEqual(
      new Map([
        ['Captain · claude', '%0'],
        ['Coder · codex', '%1'],
      ]),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'tmux',
      [
        'list-panes',
        '-t',
        'tmux-play-123:0',
        '-F',
        '#{pane_title}\t#{pane_id}',
      ],
      { stdio: 'pipe' },
    );
  });

  it('returns no pane targets when tmux cannot list panes', () => {
    spawnSyncMock.mockReturnValue({ status: 1 });

    expect(queryPaneTargetsByTitle('missing')).toEqual(new Map());
  });
});

describe('orchestrator tmux isolation', () => {
  const savedTmux = process.env.TMUX;
  const savedPane = process.env.TMUX_PANE;
  const savedTmpDir = process.env.TMUX_TMPDIR;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    setOrchestratorTmuxEnv(undefined);
  });

  afterEach(() => {
    setOrchestratorTmuxEnv(undefined);
    restore('TMUX', savedTmux);
    restore('TMUX_PANE', savedPane);
    restore('TMUX_TMPDIR', savedTmpDir);
  });

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  it('scrubs tmux handles from process.env so spawned agents are sandboxed', () => {
    process.env.TMUX = '/private/tmp/tmux-501/default,123,0';
    process.env.TMUX_PANE = '%4';
    delete process.env.TMUX_TMPDIR;

    isolateOrchestratorFromAgents();

    // A spawned agent inherits this process.env: no live session handles, and
    // a redirected socket dir so its `tmux` lands on a private server.
    expect(process.env.TMUX).toBeUndefined();
    expect(process.env.TMUX_PANE).toBeUndefined();
    expect(process.env.TMUX_TMPDIR).toBeDefined();
    expect(process.env.TMUX_TMPDIR).not.toBe('/private/tmp/tmux-501/default');
  });

  it('keeps the orchestrator reporting in-tmux after the scrub', () => {
    process.env.TMUX = '/private/tmp/tmux-501/default,123,0';

    expect(isOrchestratorInTmux()).toBe(true);
    isolateOrchestratorFromAgents();
    // process.env.TMUX is now gone, but the pinned snapshot keeps this true so
    // pane-width queries still run for the orchestrator.
    expect(process.env.TMUX).toBeUndefined();
    expect(isOrchestratorInTmux()).toBe(true);
  });

  it("runs the orchestrator's own tmux commands with the pinned real env", () => {
    process.env.TMUX = '/private/tmp/tmux-501/default,123,0';
    isolateOrchestratorFromAgents();
    spawnSyncMock.mockReturnValue({ status: 0 });

    runTmux('list-panes', '-t', 'tmux-play-abc:0');

    const call = spawnSyncMock.mock.calls.at(-1);
    expect(call?.[0]).toBe('tmux');
    expect(call?.[1]).toEqual(['list-panes', '-t', 'tmux-play-abc:0']);
    // The pinned env still carries the real TMUX handle so this reaches the
    // run's session, not the agents' sandbox socket.
    expect((call?.[2] as { env?: NodeJS.ProcessEnv }).env?.TMUX).toBe(
      '/private/tmp/tmux-501/default,123,0',
    );
  });

  it('is a no-op when the orchestrator is not inside tmux', () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    delete process.env.TMUX_TMPDIR;

    isolateOrchestratorFromAgents();

    expect(isOrchestratorInTmux()).toBe(false);
    expect(process.env.TMUX_TMPDIR).toBeUndefined();
  });
});
