// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { iterateDisplay } from '../shared/display-width.js';
import { formatCligentEvent } from '../shared/events.js';
import { renderMarkdown } from '../shared/glow.js';
import type {
  CaptainRunResult,
  RoleRunResult,
} from './contract.js';
import type {
  RecordObserver,
  RoleEventRecord,
  RoleFinishedRecord,
  RolePromptRecord,
  TmuxPlayRecord,
} from './records.js';
import {
  SGR_RESET,
  SPEAKER_BOSS,
  SPEAKER_CAPTAIN,
  STATUS_ABORTED,
  STATUS_ERROR,
  TOOL_DENIED,
  TOOL_FAIL,
  TOOL_INVOKE,
  TOOL_OK,
  bold24bitFg,
  roleAccent,
} from './role-colors.js';
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

// TMUX-038/039 prefix and status SGR anchors. Built once at module load.
const PREFIX_BOSS_SGR = bold24bitFg(SPEAKER_BOSS);
const PREFIX_CAPTAIN_SGR = bold24bitFg(SPEAKER_CAPTAIN);
const STATUS_ERROR_SGR = bold24bitFg(STATUS_ERROR);
const STATUS_ABORTED_SGR = bold24bitFg(STATUS_ABORTED);

// TMUX-049 tool lifecycle SGR anchors. The tool-result body is now rendered
// through the TMUX-050 glow pipeline as a fenced code block, so the prior
// `overlay0` dim wrap (which kept the body visually subordinate to the
// header) is no longer applied — glow's code-block styling supersedes it.
const TOOL_INVOKE_SGR = bold24bitFg(TOOL_INVOKE);
const TOOL_OK_SGR = bold24bitFg(TOOL_OK);
const TOOL_FAIL_SGR = bold24bitFg(TOOL_FAIL);
const TOOL_DENIED_SGR = bold24bitFg(TOOL_DENIED);

export type WidthSource = () => number;

export interface TmuxPresenterWriter {
  write(value: string): unknown;
}

export interface TmuxPresenterOptions {
  readonly boss: TmuxPresenterWriter;
  readonly roles: ReadonlyMap<string, TmuxPresenterWriter>;
  readonly bossWidth?: WidthSource;
  readonly roleWidths?: ReadonlyMap<string, WidthSource>;
  // role-id → adapter-name. Used to pick the role's prefix SGR color from
  // the adapter map per TMUX-048. When absent the role prefix stays uncolored
  // (graceful fallback for callers / older tests that don't supply it).
  readonly roleAdapters?: ReadonlyMap<string, string>;
}

interface OpenBlock {
  who: string;
  text: string;
}

export class TmuxPresenter implements RecordObserver {
  private readonly boss: TmuxPresenterWriter;
  private readonly roles: ReadonlyMap<string, TmuxPresenterWriter>;
  private readonly roleAdapters: ReadonlyMap<string, string>;
  private readonly widths = new WeakMap<TmuxPresenterWriter, WidthSource>();
  // TMUX-050: per-writer accumulator for the open text block. A block opens
  // on the first text / text_delta event for a writer and flushes through
  // glow at the next boundary (run result, prompt, tool event, status,
  // runtime error, turn abort). Markdown is not streamable — glow needs the
  // complete block before it can render fenced code, lists, etc. correctly.
  private readonly blocks = new WeakMap<TmuxPresenterWriter, OpenBlock>();

  constructor(options: TmuxPresenterOptions) {
    this.boss = options.boss;
    this.roles = options.roles;
    this.roleAdapters = options.roleAdapters ?? new Map();
    if (options.bossWidth) {
      this.widths.set(this.boss, options.bossWidth);
    }
    if (options.roleWidths) {
      for (const [roleId, source] of options.roleWidths) {
        const writer = this.roles.get(roleId);
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
        this.writeStatusLine(
          this.boss,
          'captain',
          paintStatus('aborted', `[turn aborted: ${record.reason ?? 'aborted'}]`),
        );
        break;
      case 'role_prompt':
        this.writeRolePrompt(record);
        break;
      case 'role_event':
        this.writeRoleEvent(record);
        break;
      case 'role_finished':
        this.writeRoleFinished(record);
        break;
      case 'captain_event':
        this.writeFormatted(this.boss, 'captain', record.event);
        break;
      case 'captain_finished':
        this.writeRunResult(this.boss, 'captain', record.result);
        break;
      case 'captain_status':
        this.flushBlock(this.boss);
        this.writeStatusLine(
          this.boss,
          'captain',
          `[status] ${record.message}${formatStatusData(record.data)}`,
        );
        break;
      case 'runtime_error':
        this.flushBlock(this.boss);
        this.writeStatusLine(
          this.boss,
          'captain',
          paintStatus('error', `[runtime error: ${record.message}]`),
        );
        break;
    }
  }

  private writeRolePrompt(record: RolePromptRecord): void {
    const writer = this.roleWriter(record.roleId);
    this.writeBlock(writer, 'captain', record.prompt);
  }

  private writeRoleEvent(record: RoleEventRecord): void {
    this.writeFormatted(
      this.roleWriter(record.roleId),
      record.roleId,
      record.event,
    );
  }

  private writeRoleFinished(record: RoleFinishedRecord): void {
    this.writeRunResult(
      this.roleWriter(record.roleId),
      record.roleId,
      record.result,
    );
  }

  private writeRunResult(
    writer: TmuxPresenterWriter,
    who: string,
    result: RoleRunResult | CaptainRunResult,
  ): void {
    this.flushBlock(writer);
    if (result.status === 'ok') return;
    const line =
      result.status === 'error'
        ? paintStatus('error', `[error: ${result.error ?? 'Agent run failed'}]`)
        : paintStatus('aborted', '[aborted]');
    this.writeStatusLine(writer, who, line);
  }

  private writeFormatted(
    writer: TmuxPresenterWriter,
    who: string,
    event: Parameters<typeof formatCligentEvent>[0],
  ): void {
    // Final result records own visible status; raw terminal protocol events
    // would duplicate failures and reintroduce noisy ok/usage footers.
    if (event.type === 'done' || event.type === 'error') return;

    // TMUX-049: tool lifecycle has its own prefix grammar instead of the
    // speaker prefix, so it bypasses the markdown pipeline.
    if (event.type === 'tool_use') {
      this.writeToolInvoke(writer, event.payload as ToolUsePayload);
      return;
    }
    if (event.type === 'tool_result') {
      this.writeToolResult(writer, event.payload as ToolResultPayload);
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
  // `text` events and for role/captain prompts that arrive complete.
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
      rendered = renderMarkdown(block.text, renderWidth);
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

  private writeStatusLine(
    writer: TmuxPresenterWriter,
    who: string,
    body: string,
  ): void {
    const sgr = this.prefixSgr(who);
    const intro = sgr ? `${sgr}${who}> ${SGR_RESET}` : `${who}> `;
    writer.write(`${intro}${body}\n`);
  }

  private writeToolInvoke(
    writer: TmuxPresenterWriter,
    payload: ToolUsePayload,
  ): void {
    this.flushBlock(writer);
    const inputSummary = summarizeToolInput(payload.input);
    const header = inputSummary
      ? `${payload.toolName} ${inputSummary}`
      : payload.toolName;
    writer.write(`${TOOL_INVOKE_SGR}tool> ${SGR_RESET}${header}\n`);
  }

  private writeToolResult(
    writer: TmuxPresenterWriter,
    payload: ToolResultPayload,
  ): void {
    this.flushBlock(writer);
    const { symbol, sgr } = toolResultStyle(payload.status);
    const intro = `${sgr}tool< ${symbol} ${SGR_RESET}`;
    const durationText = formatDuration(payload.durationMs);
    const headLine = durationText
      ? `${payload.toolName} ${durationText}`
      : payload.toolName;
    let output = `${intro}${headLine}\n`;
    const body = stringifyToolOutput(payload.output).trimEnd();
    if (body) {
      output += this.renderToolBody(writer, body);
    }
    writer.write(output);
  }

  // Render a tool-result body through glow as a fenced code block (per
  // TMUX-049) so glow leaves the content unwrapped, then indent every line
  // by two spaces so the body trails its `tool< …` header line under the
  // standard continuation-indent grammar. The fence is selected to be safe
  // against an embedded triple-backtick block in the payload (see
  // `selectCodeFence`). On rare mid-session glow failure, the raw body is
  // emitted indented so the session keeps moving.
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
    let rendered: string;
    try {
      rendered = renderMarkdown(fenced, renderWidth);
    } catch {
      rendered = body.endsWith('\n') ? body : `${body}\n`;
    }
    return indentLines(rendered, CONTINUATION_INDENT);
  }

  // Returns the SGR opener (`\x1b[1;38;2;…m`) for a speaker's prefix, or
  // undefined when there's no defined color (fallback: emit the prefix in
  // the writer's default foreground).
  private prefixSgr(who: string): string | undefined {
    if (who === 'boss') return PREFIX_BOSS_SGR;
    if (who === 'captain') return PREFIX_CAPTAIN_SGR;
    const adapter = this.roleAdapters.get(who);
    if (adapter) return bold24bitFg(roleAccent(adapter));
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

  private roleWriter(roleId: string): TmuxPresenterWriter {
    const writer = this.roles.get(roleId);
    if (!writer) {
      throw new Error(`Missing tmux presenter writer for role: ${roleId}`);
    }
    return writer;
  }

  // Apply the TMUX-038 prefix/indent grammar to glow's rendered output:
  // the first nonblank line carries the colored `<who>> ` prefix; every
  // nonblank continuation line carries the two-space hanging indent; blank
  // lines stay blank. The cell-width budget passed to glow (see flushBlock)
  // already reserves prefixWidth so prefixed first line and indented
  // continuations fit the pane without re-wrap.
  private applyPrefix(who: string, rendered: string): string {
    const sgr = this.prefixSgr(who);
    const intro = sgr ? `${sgr}${who}> ${SGR_RESET}` : `${who}> `;
    const trimmed = rendered.endsWith('\n')
      ? rendered.slice(0, -1)
      : rendered;
    const lines = trimmed.split('\n');
    let firstNonblankIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (visibleNonblank(lines[i] ?? '')) {
        firstNonblankIdx = i;
        break;
      }
    }
    if (firstNonblankIdx === -1) {
      // All-blank rendered output: pass through without applying a prefix
      // because there's no nonblank line to tag; synthesizing a prefix on
      // empty content would be visual noise.
      return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
    }
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (i < firstNonblankIdx) {
        out.push(line);
      } else if (i === firstNonblankIdx) {
        out.push(`${intro}${line}`);
      } else if (line.length === 0) {
        out.push('');
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
// glow-rendered tool body under the `tool< …` header line so it carries
// the same two-space continuation indent as text-body continuations.
function indentLines(rendered: string, indent: string): string {
  const trimmed = rendered.endsWith('\n')
    ? rendered.slice(0, -1)
    : rendered;
  const lines = trimmed.split('\n');
  const out = lines.map((line) =>
    line.length === 0 ? '' : `${indent}${line}`,
  );
  return `${out.join('\n')}\n`;
}

// TMUX-039 status coloring. The bracketed status body gets a red (error) or
// yellow (aborted) bold span; the surrounding speaker prefix keeps its own
// SGR colors.
function paintStatus(kind: 'error' | 'aborted', text: string): string {
  const sgr = kind === 'error' ? STATUS_ERROR_SGR : STATUS_ABORTED_SGR;
  return `${sgr}${text}${SGR_RESET}`;
}

// TMUX-049 tool-result outcome → status symbol + prefix SGR.
function toolResultStyle(
  status: ToolResultPayload['status'],
): { symbol: string; sgr: string } {
  if (status === 'success') return { symbol: '✓', sgr: TOOL_OK_SGR };
  if (status === 'error') return { symbol: '✗', sgr: TOOL_FAIL_SGR };
  return { symbol: '·', sgr: TOOL_DENIED_SGR };
}

// Pick the most useful single-string description of a tool's input for the
// `tool>` header. Known keys come first; fall back to a truncated JSON dump.
function summarizeToolInput(input: Record<string, unknown>): string {
  for (const key of [
    'command',
    'file_path',
    'path',
    'pattern',
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
