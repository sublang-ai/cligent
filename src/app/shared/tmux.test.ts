// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import {
  attachTmuxSession,
  isTmuxAvailable,
  killTmuxSession,
  runTmux,
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
});
