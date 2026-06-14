// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { Writable } from 'node:stream';

// TMUX-079: Node's readline redraws the live prompt with `clearScreenDown`
// (CSI 0J — erase from the cursor to the end of the display) on every edit,
// including each backspace. When the Boss/Captain prompt sits at the top of
// its tmux pane (the common case — the pane is mostly empty), that
// erase-from-home covers the whole on-screen area, and tmux preserves the
// erased non-blank rows by scrolling them into the pane's scrollback history
// rather than merely blanking them. The consequence is that every
// intermediate edit state (`boss> abc`, `boss> ab`, `boss> a`, ...) is pushed
// into scrollback and reappears, out of order, when the Boss scrolls the pane
// up. Translating the erase into a cursor-preserving, line-scoped clear keeps
// the redraw visually identical while never scrolling a line into history,
// because line-scoped erases (CSI K / CSI 2K) are not history-preserving.
//
// Matches `\x1b[J` and `\x1b[0J` only; the other erase-display variants
// (`\x1b[1J`, `\x1b[2J`, `\x1b[3J`) are not emitted by readline's line
// refresh and are left untouched so any deliberate full clear keeps its
// stock semantics.
const CLEAR_SCREEN_DOWN = /\x1b\[0?J/g;

// Replace one `clearScreenDown` with a sequence that reproduces its visible
// effect — clear the cursor's row from the cursor to the line end, then clear
// every row below to the bottom of the pane — using only line-scoped erases,
// with the cursor saved and restored so readline can continue its redraw from
// exactly where it left off. `\x1b[1B` (cursor down) stops at the bottom
// margin instead of scrolling, so clearing `rows` lines from any starting row
// is safe and never overshoots into history.
function lineScopedClearDown(rows: number): string {
  const lineCount =
    Number.isFinite(rows) && rows > 0 ? Math.min(Math.floor(rows), 1000) : 1;
  let sequence = '\x1b7\x1b[0K';
  for (let i = 1; i < lineCount; i += 1) {
    sequence += '\x1b[1B\x1b[2K';
  }
  return sequence + '\x1b8';
}

// Rewrite any `clearScreenDown` escapes in a chunk written by readline. `rows`
// is the pane height; when unknown the fallback clears only the cursor's row,
// which still prevents scrollback pollution (line-scoped) and is correct for
// the single-row prompt that is by far the common case.
export function clampClearScreenDown(chunk: string, rows: number): string {
  if (!chunk.includes('\x1b[')) {
    return chunk;
  }
  return chunk.replace(CLEAR_SCREEN_DOWN, () => lineScopedClearDown(rows));
}

// Wrap a TTY output stream so that readline's `clearScreenDown` redraws are
// rewritten per `clampClearScreenDown`, while every other property and method
// (`columns`, `rows`, `isTTY`, `on`, backpressure, ...) is delegated to the
// real stream untouched. Only the readline output is wrapped; the presenter's
// streaming writes keep using the raw stream so legitimate output still scrolls
// into history normally.
export function wrapScrollbackSafeOutput(output: Writable): Writable {
  return new Proxy(output, {
    get(target, prop) {
      if (prop === 'write') {
        return function write(
          this: unknown,
          chunk: unknown,
          ...rest: unknown[]
        ): boolean {
          const data =
            typeof chunk === 'string'
              ? clampClearScreenDown(
                  chunk,
                  (target as { rows?: number }).rows ?? 0,
                )
              : chunk;
          return (
            target.write as (chunk: unknown, ...rest: unknown[]) => boolean
          ).call(target, data, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
