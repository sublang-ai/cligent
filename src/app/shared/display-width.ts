// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export type DisplayToken =
  | { type: 'newline' }
  | { type: 'escape'; sequence: string }
  | { type: 'char'; char: string; cells: 0 | 1 | 2 };

type PendingEscape =
  | { kind: 'esc_only' } // saw ESC at chunk end; next byte decides CSI/OSC/simple
  | { kind: 'csi'; prefix: string } // CSI accumulator (terminated by 0x40–0x7E)
  | { kind: 'osc'; prefix: string }; // OSC accumulator (terminated by BEL or ESC \)

// Stateful parser for the display-token stream. Each `consume(text)` yields
// the tokens fully derivable from the accumulated state; an ANSI escape that
// is incomplete at the chunk boundary stays buffered until the next chunk
// finishes it, so callers can soft-wrap on token boundaries without splitting
// a CSI/OSC in half across streaming writes.
export class DisplayParser {
  private pending: PendingEscape | undefined;

  *consume(text: string): Generator<DisplayToken> {
    let i = 0;
    if (this.pending) {
      const result = this.continuePending(text);
      if (result.token !== undefined) {
        yield result.token;
      }
      i = result.next;
      if (this.pending) {
        // entire chunk absorbed by the pending escape
        return;
      }
    }

    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 0x1b) {
        const result = this.scanEscape(text, i);
        if (result.token !== undefined) {
          yield result.token;
        }
        if (this.pending) {
          return;
        }
        i = result.next;
        continue;
      }
      if (code === 0x0a) {
        yield { type: 'newline' };
        i += 1;
        continue;
      }
      const cp = text.codePointAt(i);
      if (cp === undefined) {
        // unpaired surrogate; emit as zero-width
        yield { type: 'char', char: text[i] ?? '', cells: 0 };
        i += 1;
        continue;
      }
      const char = String.fromCodePoint(cp);
      yield { type: 'char', char, cells: displayCells(cp) };
      i += char.length;
    }
  }

  // Drains any half-parsed escape as a (possibly partial) escape token so a
  // single-shot caller does not lose trailing bytes; streaming callers should
  // not invoke this until the stream is done.
  *flush(): Generator<DisplayToken> {
    if (!this.pending) return;
    yield { type: 'escape', sequence: pendingPrefix(this.pending) };
    this.pending = undefined;
  }

  private continuePending(text: string): {
    token?: DisplayToken;
    next: number;
  } {
    const pending = this.pending!;
    if (pending.kind === 'esc_only') {
      if (text.length === 0) {
        return { next: 0 };
      }
      const next = text.charCodeAt(0);
      if (next === 0x5b) {
        this.pending = { kind: 'csi', prefix: '\x1b[' };
        return this.continueCsi(text, 1);
      }
      if (next === 0x5d) {
        this.pending = { kind: 'osc', prefix: '\x1b]' };
        return this.continueOsc(text, 1);
      }
      this.pending = undefined;
      return {
        token: { type: 'escape', sequence: `\x1b${text[0] ?? ''}` },
        next: 1,
      };
    }
    if (pending.kind === 'csi') {
      return this.continueCsi(text, 0);
    }
    return this.continueOsc(text, 0);
  }

  private continueCsi(
    text: string,
    start: number,
  ): { token?: DisplayToken; next: number } {
    const pending = this.pending as { kind: 'csi'; prefix: string };
    let j = start;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      j += 1;
      if (c >= 0x40 && c <= 0x7e) {
        const sequence = pending.prefix + text.slice(start, j);
        this.pending = undefined;
        return { token: { type: 'escape', sequence }, next: j };
      }
    }
    this.pending = {
      kind: 'csi',
      prefix: pending.prefix + text.slice(start),
    };
    return { next: text.length };
  }

  private continueOsc(
    text: string,
    start: number,
  ): { token?: DisplayToken; next: number } {
    const pending = this.pending as { kind: 'osc'; prefix: string };
    // ST split across chunks: previous chunk ended with ESC, current starts with `\\`.
    if (pending.prefix.endsWith('\x1b') && text.charCodeAt(start) === 0x5c) {
      const sequence = pending.prefix + '\\';
      this.pending = undefined;
      return { token: { type: 'escape', sequence }, next: start + 1 };
    }
    let j = start;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c === 0x07) {
        const sequence = pending.prefix + text.slice(start, j + 1);
        this.pending = undefined;
        return { token: { type: 'escape', sequence }, next: j + 1 };
      }
      if (c === 0x1b && j + 1 < text.length && text.charCodeAt(j + 1) === 0x5c) {
        const sequence = pending.prefix + text.slice(start, j + 2);
        this.pending = undefined;
        return { token: { type: 'escape', sequence }, next: j + 2 };
      }
      j += 1;
    }
    this.pending = {
      kind: 'osc',
      prefix: pending.prefix + text.slice(start),
    };
    return { next: text.length };
  }

  private scanEscape(
    text: string,
    start: number,
  ): { token?: DisplayToken; next: number } {
    if (start + 1 >= text.length) {
      this.pending = { kind: 'esc_only' };
      return { next: text.length };
    }
    const next = text.charCodeAt(start + 1);
    if (next === 0x5b) {
      this.pending = { kind: 'csi', prefix: '\x1b[' };
      return this.continueCsi(text, start + 2);
    }
    if (next === 0x5d) {
      this.pending = { kind: 'osc', prefix: '\x1b]' };
      return this.continueOsc(text, start + 2);
    }
    return {
      token: { type: 'escape', sequence: text.slice(start, start + 2) },
      next: start + 2,
    };
  }
}

function pendingPrefix(pending: PendingEscape): string {
  if (pending.kind === 'esc_only') return '\x1b';
  return pending.prefix;
}

// One-shot tokenization. Equivalent to `new DisplayParser().consume(text)`
// followed by `flush()`, so any trailing partial escape surfaces as a final
// escape token.
export function* iterateDisplay(text: string): Generator<DisplayToken> {
  const parser = new DisplayParser();
  yield* parser.consume(text);
  yield* parser.flush();
}

export function displayCells(codepoint: number): 0 | 1 | 2 {
  if (codepoint < 0x20) return 0; // C0 controls (LF handled separately)
  if (codepoint === 0x7f) return 0; // DEL
  if (codepoint >= 0x80 && codepoint < 0xa0) return 0; // C1 controls
  if (isZeroWidthFormat(codepoint)) return 0;
  if (isCombiningMark(codepoint)) return 0;
  if (isWide(codepoint)) return 2;
  return 1;
}

function isZeroWidthFormat(cp: number): boolean {
  // ZWSP, ZWNJ, ZWJ, Word Joiner, BOM.
  return (
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0x2060 ||
    cp === 0xfeff
  );
}

const COMBINING_MARK_REGEX = /\p{M}/u;
const EMOJI_PRESENTATION_REGEX = /\p{Emoji_Presentation}/u;

function isCombiningMark(cp: number): boolean {
  if (cp < 0x300) return false; // fast path: combining marks start at U+0300
  return COMBINING_MARK_REGEX.test(String.fromCodePoint(cp));
}

// Curated subset of Unicode East Asian Width = Wide/Fullwidth blocks. JS
// regex does not expose the `East_Asian_Width` property, so we cannot match
// it directly; this table covers the high-frequency CJK / Hangul / Kana /
// Yi / Tangut / Khitan / Nüshu / Yijing / Tai Xuan Jing / Counting Rod /
// Fullwidth blocks plus a few related symbol blocks. The
// `Emoji_Presentation` regex catches BMP emoji from U+2300 onward and every
// supplementary emoji block, including blocks added in future Unicode
// releases. EAW=W codepoints that are neither in the listed blocks nor
// `Emoji_Presentation` (e.g., certain archaic scripts and rare symbol
// blocks not yet enumerated) may still fall through to one cell — see
// TMUX-046 for the documented scope.
function isWide(cp: number): boolean {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2329 && cp <= 0x232a) || // angle brackets
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals / Kangxi / IDC / CJK Symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana / Katakana / Bopomofo / CJK Strokes / Enclosed CJK
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4dc0 && cp <= 0x4dff) || // Yijing Hexagram Symbols
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical Forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compat Forms / Small Form Variants
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x16fe0 && cp <= 0x16fe4) || // Ideographic Symbols and Punctuation
    (cp >= 0x16ff0 && cp <= 0x16ff1) || // Ideographic vertical forms
    (cp >= 0x17000 && cp <= 0x187f7) || // Tangut Ideographs
    (cp >= 0x18800 && cp <= 0x18cff) || // Tangut Components + Khitan Small Script (block)
    (cp >= 0x18d00 && cp <= 0x18d7f) || // Tangut Supplement (block)
    (cp >= 0x1aff0 && cp <= 0x1afff) || // Kana Extended-B
    (cp >= 0x1b000 && cp <= 0x1b16f) || // Kana Supplement / Kana Ext-A / Small Kana Ext
    (cp >= 0x1b170 && cp <= 0x1b2ff) || // Nüshu (block)
    (cp >= 0x1d300 && cp <= 0x1d37f) || // Tai Xuan Jing Symbols + Counting Rod Numerals
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Ext B–F
    (cp >= 0x30000 && cp <= 0x3fffd) // CJK Ext G+
  ) {
    return true;
  }
  // Default-emoji-presented codepoints: BMP emoji from U+2300 onward and
  // every supplementary emoji block — including any future block — count as
  // two cells without source changes.
  if (cp >= 0x2300) {
    return EMOJI_PRESENTATION_REGEX.test(String.fromCodePoint(cp));
  }
  return false;
}
