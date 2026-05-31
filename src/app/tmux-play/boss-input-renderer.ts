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
// Cell model: each UTF-16 code unit of `line` counts as one cell, matching the
// readline `cursor` index so positioning stays exact for the ASCII prompts and
// content this app renders. Double-width (e.g. CJK) cells are out of scope for
// IR-024, whose bug is an ASCII full-width-row artifact.

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

interface Layout {
  readonly rows: string[];
  readonly row0Capacity: number;
  readonly contCapacity: number;
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
    const layout = this.layout(line, columns);
    const target = positionOf(
      clampedCursor,
      line.length,
      this.promptWidth,
      layout,
    );

    let out = this.moveToTopLeft();
    out += CLEAR_TO_END_OF_SCREEN;
    out += this.prompt + layout.rows[0];
    for (let i = 1; i < layout.rows.length; i += 1) {
      out += `\r\n${layout.rows[i]}`;
    }

    const lastRow = layout.rows.length - 1;
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

  private layout(line: string, columns: number): Layout {
    const wrapWidth = Math.max(1, columns - RESERVED_COLUMNS);
    const row0Capacity = Math.max(1, wrapWidth - this.promptWidth);
    const contCapacity = wrapWidth;

    const rows = [line.slice(0, row0Capacity)];
    const rest = line.slice(row0Capacity);
    for (let i = 0; i < rest.length; i += contCapacity) {
      rows.push(rest.slice(i, i + contCapacity));
    }
    return { rows, row0Capacity, contCapacity };
  }
}

// Map a cursor offset (0..lineLength) to its (row, col) in the laid-out region.
// A cursor at a row's capacity boundary sits at the next row's column 0 when
// more content follows, but rests on the (unwritten) reserved cell at the row's
// right edge when it is the end of the buffer — so a full row does not push a
// phantom blank row.
function positionOf(
  offset: number,
  lineLength: number,
  promptWidth: number,
  layout: Layout,
): Position {
  const { row0Capacity, contCapacity } = layout;

  if (offset < row0Capacity) {
    return { row: 0, col: promptWidth + offset };
  }
  if (offset === row0Capacity) {
    if (offset === lineLength) {
      return { row: 0, col: promptWidth + offset };
    }
    return { row: 1, col: 0 };
  }

  const rel = offset - row0Capacity;
  const row = 1 + Math.floor(rel / contCapacity);
  const col = rel % contCapacity;
  if (col === 0) {
    if (offset === lineLength) {
      return { row: row - 1, col: contCapacity };
    }
    return { row, col: 0 };
  }
  return { row, col };
}
