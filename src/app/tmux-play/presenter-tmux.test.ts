// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent } from '../../events.js';
import type { CligentEvent } from '../../types.js';

// TMUX-050: text bodies flow through glow before reaching the writer. Mock
// the render module at the import boundary so presenter tests stay
// hermetic — none of them need a real glow binary. Default behavior is
// identity (return the text unchanged) so post-indent/prefix assertions
// stay readable; individual tests override when they care about glow
// arguments or simulated render failures.
const { renderMarkdownMock } = vi.hoisted(() => ({
  renderMarkdownMock: vi.fn(
    (text: string, _width: number, _flavor: 'mocha' | 'latte') => text,
  ),
}));

vi.mock('../shared/glow.js', () => ({
  isGlowAvailable: () => true,
  renderMarkdown: renderMarkdownMock,
  GLOW_INSTALL_URL: 'https://github.com/charmbracelet/glow#installation',
}));

import { createTmuxPresenter } from './presenter-tmux.js';
import type { CaptainEventRecord, TmuxPlayRecord } from './records.js';

// Per TMUX-038/039 the presenter emits SGR escapes around speaker prefixes
// and status bodies. Tests that assert visible content call `text()`
// (ANSI-stripped); the color-aware tests query `raw()` for byte-exact
// comparison.
const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

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

function captainEvent(event: CligentEvent): CaptainEventRecord {
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
  beforeEach(() => {
    renderMarkdownMock.mockReset();
    renderMarkdownMock.mockImplementation((text: string) => text);
  });

  // Buffer-then-render core (TMUX-050).

  it('routes player records to the matching player log and renders each block', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const reviewer = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map([
        ['coder', coder],
        ['reviewer', reviewer],
      ]),
    });

    presenter.onRecord(playerPrompt('coder', 'implement\nfeature'));
    presenter.onRecord(playerEvent('coder', textEvent('done\nagain')));
    presenter.onRecord(playerFinishedOk('coder'));

    // Identity-mocked glow plus the TMUX-038 prefix/indent grammar yields the
    // same shape as the pre-IR-013 character-wrap path for short prose.
    expect(coder.text()).toBe(
      'captain> implement\n' +
        '  feature\n' +
        'coder> done\n' +
        '  again\n',
    );
    expect(reviewer.text()).toBe('');
    expect(boss.text()).toBe('');
  });

  it('buffers streaming text_delta events and flushes on player_finished', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerEvent('coder', textDeltaEvent('first\n')));
    // Nothing should reach the writer mid-stream — the block is still open.
    expect(coder.text()).toBe('');

    presenter.onRecord(playerEvent('coder', textDeltaEvent('second\n\nthird\n')));
    expect(coder.text()).toBe('');

    presenter.onRecord(playerFinishedOk('coder'));

    expect(coder.text()).toBe(
      'coder> first\n' +
        '  second\n' +
        '\n' +
        '  third\n',
    );
    // Glow saw the assembled block, not three separate deltas.
    expect(renderMarkdownMock).toHaveBeenCalledTimes(1);
    expect(renderMarkdownMock.mock.calls[0]?.[0]).toBe(
      'first\nsecond\n\nthird\n',
    );
  });

  it('opens a fresh block for streamed deltas after a flush', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerEvent('coder', textDeltaEvent('first')));
    presenter.onRecord(playerFinishedOk('coder'));
    presenter.onRecord(playerEvent('coder', textDeltaEvent('second\n')));
    presenter.onRecord(playerFinishedOk('coder'));

    expect(coder.text()).toBe('coder> first\ncoder> second\n');
  });

  it('trims leading and trailing blank lines from rendered output before prefixing', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    // Simulate glow's default dark style which wraps every rendered block in
    // a leading + trailing blank line as its paragraph margin. Without the
    // trim, two consecutive blocks land as `\nA\n\n\nB\n` with stacked
    // margins; with the trim they sit immediately after one another so the
    // pane reads as a turn log rather than a sparsely-padded one.
    renderMarkdownMock.mockImplementation(
      (text: string) => `\n${text.trimEnd()}\n\n`,
    );

    presenter.onRecord(playerEvent('coder', textEvent('hello')));
    presenter.onRecord(playerEvent('coder', textEvent('again')));

    expect(coder.text()).toBe('coder> hello\ncoder> again\n');
  });

  it('keeps internal blank lines between paragraphs even when the edges are trimmed', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    renderMarkdownMock.mockImplementation(
      () => '\nfirst paragraph\n\nsecond paragraph\n\n',
    );

    presenter.onRecord(playerEvent('coder', textEvent('hello')));

    // The leading and trailing glow blanks are gone, but the inter-paragraph
    // blank between `first` and `second` survives untouched.
    expect(coder.text()).toBe(
      'coder> first paragraph\n\n  second paragraph\n',
    );
  });

  it('preserves ANSI-wrapped blank rows from glow without right-padding spaces', () => {
    // Glow code-block padding sometimes ships as `\x1b[<bg>m   \x1b[0m`
    // — a span of background color around spaces, no visible characters.
    // The indent decision still treats the row as blank, but the right-side
    // reservation spaces are stripped so a glow-rendered block does not fill
    // the pane with padded cells after visible content ends.
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    const ansiPad = '\x1b[48;5;235m   \x1b[0m';
    const strippedAnsiPad = '\x1b[48;5;235m\x1b[0m';
    renderMarkdownMock.mockImplementation(
      () => `${ansiPad}\nfirst\n${ansiPad}\nsecond\n${ansiPad}\n`,
    );

    presenter.onRecord(playerEvent('coder', textEvent('payload')));

    // Outer-margin trim drops one padded blank per edge. The middle
    // ANSI-wrapped pad sits between `first` and `second` and reaches the
    // writer without its right-padding spaces, NOT prefixed with `  `.
    expect(coder.raw()).toBe(
      'coder> first\n' +
        `${strippedAnsiPad}\n` +
        '  second\n',
    );
  });

  it('keeps space-padded blank rows blank without preserving right padding', () => {
    // Real glow emits "blank" structural rows as space-padded lines (often
    // with a background-color SGR), not as truly empty strings. A blanket
    // `line.length === 0` indent decision treats those as non-blank and
    // prepends two spaces. The presenter now strips glow's right-padding
    // cells first, then uses visibleNonblank() so the row remains a blank
    // line without reserving the rest of the pane.
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    renderMarkdownMock.mockImplementation(
      () => '   \nhello\n   \nworld\n   \n',
    );

    presenter.onRecord(playerEvent('coder', textEvent('payload')));

    // Outer-margin trim drops one padded blank per edge (it already uses
    // visibleNonblank). The remaining middle padded row is still blank and
    // unindented, but its padding spaces are gone.
    expect(coder.text()).toBe(
      'coder> hello\n' +
        '\n' +
        '  world\n',
    );
  });

  it('strips glow right padding while preserving left indentation', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    renderMarkdownMock.mockImplementation(
      () => '  first     \n  second\t \n',
    );

    presenter.onRecord(playerEvent('coder', textEvent('payload')));

    expect(coder.text()).toBe('coder>   first\n    second\n');
    for (const line of coder.text().split('\n')) {
      expect(line).not.toMatch(/[ \t]+$/u);
    }
  });

  it('trims only the outermost one leading and one trailing blank per edge', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    // Simulate glow's actual fenced-code-with-payload-blank rendering shape:
    // outer margin + frame-top + payload leading blank + content + payload
    // trailing blank + frame-bottom + outer margin. Without an outer-only
    // trim, a blanket multi-line trim collapses the frame rows together
    // with the payload edges and the structure visible in real glow output
    // disappears — the bug the reviewer flagged for fenced code.
    renderMarkdownMock.mockImplementation(
      () => '\n\n\ncontent\n\n\n',
    );

    presenter.onRecord(playerEvent('coder', textEvent('payload')));

    // After trim-1: leading blank count goes from 3 to 2; trailing from 2
    // to 1. The kept blanks ride between the prefix and the content,
    // preserving glow's structural padding so a real-glow fenced block
    // does not lose its frame.
    expect(coder.text()).toBe(
      '\n\ncoder> content\n\n',
    );
  });

  it('flushes the open block before a tool event arrives on the same writer', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerEvent('coder', textDeltaEvent('partial\n')));
    presenter.onRecord(
      playerEvent('coder', toolUseEvent('Bash', { command: 'ls' })),
    );

    // The text deltas flushed before the `[tool ↪]` header so the order on
    // the pane matches the order of events.
    expect(coder.text()).toBe('coder> partial\ncoder> [tool ↪] Bash ls\n');
  });

  it('flushes the open block before a new player_prompt on the same writer', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerEvent('coder', textDeltaEvent('first')));
    presenter.onRecord(playerPrompt('coder', 'next prompt'));

    expect(coder.text()).toBe('coder> first\ncaptain> next prompt\n');
  });

  it('flushes the open block before a runtime_error', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
    });

    presenter.onRecord(captainEvent(textDeltaEvent('partial')));
    presenter.onRecord({
      type: 'runtime_error',
      turnId: 1,
      timestamp: 0,
      message: 'boom',
    });

    expect(boss.text()).toBe(
      'captain> partial\ncaptain> [runtime error] boom\n',
    );
  });

  // Render-width budgeting (TMUX-050).

  it('renders text blocks at paneWidth minus the continuation indent', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
      playerWidths: new Map([['coder', () => 80]]),
    });

    presenter.onRecord(playerEvent('coder', textEvent('hello world')));

    // Text blocks render to the two-space continuation budget so continuation
    // rows use the full pane width. The first rendered row is split later if
    // the speaker prefix needs extra cells.
    expect(renderMarkdownMock).toHaveBeenCalledWith('hello world\n', 78, 'mocha');
  });

  it('splits only the first rendered row to fit the visible speaker prefix', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
      bossWidth: () => 40,
    });
    renderMarkdownMock.mockImplementation(
      () =>
        '  I added a copy-mode wheel-up clamp\n' +
        '  so scrolling stops at the oldest\n',
    );

    presenter.onRecord(captainEvent(textEvent('input')));

    const lines = boss.text().trimEnd().split('\n');
    expect(lines).toEqual([
      'captain>   I added a copy-mode wheel-up',
      '  clamp',
      '    so scrolling stops at the oldest',
    ]);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it('keeps the prefix-fit continuation indent outside active ANSI spans', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
      playerWidths: new Map([['coder', () => 30]]),
    });
    renderMarkdownMock.mockImplementation(
      () => '\x1b[1m  alpha beta gamma delta\x1b[0m\n',
    );

    presenter.onRecord(playerEvent('coder', textEvent('input')));

    expect(coder.raw()).toContain('\x1b[0m\n  \x1b[1m');
    expect(coder.text().split('\n').slice(0, 2)).toEqual([
      'coder>   alpha beta gamma',
      '  delta',
    ]);
  });

  it('falls back to an 80-column default render width when no width source is configured', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
      // No playerWidths entry, so the writer has no width source.
    });

    presenter.onRecord(playerEvent('coder', textEvent('hi')));

    expect(renderMarkdownMock).toHaveBeenCalledWith('hi\n', 78, 'mocha');
  });

  // Prefix grammar (TMUX-038).

  it('applies the colored speaker prefix to glow output without wrapping it in another span', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
      playerAdapters: new Map([['coder', 'claude']]),
    });

    // Simulate glow returning a bolded heading so we can check that the
    // post-indent does not corrupt embedded SGR runs.
    renderMarkdownMock.mockImplementation(
      () => '\x1b[1mHeading\x1b[0m\nbody line\n',
    );

    presenter.onRecord(playerEvent('coder', textEvent('# Heading\nbody line')));

    expect(coder.raw()).toBe(
      '\x1b[1;38;2;166;227;161mcoder> \x1b[0m\x1b[1mHeading\x1b[0m\n' +
        '  body line\n',
    );
  });

  it('renders bold markdown markers when glow translates them, not as literal asterisks', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    renderMarkdownMock.mockImplementation(
      () => 'value is \x1b[1m57°F\x1b[0m today\n',
    );

    presenter.onRecord(playerEvent('coder', textEvent('value is **57°F** today')));

    // The visible content has no literal `**` markers — they were consumed
    // by glow and rendered as a bold SGR span around `57°F`.
    expect(coder.text()).toBe('coder> value is 57°F today\n');
    expect(coder.raw()).not.toContain('**');
  });

  it('leaves blank continuation lines blank rather than indented', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerEvent('coder', textEvent('one\n\ntwo')));

    expect(coder.text()).toBe('coder> one\n\n  two\n');
  });

  it('emits nothing for all-blank rendered output, never a bare prefix line', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerEvent('coder', textEvent('   \n\n')));

    // Source had no nonblank content. After the edge trim there is no line
    // to tag, so the writer receives no bytes — empty content does not
    // surface as a stranded `coder> ` line or a parade of blank lines.
    expect(coder.text()).toBe('');
  });

  // Table-driven: vary glow's leading/trailing blank-line counts across the
  // [0, 3] grid to catch off-by-one regressions in the trim-1 contract. The
  // invariant is "strip at most one blank per edge, never more, never less"
  // — easy to silently get wrong on any future refactor of trimOuterMargin.
  for (let leading = 0; leading <= 3; leading++) {
    for (let trailing = 0; trailing <= 3; trailing++) {
      it(`text-body trim leaves ${Math.max(0, leading - 1)} leading + ${Math.max(0, trailing - 1)} trailing blanks given ${leading} + ${trailing} from glow`, () => {
        const coder = new MemoryWriter();
        const presenter = createTmuxPresenter({
          boss: new MemoryWriter(),
          players: new Map([['coder', coder]]),
        });

        renderMarkdownMock.mockImplementation(
          () => '\n'.repeat(leading) + 'content\n' + '\n'.repeat(trailing),
        );

        presenter.onRecord(playerEvent('coder', textEvent('input')));

        const expectedLeading = Math.max(0, leading - 1);
        const expectedTrailing = Math.max(0, trailing - 1);
        const expected =
          '\n'.repeat(expectedLeading) +
          'coder> content\n' +
          '\n'.repeat(expectedTrailing);
        expect(coder.text()).toBe(expected);
      });
    }
  }

  // Mid-session glow failure.

  it('falls back to raw text when renderMarkdown throws mid-session', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    renderMarkdownMock.mockImplementationOnce(() => {
      throw new Error('glow render failed: broken pipe');
    });

    presenter.onRecord(playerEvent('coder', textEvent('emergency message')));

    // Content reaches the pane (under the prefix) even though glow blew up;
    // the launcher gate handles the startup case, so this guards rare
    // mid-session failures rather than masking a misconfigured environment.
    expect(coder.text()).toBe('coder> emergency message\n');
  });

  // Routing (Boss vs. player panes).

  it('routes Boss and Captain records to the Boss pane', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map([['coder', coder]]),
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
      data: { playerCount: 1 },
    });
    presenter.onRecord({
      type: 'captain_prompt',
      turnId: 1,
      timestamp: 102,
      prompt: 'summarize player output',
    });
    presenter.onRecord(captainEvent(textEvent('answer')));
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
      'captain> [status] reviewing {"playerCount":1}\n' +
        'captain> answer\n' +
        'captain> [runtime error] observer failed\n',
    );
    expect(coder.text()).toBe('');
  });

  it('omits Boss prompt re-echo and Captain prompt bodies on the Boss pane', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
    });

    presenter.onRecord({
      type: 'turn_started',
      turnId: 1,
      timestamp: 100,
      turn: { id: 1, prompt: 'ship it', timestamp: 100 },
    });
    presenter.onRecord({
      type: 'captain_prompt',
      turnId: 1,
      timestamp: 101,
      prompt: '=== player:coder status:ok ===\nraw player text\n=== /player:coder ===',
    });

    expect(boss.text()).toBe('');
  });

  it('ignores captain telemetry', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
    });

    presenter.onRecord({
      type: 'captain_telemetry',
      turnId: null,
      timestamp: 100,
      topic: 'sketch.highlight',
      payload: { state: 'done' },
    });

    expect(boss.text()).toBe('');
  });

  // Hidden Captain calls (TMUX-072).

  it('writes nothing to the Boss pane for a hidden Captain call', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
    });

    // A hidden call's records flow through the presenter exactly as a
    // visible one would (prompt → streamed deltas → finished), but every
    // record carries `visibility: 'hidden'`.
    presenter.onRecord({
      type: 'captain_prompt',
      turnId: 1,
      timestamp: 1,
      prompt: 'hidden work',
      visibility: 'hidden',
    });
    presenter.onRecord({
      ...captainEvent(textDeltaEvent('secret ')),
      visibility: 'hidden',
    });
    presenter.onRecord({
      ...captainEvent(textDeltaEvent('answer')),
      visibility: 'hidden',
    });
    presenter.onRecord({
      type: 'captain_finished',
      turnId: 1,
      timestamp: 2,
      result: { status: 'ok', turnId: 1, finalText: 'secret answer' },
      visibility: 'hidden',
    });

    // Skipping the hidden events keeps the text out of the open block, so
    // the finished record has nothing to flush — zero bytes reach the pane.
    expect(boss.raw()).toBe('');
    expect(renderMarkdownMock).not.toHaveBeenCalled();
  });

  it('writes no error line for a hidden Captain call that fails', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
    });

    presenter.onRecord({
      ...captainEvent(errorEvent('captain failed')),
      visibility: 'hidden',
    });
    presenter.onRecord({
      type: 'captain_finished',
      turnId: 1,
      timestamp: 2,
      result: { status: 'error', turnId: 1, error: 'captain failed' },
      visibility: 'hidden',
    });

    // The error status is still carried in the record for non-presenter
    // observers, but the tmux presenter emits nothing for a hidden call.
    expect(boss.raw()).toBe('');
  });

  it('renders a visible Captain call unchanged when visibility is set explicitly', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
    });

    // An explicit `visibility: 'visible'` produces byte-for-byte the same
    // output as an untagged (omitted) record.
    presenter.onRecord({
      ...captainEvent(textEvent('answer')),
      visibility: 'visible',
    });
    presenter.onRecord({
      type: 'captain_finished',
      turnId: 1,
      timestamp: 2,
      result: { status: 'ok', turnId: 1, finalText: 'answer' },
      visibility: 'visible',
    });

    expect(boss.text()).toBe('captain> answer\n');
  });

  it('does not fail on unserializable status data', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
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

  it('fails when a player log writer is missing', () => {
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map(),
    });

    expect(() =>
      presenter.onRecord(playerPrompt('coder', 'implement feature')),
    ).toThrow('Missing tmux presenter writer for player: coder');
  });

  // Status line coloring (TMUX-038/039).

  it('renders final failures once with speaker prefixes and status SGRs', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerEvent('coder', errorEvent('player failed')));
    presenter.onRecord(playerFinished('coder', 'error', 'player failed'));
    presenter.onRecord(captainEvent(errorEvent('captain failed')));
    presenter.onRecord({
      type: 'captain_finished',
      turnId: 1,
      timestamp: 102,
      result: { status: 'error', turnId: 1, error: 'captain failed' },
    });
    presenter.onRecord(playerFinished('coder', 'aborted'));
    presenter.onRecord(captainEvent(doneEvent()));
    presenter.onRecord({
      type: 'captain_finished',
      turnId: 2,
      timestamp: 105,
      result: { status: 'aborted', turnId: 2 },
    });

    expect(coder.text()).toBe(
      'coder> [error] player failed\n' +
        'coder> [aborted]\n',
    );
    expect(boss.text()).toBe(
      'captain> [error] captain failed\n' +
        'captain> [aborted]\n',
    );
  });

  it('wraps the captain prefix in mauve SGR for a player_prompt', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerPrompt('coder', 'implement feature'));

    expect(coder.raw()).toBe(
      '\x1b[1;38;2;203;166;247mcaptain> \x1b[0mimplement feature\n',
    );
  });

  it('keys the player prefix color off the adapter map per TMUX-048', () => {
    const coder = new MemoryWriter();
    const reviewer = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([
        ['coder', coder],
        ['reviewer', reviewer],
      ]),
      playerAdapters: new Map([
        ['coder', 'claude'],
        ['reviewer', 'codex'],
      ]),
    });

    presenter.onRecord(playerEvent('coder', textEvent('done')));
    presenter.onRecord(playerEvent('reviewer', textEvent('lgtm')));

    expect(coder.raw()).toBe(
      '\x1b[1;38;2;166;227;161mcoder> \x1b[0mdone\n',
    );
    expect(reviewer.raw()).toBe(
      '\x1b[1;38;2;148;226;213mreviewer> \x1b[0mlgtm\n',
    );
  });

  it('falls back to uncolored prefix when no adapter is mapped for a player', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerEvent('coder', textEvent('hello')));

    expect(coder.raw()).toBe('coder> hello\n');
  });

  it('paints player-error body red while preserving the player prefix color', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
      playerAdapters: new Map([['coder', 'claude']]),
    });

    presenter.onRecord(playerFinished('coder', 'error', 'player failed'));

    // Per TMUX-039 the SGR span now wraps only the bracketed tag `[error]`;
    // the body sits outside the brackets, unstyled.
    expect(coder.raw()).toBe(
      '\x1b[1;38;2;166;227;161mcoder> \x1b[0m' +
        '\x1b[1;38;2;243;139;168m[error]\x1b[0m player failed\n',
    );
  });

  it('paints player-aborted body yellow while preserving the player prefix color', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
      playerAdapters: new Map([['coder', 'codex']]),
    });

    presenter.onRecord(playerFinished('coder', 'aborted'));

    // No body for `[aborted]` per TMUX-039 — the bracketed tag stands alone.
    expect(coder.raw()).toBe(
      '\x1b[1;38;2;148;226;213mcoder> \x1b[0m' +
        '\x1b[1;38;2;249;226;175m[aborted]\x1b[0m\n',
    );
  });

  it('paints captain-pane turn_aborted body yellow under captain prefix', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
    });

    presenter.onRecord({
      type: 'turn_aborted',
      turnId: 1,
      timestamp: 0,
      reason: 'sigint',
    });

    // Per TMUX-039 only the bracketed tag carries the yellow outcome SGR
    // span; the reason `sigint` sits outside the brackets, unstyled.
    expect(boss.raw()).toBe(
      '\x1b[1;38;2;203;166;247mcaptain> \x1b[0m' +
        '\x1b[1;38;2;249;226;175m[turn aborted]\x1b[0m sigint\n',
    );
  });

  it('omits the body when a turn_aborted record carries no reason', () => {
    // TMUX-039 kind table: `[turn aborted]` body is the abort reason "when
    // present". TurnAbortedRecord.reason is optional, so a record without
    // it must render as the bracketed tag alone — no synthesized fallback
    // word (under the outside-brackets grammar a placeholder like
    // `aborted` would read as an actual reason, not absence).
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
    });

    presenter.onRecord({
      type: 'turn_aborted',
      turnId: 1,
      timestamp: 0,
    });

    expect(boss.raw()).toBe(
      '\x1b[1;38;2;203;166;247mcaptain> \x1b[0m' +
        '\x1b[1;38;2;249;226;175m[turn aborted]\x1b[0m\n',
    );
  });

  it('paints runtime_error body red under captain prefix', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
    });

    presenter.onRecord({
      type: 'runtime_error',
      turnId: null,
      timestamp: 0,
      message: 'boom',
    });

    // TMUX-039 body-attachment normalization: message sits outside the
    // brackets unstyled; the colored span covers `[runtime error]` only.
    expect(boss.raw()).toBe(
      '\x1b[1;38;2;203;166;247mcaptain> \x1b[0m' +
        '\x1b[1;38;2;243;139;168m[runtime error]\x1b[0m boom\n',
    );
  });

  // Tool lifecycle (TMUX-049 under the unified TMUX-039 bracketed-tag grammar).

  it('colors the player speaker prefix by the caller\'s adapter accent for tool_use', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
      playerAdapters: new Map([['coder', 'claude']]),
    });

    presenter.onRecord(
      playerEvent('coder', toolUseEvent('Bash', { command: 'npm test' })),
    );

    // claude → green #a6e3a1 → fg 166;227;161 on the `coder> ` speaker prefix
    // span. The `[tool ↪]` tag is uncolored per TMUX-039 — speaker identity is
    // already carried by the prefix, so the tag carries no color span.
    expect(coder.raw()).toBe(
      '\x1b[1;38;2;166;227;161mcoder> \x1b[0m[tool ↪] Bash npm test\n',
    );
  });

  it('leaves the speaker prefix uncolored for tool_use when no adapter is mapped', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
      // No playerAdapters entry — matches the TMUX-038 prefix fallback.
    });

    presenter.onRecord(
      playerEvent('coder', toolUseEvent('Bash', { command: 'npm test' })),
    );

    // No SGR anywhere: the prefix has no adapter color and the `[tool ↪]`
    // bracketed tag is always uncolored per TMUX-039.
    expect(coder.raw()).toBe('coder> [tool ↪] Bash npm test\n');
  });

  it('colors the captain speaker prefix mauve for a Captain-emitted tool_use', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
    });

    presenter.onRecord(
      captainEvent(toolUseEvent('Read', { file_path: 'src/main.ts' })),
    );

    // captain → mauve #cba6f7 → fg 203;166;247 on the `captain> ` prefix.
    // The `[tool ↪]` tag stays uncolored per TMUX-039.
    expect(boss.raw()).toBe(
      '\x1b[1;38;2;203;166;247mcaptain> \x1b[0m[tool ↪] Read src/main.ts\n',
    );
  });

  it('summarises tool input keys in priority order and truncates long values', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      playerEvent(
        'coder',
        toolUseEvent('Read', {
          description: 'long-form',
          file_path:
            '/very/long/path/that/will/be/truncated/because/it/exceeds/sixty/characters/eventually.ts',
        }),
      ),
    );

    expect(coder.text()).toBe(
      'coder> [tool ↪] Read /very/long/path/that/will/be/truncated/because/it/exceeds/s…\n',
    );
  });

  it('truncates wide-character input summaries by cells, not code units', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      playerEvent(
        'coder',
        toolUseEvent('X', { prompt: '一二三四五六七八九十'.repeat(4) }),
      ),
    );
    presenter.onRecord(
      playerEvent('coder', toolUseEvent('Y', { prompt: '🚀'.repeat(40) })),
    );

    expect(coder.text()).toBe(
      'coder> [tool ↪] X 一二三四五六七八九十一二三四五六七八九十一二三四五六七八九…\n' +
        'coder> [tool ↪] Y 🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀…\n',
    );
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(coder.raw())).toBe(false);
  });

  it('falls back to JSON when no priority key is a string', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      playerEvent('coder', toolUseEvent('Custom', { count: 3, flag: true })),
    );

    expect(coder.text()).toBe('coder> [tool ↪] Custom {"count":3,"flag":true}\n');
  });

  it('uses `query` as a priority key so search-tool calls do not fall through to JSON', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      playerEvent(
        'coder',
        toolUseEvent('ToolSearch', {
          query: 'select:WebFetch',
          max_results: 1,
        }),
      ),
    );

    // Without `query` in the priority list this would render as
    // `coder> [tool ↪] ToolSearch {"query":"select:WebFetch","max_results":1}`
    // — technically correct but visually noisy and the same pattern the user
    // flagged in IR-013's post-implementation review.
    expect(coder.text()).toBe('coder> [tool ↪] ToolSearch select:WebFetch\n');
  });

  it('omits the input summary when the tool has no input keys', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerEvent('coder', toolUseEvent('Status', {})));

    // No usable input summary → line ends at `<toolName>` with no trailing
    // space per TMUX-049.
    expect(coder.text()).toBe('coder> [tool ↪] Status\n');
  });

  it('renders a success tool_result with a green `[tool ✓]` tag and a fenced + indented body', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      playerEvent(
        'coder',
        toolResultEvent(
          'Bash',
          'success',
          { stdout: 'npm test passed\n2 tests run' },
          1234,
        ),
      ),
    );

    // Under TMUX-039 the colored SGR span covers only the bracketed tag
    // `[tool ✓]`; the body `Bash 1.2s` sits outside the brackets unstyled.
    // The speaker prefix `coder> ` is uncolored here (no playerAdapters
    // mapping for `coder`). The body block is wrapped in a triple-backtick
    // fence (longest backtick run in the payload is 0, so the minimum fence
    // of three applies) and passed through glow; the identity mock returns
    // it verbatim. The result is then indented two spaces under the header.
    expect(coder.raw()).toBe(
      'coder> \x1b[1;38;2;166;227;161m[tool ✓]\x1b[0m Bash 1.2s\n' +
        '  ```\n' +
        '  npm test passed\n' +
        '  2 tests run\n' +
        '  ```\n',
    );
  });

  it('renders an error tool_result with a red `[tool ✗]` tag and a fenced + indented body', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      playerEvent(
        'coder',
        toolResultEvent('Edit', 'error', 'permission denied', 50),
      ),
    );

    expect(coder.raw()).toBe(
      'coder> \x1b[1;38;2;243;139;168m[tool ✗]\x1b[0m Edit 50ms\n' +
        '  ```\n' +
        '  permission denied\n' +
        '  ```\n',
    );
  });

  it('renders a denied tool_result with a yellow `[tool ·]` tag and no body when output is empty', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      playerEvent('coder', toolResultEvent('WebFetch', 'denied', null)),
    );

    expect(coder.raw()).toBe(
      'coder> \x1b[1;38;2;249;226;175m[tool ·]\x1b[0m WebFetch\n',
    );
  });

  it('routes captain-emitted tool events to the Boss/Captain pane per TMUX-040', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      players: new Map(),
    });

    presenter.onRecord(
      captainEvent(toolUseEvent('Read', { file_path: 'src/main.ts' })),
    );
    presenter.onRecord(
      captainEvent(toolResultEvent('Read', 'success', '42 lines', 80)),
    );

    expect(boss.text()).toBe(
      'captain> [tool ↪] Read src/main.ts\n' +
        'captain> [tool ✓] Read 80ms\n' +
        '  ```\n' +
        '  42 lines\n' +
        '  ```\n',
    );
  });

  // Tool-body fencing (TMUX-049 / TMUX-050).

  it('does not call renderMarkdown when the tool_result body is empty', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      playerEvent('coder', toolResultEvent('WebFetch', 'denied', null)),
    );

    expect(renderMarkdownMock).not.toHaveBeenCalled();
  });

  it('renders the tool_result body at paneWidth minus the continuation indent', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
      playerWidths: new Map([['coder', () => 80]]),
    });

    presenter.onRecord(
      playerEvent('coder', toolResultEvent('Bash', 'success', 'hi')),
    );

    // Two-space continuation indent → render at 80 - 2 = 78.
    expect(renderMarkdownMock).toHaveBeenCalledWith(
      '```\nhi\n```\n',
      78,
      'mocha',
    );
  });

  it('selects a fence one longer than the longest backtick run in the payload', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    // Payload contains a triple-backtick fence inside — a naive ``` wrapper
    // would terminate early. The fence must be at least four backticks long.
    const payload = 'before\n```\ninner code\n```\nafter';
    presenter.onRecord(
      playerEvent('coder', toolResultEvent('Cat', 'success', payload)),
    );

    expect(renderMarkdownMock).toHaveBeenCalledWith(
      '````\nbefore\n```\ninner code\n```\nafter\n````\n',
      expect.any(Number),
      'mocha',
    );
  });

  it('keeps an embedded fence fully inside the wrapper at output time', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    const payload = 'pre\n```\ncode\n```\npost';
    presenter.onRecord(
      playerEvent('coder', toolResultEvent('Cat', 'success', payload)),
    );

    // Identity glow returns the fenced payload verbatim; every line —
    // including the embedded ``` — sits under the outer ```` wrapper with
    // the two-space indent applied.
    expect(coder.text()).toBe(
      'coder> [tool ✓] Cat\n' +
        '  ````\n' +
        '  pre\n' +
        '  ```\n' +
        '  code\n' +
        '  ```\n' +
        '  post\n' +
        '  ````\n',
    );
  });

  it('grows the fence to one longer than a 5-backtick run in the payload', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      playerEvent(
        'coder',
        toolResultEvent('Cat', 'success', 'edges `````` here'),
      ),
    );

    // The payload's longest backtick run is six, so the wrapper is seven.
    expect(renderMarkdownMock).toHaveBeenCalledWith(
      '```````\nedges `````` here\n```````\n',
      expect.any(Number),
      'mocha',
    );
  });

  it('passes a long single-line body to glow untouched (glow leaves code unwrapped)', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
      playerWidths: new Map([['coder', () => 40]]),
    });

    const long = 'x'.repeat(120);
    presenter.onRecord(
      playerEvent('coder', toolResultEvent('Cat', 'success', long)),
    );

    // The presenter never inserts a mid-token break — the long token reaches
    // glow whole inside the fence, and the (mocked-identity) output lands
    // intact under the two-space indent. Real glow likewise leaves long code
    // lines unwrapped by design.
    expect(coder.text()).toBe(
      'coder> [tool ✓] Cat\n' +
        '  ```\n' +
        `  ${long}\n` +
        '  ```\n',
    );
  });

  it('keeps space-padded blank rows from a tool body blank without right padding', () => {
    // Same invariant as the text-body version, exercised through the
    // tool-result indentLines path. Real glow's fenced-code rendering emits
    // its frame rows as space-padded (sometimes background-styled) lines.
    // The structure must survive, but the trailing padding cells should not
    // reserve the right side of the pane.
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    renderMarkdownMock.mockImplementation(
      () => '   \n   \nfoo\n   \n   \n',
    );

    presenter.onRecord(
      playerEvent('coder', toolResultEvent('Cat', 'success', 'payload')),
    );

    // Outer-margin trim removes one padded blank per edge; the remaining
    // blank rows on either side of `foo` remain unindented and no longer
    // carry their right-padding spaces; only `foo` itself picks up the
    // two-space indent.
    expect(coder.text()).toBe(
      'coder> [tool ✓] Cat\n' +
        '\n' +
        '  foo\n' +
        '\n',
    );
  });

  it('strips glow right padding from a tool body while preserving body indent', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    renderMarkdownMock.mockImplementation(
      () => '  ```    \n  output   \n  ```\t \n',
    );

    presenter.onRecord(
      playerEvent('coder', toolResultEvent('Cat', 'success', 'payload')),
    );

    expect(coder.text()).toBe(
      'coder> [tool ✓] Cat\n' +
        '    ```\n' +
        '    output\n' +
        '    ```\n',
    );
    for (const line of coder.text().split('\n')) {
      expect(line).not.toMatch(/[ \t]+$/u);
    }
  });

  it('preserves a payload trailing blank line through the fence and indent', () => {
    // Real tools sometimes emit a final blank row (e.g., a file whose last
    // line is empty, or `printf 'foo\n\n'`). The old blanket .trimEnd() on
    // the body stripped both the terminator and the trailing blank before
    // anything reached the fence; the new strip-one-trailing-newline rule
    // drops only the terminator so the blank survives the outer-margin
    // trim, matching TMUX-049's promise that payload blank rows survive.
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(
      playerEvent('coder', toolResultEvent('Cat', 'success', 'foo\n\n')),
    );

    expect(coder.text()).toBe(
      'coder> [tool ✓] Cat\n' +
        '  ```\n' +
        '  foo\n' +
        '\n' +
        '  ```\n',
    );
  });

  it('preserves the fenced-code frame and payload blank lines under the two-space indent', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    // Mirror real glow's rendering shape for a fenced block whose payload
    // starts with a blank line: outer margin + frame top + payload leading
    // blank + content + payload trailing blank + frame bottom + outer
    // margin. The outer-margin-only trim removes exactly the first and
    // last blank — `glow`'s paragraph pad — and leaves the structural
    // blanks the user can actually see in glow's fenced rendering.
    renderMarkdownMock.mockImplementation(
      () => '\n\n\nfoo\n\n\n',
    );

    presenter.onRecord(
      playerEvent('coder', toolResultEvent('Cat', 'success', '\nfoo')),
    );

    // After trim-1: from 3 leading + 2 trailing → 2 leading + 1 trailing.
    // Each non-blank line picks up the two-space indent; blanks stay
    // unindented so the frame reads as the user would see it in a glow
    // pane outside this presenter.
    expect(coder.text()).toBe(
      'coder> [tool ✓] Cat\n' +
        '\n' +
        '\n' +
        '  foo\n' +
        '\n',
    );
  });

  it('preserves a payload trailing blank line in the fallback path when glow fails', () => {
    // The previous fallback ran the raw body through indentLines, which
    // calls trimOuterMargin and would mistake a payload trailing blank
    // for a glow margin (the raw body never passed through glow, so it
    // has no glow margin to strip). The new indentLinesRaw helper skips
    // the outer-margin trim so the spec's twin promises hold on the
    // failure path: emit the raw body, AND preserve trailing payload
    // blank rows.
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    renderMarkdownMock.mockImplementationOnce(() => {
      throw new Error('glow render failed: broken pipe');
    });

    presenter.onRecord(
      playerEvent('coder', toolResultEvent('Cat', 'success', 'foo\n\n')),
    );

    // raw 'foo\n\n' → body 'foo\n' after strip-one-terminator. The blank
    // line beyond that terminator survives into the indented output.
    expect(coder.text()).toBe(
      'coder> [tool ✓] Cat\n' +
        '  foo\n' +
        '\n',
    );
  });

  it('falls back to raw indented body when glow render fails for a tool_result', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    renderMarkdownMock.mockImplementationOnce(() => {
      throw new Error('glow render failed: broken pipe');
    });

    presenter.onRecord(
      playerEvent('coder', toolResultEvent('Bash', 'success', 'first\nsecond')),
    );

    // Header still emits with the unified speaker prefix + bracketed-tag
    // grammar; body falls through as the raw payload (no fences) with the
    // two-space continuation indent applied.
    expect(coder.text()).toBe(
      'coder> [tool ✓] Bash\n' +
        '  first\n' +
        '  second\n',
    );
  });

  it('formats tool durations as ms under 1s and seconds otherwise', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerEvent('coder', toolResultEvent('A', 'success', '', 7)));
    presenter.onRecord(
      playerEvent('coder', toolResultEvent('B', 'success', '', 1500)),
    );

    expect(coder.text()).toBe(
      'coder> [tool ✓] A 7ms\ncoder> [tool ✓] B 1.5s\n',
    );
  });

  it('omits the duration when durationMs is undefined', () => {
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      players: new Map([['coder', coder]]),
    });

    presenter.onRecord(playerEvent('coder', toolResultEvent('A', 'success', '')));

    expect(coder.text()).toBe('coder> [tool ✓] A\n');
  });
});

function playerPrompt(playerId: string, prompt: string): TmuxPlayRecord {
  return {
    type: 'player_prompt',
    turnId: 1,
    timestamp: 100,
    playerId,
    prompt,
  };
}

function playerEvent(playerId: string, event: CligentEvent): TmuxPlayRecord {
  return {
    type: 'player_event',
    turnId: 1,
    timestamp: 101,
    playerId,
    event,
  };
}

function playerFinished(
  playerId: string,
  status: 'error' | 'aborted',
  error?: string,
): TmuxPlayRecord {
  return {
    type: 'player_finished',
    turnId: 1,
    timestamp: 102,
    playerId,
    result: {
      playerId,
      turnId: 1,
      status,
      ...(error !== undefined ? { error } : {}),
    },
  };
}

function playerFinishedOk(playerId: string): TmuxPlayRecord {
  return {
    type: 'player_finished',
    turnId: 1,
    timestamp: 102,
    playerId,
    result: { playerId, turnId: 1, status: 'ok' },
  };
}
