// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { formatCligentEvent } from '../shared/events.js';
import { DisplayParser } from '../shared/display-width.js';
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
  bold24bitFg,
  roleAccent,
} from './role-colors.js';

const CONTINUATION_INDENT = '  ';

// TMUX-038/039 prefix and status SGR anchors. Built once at module load.
const PREFIX_BOSS_SGR = bold24bitFg(SPEAKER_BOSS);
const PREFIX_CAPTAIN_SGR = bold24bitFg(SPEAKER_CAPTAIN);
const STATUS_ERROR_SGR = bold24bitFg(STATUS_ERROR);
const STATUS_ABORTED_SGR = bold24bitFg(STATUS_ABORTED);

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

export class TmuxPresenter implements RecordObserver {
  private readonly boss: TmuxPresenterWriter;
  private readonly roles: ReadonlyMap<string, TmuxPresenterWriter>;
  private readonly roleAdapters: ReadonlyMap<string, string>;
  private readonly widths = new WeakMap<TmuxPresenterWriter, WidthSource>();
  private readonly lineStarts = new WeakMap<TmuxPresenterWriter, boolean>();
  private readonly lineOffsets = new WeakMap<TmuxPresenterWriter, number>();
  private readonly lineColumns = new WeakMap<TmuxPresenterWriter, number>();
  private readonly parsers = new WeakMap<TmuxPresenterWriter, DisplayParser>();

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

    const formatted = formatCligentEvent(event);
    if (formatted !== null) {
      if (event.type === 'text_delta') {
        this.writePrefixed(writer, who, formatted);
      } else {
        this.writePrefixedBlock(writer, who, formatted);
      }
    }
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
  ): void {
    this.flushPendingEscape(writer);
    this.breakLineIfNeeded(writer);
    this.resetLineOffset(writer);
    this.writePrefixed(writer, who, ensureTrailingNewline(value));
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
  ): void {
    let atLineStart = this.lineStarts.get(writer) ?? true;
    let lineOffset = this.lineOffsets.get(writer) ?? 0;
    let column = this.lineColumns.get(writer) ?? 0;
    const width = this.effectiveWrapWidth(writer);
    let output = '';

    const prefixSgr = this.prefixSgr(who);

    const emitIntro = (): void => {
      // TMUX-038: only the first-line prefix carries color; continuation
      // indents on wrapped/multi-line blocks stay uncolored so the body's
      // own ANSI state (the empty default) governs them.
      const intro = lineOffset === 0 ? `${who}> ` : CONTINUATION_INDENT;
      if (lineOffset === 0 && prefixSgr) {
        output += `${prefixSgr}${intro}${SGR_RESET}`;
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
        output += '\n';
        atLineStart = true;
        column = 0;
        continue;
      }
      if (atLineStart) {
        emitIntro();
      }
      if (token.type === 'escape') {
        output += token.sequence;
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
        output += `\n${CONTINUATION_INDENT}`;
        column = CONTINUATION_INDENT.length;
        lineOffset += 1;
      }
      output += token.char;
      column += token.cells;
    }

    this.lineStarts.set(writer, atLineStart);
    this.lineOffsets.set(writer, lineOffset);
    this.lineColumns.set(writer, column);
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
