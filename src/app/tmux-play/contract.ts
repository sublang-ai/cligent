// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { RoleAdapterImports, RoleAdapterName } from './roles.js';
import type { RecordObserver } from './records.js';

export interface Captain {
  init?(session: CaptainSession): Promise<void>;
  handleBossTurn(turn: BossTurn, context: CaptainContext): Promise<void>;
  dispose?(): Promise<void>;
}

export interface BossTurn {
  id: number;
  prompt: string;
  timestamp: number;
}

export interface CaptainSession {
  readonly signal: AbortSignal;
  readonly roles: readonly RoleHandle[];
  emitStatus(
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  emitTelemetry(event: CaptainTelemetry): Promise<void>;
}

export interface CaptainContext {
  readonly signal: AbortSignal;
  readonly roles: readonly RoleHandle[];
  callRole(roleId: string, prompt: string): Promise<RoleRunResult>;
  callCaptain(prompt: string): Promise<CaptainRunResult>;
}

export interface CaptainTelemetry {
  readonly topic: string;
  readonly payload: unknown;
}

export interface RoleHandle {
  readonly id: string;
  readonly adapter: RoleAdapterName;
  readonly model?: string;
}

export type RunStatus = 'ok' | 'aborted' | 'error';

export interface RoleRunResult {
  readonly status: RunStatus;
  readonly roleId: string;
  readonly turnId: number;
  readonly finalText?: string;
  readonly error?: string;
}

export interface CaptainRunResult {
  readonly status: RunStatus;
  readonly turnId: number;
  readonly finalText?: string;
  readonly error?: string;
}

export interface RuntimeRoleConfig {
  readonly id: string;
  readonly adapter: RoleAdapterName;
  readonly model?: string;
  readonly instruction?: string;
}

export interface RuntimeCaptainConfig {
  readonly adapter: RoleAdapterName;
  readonly model?: string;
  readonly instruction?: string;
}

export interface RunTmuxPlayOptions {
  readonly captain: Captain;
  readonly captainConfig: RuntimeCaptainConfig;
  readonly roles: readonly RuntimeRoleConfig[];
  readonly observers?: readonly RecordObserver[];
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly adapterImports?: RoleAdapterImports;
}
