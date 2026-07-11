// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { PlayerAdapterImports, PlayerAdapterName } from './players.js';
import type { RecordObserver } from './records.js';
import type { PermissionPolicy, ReasoningEffort } from '../../types.js';

export interface Captain {
  init?(session: CaptainSession): Promise<void>;
  handleBossTurn(turn: BossTurn, context: CaptainContext): Promise<void>;
  /**
   * TMUX-085: final live-session hook. Runs once after the active turn
   * unwinds, while CaptainSession emissions are still accepted, and before
   * the session signal aborts. Use dispose() for post-close resource release.
   */
  prepareDispose?(): Promise<void>;
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
  /**
   * TMUX-081: change which configured players have panes in the main tmux
   * window, for phase setup in `init()` or between Boss turns. `playerIds`
   * must be a non-empty, duplicate-free subset of the configured player ids;
   * an invalid argument rejects before any record is emitted, leaving the
   * visible set unchanged. An accepted call emits one `player_view_changed`.
   */
  setVisiblePlayers(playerIds: readonly string[]): Promise<void>;
}

/**
 * Presentation visibility for the records a call emits. `visible` (the
 * default) renders to the Boss pane as before; `hidden` keeps the call's
 * behaviour and result identical but tags its records so the tmux presenter
 * skips them, while non-presenter observers still receive the full trace.
 */
export type RecordVisibility = 'visible' | 'hidden';

export interface CallCaptainOptions {
  /**
   * Whether the Captain call's records reach the Boss pane. Defaults to
   * `'visible'`. `'hidden'` produces zero Boss-pane output while returning
   * the same {@link CaptainRunResult}.
   */
  readonly visibility?: RecordVisibility;
}

/**
 * Per-call player session selection. A string resumes that opaque backend
 * session, `false` forces a fresh session, and omission preserves the
 * player's runtime-managed auto-resume behavior.
 */
export interface CallPlayerOptions {
  readonly resume?: string | false;
}

export interface CaptainContext {
  readonly signal: AbortSignal;
  readonly players: readonly PlayerHandle[];
  callPlayer(
    playerId: string,
    prompt: string,
    options?: CallPlayerOptions,
  ): Promise<PlayerRunResult>;
  callCaptain(
    prompt: string,
    options?: CallCaptainOptions,
  ): Promise<CaptainRunResult>;
  /**
   * TMUX-081: turn-scoped variant of {@link CaptainSession.setVisiblePlayers}
   * for mid-turn workflow transitions. Same validation and rejection
   * semantics; an accepted call emits one `player_view_changed` carrying the
   * active turn id.
   */
  setVisiblePlayers(playerIds: readonly string[]): Promise<void>;
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
