// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import { BossInputRenderer } from './boss-input-renderer.js';

// A plain `boss> ` prompt keeps the asserted byte strings readable; the prompt
// has visible width 6.
const PROMPT = 'boss> ';
const PROMPT_WIDTH = 6;

function renderer(prompt = PROMPT, promptWidth = PROMPT_WIDTH): BossInputRenderer {
  return new BossInputRenderer({ prompt, promptWidth });
}

// Remove SGR / cursor-control escapes so a row's *visible* width can be
// measured.
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// Recover the visible rows the renderer painted: drop the clear preamble and the
// trailing cursor-positioning suffix, split on the explicit wrap breaks, and
// strip styling.
function paintedRows(output: string): string[] {
  const afterClear = output.slice(output.indexOf('\x1b[0J') + '\x1b[0J'.length);
  const body = afterClear.replace(/\r(?:\x1b\[\d+A)?(?:\x1b\[\d+C)?$/, '');
  return body.split('\r\n').map(stripAnsi);
}

describe('BossInputRenderer.render — boundary byte output', () => {
  // W = 10, prompt width 6 → wrapWidth 9, row-0 content capacity 3,
  // continuation capacity 9. The rightmost column (index 9) is never written.
  const W = 10;

  it('paints an empty buffer with the cursor just past the prompt', () => {
    expect(renderer().render('', 0, W)).toBe('\r\x1b[0Jboss> \r\x1b[6C');
  });

  it('keeps content that fills row 0 to the reserved edge on one row', () => {
    // 'abc' → prompt(6)+3 = 9 = W-1; the cursor rests on the reserved cell.
    expect(renderer().render('abc', 3, W)).toBe('\r\x1b[0Jboss> abc\r\x1b[9C');
  });

  it('wraps the exact-W character to a new row via an explicit break', () => {
    // 'abcd' → prompt+content = 10 = W. With the reserved column the 4th char
    // moves to row 1 behind a real `\r\n`, so no char is written into cell W
    // and the terminal never enters deferred wrap.
    expect(renderer().render('abcd', 4, W)).toBe(
      '\r\x1b[0Jboss> abc\r\nd\r\x1b[1C',
    );
  });

  it('lays a 2·W-wide line across three rows with breaks at each boundary', () => {
    // prompt+14 = 20 = 2·W → rows: 'boss> abc' | 'defghijkl' | 'mn'.
    expect(renderer().render('abcdefghijklmn', 14, W)).toBe(
      '\r\x1b[0Jboss> abc\r\ndefghijkl\r\nmn\r\x1b[2C',
    );
  });

  it('honors prompt visible width, not byte length, with an ANSI prompt', () => {
    const ansiPrompt = '\x1b[1mboss> \x1b[0m';
    expect(renderer(ansiPrompt, PROMPT_WIDTH).render('abcd', 4, W)).toBe(
      `\r\x1b[0J${ansiPrompt}abc\r\nd\r\x1b[1C`,
    );
  });
});

describe('BossInputRenderer.render — cursor tracking and repaint', () => {
  const W = 10;

  it('moves the cursor up into a wrapped row on the next repaint', () => {
    const r = renderer();
    r.render('abcdefghijklmn', 14, W); // leaves the cursor on row 2
    // Moving the edit cursor to index 5 (row 1, col 2) repaints in place: up 2
    // rows to the region top-left, then back down to the wrapped position.
    expect(r.render('abcdefghijklmn', 5, W)).toBe(
      '\r\x1b[2A\x1b[0Jboss> abc\r\ndefghijkl\r\nmn\r\x1b[1A\x1b[2C',
    );
  });
});

describe('BossInputRenderer.clear', () => {
  const W = 10;

  it('erases an empty region from the top-left', () => {
    expect(renderer().clear()).toBe('\r\x1b[0J');
  });

  it('moves up to the region top-left before clearing a multi-row paint', () => {
    const r = renderer();
    r.render('abcdefghijklmn', 5, W); // cursor on row 1
    expect(r.clear()).toBe('\r\x1b[1A\x1b[0J');
  });

  it('resets cursor tracking so the next render does not move up', () => {
    const r = renderer();
    r.render('abcdefghijklmn', 14, W); // cursor on row 2
    r.clear();
    // After a clear the cursor is at the region top-left, so the repaint
    // preamble carries no cursor-up.
    expect(r.render('', 0, W)).toBe('\r\x1b[0Jboss> \r\x1b[6C');
  });
});

describe('BossInputRenderer — reserved-column and lossless invariants', () => {
  it('never paints a row of visible width W and loses no characters', () => {
    const sample =
      'The quick brown fox jumps over the lazy dog 0123456789 ' +
      'and keeps typing well past two pane widths to force wrapping.';
    for (let W = 8; W <= 40; W += 1) {
      for (const len of [0, 1, W - 7, W - 6, W, W + 1, 2 * W, sample.length]) {
        const line = sample.slice(0, Math.max(0, Math.min(len, sample.length)));
        const rows = paintedRows(renderer().render(line, line.length, W));

        // No painted row reaches the terminal width: the rightmost column
        // stays unused (TMUX-067).
        for (const row of rows) {
          expect(row.length).toBeLessThanOrEqual(W - 1);
        }

        // The prompt-stripped rows concatenate back to the typed text: the
        // renderer drops and duplicates no characters.
        const joined = rows
          .map((row, index) => (index === 0 ? row.slice(PROMPT_WIDTH) : row))
          .join('');
        expect(joined).toBe(line);
      }
    }
  });
});
