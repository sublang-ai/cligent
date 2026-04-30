// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { RoleAdapterImports, RoleAdapterName } from './roles.js';

export interface Captain {
  handleBossTurn(turn: BossTurn, context: CaptainContext): Promise<void>;
  dispose?(): Promise<void>;
}

export interface BossTurn {
  id: number;
  prompt: string;
  timestamp: number;
}

export interface CaptainContext {
  readonly signal: AbortSignal;
  readonly roles: readonly RoleHandle[];
  callRole(
    roleId: string,
    prompt: string,
    options?: RoleCallOptions,
  ): Promise<RoleRunResult>;
  callCaptain(
    prompt: string,
    options?: CaptainCallOptions,
  ): Promise<CaptainRunResult>;
  emitStatus(
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
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

export interface RoleCallOptions {
  readonly metadata?: Record<string, unknown>;
}

export type CaptainCallOptions = RoleCallOptions;

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
  readonly observers?: readonly {
    onRecord(record: unknown): void | Promise<void>;
  }[];
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly adapterImports?: RoleAdapterImports;
}
