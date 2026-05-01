// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { formatCligentEvent } from '../shared/events.js';
import type {
  CaptainRunResult,
  RoleRunResult,
  RunStatus,
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

  constructor(options: TmuxPresenterOptions) {
    this.boss = options.boss;
    this.roles = options.roles;
  }

  onRecord(record: TmuxPlayRecord): void {
    switch (record.type) {
      case 'turn_started':
        this.boss.write(`boss> ${record.turn.prompt}\n\n`);
        break;
      case 'turn_finished':
        this.boss.write('[turn finished]\n');
        break;
      case 'turn_aborted':
        this.boss.write(`[turn aborted: ${record.reason ?? 'aborted'}]\n`);
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
        this.boss.write(`[captain prompt]\n${record.prompt}\n\n`);
        break;
      case 'captain_event':
        this.writeFormatted(this.boss, record.event);
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
        this.boss.write(`[runtime error: ${record.message}]\n`);
        break;
    }
  }

  private writeRolePrompt(record: RolePromptRecord): void {
    const writer = this.roleWriter(record.roleId);
    writer.write(`[captain prompt]\n${record.prompt}\n\n`);
  }

  private writeRoleEvent(record: RoleEventRecord): void {
    this.writeFormatted(this.roleWriter(record.roleId), record.event);
  }

  private writeRoleFinished(record: RoleFinishedRecord): void {
    this.writeRunResult(
      this.roleWriter(record.roleId),
      `role ${record.roleId}`,
      record.result,
    );
  }

  private writeStatus(
    message: string,
    data: Record<string, unknown> | undefined,
  ): void {
    this.boss.write(`[status] ${message}${formatStatusData(data)}\n`);
  }

  private writeRunResult(
    writer: TmuxPresenterWriter,
    label: string,
    result: RoleRunResult | CaptainRunResult,
  ): void {
    const suffix = result.error ? `: ${result.error}` : '';
    writer.write(`[${label} ${statusLabel(result.status)}${suffix}]\n`);
  }

  private writeFormatted(
    writer: TmuxPresenterWriter,
    event: Parameters<typeof formatCligentEvent>[0],
  ): void {
    const formatted = formatCligentEvent(event);
    if (formatted !== null) {
      writer.write(formatted);
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

function statusLabel(status: RunStatus): string {
  return status === 'ok' ? 'ok' : status;
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
