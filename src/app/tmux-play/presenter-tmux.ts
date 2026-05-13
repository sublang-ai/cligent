// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { formatCligentEvent } from '../shared/events.js';
import { DisplayParser, iterateDisplay } from '../shared/display-width.js';
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
  TOOL_OUTPUT_DIM,
  bold24bitFg,
  fg24bit,
  roleAccent,
} from './role-colors.js';
import type {
  ToolResultPayload,
  ToolUsePayload,
} from '../../types.js';

const CONTINUATION_INDENT = '  ';

// TMUX-038/039 prefix and status SGR anchors. Built once at module load.
const PREFIX_BOSS_SGR = bold24bitFg(SPEAKER_BOSS);
const PREFIX_CAPTAIN_SGR = bold24bitFg(SPEAKER_CAPTAIN);
const STATUS_ERROR_SGR = bold24bitFg(STATUS_ERROR);
const STATUS_ABORTED_SGR = bold24bitFg(STATUS_ABORTED);

// TMUX-049 tool lifecycle SGR anchors.
const TOOL_INVOKE_SGR = bold24bitFg(TOOL_INVOKE);
const TOOL_OK_SGR = bold24bitFg(TOOL_OK);
const TOOL_FAIL_SGR = bold24bitFg(TOOL_FAIL);
const TOOL_DENIED_SGR = bold24bitFg(TOOL_DENIED);
const TOOL_OUTPUT_DIM_SGR = fg24bit(TOOL_OUTPUT_DIM);

export type WidthSource = () => number;

export interface TmuxPresenterWriter {
  write(value: string): unknown;
}

// First-line intro override for writePrefixed. Used by the tool lifecycle
// path (TMUX-049) which replaces `<who>> ` with `tool> ` or `tool< <sym> `.
interface PrefixOverride {
  readonly intro: string;
  readonly sgr: string | undefined;
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

export class TmuxPresenter implements RecordObserver {
  private readonly boss: TmuxPresenterWriter;
  private readonly roles: ReadonlyMap<string, TmuxPresenterWriter>;
  private readonly roleAdapters: ReadonlyMap<string, string>;
  private readonly widths = new WeakMap<TmuxPresenterWriter, WidthSource>();
  private readonly lineStarts = new WeakMap<TmuxPresenterWriter, boolean>();
  private readonly lineOffsets = new WeakMap<TmuxPresenterWriter, number>();
  private readonly lineColumns = new WeakMap<TmuxPresenterWriter, number>();
  private readonly parsers = new WeakMap<TmuxPresenterWriter, DisplayParser>();
  // TMUX-046: per-writer carry of the last body-emitted SGR opener so the
  // close/reopen continuation invariant survives across `text_delta` events
  // that split the opener and the wrap/newline boundary into separate calls.
  private readonly activeBodySgrs = new WeakMap<TmuxPresenterWriter, string>();

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

  onRecord(record: TmuxPlayRecord): void {
    switch (record.type) {
      case 'turn_started':
        break;
      case 'turn_finished':
        break;
      case 'turn_aborted':
        this.writePrefixedLine(
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
      case 'captain_prompt':
        break;
      case 'captain_event':
        this.writeFormatted(this.boss, 'captain', record.event);
        break;
      case 'captain_finished':
        this.writeRunResult(this.boss, 'captain', record.result);
        break;
      case 'captain_status':
        this.writeStatus(record.message, record.data);
        break;
      case 'captain_telemetry':
        break;
      case 'runtime_error':
        this.writePrefixedLine(
          this.boss,
          'captain',
          paintStatus('error', `[runtime error: ${record.message}]`),
        );
        break;
    }
  }

  private writeRolePrompt(record: RolePromptRecord): void {
    const writer = this.roleWriter(record.roleId);
    this.writePrefixedBlock(writer, 'captain', record.prompt);
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

  private writeStatus(
    message: string,
    data: Record<string, unknown> | undefined,
  ): void {
    this.writePrefixedLine(
      this.boss,
      'captain',
      `[status] ${message}${formatStatusData(data)}`,
    );
  }

  private writeRunResult(
    writer: TmuxPresenterWriter,
    who: string,
    result: RoleRunResult | CaptainRunResult,
  ): void {
    if (result.status === 'ok') {
      this.flushPendingEscape(writer);
      this.breakLineIfNeeded(writer);
      this.resetLineOffset(writer);
      return;
    }

    const line =
      result.status === 'error'
        ? paintStatus('error', `[error: ${result.error ?? 'Agent run failed'}]`)
        : paintStatus('aborted', '[aborted]');
    this.writePrefixedLine(writer, who, line);
  }

  private writeFormatted(
    writer: TmuxPresenterWriter,
    who: string,
    event: Parameters<typeof formatCligentEvent>[0],
  ): void {
    // Final result records own visible status; raw terminal protocol events would
    // duplicate failures and reintroduce noisy ok/usage footers.
    if (event.type === 'done' || event.type === 'error') {
      return;
    }

    // TMUX-049: tool lifecycle has its own prefix grammar (`tool>` / `tool<`)
    // instead of the speaker prefix; rendered on the calling entity's pane.
    if (event.type === 'tool_use') {
      this.writeToolInvoke(writer, event.payload as ToolUsePayload);
      return;
    }
    if (event.type === 'tool_result') {
      this.writeToolResult(writer, event.payload as ToolResultPayload);
      return;
    }

    const formatted = formatCligentEvent(event);
    if (formatted !== null) {
      if (event.type === 'text_delta') {
        this.writePrefixed(writer, who, formatted);
      } else {
        this.writePrefixedBlock(writer, who, formatted);
      }
    }
  }

  private writeToolInvoke(
    writer: TmuxPresenterWriter,
    payload: ToolUsePayload,
  ): void {
    const inputSummary = summarizeToolInput(payload.input);
    const header = inputSummary
      ? `${payload.toolName} ${inputSummary}`
      : payload.toolName;
    this.writePrefixedBlock(writer, 'tool', `${header}\n`, {
      intro: 'tool> ',
      sgr: TOOL_INVOKE_SGR,
    });
  }

  private writeToolResult(
    writer: TmuxPresenterWriter,
    payload: ToolResultPayload,
  ): void {
    const { symbol, sgr } = toolResultStyle(payload.status);
    const intro = `tool< ${symbol} `;
    const durationText = formatDuration(payload.durationMs);
    const headLine = durationText
      ? `${payload.toolName} ${durationText}`
      : payload.toolName;
    const outputText = stringifyToolOutput(payload.output).trimEnd();
    // Tool output body is dimmed via overlay0 (plain — not bold). The
    // wrapper SGR runs through the parser, so the activeBodySgr machinery
    // from TMUX-046 keeps every continuation indent uncolored.
    const dimmedBody = outputText
      ? `\n${TOOL_OUTPUT_DIM_SGR}${outputText}${SGR_RESET}`
      : '';
    this.writePrefixedBlock(writer, 'tool', `${headLine}${dimmedBody}\n`, {
      intro,
      sgr,
    });
  }

  // Drains any escape that the writer's parser is still holding from a prior
  // streaming sequence so its bytes belong to that block (emitted before the
  // closing `\n`), and the next block parses from a clean state instead of
  // misclassifying its leading byte as the missing CSI/OSC terminator.
  private flushPendingEscape(writer: TmuxPresenterWriter): void {
    const parser = this.parsers.get(writer);
    if (!parser) return;
    let drained = '';
    for (const token of parser.flush()) {
      if (token.type === 'escape') {
        drained += token.sequence;
      }
    }
    if (drained) {
      writer.write(drained);
    }
  }

  private writePrefixedBlock(
    writer: TmuxPresenterWriter,
    who: string,
    value: string,
    override?: PrefixOverride,
  ): void {
    this.flushPendingEscape(writer);
    this.breakLineIfNeeded(writer);
    this.resetLineOffset(writer);
    this.writePrefixed(writer, who, ensureTrailingNewline(value), override);
    this.resetLineOffset(writer);
  }

  private writePrefixedLine(
    writer: TmuxPresenterWriter,
    who: string,
    line: string,
  ): void {
    this.flushPendingEscape(writer);
    this.breakLineIfNeeded(writer);
    this.resetLineOffset(writer);
    this.writePrefixed(writer, who, `${line}\n`);
    this.resetLineOffset(writer);
  }

  private writePrefixed(
    writer: TmuxPresenterWriter,
    who: string,
    value: string,
    override?: PrefixOverride,
  ): void {
    let atLineStart = this.lineStarts.get(writer) ?? true;
    let lineOffset = this.lineOffsets.get(writer) ?? 0;
    let column = this.lineColumns.get(writer) ?? 0;
    const width = this.effectiveWrapWidth(writer);
    let output = '';

    const introText = override?.intro ?? `${who}> `;
    const introSgr =
      override !== undefined ? override.sgr : this.prefixSgr(who);
    // The last SGR opener the body emitted (i.e., a CSI ending in `m` that is
    // not a reset). TMUX-038 requires continuation indents to stay uncolored;
    // at every continuation boundary we close this span before the `\n`,
    // emit the (uncolored) indent, and reopen it so the body resumes its
    // color on the new row. Per TMUX-046 this state is carried on the
    // writer, not on a single writePrefixed() call, so a streaming sequence
    // that splits the opener and the wrap across separate `text_delta`
    // events still honors the close/reopen rule.
    let activeBodySgr = this.activeBodySgrs.get(writer);

    const emitIntro = (): void => {
      // TMUX-038: only the first-line prefix carries color; continuation
      // indents on wrapped/multi-line blocks stay uncolored.
      const intro = lineOffset === 0 ? introText : CONTINUATION_INDENT;
      if (lineOffset === 0 && introSgr) {
        output += `${introSgr}${intro}${SGR_RESET}`;
      } else {
        output += intro;
      }
      column = intro.length;
      lineOffset += 1;
      atLineStart = false;
    };

    let parser = this.parsers.get(writer);
    if (!parser) {
      parser = new DisplayParser();
      this.parsers.set(writer, parser);
    }

    for (const token of parser.consume(value)) {
      if (token.type === 'newline') {
        // Newlines that arrive before any visible content still emit so leading
        // blank lines render blank without consuming the speaker prefix.
        // Close any active body SGR before the newline so the continuation
        // indent that follows stays uncolored.
        output += activeBodySgr ? `${SGR_RESET}\n` : '\n';
        atLineStart = true;
        column = 0;
        continue;
      }
      if (atLineStart) {
        emitIntro();
        // On a continuation line (lineOffset > 1 after emitIntro), reopen
        // the body SGR after the uncolored indent so the body's color
        // continues. First-line prefixes have their own SGR pair emitted
        // inside emitIntro and don't need this re-emit.
        if (lineOffset > 1 && activeBodySgr) {
          output += activeBodySgr;
        }
      }
      if (token.type === 'escape') {
        output += token.sequence;
        if (isSgrEscape(token.sequence)) {
          activeBodySgr = isSgrReset(token.sequence)
            ? undefined
            : token.sequence;
        }
        continue;
      }
      // Soft-wrap before placing a visible char that would overflow the pane;
      // skip the wrap when we are already on a fresh continuation row so we
      // never loop forever on a char that cannot fit even after wrapping.
      if (
        token.cells > 0 &&
        column + token.cells > width &&
        column > CONTINUATION_INDENT.length
      ) {
        if (activeBodySgr) {
          output += `${SGR_RESET}\n${CONTINUATION_INDENT}${activeBodySgr}`;
        } else {
          output += `\n${CONTINUATION_INDENT}`;
        }
        column = CONTINUATION_INDENT.length;
        lineOffset += 1;
      }
      output += token.char;
      column += token.cells;
    }

    this.lineStarts.set(writer, atLineStart);
    this.lineOffsets.set(writer, lineOffset);
    this.lineColumns.set(writer, column);
    if (activeBodySgr === undefined) {
      this.activeBodySgrs.delete(writer);
    } else {
      this.activeBodySgrs.set(writer, activeBodySgr);
    }
    if (output) {
      writer.write(output);
    }
  }

  // Returns the configured width if a wrap can actually fit indent + content;
  // otherwise Infinity so the writer falls back to no soft-wrap.
  private effectiveWrapWidth(writer: TmuxPresenterWriter): number {
    const source = this.widths.get(writer);
    if (!source) {
      return Number.POSITIVE_INFINITY;
    }
    const width = source();
    if (!Number.isFinite(width) || width <= CONTINUATION_INDENT.length) {
      return Number.POSITIVE_INFINITY;
    }
    return width;
  }

  private breakLineIfNeeded(writer: TmuxPresenterWriter): void {
    if (this.lineStarts.get(writer) === false) {
      writer.write('\n');
      this.lineStarts.set(writer, true);
      this.resetLineOffset(writer);
    }
  }

  private resetLineOffset(writer: TmuxPresenterWriter): void {
    this.lineOffsets.set(writer, 0);
    this.lineColumns.set(writer, 0);
  }

  private roleWriter(roleId: string): TmuxPresenterWriter {
    const writer = this.roles.get(roleId);
    if (!writer) {
      throw new Error(`Missing tmux presenter writer for role: ${roleId}`);
    }
    return writer;
  }
}

export function createTmuxPresenter(
  options: TmuxPresenterOptions,
): RecordObserver {
  return new TmuxPresenter(options);
}

function formatStatusData(
  data: Record<string, unknown> | undefined,
): string {
  if (data === undefined) {
    return '';
  }

  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ' [unserializable data]';
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

// TMUX-039 status coloring. The bracketed status body gets a red (error) or
// yellow (aborted) bold span; the surrounding speaker prefix keeps its own
// SGR colors. Wrapping is opaque to the DisplayParser — it sees the SGR
// bytes as zero-width escape tokens and preserves them through soft-wrap.
function paintStatus(kind: 'error' | 'aborted', text: string): string {
  const sgr = kind === 'error' ? STATUS_ERROR_SGR : STATUS_ABORTED_SGR;
  return `${sgr}${text}${SGR_RESET}`;
}

// TMUX-049 tool-result outcome → status symbol + prefix SGR. Mirrors the
// outcome palette: success/green, error/red, denied/yellow.
function toolResultStyle(
  status: ToolResultPayload['status'],
): { symbol: string; sgr: string } {
  if (status === 'success') return { symbol: '✓', sgr: TOOL_OK_SGR };
  if (status === 'error') return { symbol: '✗', sgr: TOOL_FAIL_SGR };
  return { symbol: '·', sgr: TOOL_DENIED_SGR };
}

// Pick the most useful single-string description of a tool's input for the
// `tool>` header. Known keys come first (matching the most common tools the
// adapters expose); fall back to a truncated JSON dump.
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

// Tool result output payloads vary: string, `{ stdout }`, or JSON-shaped
// structured data. Pick the human-readable form when one exists; otherwise
// pretty-print JSON.
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
// rather than by UTF-16 code units, and the per-token `char` carries the
// whole codepoint so surrogate pairs are never split.
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

// Distinguishes SGR (Select Graphic Rendition) escapes — CSI parameters
// terminated by `m` — from other CSI commands (cursor movement, erase,
// etc.) which don't affect text color/style and so don't need the
// continuation-indent uncoloring treatment.
function isSgrEscape(seq: string): boolean {
  return /^\x1b\[[\d;]*m$/.test(seq);
}

// `\x1b[m` (no params) is the canonical "reset all attributes" form, as is
// `\x1b[0m`. Both close any active SGR span.
function isSgrReset(seq: string): boolean {
  return seq === '\x1b[0m' || seq === '\x1b[m';
}
