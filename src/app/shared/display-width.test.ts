// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import {
  DisplayParser,
  displayCells,
  iterateDisplay,
  type DisplayToken,
} from './display-width.js';

function collect(text: string): DisplayToken[] {
  return Array.from(iterateDisplay(text));
}

describe('displayCells', () => {
  it('returns 1 for ASCII printables', () => {
    expect(displayCells('a'.codePointAt(0) ?? 0)).toBe(1);
    expect(displayCells('~'.codePointAt(0) ?? 0)).toBe(1);
  });

  it('returns 0 for C0/C1 control codes and DEL', () => {
    expect(displayCells(0x00)).toBe(0);
    expect(displayCells(0x07)).toBe(0);
    expect(displayCells(0x1f)).toBe(0);
    expect(displayCells(0x7f)).toBe(0);
    expect(displayCells(0x9b)).toBe(0);
  });

  it('returns 0 for zero-width format characters', () => {
    expect(displayCells(0x200b)).toBe(0); // ZWSP
    expect(displayCells(0x200d)).toBe(0); // ZWJ
    expect(displayCells(0xfeff)).toBe(0); // BOM
  });

  it('returns 0 for Unicode combining marks', () => {
    expect(displayCells(0x0301)).toBe(0); // combining acute accent
    expect(displayCells(0x0308)).toBe(0); // combining diaeresis
  });

  it('returns 2 for East Asian Wide and Fullwidth codepoints', () => {
    expect(displayCells('一'.codePointAt(0) ?? 0)).toBe(2); // U+4E00
    expect(displayCells('한'.codePointAt(0) ?? 0)).toBe(2); // U+D55C
    expect(displayCells('Ａ'.codePointAt(0) ?? 0)).toBe(2); // fullwidth A
    expect(displayCells('🎉'.codePointAt(0) ?? 0)).toBe(2); // emoji
  });

  it('returns 2 for emoji in supplementary-plane blocks via Emoji_Presentation', () => {
    // 🟧 lives in Geometric Shapes Extended (U+1F780–1F7FF); 🫠 lives in
    // Symbols and Pictographs Extended-A (U+1FA00–1FAFF). Both are
    // Emoji_Presentation=Yes and render as two cells in modern terminals.
    expect(displayCells('🟧'.codePointAt(0) ?? 0)).toBe(2); // U+1F7E7
    expect(displayCells('🫠'.codePointAt(0) ?? 0)).toBe(2); // U+1FAE0
  });

  it('returns 2 for BMP emoji caught by Emoji_Presentation at cp ≥ 0x2300', () => {
    expect(displayCells(0x231a)).toBe(2); // ⌚ WATCH
    expect(displayCells(0x2615)).toBe(2); // ☕ HOT BEVERAGE
    expect(displayCells(0x23f0)).toBe(2); // ⏰ ALARM CLOCK
  });

  it('returns 2 for Tangut, Khitan, and Nüshu codepoints per EAW=W', () => {
    expect(displayCells(0x17000)).toBe(2); // Tangut Ideograph
    expect(displayCells(0x18800)).toBe(2); // Tangut Components
    expect(displayCells(0x18b00)).toBe(2); // Khitan Small Script
    expect(displayCells(0x18cff)).toBe(2); // Khitan block tail (reserved)
    expect(displayCells(0x1b170)).toBe(2); // Nüshu
  });

  it('returns 2 for the additional EAW=W blocks the implementation tracks', () => {
    expect(displayCells(0xa960)).toBe(2); // Hangul Jamo Extended-A
    expect(displayCells(0x4dc0)).toBe(2); // Yijing Hexagram Symbols
    expect(displayCells(0x1aff0)).toBe(2); // Kana Extended-B
    expect(displayCells(0x1b000)).toBe(2); // Kana Supplement
    expect(displayCells(0x1b100)).toBe(2); // Kana Extended-A
    expect(displayCells(0x1b150)).toBe(2); // Small Kana Extension
    expect(displayCells(0x1d300)).toBe(2); // Tai Xuan Jing Symbols
    expect(displayCells(0x1d360)).toBe(2); // Counting Rod Numerals
  });

  it('returns 1 for codepoints that Unicode reports as Neutral despite living in pictograph-adjacent blocks', () => {
    // Symbols for Legacy Computing (U+1FB00–1FBFF) is mostly Neutral —
    // sextant/octant blocks and segmented digits occupy a single column by
    // design, even though they live near the supplementary-plane emoji.
    expect(displayCells(0x1fb70)).toBe(1);
    // Supplemental Arrows-C (U+1F800–1F8FF) is Neutral.
    expect(displayCells(0x1f800)).toBe(1);
  });
});

describe('iterateDisplay', () => {
  it('yields chars and newlines for plain ASCII', () => {
    expect(collect('ab\nc')).toEqual([
      { type: 'char', char: 'a', cells: 1 },
      { type: 'char', char: 'b', cells: 1 },
      { type: 'newline' },
      { type: 'char', char: 'c', cells: 1 },
    ]);
  });

  it('consumes ANSI CSI sequences as a single zero-width token', () => {
    expect(collect('\x1b[31mhi\x1b[0m')).toEqual([
      { type: 'escape', sequence: '\x1b[31m' },
      { type: 'char', char: 'h', cells: 1 },
      { type: 'char', char: 'i', cells: 1 },
      { type: 'escape', sequence: '\x1b[0m' },
    ]);
  });

  it('consumes ANSI OSC sequences terminated by BEL or ST', () => {
    expect(collect('\x1b]0;title\x07x')).toEqual([
      { type: 'escape', sequence: '\x1b]0;title\x07' },
      { type: 'char', char: 'x', cells: 1 },
    ]);
    expect(collect('\x1b]0;title\x1b\\y')).toEqual([
      { type: 'escape', sequence: '\x1b]0;title\x1b\\' },
      { type: 'char', char: 'y', cells: 1 },
    ]);
  });

  it('falls back to ESC + next byte for unrecognized escapes', () => {
    expect(collect('\x1b=x')).toEqual([
      { type: 'escape', sequence: '\x1b=' },
      { type: 'char', char: 'x', cells: 1 },
    ]);
  });

  it('treats a trailing ESC as a partial escape rather than a char', () => {
    expect(collect('a\x1b')).toEqual([
      { type: 'char', char: 'a', cells: 1 },
      { type: 'escape', sequence: '\x1b' },
    ]);
  });

  it('counts CJK and emoji codepoints as two cells', () => {
    expect(collect('中a🎉')).toEqual([
      { type: 'char', char: '中', cells: 2 },
      { type: 'char', char: 'a', cells: 1 },
      { type: 'char', char: '🎉', cells: 2 },
    ]);
  });

  it('counts combining marks as zero cells next to the base char', () => {
    // 'é' as 'e' + U+0301
    expect(collect('é')).toEqual([
      { type: 'char', char: 'e', cells: 1 },
      { type: 'char', char: '́', cells: 0 },
    ]);
  });
});

describe('DisplayParser', () => {
  it('carries a CSI sequence split across consume() calls', () => {
    const parser = new DisplayParser();
    const first = Array.from(parser.consume('hello\x1b[31'));
    const second = Array.from(parser.consume('m world'));

    expect(first).toEqual([
      { type: 'char', char: 'h', cells: 1 },
      { type: 'char', char: 'e', cells: 1 },
      { type: 'char', char: 'l', cells: 1 },
      { type: 'char', char: 'l', cells: 1 },
      { type: 'char', char: 'o', cells: 1 },
    ]);
    expect(second[0]).toEqual({ type: 'escape', sequence: '\x1b[31m' });
    expect(second.slice(1)).toEqual([
      { type: 'char', char: ' ', cells: 1 },
      { type: 'char', char: 'w', cells: 1 },
      { type: 'char', char: 'o', cells: 1 },
      { type: 'char', char: 'r', cells: 1 },
      { type: 'char', char: 'l', cells: 1 },
      { type: 'char', char: 'd', cells: 1 },
    ]);
  });

  it('carries a CSI sequence when the entire chunk lives inside the escape', () => {
    const parser = new DisplayParser();
    const first = Array.from(parser.consume('\x1b['));
    const second = Array.from(parser.consume('33;1'));
    const third = Array.from(parser.consume('mA'));

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(third).toEqual([
      { type: 'escape', sequence: '\x1b[33;1m' },
      { type: 'char', char: 'A', cells: 1 },
    ]);
  });

  it('carries a bare ESC at chunk boundary and decides CSI vs simple on the next byte', () => {
    const parser = new DisplayParser();
    expect(Array.from(parser.consume('a\x1b'))).toEqual([
      { type: 'char', char: 'a', cells: 1 },
    ]);
    expect(Array.from(parser.consume('[0mB'))).toEqual([
      { type: 'escape', sequence: '\x1b[0m' },
      { type: 'char', char: 'B', cells: 1 },
    ]);
  });

  it('treats a bare ESC followed by a non-CSI/OSC byte as a simple escape', () => {
    const parser = new DisplayParser();
    expect(Array.from(parser.consume('\x1b'))).toEqual([]);
    expect(Array.from(parser.consume('=x'))).toEqual([
      { type: 'escape', sequence: '\x1b=' },
      { type: 'char', char: 'x', cells: 1 },
    ]);
  });

  it('carries an OSC sequence terminated by BEL across chunks', () => {
    const parser = new DisplayParser();
    expect(Array.from(parser.consume('\x1b]0;ti'))).toEqual([]);
    expect(Array.from(parser.consume('tle\x07x'))).toEqual([
      { type: 'escape', sequence: '\x1b]0;title\x07' },
      { type: 'char', char: 'x', cells: 1 },
    ]);
  });

  it('carries an OSC sequence whose ST splits between ESC and the trailing backslash', () => {
    const parser = new DisplayParser();
    expect(Array.from(parser.consume('\x1b]0;hi\x1b'))).toEqual([]);
    expect(Array.from(parser.consume('\\y'))).toEqual([
      { type: 'escape', sequence: '\x1b]0;hi\x1b\\' },
      { type: 'char', char: 'y', cells: 1 },
    ]);
  });

  it('flush() drains a still-pending partial escape so single-shot callers see it', () => {
    const parser = new DisplayParser();
    expect(Array.from(parser.consume('a\x1b[31'))).toEqual([
      { type: 'char', char: 'a', cells: 1 },
    ]);
    expect(Array.from(parser.flush())).toEqual([
      { type: 'escape', sequence: '\x1b[31' },
    ]);
    expect(Array.from(parser.flush())).toEqual([]);
  });
});
