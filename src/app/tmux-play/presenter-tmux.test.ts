// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createEvent } from '../../events.js';
import type { CligentEvent } from '../../types.js';
import { createTmuxPresenter } from './presenter-tmux.js';
import type { TmuxPlayRecord } from './records.js';

// Per TMUX-038/039 the presenter emits SGR escapes around speaker prefixes
// and status bodies. Pre-existing routing / wrapping / content tests assert
// the plain visible text — call `text()` (ANSI stripped) for those. The new
// color-aware tests query `raw()` for byte-exact comparison.
const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

// For tests that intentionally pass an ANSI sequence through the body but
// don't care about the prefix's color: strip the SGR pair around the
// `<who>> ` first-line prefix and keep everything else intact.
function stripPrefixSgr(value: string): string {
  return value.replace(/\x1B\[1;38;2;\d+;\d+;\d+m([^\x1B]*?> )\x1B\[0m/g, '$1');
}

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

function textDeltaEvent(delta: string): CligentEvent {
  return createEvent('text_delta', 'codex', { delta }, 'sid');
}

function toolUseEvent(
  toolName: string,
  input: Record<string, unknown>,
): CligentEvent {
  return createEvent(
    'tool_use',
    'codex',
    { toolName, toolUseId: 'tu1', input },
    'sid',
  );
}

function toolResultEvent(
  toolName: string,
  status: 'success' | 'error' | 'denied',
  output: unknown,
  durationMs?: number,
): CligentEvent {
  return createEvent(
    'tool_result',
    'codex',
    durationMs === undefined
      ? { toolName, toolUseId: 'tu1', status, output }
      : { toolName, toolUseId: 'tu1', status, output, durationMs },
    'sid',
  );
}

function captainEvent(event: CligentEvent): TmuxPlayRecord {
  return {
    type: 'captain_event',
    turnId: 1,
    timestamp: 1,
    event,
  };
}

function errorEvent(message: string): CligentEvent {
  return createEvent('error', 'codex', { message, recoverable: false }, 'sid');
}

function doneEvent(): CligentEvent {
  return createEvent(
    'done',
    'codex',
    {
      status: 'interrupted',
      usage: { inputTokens: 1, outputTokens: 0, toolUses: 0 },
      durationMs: 100,
    },
    'sid',
  );
}

describe('TmuxPresenter', () => {
  it('routes role records to the matching role log', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const reviewer = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([
        ['coder', coder],
        ['reviewer', reviewer],
      ]),
    });

    presenter.onRecord(rolePrompt('coder', 'implement\nfeature'));
    presenter.onRecord(roleEvent('coder', textEvent('done\nagain')));
    presenter.onRecord({
      type: 'role_finished',
      turnId: 1,
      timestamp: 102,
      roleId: 'coder',
      result: {
        status: 'ok',
        roleId: 'coder',
        turnId: 1,
        finalText: 'done',
      },
    });

    expect(coder.text()).toBe(
      'captain> implement\n' +
        '  feature\n' +
        'coder> done\n' +
        '  again\n',
    );
    expect(reviewer.text()).toBe('');
    expect(boss.text()).toBe('');
  });

  it('indents continuation lines across streaming text deltas', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(roleEvent('coder', textDeltaEvent('first\n')));
    presenter.onRecord(roleEvent('coder', textDeltaEvent('second\n\nthird\n')));
    presenter.onRecord({
      type: 'role_finished',
      turnId: 1,
      timestamp: 102,
      roleId: 'coder',
      result: {
        status: 'ok',
        roleId: 'coder',
        turnId: 1,
        finalText: 'first\nsecond\nthird',
      },
    });
    presenter.onRecord(roleEvent('coder', textDeltaEvent('next')));

    expect(coder.text()).toBe(
      'coder> first\n' +
        '  second\n' +
        '\n' +
        '  third\n' +
        'coder> next',
    );
    expect(boss.text()).toBe('');
  });

  it('prefixes first content after leading blank streaming deltas', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(roleEvent('coder', textDeltaEvent('\nhello\n')));
    presenter.onRecord({
      type: 'role_finished',
      turnId: 1,
      timestamp: 102,
      roleId: 'coder',
      result: {
        status: 'ok',
        roleId: 'coder',
        turnId: 1,
        finalText: '\nhello',
      },
    });
    presenter.onRecord(roleEvent('coder', textDeltaEvent('\n')));
    presenter.onRecord(roleEvent('coder', textDeltaEvent('again\n')));

    expect(coder.text()).toBe('\ncoder> hello\n\ncoder> again\n');
    expect(boss.text()).toBe('');
  });

  it('indents across text delta chunks split before newline', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(roleEvent('coder', textDeltaEvent('first')));
    presenter.onRecord(roleEvent('coder', textDeltaEvent('\nsecond\n')));

    expect(coder.text()).toBe('coder> first\n  second\n');
    expect(boss.text()).toBe('');
  });

  it('starts a new block after ok runs with unterminated text', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(roleEvent('coder', textDeltaEvent('first')));
    presenter.onRecord({
      type: 'role_finished',
      turnId: 1,
      timestamp: 102,
      roleId: 'coder',
      result: {
        status: 'ok',
        roleId: 'coder',
        turnId: 1,
        finalText: 'first',
      },
    });
    presenter.onRecord(roleEvent('coder', textDeltaEvent('second\n')));

    expect(coder.text()).toBe('coder> first\ncoder> second\n');
    expect(boss.text()).toBe('');
  });

  it('breaks before a new prefixed block after unterminated text', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(roleEvent('coder', textDeltaEvent('first')));
    presenter.onRecord(rolePrompt('coder', 'next prompt'));

    expect(coder.text()).toBe('coder> first\ncaptain> next prompt\n');
    expect(boss.text()).toBe('');
  });

  it('routes Boss and Captain records to the Boss pane', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord({
      type: 'turn_started',
      turnId: 1,
      timestamp: 100,
      turn: {
        id: 1,
        prompt: 'ship it',
        timestamp: 100,
      },
    });
    presenter.onRecord({
      type: 'captain_status',
      turnId: 1,
      timestamp: 101,
      message: 'reviewing',
      data: { roleCount: 1 },
    });
    presenter.onRecord({
      type: 'captain_prompt',
      turnId: 1,
      timestamp: 102,
      prompt: 'summarize role output',
    });
    presenter.onRecord({
      type: 'captain_event',
      turnId: 1,
      timestamp: 103,
      event: textEvent('answer'),
    });
    presenter.onRecord({
      type: 'captain_finished',
      turnId: 1,
      timestamp: 104,
      result: {
        status: 'ok',
        turnId: 1,
        finalText: 'answer',
      },
    });
    presenter.onRecord({
      type: 'runtime_error',
      turnId: 1,
      timestamp: 105,
      message: 'observer failed',
    });
    presenter.onRecord({
      type: 'turn_finished',
      turnId: 1,
      timestamp: 106,
    });

    expect(boss.text()).toBe(
      'captain> [status] reviewing {"roleCount":1}\n' +
        'captain> answer\n' +
        'captain> [runtime error: observer failed]\n',
    );
    expect(coder.text()).toBe('');
  });

  it('renders final failures once with speaker prefixes', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(roleEvent('coder', errorEvent('role failed')));
    presenter.onRecord({
      type: 'role_finished',
      turnId: 1,
      timestamp: 100,
      roleId: 'coder',
      result: {
        status: 'error',
        roleId: 'coder',
        turnId: 1,
        error: 'role failed',
      },
    });
    presenter.onRecord({
      type: 'captain_event',
      turnId: 1,
      timestamp: 101,
      event: errorEvent('captain failed'),
    });
    presenter.onRecord({
      type: 'captain_finished',
      turnId: 1,
      timestamp: 102,
      result: {
        status: 'error',
        turnId: 1,
        error: 'captain failed',
      },
    });
    presenter.onRecord({
      type: 'role_finished',
      turnId: 2,
      timestamp: 103,
      roleId: 'coder',
      result: {
        status: 'aborted',
        roleId: 'coder',
        turnId: 2,
      },
    });
    presenter.onRecord({
      type: 'captain_event',
      turnId: 2,
      timestamp: 104,
      event: doneEvent(),
    });
    presenter.onRecord({
      type: 'captain_finished',
      turnId: 2,
      timestamp: 105,
      result: {
        status: 'aborted',
        turnId: 2,
      },
    });

    expect(coder.text()).toBe(
      'coder> [error: role failed]\n' +
        'coder> [aborted]\n',
    );
    expect(boss.text()).toBe(
      'captain> [error: captain failed]\n' +
        'captain> [aborted]\n',
    );
  });

  it('omits Boss prompt re-echo and Captain prompt bodies', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord({
      type: 'turn_started',
      turnId: 1,
      timestamp: 100,
      turn: {
        id: 1,
        prompt: 'ship it',
        timestamp: 100,
      },
    });
    presenter.onRecord({
      type: 'captain_prompt',
      turnId: 1,
      timestamp: 101,
      prompt: '=== role:coder status:ok ===\nraw role text\n=== /role:coder ===',
    });

    expect(boss.text()).toBe('');
  });

  it('ignores captain telemetry', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord({
      type: 'captain_telemetry',
      turnId: null,
      timestamp: 100,
      topic: 'sketch.highlight',
      payload: { state: 'done' },
    });

    expect(boss.text()).toBe('');
    expect(coder.text()).toBe('');
  });

  it('does not fail on unserializable status data', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map(),
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    presenter.onRecord({
      type: 'captain_status',
      turnId: null,
      timestamp: 100,
      message: 'ready',
      data: circular,
    });

    expect(boss.text()).toBe('captain> [status] ready [unserializable data]\n');
  });

  it('soft-wraps long lines at the role pane width with hanging indent', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
      roleWidths: new Map([['coder', () => 12]]),
    });

    // First row: `coder> abcdef` is 13 chars, exceeds width 12.
    // Wrap so first row is `coder> abcde` (12 chars), continuation gets two-space indent.
    presenter.onRecord(roleEvent('coder', textEvent('abcdefghij')));

    expect(coder.text()).toBe(
      'coder> abcde\n' +
        '  fghij\n',
    );
    expect(boss.text()).toBe('');
  });

  it('soft-wraps streaming deltas split across the wrap boundary', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
      roleWidths: new Map([['coder', () => 10]]),
    });

    presenter.onRecord(roleEvent('coder', textDeltaEvent('abcd')));
    presenter.onRecord(roleEvent('coder', textDeltaEvent('efgh')));
    presenter.onRecord(roleEvent('coder', textDeltaEvent('ijklm')));

    // Width 10. Row 1 = `coder> ` (7) + 3 chars = `coder> abc`. Continuation
    // rows are `  ` + up to 8 chars (10 - indent). Total content 13 chars
    // splits 3 / 8 / 2 across three rows; no trailing newline since the deltas
    // don't carry one.
    expect(coder.text()).toBe(
      'coder> abc\n' +
        '  defghijk\n' +
        '  lm',
    );
  });

  it('soft-wraps the Boss pane via the configured boss width source', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map(),
      bossWidth: () => 15,
    });

    presenter.onRecord({
      type: 'captain_event',
      turnId: 1,
      timestamp: 100,
      event: textEvent('the quick brown fox'),
    });

    // Width 15. Row 1 = `captain> ` (9) + 6 chars = `captain> the qu`. Row 2 =
    // `  ` + 13 chars = `  ick brown fox`. Trailing `\n` comes from the `text`
    // event formatter.
    expect(boss.text()).toBe(
      'captain> the qu\n' +
        '  ick brown fox\n',
    );
  });

  it('honors width changes between writes', () => {
    const coder = new MemoryWriter();
    let width = 100;
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
      roleWidths: new Map([['coder', () => width]]),
    });

    presenter.onRecord(roleEvent('coder', textEvent('aaaaaaaaaa')));
    width = 8;
    presenter.onRecord(roleEvent('coder', textEvent('bbbbbbbbbb')));

    // First write at width 100 fits on one prefixed row.
    // Second write begins a fresh block (new `coder> ` prefix) and wraps at 8.
    expect(coder.text()).toBe(
      'coder> aaaaaaaaaa\n' +
        'coder> b\n' +
        '  bbbbbb\n' +
        '  bbb\n',
    );
  });

  it('falls back to no soft-wrap when width source returns Infinity', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
      roleWidths: new Map([['coder', () => Number.POSITIVE_INFINITY]]),
    });

    presenter.onRecord(roleEvent('coder', textEvent('one two three four five')));

    expect(coder.text()).toBe('coder> one two three four five\n');
  });

  it('soft-wraps East Asian Wide characters at the correct cell column', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
      // Width 12: row 1 = `coder> ` (7 cells) + 2 CJK chars (4 cells) = 11 cells.
      // A third CJK char would land at column 13 and wrap; continuation rows
      // hold 5 CJK chars (10 cells) before the next wrap.
      roleWidths: new Map([['coder', () => 12]]),
    });

    presenter.onRecord(roleEvent('coder', textEvent('一二三四五六七')));

    expect(coder.text()).toBe(
      'coder> 一二\n' +
        '  三四五六七\n',
    );
  });

  it('flushes a pending escape at a block boundary so the next block parses cleanly', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
    });

    // First role event ends with an incomplete CSI; the run then finishes ok
    // and a fresh role event arrives. Without a flush, the next chunk's 'n'
    // (0x6E, a valid CSI final byte) would be eaten by the lingering parser
    // state and produce `coder> \x1b[31next`.
    presenter.onRecord(roleEvent('coder', textDeltaEvent('hello\x1b[31')));
    presenter.onRecord({
      type: 'role_finished',
      turnId: 1,
      timestamp: 100,
      roleId: 'coder',
      result: {
        status: 'ok',
        roleId: 'coder',
        turnId: 1,
        finalText: 'hello',
      },
    });
    presenter.onRecord(roleEvent('coder', textEvent('next')));

    expect(coder.text()).toBe(
      'coder> hello\x1b[31\n' +
        'coder> next\n',
    );
  });

  it('keeps an ANSI sequence intact when split across streaming deltas', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
      // Width 12: `coder> hello` is exactly 12 cells, so the next visible char
      // must wrap. The CSI lives across the second delta boundary; the wrap
      // must land between the (now-complete) escape and the next space, never
      // inside the CSI's parameter bytes.
      roleWidths: new Map([['coder', () => 12]]),
    });

    presenter.onRecord(roleEvent('coder', textDeltaEvent('hello')));
    presenter.onRecord(roleEvent('coder', textDeltaEvent('\x1b[31')));
    presenter.onRecord(roleEvent('coder', textDeltaEvent('m world')));

    // The original intent: the body's `\x1b[31m` survives the streaming
    // split and is emitted as a single atomic escape (never broken across
    // the wrap boundary). That property still holds. Per the TMUX-038
    // continuation-indent-uncoloring invariant, the body SGR is now also
    // closed before `\n  ` and reopened after the indent so the indent
    // stays outside the red span.
    expect(stripPrefixSgr(coder.raw())).toBe(
      'coder> hello\x1b[31m\x1b[0m\n' +
        '  \x1b[31m world',
    );
  });

  it('passes ANSI escape sequences through without splitting at wrap', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
      roleWidths: new Map([['coder', () => 12]]),
    });

    // The CSI sequences carry no visible cells, so the wrap point depends on
    // the visible chars only ('hello world!' = 12 cells).
    presenter.onRecord(
      roleEvent('coder', textEvent('\x1b[31mhello\x1b[0m world!')),
    );

    // Use raw() — preserving the body's own SGR through soft-wrap is the
    // point. The leading prefix SGR (if any) is stripped by stripPrefixSgr.
    expect(stripPrefixSgr(coder.raw())).toBe(
      'coder> \x1b[31mhello\x1b[0m\n' +
        '   world!\n',
    );
  });

  it('fails when a role log writer is missing', () => {
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map(),
    });

    expect(() =>
      presenter.onRecord(rolePrompt('coder', 'implement feature')),
    ).toThrow('Missing tmux presenter writer for role: coder');
  });

  // TMUX-038/039 color-aware assertions.

  it('wraps the captain prefix in mauve SGR and leaves body uncolored', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(rolePrompt('coder', 'implement feature'));

    // Mauve = #cba6f7 → SGR fg 203;166;247.
    expect(coder.raw()).toBe(
      '\x1b[1;38;2;203;166;247mcaptain> \x1b[0mimplement feature\n',
    );
  });

  it('keys the role prefix color off the adapter map per TMUX-048', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const reviewer = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([
        ['coder', coder],
        ['reviewer', reviewer],
      ]),
      roleAdapters: new Map([
        ['coder', 'claude'],
        ['reviewer', 'codex'],
      ]),
    });

    presenter.onRecord(roleEvent('coder', textEvent('done')));
    presenter.onRecord(roleEvent('reviewer', textEvent('lgtm')));

    // claude → green #a6e3a1 → fg 166;227;161.
    expect(coder.raw()).toBe(
      '\x1b[1;38;2;166;227;161mcoder> \x1b[0mdone\n',
    );
    // codex → teal #94e2d5 → fg 148;226;213.
    expect(reviewer.raw()).toBe(
      '\x1b[1;38;2;148;226;213mreviewer> \x1b[0mlgtm\n',
    );
  });

  it('falls back to uncolored prefix when no adapter is mapped for a role', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
      // roleAdapters intentionally omitted.
    });

    presenter.onRecord(roleEvent('coder', textEvent('hello')));

    expect(coder.raw()).toBe('coder> hello\n');
  });

  it('paints role-error body red while preserving the role prefix color', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
      roleAdapters: new Map([['coder', 'claude']]),
    });

    presenter.onRecord(roleFinished('coder', 'error', 'role failed'));

    // Prefix carries claude green (166;227;161); body carries error red
    // (#f38ba8 → 243;139;168). Two distinct SGR spans on one line.
    expect(coder.raw()).toBe(
      '\x1b[1;38;2;166;227;161mcoder> \x1b[0m' +
        '\x1b[1;38;2;243;139;168m[error: role failed]\x1b[0m\n',
    );
  });

  it('paints role-aborted body yellow while preserving the role prefix color', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
      roleAdapters: new Map([['coder', 'codex']]),
    });

    presenter.onRecord(roleFinished('coder', 'aborted'));

    // Aborted yellow = #f9e2af → fg 249;226;175.
    expect(coder.raw()).toBe(
      '\x1b[1;38;2;148;226;213mcoder> \x1b[0m' +
        '\x1b[1;38;2;249;226;175m[aborted]\x1b[0m\n',
    );
  });

  it('paints captain-pane turn_aborted body yellow under captain prefix', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map(),
    });

    presenter.onRecord({
      type: 'turn_aborted',
      turnId: 1,
      timestamp: 0,
      reason: 'sigint',
    });

    expect(boss.raw()).toBe(
      '\x1b[1;38;2;203;166;247mcaptain> \x1b[0m' +
        '\x1b[1;38;2;249;226;175m[turn aborted: sigint]\x1b[0m\n',
    );
  });

  it('paints runtime_error body red under captain prefix', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map(),
    });

    presenter.onRecord({
      type: 'runtime_error',
      turnId: null,
      timestamp: 0,
      message: 'boom',
    });

    expect(boss.raw()).toBe(
      '\x1b[1;38;2;203;166;247mcaptain> \x1b[0m' +
        '\x1b[1;38;2;243;139;168m[runtime error: boom]\x1b[0m\n',
    );
  });

  it('does not color continuation indent on wrapped blocks', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
      roleAdapters: new Map([['coder', 'claude']]),
      roleWidths: new Map([['coder', () => 12]]),
    });

    // 'coder> hello world' wraps at width 12: first line carries SGR prefix,
    // continuation line carries only two-space indent with no SGR. The space
    // between `hello` and `world` ends up on the continuation row, giving
    // `  ` (indent) + ` world` (carried-over space + word).
    presenter.onRecord(roleEvent('coder', textEvent('hello world')));

    expect(coder.raw()).toBe(
      '\x1b[1;38;2;166;227;161mcoder> \x1b[0mhello\n   world\n',
    );
  });

  it('carries the body SGR across text_delta events for the indent-uncoloring rule', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
      // No roleAdapters → uncolored prefix; the test is about the BODY's
      // SGR persisting across deltas, not about the prefix.
      roleWidths: new Map([['coder', () => 12]]),
    });

    // Delta 1: opens red SGR, emits no visible content. activeBodySgr lives
    // on the writer (TMUX-046 per-writer state) so delta 2's call still
    // knows the span is open.
    presenter.onRecord(roleEvent('coder', textDeltaEvent('\x1b[31m')));
    // Delta 2: 9 visible chars; with prefix `coder> ` (7 cells) and width
    // 12, the wrap fires after the 5th char at column 12 — entirely
    // inside delta 2.
    presenter.onRecord(roleEvent('coder', textDeltaEvent('abcdefghi')));

    // The wrap closes the red opened in delta 1, emits the uncolored
    // indent, then reopens red. Without the per-writer carry, delta 2's
    // local activeBodySgr would be undefined and the indent would render
    // colored.
    expect(coder.raw()).toBe(
      'coder> \x1b[31mabcde\x1b[0m\n  \x1b[31mfghi',
    );
  });

  it('closes and reopens the body SGR around continuation indents when wrapping a colored status', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
      roleAdapters: new Map([['coder', 'claude']]),
      // Width 20: `coder> ` is 7 cells, body width is 13, the error body
      // wraps three times.
      roleWidths: new Map([['coder', () => 20]]),
    });

    presenter.onRecord(
      roleFinished('coder', 'error', 'this is a long error message that will need to wrap'),
    );

    // Each continuation boundary closes the red body span before \n and
    // reopens it after the (uncolored) 2-space indent. The TMUX-038
    // continuation-indent-uncolored invariant.
    expect(coder.raw()).toBe(
      // First row: claude prefix, body red opens, body, body red closes.
      '\x1b[1;38;2;166;227;161mcoder> \x1b[0m' +
        '\x1b[1;38;2;243;139;168m[error: this \x1b[0m\n' +
        // Continuation row: uncolored indent, body red reopens, body, body red closes.
        '  \x1b[1;38;2;243;139;168mis a long error me\x1b[0m\n' +
        '  \x1b[1;38;2;243;139;168mssage that will ne\x1b[0m\n' +
        '  \x1b[1;38;2;243;139;168med to wrap]\x1b[0m\n',
    );

    // Structural invariant: every `\n  ` continuation boundary is preceded
    // by an SGR reset, so the indent itself sits outside any active span.
    const raw = coder.raw();
    let cursor = 0;
    let boundaries = 0;
    while (true) {
      const idx = raw.indexOf('\n  ', cursor);
      if (idx < 0) break;
      expect(raw.slice(0, idx).endsWith('\x1b[0m')).toBe(true);
      boundaries += 1;
      cursor = idx + 3;
    }
    expect(boundaries).toBeGreaterThanOrEqual(3);
  });

  // TMUX-049 tool lifecycle assertions.

  it('renders a role tool_use as a peach `tool>` line in the role pane', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      roleEvent('coder', toolUseEvent('Bash', { command: 'npm test' })),
    );

    // Peach #fab387 → fg 250;179;135.
    expect(coder.raw()).toBe(
      '\x1b[1;38;2;250;179;135mtool> \x1b[0mBash npm test\n',
    );
  });

  it('summarises tool input keys in priority order and truncates long values', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
    });

    // file_path beats arbitrary `description` because `command`/`file_path`/
    // `path`/`pattern`/`prompt`/`description` is the priority order.
    presenter.onRecord(
      roleEvent(
        'coder',
        toolUseEvent('Read', {
          description: 'long-form',
          file_path: '/very/long/path/that/will/be/truncated/because/it/exceeds/sixty/characters/eventually.ts',
        }),
      ),
    );

    expect(coder.text()).toBe(
      'tool> Read /very/long/path/that/will/be/truncated/because/it/exceeds/s…\n',
    );
  });

  it('falls back to JSON when no priority key is a string', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      roleEvent('coder', toolUseEvent('Custom', { count: 3, flag: true })),
    );

    expect(coder.text()).toBe('tool> Custom {"count":3,"flag":true}\n');
  });

  it('omits the input summary when the tool has no input keys', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(roleEvent('coder', toolUseEvent('Status', {})));

    expect(coder.text()).toBe('tool> Status\n');
  });

  it('renders a success tool_result as green `tool< ✓` with dim body', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      roleEvent(
        'coder',
        toolResultEvent(
          'Bash',
          'success',
          { stdout: 'npm test passed\n2 tests run' },
          1234,
        ),
      ),
    );

    // Green #a6e3a1 → bold fg 166;227;161. Dim body uses plain (no-bold)
    // overlay0 #6c7086 → fg 108;112;134. Continuation indent uncolored,
    // reopens dim per the TMUX-046 close/reopen rule.
    expect(coder.raw()).toBe(
      '\x1b[1;38;2;166;227;161mtool< ✓ \x1b[0mBash 1.2s\n' +
        '  \x1b[38;2;108;112;134mnpm test passed\x1b[0m\n' +
        '  \x1b[38;2;108;112;134m2 tests run\x1b[0m\n',
    );
  });

  it('renders an error tool_result as red `tool< ✗` with dim error body', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      roleEvent(
        'coder',
        toolResultEvent('Edit', 'error', 'permission denied', 50),
      ),
    );

    expect(coder.raw()).toBe(
      '\x1b[1;38;2;243;139;168mtool< ✗ \x1b[0mEdit 50ms\n' +
        '  \x1b[38;2;108;112;134mpermission denied\x1b[0m\n',
    );
  });

  it('renders a denied tool_result as yellow `tool< ·` with no body when output is empty', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      roleEvent('coder', toolResultEvent('WebFetch', 'denied', null)),
    );

    expect(coder.raw()).toBe(
      '\x1b[1;38;2;249;226;175mtool< · \x1b[0mWebFetch\n',
    );
  });

  it('routes captain-emitted tool events to the Boss/Captain pane per TMUX-040', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map(),
    });

    presenter.onRecord(
      captainEvent(toolUseEvent('Read', { file_path: 'src/main.ts' })),
    );
    presenter.onRecord(
      captainEvent(toolResultEvent('Read', 'success', '42 lines', 80)),
    );

    expect(boss.text()).toBe(
      'tool> Read src/main.ts\n' +
        'tool< ✓ Read 80ms\n' +
        '  42 lines\n',
    );
  });

  it('formats tool durations as ms under 1s and seconds otherwise', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(roleEvent('coder', toolResultEvent('A', 'success', '', 7)));
    presenter.onRecord(
      roleEvent('coder', toolResultEvent('B', 'success', '', 1500)),
    );

    expect(coder.text()).toBe('tool< ✓ A 7ms\ntool< ✓ B 1.5s\n');
  });

  it('omits the duration when durationMs is undefined', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(roleEvent('coder', toolResultEvent('A', 'success', '')));

    expect(coder.text()).toBe('tool< ✓ A\n');
  });
});

function rolePrompt(roleId: string, prompt: string): TmuxPlayRecord {
  return {
    type: 'role_prompt',
    turnId: 1,
    timestamp: 100,
    roleId,
    prompt,
  };
}

function roleEvent(roleId: string, event: CligentEvent): TmuxPlayRecord {
  return {
    type: 'role_event',
    turnId: 1,
    timestamp: 101,
    roleId,
    event,
  };
}

function roleFinished(
  roleId: string,
  status: 'error' | 'aborted',
  error?: string,
): TmuxPlayRecord {
  return {
    type: 'role_finished',
    turnId: 1,
    timestamp: 102,
    roleId,
    result: {
      roleId,
      turnId: 1,
      status,
      ...(error !== undefined ? { error } : {}),
    },
  };
}
