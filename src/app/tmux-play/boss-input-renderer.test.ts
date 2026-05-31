// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import { displayCells } from '../shared/display-width.js';
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

// Visible cell width of a string, matching the renderer's wrap model.
function cellWidth(value: string): number {
  let cells = 0;
  for (const char of value) {
    cells += displayCells(char.codePointAt(0) ?? 0);
  }
  return cells;
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

describe('BossInputRenderer.render — wide characters (cell-aware)', () => {
  // W = 10, prompt width 6 → row-0 content budget 3 cells. `中` (U+4E2D) and
  // `🙂` (U+1F642) are each two cells wide; `🙂` is also a surrogate pair (two
  // UTF-16 code units), so naive code-unit slicing would split it.
  const W = 10;

  it('wraps a wide character that overflows the row budget by cells', () => {
    // First `中` fills cols 6-7; the second needs cols 6-7 of a new row.
    expect(renderer().render('中中', 2, W)).toBe(
      '\r\x1b[0Jboss> 中\r\n中\r\x1b[2C',
    );
  });

  it('fills a row to the reserved edge with a trailing wide character', () => {
    // 'a' at col 6, `中` at cols 7-8 → row 0 is 9 = W-1 cells; col 9 stays free.
    expect(renderer().render('a中', 2, W)).toBe('\r\x1b[0Jboss> a中\r\x1b[9C');
  });

  it('wraps rather than splitting a wide character, leaving a blank cell', () => {
    // 'ab' uses cols 6-7; `中` needs two cells but only col 8 remains before the
    // reserved col 9, so it wraps — col 8 stays blank, never half a glyph.
    expect(renderer().render('ab中', 3, W)).toBe(
      '\r\x1b[0Jboss> ab\r\n中\r\x1b[2C',
    );
  });

  it('counts a wide character as two cells when placing the cursor', () => {
    // Cursor index 1 sits before 'a', which `中` (two cells) pushed to col 8.
    expect(renderer().render('中a', 1, W)).toBe('\r\x1b[0Jboss> 中a\r\x1b[8C');
  });

  it('keeps a surrogate-pair emoji whole across a wrap boundary', () => {
    expect(renderer().render('🙂🙂', 4, W)).toBe(
      '\r\x1b[0Jboss> 🙂\r\n🙂\r\x1b[2C',
    );
  });

  it('maps a code-unit cursor past a surrogate pair to the right column', () => {
    // The emoji is two code units, so cursor index 2 sits before 'a' at col 8.
    expect(renderer().render('🙂a', 2, W)).toBe('\r\x1b[0Jboss> 🙂a\r\x1b[8C');
  });

  it('starts content on the wrap row when row 0 is too narrow for a wide char', () => {
    // W = 8 → row-0 content budget is 1 cell, too small for a two-cell `中`, so
    // row 0 carries only the prompt and `中` begins on the wrap row.
    expect(renderer().render('中', 1, 8)).toBe('\r\x1b[0Jboss> \r\n中\r\x1b[2C');
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
  it('never paints a row wider than W-1 cells and loses no characters', () => {
    // Mixed ASCII, wide CJK, surrogate-pair emoji, and a precomposed accent, so
    // the cell-aware packing is exercised against real boundary positions.
    const codePoints = [
      ...('The quick brown 狐 fox 🙂 jumps 测试 over the lazy 🐶 dog ' +
        'café 0123456789 and keeps typing 中文 well past two pane widths.'),
    ];
    for (let W = 8; W <= 40; W += 1) {
      for (const len of [0, 1, W - 7, W - 6, W, W + 1, 2 * W, codePoints.length]) {
        const count = Math.max(0, Math.min(len, codePoints.length));
        const line = codePoints.slice(0, count).join('');
        const rows = paintedRows(renderer().render(line, line.length, W));

        // No painted row reaches the terminal width: the rightmost column
        // stays unused, measured in display cells (TMUX-067).
        for (const row of rows) {
          expect(cellWidth(row)).toBeLessThanOrEqual(W - 1);
        }

        // The prompt-stripped rows concatenate back to the typed text: the
        // renderer drops, duplicates, and splits no characters.
        const joined = rows
          .map((row, index) => (index === 0 ? row.slice(PROMPT.length) : row))
          .join('');
        expect(joined).toBe(line);
      }
    }
  });
});
