// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Wrap-correct Boss input renderer (TMUX-067 / IR-024).
//
// Node's `readline` redraw drives the terminal into the deferred-wrap ("magic
// margin", DECAWM) state whenever a rendered input row is exactly the pane
// width: it writes a character into the terminal's last cell, then compensates
// for the ambiguous cursor position with an extra forced row that strands a
// duplicate of the full-width row into scrollback. This renderer owns the Boss
// input redraw instead, laying the prompt-plus-line out so that:
//
//   * every display row is at most `columns - 1` visible cells, so the
//     rightmost column is never written and the terminal never enters the
//     deferred-wrap state;
//   * wrap points are emitted as explicit `\r\n` breaks rather than relying on
//     the terminal's auto-wrap;
//   * the input region is cleared (cursor up to its top-left, then clear to end
//     of screen) before each repaint, so editing never leaves stale rows; and
//   * the cursor is positioned from the readline `cursor` index across wrap
//     boundaries.
//
// The renderer is driven off readline's `line` / `cursor` (the session feeds
// them on each keypress) and emits only byte strings, so its output is
// deterministic and unit-testable at exact `W` and `2·W` boundary widths.
//
// Cell model: widths are measured in display cells via `displayCells` — the
// same model the presenter soft-wraps with (TMUX-046) — and the buffer is
// packed a code point at a time. A wide (CJK / emoji, two-cell) character is
// therefore never split across a wrap boundary and never overflows the reserved
// rightmost column: when it would not fit in a row's remaining cells it wraps to
// the next row, leaving the odd trailing cell blank. The readline `cursor` is a
// UTF-16 code-unit index, so positions are mapped back to it via each code
// point's code-unit length.

import { displayCells } from '../shared/display-width.js';

const RESERVED_COLUMNS = 1;
const CLEAR_TO_END_OF_SCREEN = '\x1b[0J';

export interface BossInputRendererOptions {
  // Bytes emitted for the prompt; may include ANSI styling (e.g. a colored
  // `boss> `). Its visible width is given separately by `promptWidth`.
  readonly prompt: string;
  // Visible width of the prompt in cells (e.g. 6 for `boss> `). Drives layout
  // independently of `prompt`'s byte length so ANSI styling does not skew wrap
  // math.
  readonly promptWidth: number;
}

interface Position {
  readonly row: number;
  readonly col: number;
}

// A placed code point: the code-unit offset of its start in `line`, and the
// (row, col) where it was painted. Used to map a readline cursor index back to
// a screen position.
interface Placement {
  readonly offset: number;
  readonly row: number;
  readonly col: number;
}

interface Packed {
  readonly rows: string[];
  readonly placements: Placement[];
  // Position of the cursor when it sits at the very end of the buffer.
  readonly end: Position;
}

export class BossInputRenderer {
  private readonly prompt: string;
  private readonly promptWidth: number;
  // Row (0-based from the input region's top-left) where the last paint left
  // the cursor; the next repaint moves up this many rows to reach the top-left.
  private prevCursorRow = 0;

  constructor(options: BossInputRendererOptions) {
    this.prompt = options.prompt;
    this.promptWidth = options.promptWidth;
  }

  // Repaint the input region for the given edit buffer and cursor index at the
  // current terminal width, returning the bytes to write. Assumes the cursor
  // sits where the previous `render` / `clear` left it (or, on the first call
  // after construction / `reset`, at the input region's top-left).
  render(line: string, cursor: number, columns: number): string {
    const clampedCursor = Math.max(0, Math.min(cursor, line.length));
    const packed = this.pack(line, columns);
    const target = positionOf(clampedCursor, this.promptWidth, packed);

    let out = this.moveToTopLeft();
    out += CLEAR_TO_END_OF_SCREEN;
    out += this.prompt + packed.rows[0];
    for (let i = 1; i < packed.rows.length; i += 1) {
      out += `\r\n${packed.rows[i]}`;
    }

    const lastRow = packed.rows.length - 1;
    out += '\r';
    const up = lastRow - target.row;
    if (up > 0) {
      out += `\x1b[${up}A`;
    }
    if (target.col > 0) {
      out += `\x1b[${target.col}C`;
    }

    this.prevCursorRow = target.row;
    return out;
  }

  // Erase the input region: move to its top-left and clear to end of screen,
  // leaving the cursor at the top-left. Used before captain output streams into
  // the same pane so the input never double-prints (TMUX-037).
  clear(): string {
    const out = `${this.moveToTopLeft()}${CLEAR_TO_END_OF_SCREEN}`;
    this.prevCursorRow = 0;
    return out;
  }

  // Forget the prior cursor row without emitting bytes. The next `render`
  // treats the current cursor position as the input region's top-left; callers
  // use this after repositioning the cursor by other means.
  reset(): void {
    this.prevCursorRow = 0;
  }

  private moveToTopLeft(): string {
    let out = '\r';
    if (this.prevCursorRow > 0) {
      out += `\x1b[${this.prevCursorRow}A`;
    }
    return out;
  }

  // Pack the edit buffer into display rows that each stay within `columns - 1`
  // cells (reserving the rightmost column). Row 0 begins after the prompt; wrap
  // rows begin at column 0. A code point that would not fit in the current row's
  // remaining cells starts a new row, so a two-cell character never straddles
  // the reserved column.
  private pack(line: string, columns: number): Packed {
    const wrapWidth = Math.max(1, columns - RESERVED_COLUMNS);
    const row0Budget = Math.max(0, wrapWidth - this.promptWidth);

    const rows = [''];
    const placements: Placement[] = [];
    let row = 0;
    let used = 0; // cells filled in the current row's content area
    let offset = 0; // code-unit offset of the next code point

    const rowBudget = (r: number): number => (r === 0 ? row0Budget : wrapWidth);
    const rowBase = (r: number): number => (r === 0 ? this.promptWidth : 0);

    for (const char of line) {
      const cells = displayCells(char.codePointAt(0) ?? 0);
      const budget = rowBudget(row);
      const overflows = used + cells > budget;
      // Wrap when the code point does not fit — either the row already holds
      // content, or row 0 is too narrow for it (prompt nearly fills the line),
      // in which case content starts on the first wrap row. A row that is still
      // empty on a wrap row keeps the character to avoid an infinite loop in
      // degenerately narrow panes.
      if (overflows && (used > 0 || (row === 0 && cells > budget))) {
        row += 1;
        rows.push('');
        used = 0;
      }
      placements.push({ offset, row, col: rowBase(row) + used });
      rows[row] += char;
      used += cells;
      offset += char.length;
    }

    const lastRow = rows.length - 1;
    const end: Position = { row: lastRow, col: rowBase(lastRow) + used };
    return { rows, placements, end };
  }
}

// Map a readline cursor index (a UTF-16 code-unit offset, 0..lineLength) to its
// painted (row, col). A cursor sitting before a code point shows at that code
// point's position — which is the start of the next row when the previous row
// filled — and a cursor at the end of the buffer rests just past the last code
// point (on the unwritten reserved cell when the row filled exactly).
function positionOf(
  cursor: number,
  promptWidth: number,
  packed: Packed,
): Position {
  const { placements, end } = packed;
  if (placements.length === 0) {
    return { row: 0, col: promptWidth };
  }
  for (const placement of placements) {
    if (placement.offset >= cursor) {
      return { row: placement.row, col: placement.col };
    }
  }
  return end;
}
