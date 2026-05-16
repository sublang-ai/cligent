// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createEvent } from '../../events.js';
import type { CligentEvent } from '../../types.js';
import { isGlowAvailable } from '../shared/glow.js';
import { createTmuxPresenter } from './presenter-tmux.js';
import type { TmuxPlayRecord } from './records.js';

// The unit suite mocks renderMarkdown so the presenter logic stays hermetic
// and fast; the real-glow acceptance probes (TTMUX-050) cover glow in
// isolation. Neither layer exercises the integration seam — "presenter +
// real glow output shape" — where every IR-013 polish-round bug lived
// (trim-all, .trimEnd(), space-padded blanks, fallback double-strip).
// These probes close that gap by feeding events through a real
// TmuxPresenter against real glow and asserting structural properties of
// the writer's bytes, not byte-exact output (real glow's ANSI varies by
// version and style).
const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;
const GLOW_AVAILABLE = isGlowAvailable();
const acceptanceIt = GLOW_AVAILABLE ? it : it.skip;

class MemoryWriter {
  readonly chunks: string[] = [];

  write(value: string): void {
    this.chunks.push(value);
  }

  raw(): string {
    return this.chunks.join('');
  }

  text(): string {
    return this.raw().replace(ANSI_PATTERN, '');
  }
}

function textEvent(content: string): CligentEvent {
  return createEvent('text', 'codex', { content }, 'sid');
}

function roleEvent(roleId: string, event: CligentEvent): TmuxPlayRecord {
  return {
    type: 'role_event',
    turnId: 1,
    timestamp: 1,
    roleId,
    event,
  };
}

function roleFinishedOk(roleId: string): TmuxPlayRecord {
  return {
    type: 'role_finished',
    turnId: 1,
    timestamp: 2,
    roleId,
    result: { roleId, turnId: 1, status: 'ok' },
  };
}

function toolResultEvent(
  toolName: string,
  output: unknown,
): CligentEvent {
  return createEvent(
    'tool_result',
    'codex',
    { toolName, toolUseId: 'tu1', status: 'success', output },
    'sid',
  );
}

describe('TmuxPresenter + real glow acceptance', () => {
  acceptanceIt(
    'renders text-body markdown into well-formed prefixed output',
    () => {
      const coder = new MemoryWriter();
      const presenter = createTmuxPresenter({
        boss: new MemoryWriter(),
        roles: new Map([['coder', coder]]),
        roleAdapters: new Map([['coder', 'claude']]),
        roleWidths: new Map([['coder', () => 80]]),
      });

      presenter.onRecord(
        roleEvent(
          'coder',
          textEvent('# Heading\n\nA paragraph with **bold** content.'),
        ),
      );
      presenter.onRecord(roleFinishedOk('coder'));

      const raw = coder.raw();
      const visible = coder.text();
      const lines = visible.split('\n');

      // glow rendered the bold: ANSI present, no literal `**`.
      expect(raw).toMatch(/\x1B\[[0-9;]*m/);
      expect(visible).not.toContain('**');
      expect(visible).toContain('bold');

      // Exactly one prefix line for one block — catches any path that
      // re-prefixes continuation lines or drops the prefix entirely.
      const prefixLines = lines.filter((l) => l.startsWith('coder>'));
      expect(prefixLines).toHaveLength(1);

      // Every nonblank visible line either starts with the prefix or with
      // the two-space hanging indent. Catches regressions where glow's
      // left margin reaches the writer without the indent (or where the
      // indent doubles glow's margin into a wider gap).
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const ok = line.startsWith('coder> ') || line.startsWith('  ');
        expect(
          ok,
          `line missing prefix/indent: ${JSON.stringify(line)}`,
        ).toBe(true);
      }
    },
  );

  acceptanceIt(
    'preserves an intentional payload trailing blank in a tool_result body',
    () => {
      const coder = new MemoryWriter();
      const presenter = createTmuxPresenter({
        boss: new MemoryWriter(),
        roles: new Map([['coder', coder]]),
      });

      // Payload ends with an intentional blank row (think `cat` on a file
      // whose final line is empty). The TMUX-049 contract is that this
      // blank survives the fence + glow + indent pipeline.
      presenter.onRecord(roleEvent('coder', toolResultEvent('Cat', 'foo\n\n')));

      const visible = coder.text();
      // Structural assertion: somewhere in the output, `foo` is followed
      // by a blank line before the next content (the closing fence row).
      // We don't pin exact bytes — real glow's fenced-code rendering
      // varies in padding — but the trailing-blank-preservation property
      // must hold or the user's intent is silently lost.
      expect(visible).toMatch(/foo\s*\n\s*\n/);
    },
  );

  acceptanceIt(
    'does not stack blank lines between consecutive short text blocks',
    () => {
      const coder = new MemoryWriter();
      const presenter = createTmuxPresenter({
        boss: new MemoryWriter(),
        roles: new Map([['coder', coder]]),
        roleWidths: new Map([['coder', () => 80]]),
      });

      // Two short blocks back-to-back. Pre-trim-1, each block carried
      // glow's leading + trailing paragraph margin so the gap between
      // turns was 2 blank lines (one trailing from block A + one leading
      // from block B). The user explicitly flagged this as "excessive
      // blank lines between player messages" on a live screenshot.
      presenter.onRecord(roleEvent('coder', textEvent('first message')));
      presenter.onRecord(roleFinishedOk('coder'));
      presenter.onRecord(roleEvent('coder', textEvent('second message')));
      presenter.onRecord(roleFinishedOk('coder'));

      const visible = coder.text();
      // No run of 3+ consecutive newlines anywhere — that would mean two
      // blank lines stacked between turns, which the user reported as
      // visual noise. One blank line is acceptable (glow's paragraph
      // structure); two is the regression.
      expect(visible).not.toMatch(/\n\n\n/);
      // Both messages reached the writer.
      expect(visible).toContain('first message');
      expect(visible).toContain('second message');
    },
  );
});
