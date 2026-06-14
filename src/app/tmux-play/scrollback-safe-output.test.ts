// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  clampClearScreenDown,
  wrapScrollbackSafeOutput,
} from './scrollback-safe-output.js';

describe('clampClearScreenDown (TMUX-079)', () => {
  it('passes chunks without escape sequences through unchanged', () => {
    expect(clampClearScreenDown('boss> abc', 10)).toBe('boss> abc');
    expect(clampClearScreenDown('', 10)).toBe('');
  });

  it('rewrites clearScreenDown into a line-scoped, history-safe clear', () => {
    const out = clampClearScreenDown('\x1b[0J', 4);
    // No erase-in-display escape survives — those are what tmux scrolls into
    // scrollback history.
    expect(out).not.toMatch(/\x1b\[0?J/);
    // The replacement saves and restores the cursor so readline's redraw
    // continues from where it left off.
    expect(out.startsWith('\x1b7')).toBe(true);
    expect(out.endsWith('\x1b8')).toBe(true);
    // It clears the cursor's row to end-of-line, then each row below with a
    // whole-line erase moved into place with cursor-down (which stops at the
    // bottom margin rather than scrolling).
    expect(out).toContain('\x1b[0K');
    expect(out).toContain('\x1b[1B\x1b[2K');
  });

  it('clears one whole line per pane row', () => {
    const rowsToWholeLineClears = (rows: number): number =>
      clampClearScreenDown('\x1b[0J', rows).split('\x1b[2K').length - 1;
    // rows below the cursor get a whole-line erase; the cursor row uses the
    // partial \x1b[0K, so a height of N yields N-1 whole-line clears.
    expect(rowsToWholeLineClears(1)).toBe(0);
    expect(rowsToWholeLineClears(4)).toBe(3);
    expect(rowsToWholeLineClears(10)).toBe(9);
  });

  it('also rewrites the parameterless CSI J form', () => {
    expect(clampClearScreenDown('\x1b[J', 3)).not.toMatch(/\x1b\[0?J/);
  });

  it('leaves erase-above and erase-all forms untouched', () => {
    // readline only emits clearScreenDown; the other ED variants carry
    // deliberate full-clear semantics that should keep their stock behavior.
    expect(clampClearScreenDown('\x1b[1J', 10)).toBe('\x1b[1J');
    expect(clampClearScreenDown('\x1b[2J', 10)).toBe('\x1b[2J');
    expect(clampClearScreenDown('\x1b[3J', 10)).toBe('\x1b[3J');
  });

  it('falls back to clearing only the cursor row when rows are unknown', () => {
    for (const rows of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = clampClearScreenDown('\x1b[0J', rows);
      expect(out).not.toMatch(/\x1b\[0?J/);
      expect(out).not.toContain('\x1b[2K');
      expect(out).toContain('\x1b[0K');
    }
  });

  it('preserves prompt bytes around the rewritten clear', () => {
    const refresh = '\x1b[1G\x1b[0Jboss> \x1b[7G';
    const out = clampClearScreenDown(refresh, 2);
    expect(out.startsWith('\x1b[1G')).toBe(true);
    expect(out.endsWith('boss> \x1b[7G')).toBe(true);
    expect(out).not.toMatch(/\x1b\[0?J/);
  });
});

describe('wrapScrollbackSafeOutput (TMUX-079)', () => {
  it('rewrites clearScreenDown on string writes using the stream height', () => {
    const sink = new PassThrough();
    const chunks: string[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    (sink as unknown as { rows: number }).rows = 5;

    const wrapped = wrapScrollbackSafeOutput(sink);
    wrapped.write('\x1b[0J');

    expect(chunks.join('')).not.toMatch(/\x1b\[0?J/);
    expect(chunks.join('').split('\x1b[2K').length - 1).toBe(4);
  });

  it('passes non-string chunks through untouched', () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));

    const wrapped = wrapScrollbackSafeOutput(sink);
    const payload = Buffer.from('\x1b[0J', 'utf8');
    wrapped.write(payload);

    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  it('delegates non-write properties to the underlying stream', () => {
    const sink = new PassThrough();
    Object.assign(sink, { columns: 80, rows: 24, isTTY: true });
    const wrapped = wrapScrollbackSafeOutput(sink) as unknown as {
      columns: number;
      rows: number;
      isTTY: boolean;
    };
    expect(wrapped.columns).toBe(80);
    expect(wrapped.rows).toBe(24);
    expect(wrapped.isTTY).toBe(true);
  });

  it('reads the height per write so a resize is reflected', () => {
    const sink = new PassThrough();
    const chunks: string[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const wrapped = wrapScrollbackSafeOutput(sink);

    (sink as unknown as { rows: number }).rows = 3;
    wrapped.write('\x1b[0J');
    (sink as unknown as { rows: number }).rows = 6;
    wrapped.write('\x1b[0J');

    const writes = chunks.join('').split('\x1b8').filter(Boolean);
    expect(writes[0].split('\x1b[2K').length - 1).toBe(2);
    expect(writes[1].split('\x1b[2K').length - 1).toBe(5);
  });
});
