// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import { isGlowAvailable, renderMarkdown } from './glow.js';

describe('glow helpers', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it('checks glow availability through glow --version', () => {
    spawnSyncMock.mockReturnValue({ status: 0 });

    expect(isGlowAvailable()).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith('glow', ['--version'], {
      stdio: 'pipe',
    });
  });

  it('returns false when glow probe cannot spawn', () => {
    spawnSyncMock.mockReturnValue({ error: new Error('spawn ENOENT') });

    expect(isGlowAvailable()).toBe(false);
  });

  it('returns false when glow probe spawns but exits nonzero', () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stderr: Buffer.from('unknown flag: --version\n'),
    });

    expect(isGlowAvailable()).toBe(false);
  });

  it('renders Markdown via glow with width pinned and stdin-fed', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from('  rendered\n'),
      stderr: Buffer.from(''),
    });

    expect(renderMarkdown('# hi', 80)).toBe('  rendered\n');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'glow',
      ['-w', '80', '-s', 'dark', '-'],
      { input: '# hi', stdio: 'pipe' },
    );
  });

  it('truncates fractional widths to integer cells before invoking glow', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    });

    renderMarkdown('hi', 79.7);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'glow',
      ['-w', '79', '-s', 'dark', '-'],
      { input: 'hi', stdio: 'pipe' },
    );
  });

  it('rejects non-positive widths up front without spawning glow', () => {
    expect(() => renderMarkdown('hi', 0)).toThrow(
      'renderMarkdown requires a positive width',
    );
    expect(() => renderMarkdown('hi', Number.NaN)).toThrow(
      'renderMarkdown requires a positive width',
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('maps glow spawn errors to a clear render error', () => {
    spawnSyncMock.mockReturnValue({ error: new Error('spawn ENOENT') });

    expect(() => renderMarkdown('hi', 80)).toThrow(
      'glow render failed: spawn ENOENT',
    );
  });

  it('includes stderr when glow exits nonzero', () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('bad input\n'),
    });

    expect(() => renderMarkdown('hi', 80)).toThrow(
      'glow render failed: bad input',
    );
  });

  it('falls back to exit status when glow has no stderr', () => {
    spawnSyncMock.mockReturnValue({
      status: 2,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    });

    expect(() => renderMarkdown('hi', 80)).toThrow(
      'glow render failed: exit 2',
    );
  });
});
