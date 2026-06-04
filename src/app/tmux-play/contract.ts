// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { PlayerAdapterImports, PlayerAdapterName } from './players.js';
import type { RecordObserver } from './records.js';
import type { PermissionPolicy, ReasoningEffort } from '../../types.js';

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
  readonly players: readonly PlayerHandle[];
  emitStatus(
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  emitTelemetry(event: CaptainTelemetry): Promise<void>;
}

export interface CaptainContext {
  readonly signal: AbortSignal;
  readonly players: readonly PlayerHandle[];
  callPlayer(playerId: string, prompt: string): Promise<PlayerRunResult>;
  callCaptain(prompt: string): Promise<CaptainRunResult>;
}

export interface CaptainTelemetry {
  readonly topic: string;
  readonly payload: unknown;
}

export interface PlayerHandle {
  readonly id: string;
  readonly adapter: PlayerAdapterName;
  readonly model?: string;
}

export type RunStatus = 'ok' | 'aborted' | 'error';

export interface PlayerRunResult {
  readonly status: RunStatus;
  readonly playerId: string;
  readonly turnId: number;
  readonly resumeToken?: string;
  readonly finalText?: string;
  readonly error?: string;
}

export interface CaptainRunResult {
  readonly status: RunStatus;
  readonly turnId: number;
  readonly finalText?: string;
  readonly error?: string;
}

export interface RuntimePlayerConfig {
  readonly id: string;
  readonly adapter: PlayerAdapterName;
  readonly model?: string;
  readonly instruction?: string;
  readonly permissions?: PermissionPolicy;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface RuntimeCaptainConfig {
  readonly adapter: PlayerAdapterName;
  readonly model?: string;
  readonly instruction?: string;
  readonly permissions?: PermissionPolicy;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface RunTmuxPlayOptions {
  readonly captain: Captain;
  readonly captainConfig: RuntimeCaptainConfig;
  readonly players: readonly RuntimePlayerConfig[];
  readonly observers?: readonly RecordObserver[];
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly adapterImports?: PlayerAdapterImports;
}
