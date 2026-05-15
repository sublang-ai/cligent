// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { isGlowAvailable, renderMarkdown } from './glow.js';

// Mirror the launcher.acceptance.test.ts pattern: gate the suite on a real
// `glow --version` probe so a runner without glow installed self-skips cleanly
// rather than failing on the first spawn. TMUX-051 makes glow a hard launch
// requirement, and TTMUX-050 / the Real-tmux Acceptance preamble agree that
// acceptance suites self-skip when their external binary is unavailable.
const GLOW_AVAILABLE = isGlowAvailable();
const acceptanceIt = GLOW_AVAILABLE ? it : it.skip;

const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

describe('glow render acceptance', () => {
  acceptanceIt(
    'renders **bold** markers as ANSI styling, not literal asterisks',
    () => {
      const output = renderMarkdown('hello **world** today\n', 80);

      // Visible content is preserved; glow consumes the `**` markers and
      // emits ANSI bold around the inner span, so the rendered output
      // contains styling but no literal `**`.
      expect(output.length).toBeGreaterThan(0);
      expect(output).toMatch(/\x1B\[/);
      expect(output).not.toContain('**');
      expect(stripAnsi(output)).toContain('world');
    },
  );

  acceptanceIt(
    'leaves a long line inside a fenced code block unwrapped at narrow width',
    () => {
      const longLine = 'x'.repeat(200);
      const fenced = '```\n' + longLine + '\n```\n';

      // Pinned at width 40 to force a word-wrap on prose; glow shall still
      // leave the fenced code block's 200-character line intact, matching
      // TMUX-049's "glow leaves long code lines unwrapped by design".
      const output = renderMarkdown(fenced, 40);
      expect(stripAnsi(output)).toContain(longLine);
    },
  );

  acceptanceIt('returns non-empty styled output for a plain paragraph', () => {
    // Smoke check that glow renders at all: a paragraph at a reasonable
    // width produces non-empty output containing the source words. Mostly
    // guards against silent glow misconfiguration (e.g., a glow build that
    // writes only to a TTY and emits nothing under spawnSync — `-s dark`
    // forces a real style and is asserted indirectly by the bold test).
    const output = renderMarkdown('the quick brown fox\n', 80);
    expect(output.length).toBeGreaterThan(0);
    expect(stripAnsi(output)).toContain('quick');
    expect(stripAnsi(output)).toContain('fox');
  });
});
