// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { iterateDisplay } from '../shared/display-width.js';
import { formatCligentEvent } from '../shared/events.js';
import { renderMarkdown } from '../shared/glow.js';
import type {
  CaptainRunResult,
  PlayerRunResult,
} from './contract.js';
import type {
  RecordObserver,
  PlayerEventRecord,
  PlayerFinishedRecord,
  PlayerPromptRecord,
  TmuxPlayRecord,
} from './records.js';
import {
  SGR_RESET,
  bold24bitFg,
  playerAccent,
  presenterPalette,
  type CatppuccinFlavor,
  type PresenterPalette,
} from './player-colors.js';
import type {
  ToolResultPayload,
  ToolUsePayload,
} from '../../types.js';

const CONTINUATION_INDENT = '  ';
const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

// Fallback render width when a writer has no width source or its source
// returns a non-finite value. 80 columns is the conventional terminal width
// and keeps glow output sane until a real pane width is available.
const DEFAULT_PANE_WIDTH = 80;

// TMUX-038/039/049 SGR anchors built once per presenter instance from the
// session's resolved Catppuccin flavor, so a Latte session uses Latte ANSI
// prefixes inside pane content and a Mocha session uses Mocha. The shape
// matches the previous module-level constants; the difference is they're
// now per-instance fields populated from `presenterPalette(flavor)`.
interface PresenterSgr {
  readonly prefixBoss: string;
  readonly prefixCaptain: string;
  readonly statusError: string;
  readonly statusAborted: string;
  readonly toolOk: string;
  readonly toolFail: string;
  readonly toolDenied: string;
}

function buildPresenterSgr(p: PresenterPalette): PresenterSgr {
  return {
    prefixBoss: bold24bitFg(p.speakerBoss),
    prefixCaptain: bold24bitFg(p.speakerCaptain),
    statusError: bold24bitFg(p.statusError),
    statusAborted: bold24bitFg(p.statusAborted),
    toolOk: bold24bitFg(p.toolOk),
    toolFail: bold24bitFg(p.toolFail),
    toolDenied: bold24bitFg(p.toolDenied),
  };
}

export type WidthSource = () => number;

export interface TmuxPresenterWriter {
  write(value: string): unknown;
}

export interface TmuxPresenterOptions {
  readonly boss: TmuxPresenterWriter;
  readonly players: ReadonlyMap<string, TmuxPresenterWriter>;
  readonly bossWidth?: WidthSource;
  readonly playerWidths?: ReadonlyMap<string, WidthSource>;
  // player-id → adapter-name. Used to pick the player's prefix SGR color from
  // the adapter map per TMUX-048. When absent the player prefix stays uncolored
  // (graceful fallback for callers / older tests that don't supply it).
  readonly playerAdapters?: ReadonlyMap<string, string>;
  /**
   * Catppuccin flavor for the SGR palette used in pane content (speaker
   * prefixes, status lines, tool lifecycle). Defaults to Mocha for
   * backwards-compat; pass `'latte'` so prefixes/status/tool colors keep
   * contrast on light-terminal sessions.
   */
  readonly themeFlavor?: CatppuccinFlavor;
}

interface OpenBlock {
  who: string;
  text: string;
}

export class TmuxPresenter implements RecordObserver {
  private readonly boss: TmuxPresenterWriter;
  private readonly players: ReadonlyMap<string, TmuxPresenterWriter>;
  private readonly playerAdapters: ReadonlyMap<string, string>;
  private readonly flavor: CatppuccinFlavor;
  private readonly sgr: PresenterSgr;
  private readonly widths = new WeakMap<TmuxPresenterWriter, WidthSource>();
  // TMUX-050: per-writer accumulator for the open text block. A block opens
  // on the first text / text_delta event for a writer and flushes through
  // glow at the next boundary (run result, prompt, tool event, status,
  // runtime error, turn abort). Markdown is not streamable — glow needs the
  // complete block before it can render fenced code, lists, etc. correctly.
  private readonly blocks = new WeakMap<TmuxPresenterWriter, OpenBlock>();

  constructor(options: TmuxPresenterOptions) {
    this.boss = options.boss;
    this.players = options.players;
    this.playerAdapters = options.playerAdapters ?? new Map();
    this.flavor = options.themeFlavor ?? 'mocha';
    this.sgr = buildPresenterSgr(presenterPalette(this.flavor));
    if (options.bossWidth) {
      this.widths.set(this.boss, options.bossWidth);
    }
    if (options.playerWidths) {
      for (const [playerId, source] of options.playerWidths) {
        const writer = this.players.get(playerId);
        if (writer) {
          this.widths.set(writer, source);
        }
      }
    }
  }

  onRecord(record: TmuxPlayRecord): void {
    switch (record.type) {
      case 'turn_started':
      case 'turn_finished':
      case 'captain_prompt':
      case 'captain_telemetry':
        break;
      case 'turn_aborted':
        this.flushBlock(this.boss);
        // TMUX-039 kind table: `[turn aborted]` body is the abort reason
        // "when present" — no synthesized fallback. A record without a
        // reason renders as just `captain> [turn aborted]\n`; under the
        // outside-brackets grammar a fallback word would read as an actual
        // reason rather than as a missing-reason placeholder.
        this.writeBracketedLine(
          this.boss,
          'captain',
          'turn aborted',
          undefined,
          this.sgr.statusAborted,
          record.reason,
        );
        break;
      case 'player_prompt':
        this.writePlayerPrompt(record);
        break;
      case 'player_event':
        this.writePlayerEvent(record);
        break;
      case 'player_finished':
        this.writePlayerFinished(record);
        break;
      case 'captain_event':
        this.writeFormatted(this.boss, 'captain', record.event);
        break;
      case 'captain_finished':
        this.writeRunResult(this.boss, 'captain', record.result);
        break;
      case 'captain_status':
        this.flushBlock(this.boss);
        this.writeBracketedLine(
          this.boss,
          'captain',
          'status',
          undefined,
          undefined,
          `${record.message}${formatStatusData(record.data)}`,
        );
        break;
      case 'runtime_error':
        this.flushBlock(this.boss);
        this.writeBracketedLine(
          this.boss,
          'captain',
          'runtime error',
          undefined,
          this.sgr.statusError,
          record.message,
        );
        break;
    }
  }

  private writePlayerPrompt(record: PlayerPromptRecord): void {
    const writer = this.playerWriter(record.playerId);
    this.writeBlock(writer, 'captain', record.prompt);
  }

  private writePlayerEvent(record: PlayerEventRecord): void {
    this.writeFormatted(
      this.playerWriter(record.playerId),
      record.playerId,
      record.event,
    );
  }

  private writePlayerFinished(record: PlayerFinishedRecord): void {
    this.writeRunResult(
      this.playerWriter(record.playerId),
      record.playerId,
      record.result,
    );
  }

  private writeRunResult(
    writer: TmuxPresenterWriter,
    who: string,
    result: PlayerRunResult | CaptainRunResult,
  ): void {
    this.flushBlock(writer);
    if (result.status === 'ok') return;
    if (result.status === 'error') {
      this.writeBracketedLine(
        writer,
        who,
        'error',
        undefined,
        this.sgr.statusError,
        result.error ?? 'Agent run failed',
      );
    } else {
      // Aborted: no body — TMUX-033 says aborted results need not carry a reason.
      this.writeBracketedLine(
        writer,
        who,
        'aborted',
        undefined,
        this.sgr.statusAborted,
        undefined,
      );
    }
  }

  private writeFormatted(
    writer: TmuxPresenterWriter,
    who: string,
    event: Parameters<typeof formatCligentEvent>[0],
  ): void {
    // Final result records own visible status; raw terminal protocol events
    // would duplicate failures and reintroduce noisy ok/usage footers.
    if (event.type === 'done' || event.type === 'error') return;

    // TMUX-049: tool lifecycle uses the standard speaker prefix plus the
    // [tool …] bracketed tag from TMUX-039's kind table — single-line
    // operational text that bypasses the Markdown pipeline.
    if (event.type === 'tool_use') {
      this.writeToolInvoke(writer, who, event.payload as ToolUsePayload);
      return;
    }
    if (event.type === 'tool_result') {
      this.writeToolResult(writer, who, event.payload as ToolResultPayload);
      return;
    }

    const formatted = formatCligentEvent(event);
    if (formatted === null) return;
    if (event.type === 'text_delta') {
      this.accumulateText(writer, who, formatted);
    } else {
      this.writeBlock(writer, who, formatted);
    }
  }

  // Append a streaming fragment to the open block on `writer` under speaker
  // `who`. Opens a new block if none exists. If the speaker changed mid-flight
  // (defensive — the runtime serializes turns, so this should not happen in
  // normal flow), flushes the prior block first so the prefix grammar still
  // matches whoever opened that block.
  private accumulateText(
    writer: TmuxPresenterWriter,
    who: string,
    text: string,
  ): void {
    const block = this.blocks.get(writer);
    if (block && block.who !== who) {
      this.flushBlock(writer);
    }
    const open = this.blocks.get(writer);
    if (open) {
      open.text += text;
    } else {
      this.blocks.set(writer, { who, text });
    }
  }

  // Render a complete text block immediately: flush any open block on this
  // writer first, then push the new block and flush it. Used for non-streaming
  // `text` events and for player/captain prompts that arrive complete.
  private writeBlock(
    writer: TmuxPresenterWriter,
    who: string,
    text: string,
  ): void {
    this.flushBlock(writer);
    this.blocks.set(writer, { who, text });
    this.flushBlock(writer);
  }

  // Render the open block on `writer` through glow and emit the result with
  // the TMUX-038 prefix/indent grammar applied. No-op when no block is open
  // or the buffered text is empty.
  private flushBlock(writer: TmuxPresenterWriter): void {
    const block = this.blocks.get(writer);
    if (!block) return;
    this.blocks.delete(writer);
    if (block.text.length === 0) return;

    const prefixWidth = block.who.length + 2; // `<who>` + `> `
    const paneWidth = this.paneWidth(writer);
    const effective = Number.isFinite(paneWidth)
      ? paneWidth
      : DEFAULT_PANE_WIDTH;
    // Reserve at least one cell so glow has somewhere to render even when the
    // pane is implausibly narrow; visual fit then depends on glow's behavior
    // for over-wide content (code/tables overflow by design per the IR).
    const renderWidth = Math.max(1, effective - prefixWidth);

    let rendered: string;
    try {
      rendered = renderMarkdown(block.text, renderWidth, this.flavor);
    } catch {
      // The launcher gate guarantees glow is healthy at startup, so a
      // mid-session render failure is rare. Surface the raw text rather than
      // crashing the session so the user still sees the content.
      rendered = block.text.endsWith('\n')
        ? block.text
        : `${block.text}\n`;
    }

    writer.write(this.applyPrefix(block.who, rendered));
  }

  // TMUX-039 unified operational-line shape: `<who>> [<tag> <optional glyph>]
  // <optional body>`. The speaker prefix carries the TMUX-038 color span; the
  // bracketed tag carries its own outcome SGR span (red/yellow/green) when
  // the kind is colored, or is emitted plain for uncolored kinds (status,
  // tool ↪). The body — when present — lives outside the brackets and is
  // unstyled by the presenter so any ANSI inside it comes from the source.
  // Single source of truth for every operational-line emission so the
  // SGR-on-tag and body-outside-brackets invariants are not hand-coded at
  // each call site.
  private writeBracketedLine(
    writer: TmuxPresenterWriter,
    who: string,
    tag: string,
    glyph: string | undefined,
    tagSgr: string | undefined,
    body: string | undefined,
  ): void {
    writer.write(this.formatBracketedLine(who, tag, glyph, tagSgr, body));
  }

  // Build (but don't write) the bytes for a single bracketed-tag line.
  // Used by tool_result so the header bytes can be concatenated with the
  // continuation-block body before a single `writer.write` call — keeping
  // the order-of-emission invariant the existing tests rely on.
  private formatBracketedLine(
    who: string,
    tag: string,
    glyph: string | undefined,
    tagSgr: string | undefined,
    body: string | undefined,
  ): string {
    const prefixSgr = this.prefixSgr(who);
    const prefix = prefixSgr ? `${prefixSgr}${who}> ${SGR_RESET}` : `${who}> `;
    const tagInner = glyph ? `[${tag} ${glyph}]` : `[${tag}]`;
    const tagSpan = tagSgr ? `${tagSgr}${tagInner}${SGR_RESET}` : tagInner;
    // Trailing space rule (TMUX-049): when there's no body, the line ends at
    // the closing bracket — no stranded space. When a body is present, it
    // sits one space outside the brackets, unstyled.
    const trailer = body !== undefined && body.length > 0 ? ` ${body}` : '';
    return `${prefix}${tagSpan}${trailer}\n`;
  }

  private writeToolInvoke(
    writer: TmuxPresenterWriter,
    who: string,
    payload: ToolUsePayload,
  ): void {
    this.flushBlock(writer);
    const inputSummary = summarizeToolInput(payload.input);
    // Body is `<toolName>` when no input summary exists, or `<toolName>
    // <inputSummary>` otherwise. The bracketed tag `[tool ↪]` is uncolored
    // per TMUX-039 — speaker identity is carried by the `<who>> ` prefix.
    const body = inputSummary
      ? `${payload.toolName} ${inputSummary}`
      : payload.toolName;
    this.writeBracketedLine(writer, who, 'tool', '↪', undefined, body);
  }

  private writeToolResult(
    writer: TmuxPresenterWriter,
    who: string,
    payload: ToolResultPayload,
  ): void {
    this.flushBlock(writer);
    const { symbol, sgr } = toolResultStyle(this.sgr, payload.status);
    const durationText = formatDuration(payload.durationMs);
    const headBody = durationText
      ? `${payload.toolName} ${durationText}`
      : payload.toolName;
    let output = this.formatBracketedLine(who, 'tool', symbol, sgr, headBody);
    // Strip exactly one trailing newline — the line terminator on the
    // payload's last line — so a plain `foo\n` does not surface as
    // `foo` + a phantom blank inside the fence. A blanket `.trimEnd()`
    // would also strip payload-intended trailing blank lines, which the
    // TMUX-049 amendment promises to preserve through the outer-margin
    // trim in renderToolBody.
    const raw = stringifyToolOutput(payload.output);
    const body = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (body) {
      output += this.renderToolBody(writer, body);
    }
    writer.write(output);
  }

  // Render a tool-result body through glow as a fenced code block (per
  // TMUX-049) so glow leaves the content unwrapped, then indent every line
  // by two spaces so the body trails its `<who>> [tool …]` header line
  // under the standard continuation-indent grammar. The fence is selected
  // to be safe against an embedded triple-backtick block in the payload
  // (see `selectCodeFence`). On rare mid-session glow failure, the raw
  // body is emitted indented so the session keeps moving.
  private renderToolBody(
    writer: TmuxPresenterWriter,
    body: string,
  ): string {
    const fence = selectCodeFence(body);
    const fenced = `${fence}\n${body}\n${fence}\n`;
    const paneWidth = this.paneWidth(writer);
    const effective = Number.isFinite(paneWidth)
      ? paneWidth
      : DEFAULT_PANE_WIDTH;
    const renderWidth = Math.max(1, effective - CONTINUATION_INDENT.length);
    try {
      const rendered = renderMarkdown(fenced, renderWidth, this.flavor);
      return indentLines(rendered, CONTINUATION_INDENT);
    } catch {
      // The raw body never passed through glow, so it carries no outer
      // paragraph margin to trim. Routing it through indentLines would
      // call trimOuterMargin, which would mistake a payload trailing blank
      // line for a glow margin and silently lose it — directly violating
      // the TMUX-049 promise to preserve payload trailing blanks AND to
      // emit raw body text on render failure. Indent the body directly
      // without the outer-margin trim.
      return indentLinesRaw(body, CONTINUATION_INDENT);
    }
  }

  // Returns the SGR opener (`\x1b[1;38;2;…m`) for a speaker's prefix, or
  // undefined when there's no defined color (fallback: emit the prefix in
  // the writer's default foreground).
  private prefixSgr(who: string): string | undefined {
    if (who === 'boss') return this.sgr.prefixBoss;
    if (who === 'captain') return this.sgr.prefixCaptain;
    const adapter = this.playerAdapters.get(who);
    if (adapter) return bold24bitFg(playerAccent(adapter, this.flavor));
    return undefined;
  }

  private paneWidth(writer: TmuxPresenterWriter): number {
    const source = this.widths.get(writer);
    if (!source) return Number.POSITIVE_INFINITY;
    const width = source();
    return Number.isFinite(width) && width > 0
      ? width
      : Number.POSITIVE_INFINITY;
  }

  private playerWriter(playerId: string): TmuxPresenterWriter {
    const writer = this.players.get(playerId);
    if (!writer) {
      throw new Error(`Missing tmux presenter writer for player: ${playerId}`);
    }
    return writer;
  }

  // Apply the TMUX-038 prefix/indent grammar to glow's rendered output:
  // the first nonblank line carries the colored `<who>> ` prefix; every
  // nonblank continuation line carries the two-space hanging indent; blank
  // lines inside the rendered block stay blank. Only `glow`'s outermost
  // one-line paragraph margin is trimmed from each edge — never all edge
  // blanks — so structural blanks `glow` emits for fenced-code frames,
  // table rows, or other multi-line constructs survive. The cell-width
  // budget passed to glow already reserves prefixWidth so the prefixed
  // first line and indented continuations fit the pane without re-wrap.
  private applyPrefix(who: string, rendered: string): string {
    const trimmed = trimOuterMargin(rendered);
    if (trimmed.length === 0) {
      // All-blank rendered output (the source was empty or pure whitespace,
      // or glow returned only its margin lines): emit nothing so empty
      // content never surfaces as a bare `<who>> ` line or a stranded blank.
      return '';
    }
    const lines = trimmed.split('\n');
    let firstIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (visibleNonblank(lines[i] ?? '')) {
        firstIdx = i;
        break;
      }
    }
    if (firstIdx === -1) return '';
    const sgr = this.prefixSgr(who);
    const intro = sgr ? `${sgr}${who}> ${SGR_RESET}` : `${who}> `;
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (i < firstIdx) {
        out.push(line);
      } else if (i === firstIdx) {
        out.push(`${intro}${line}`);
      } else if (!visibleNonblank(line)) {
        // Glow emits structural blank rows as space-padded (and sometimes
        // ANSI-styled) lines, not empty strings. Pass them through verbatim
        // so the spec's "blank lines remain blank (unindented)" invariant
        // holds for real-glow output, not just for `length === 0` mocks.
        out.push(line);
      } else {
        out.push(`${CONTINUATION_INDENT}${line}`);
      }
    }
    return `${out.join('\n')}\n`;
  }
}

export function createTmuxPresenter(
  options: TmuxPresenterOptions,
): RecordObserver {
  return new TmuxPresenter(options);
}

// True when `line` has visible content after ANSI SGR escapes are stripped.
function visibleNonblank(line: string): boolean {
  return line.replace(ANSI_PATTERN, '').trim().length > 0;
}

// Pick a backtick fence safe to wrap `body` for TMUX-049's fenced-code
// pipeline. Per CommonMark, a fenced code block opened with N backticks is
// closed by a line beginning with ≥ N backticks, so the wrapper must be at
// least one longer than the longest backtick run anywhere in the payload;
// the minimum is three (the standard fence width). This keeps any embedded
// ```` ``` ```` in the tool output inert as literal content instead of
// terminating the wrapper early and leaking the tail into Markdown
// rendering.
function selectCodeFence(body: string): string {
  let longest = 0;
  let current = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '`') {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

// Indent every nonblank line of `rendered` with `indent`, leaving blank
// lines blank, and ensure exactly one trailing newline. Used to drop a
// glow-rendered tool body under the `<who>> [tool …]` header line so it
// carries the same two-space continuation indent as text-body continuations.
// Mirrors `applyPrefix`'s outer-margin trim so glow's outermost paragraph
// margin doesn't stack between the header and the body; any further blank
// lines (the fenced-code frame, payload edge blanks, etc.) are preserved.
function indentLines(rendered: string, indent: string): string {
  return indentLinesRaw(trimOuterMargin(rendered), indent);
}

// Indent without any outer-margin trim. Used by the renderMarkdown fallback
// path where the input is the raw payload — never passed through glow — so
// there is no glow margin to strip. Using `indentLines` here would let
// `trimOuterMargin` mistake a payload trailing blank line for a glow
// margin and silently lose it, violating TMUX-049's promise to preserve
// trailing payload blanks on the failure path.
//
// `visibleNonblank` (not `length === 0`) is the blank check: glow's
// structural blank rows are space-padded — sometimes with ANSI background
// SGRs — so checking length alone would silently indent them, breaking
// the TMUX-049 promise that the body's "frame and payload edge blanks
// read as the user would see them in a glow pane outside this presenter".
function indentLinesRaw(text: string, indent: string): string {
  if (text.length === 0) return '';
  const lines = text.split('\n');
  const out = lines.map((line) =>
    visibleNonblank(line) ? `${indent}${line}` : line,
  );
  return `${out.join('\n')}\n`;
}

// Drop at most one leading and one trailing blank line (visible whitespace
// only — ANSI escapes don't count as content), returning the result without
// a trailing newline. This strips `glow`'s outermost paragraph-margin pad
// while preserving any structural blanks `glow` emits inside the block:
// fenced-code frame rows, payload edge blanks, table padding, etc. A
// blanket multi-line trim would damage those, so the limit is fixed at one
// per edge regardless of how many edge blanks are present.
function trimOuterMargin(text: string): string {
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = normalized.split('\n');
  let start = 0;
  let end = lines.length;
  if (start < end && !visibleNonblank(lines[start] ?? '')) {
    start += 1;
  }
  if (end > start && !visibleNonblank(lines[end - 1] ?? '')) {
    end -= 1;
  }
  return lines.slice(start, end).join('\n');
}

// TMUX-049 tool-result outcome → bracketed-tag glyph + tag SGR. The SGR
// opens the bracketed tag (`[tool ✓]` / `[tool ✗]` / `[tool ·]`) per
// TMUX-039's kind table; the body sits outside the brackets unstyled, so
// the SGR span is now narrower than the retired `tool< <symbol>` prefix
// span that covered the whole header line.
function toolResultStyle(
  sgr: PresenterSgr,
  status: ToolResultPayload['status'],
): { symbol: string; sgr: string } {
  if (status === 'success') return { symbol: '✓', sgr: sgr.toolOk };
  if (status === 'error') return { symbol: '✗', sgr: sgr.toolFail };
  return { symbol: '·', sgr: sgr.toolDenied };
}

// Pick the most useful single-string description of a tool's input for the
// `[tool ↪]` header. Known keys come first; fall back to a truncated JSON
// dump.
function summarizeToolInput(input: Record<string, unknown>): string {
  // Ordered priority: filesystem/shell keys first, then search/fetch
  // (`query`, common to tools like ToolSearch / WebFetch wrappers), then
  // free-form prose. `query` lifts the common search-tool case out of the
  // compact-JSON fallback so the `[tool ↪]` header surfaces the actual
  // query text instead of `{"query":"…","max_results":N}`.
  for (const key of [
    'command',
    'file_path',
    'path',
    'pattern',
    'query',
    'prompt',
    'description',
  ]) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return truncateCells(value.replace(/\s+/g, ' '), 60);
    }
  }
  try {
    const dump = JSON.stringify(input);
    if (dump === undefined || dump === '{}') return '';
    return truncateCells(dump.replace(/\s+/g, ' '), 60);
  } catch {
    return '';
  }
}

function stringifyToolOutput(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && 'stdout' in output) {
    const stdout = (output as { stdout: unknown }).stdout;
    if (typeof stdout === 'string') return stdout;
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return '';
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Truncate `value` to at most `maxCells` terminal cells (TMUX-049). Iterates
// the display-token stream so CJK / emoji are measured by cells (1 or 2)
// rather than UTF-16 code units, and surrogate pairs are never split.
function truncateCells(value: string, maxCells: number): string {
  let total = 0;
  for (const token of iterateDisplay(value)) {
    if (token.type === 'char') total += token.cells;
  }
  if (total <= maxCells) return value;
  let cells = 0;
  let prefix = '';
  for (const token of iterateDisplay(value)) {
    if (token.type !== 'char') continue;
    if (cells + token.cells > maxCells - 1) break;
    cells += token.cells;
    prefix += token.char;
  }
  return `${prefix}…`;
}

function formatStatusData(
  data: Record<string, unknown> | undefined,
): string {
  if (data === undefined) return '';
  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ' [unserializable data]';
  }
}
