// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createEvent } from '../../events.js';
import type { CligentEvent } from '../../types.js';
import { createTmuxPresenter } from './presenter-tmux.js';
import type { TmuxPlayRecord } from './records.js';

class MemoryWriter {
  readonly chunks: string[] = [];

  write(value: string): void {
    this.chunks.push(value);
  }

  text(): string {
    return this.chunks.join('');
  }
}

function textEvent(content: string): CligentEvent {
  return createEvent('text', 'codex', { content }, 'sid');
}

function textDeltaEvent(delta: string): CligentEvent {
  return createEvent('text_delta', 'codex', { delta }, 'sid');
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

    expect(coder.text()).toBe(
      'coder> hello\x1b[31m\n' +
        '   world',
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

    expect(coder.text()).toBe(
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
