// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { formatCligentEvent } from '../shared/events.js';
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

export interface TmuxPresenterWriter {
  write(value: string): unknown;
}

export interface TmuxPresenterOptions {
  readonly boss: TmuxPresenterWriter;
  readonly roles: ReadonlyMap<string, TmuxPresenterWriter>;
}

export class TmuxPresenter implements RecordObserver {
  private readonly boss: TmuxPresenterWriter;
  private readonly roles: ReadonlyMap<string, TmuxPresenterWriter>;
  private readonly lineStarts = new WeakMap<TmuxPresenterWriter, boolean>();

  constructor(options: TmuxPresenterOptions) {
    this.boss = options.boss;
    this.roles = options.roles;
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
          `[turn aborted: ${record.reason ?? 'aborted'}]`,
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
          `[runtime error: ${record.message}]`,
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
      return;
    }

    const line =
      result.status === 'error'
        ? `[error: ${result.error ?? 'Agent run failed'}]`
        : '[aborted]';
    this.writePrefixedLine(writer, who, line);
  }

  private writeFormatted(
    writer: TmuxPresenterWriter,
    who: string,
    event: Parameters<typeof formatCligentEvent>[0],
  ): void {
    if (event.type === 'done' || event.type === 'error') {
      return;
    }

    const formatted = formatCligentEvent(event);
    if (formatted !== null) {
      this.writePrefixed(writer, who, formatted);
    }
  }

  private writePrefixedBlock(
    writer: TmuxPresenterWriter,
    who: string,
    value: string,
  ): void {
    this.writePrefixed(writer, who, ensureTrailingNewline(value));
  }

  private writePrefixedLine(
    writer: TmuxPresenterWriter,
    who: string,
    line: string,
  ): void {
    this.breakLineIfNeeded(writer);
    this.writePrefixed(writer, who, `${line}\n`);
  }

  private writePrefixed(
    writer: TmuxPresenterWriter,
    who: string,
    value: string,
  ): void {
    let atLineStart = this.lineStarts.get(writer) ?? true;
    let output = '';

    for (const char of value) {
      if (atLineStart) {
        output += `${who}> `;
        atLineStart = false;
      }
      output += char;
      if (char === '\n') {
        atLineStart = true;
      }
    }

    this.lineStarts.set(writer, atLineStart);
    if (output) {
      writer.write(output);
    }
  }

  private breakLineIfNeeded(writer: TmuxPresenterWriter): void {
    if (this.lineStarts.get(writer) === false) {
      writer.write('\n');
      this.lineStarts.set(writer, true);
    }
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
