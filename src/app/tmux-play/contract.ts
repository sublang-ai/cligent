// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { PlayerAdapterImports, PlayerAdapterName } from './players.js';
import type { RecordObserver } from './records.js';
import type { Effort, EffortForAgent } from '../../effort.js';
import type { PermissionPolicy } from '../../types.js';

export interface Captain {
  init?(session: CaptainSession): Promise<void>;
  handleBossTurn(turn: BossTurn, context: CaptainContext): Promise<void>;
  /**
   * tmux-play-85: final live-session hook. Runs once after the active turn
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
  emitStatus(message: string, data?: Record<string, unknown>): Promise<void>;
  emitTelemetry(event: CaptainTelemetry): Promise<void>;
  /**
   * tmux-play-81: change which configured players have panes in the main tmux
   * window, for phase setup in `init()` or between Boss turns. `playerIds`
   * must be a duplicate-free subset of the configured player ids. The empty
   * set is accepted only for an empty configured roster; an invalid argument
   * rejects before any record is emitted, leaving the visible set unchanged.
   * An accepted call emits one `player_view_changed`.
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

/**
 * Select a concrete per-call value or deliberately defer to the provider's
 * current default. The explicit default arm is distinct from omitting the
 * enclosing settings object, which preserves tmux-play's configured values.
 */
export type TuningSelection<T extends string = string> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'provider-default' };

/**
 * Complete effective settings for one player or Captain invocation.
 * `model` and `effort` are required so a caller cannot accidentally combine
 * a current value with a configured value from another logical session.
 * Omitting `instruction` or `permissions` means no per-call instruction or
 * permission policy; configured values are not merged into this object.
 */
export interface AgentCallSettings {
  readonly model: TuningSelection;
  readonly effort: TuningSelection<Effort>;
  readonly instruction?: string;
  readonly permissions?: PermissionPolicy;
}

const AGENT_CALL_SETTINGS_ERROR = Symbol.for('cligent.agentCallSettingsError');

/**
 * A complete per-call settings replacement that tmux-play cannot accept or
 * enforce before any call record or provider work begins.
 */
export class AgentCallSettingsError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AgentCallSettingsError';
    this.cause = cause;
    Object.defineProperty(this, AGENT_CALL_SETTINGS_ERROR, { value: true });
  }
}

/** Whether an error is a tmux-play complete-settings preflight rejection. */
export function isAgentCallSettingsError(
  error: unknown,
): error is AgentCallSettingsError {
  if (typeof error !== 'object' || error === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      error,
      AGENT_CALL_SETTINGS_ERROR,
    );
    return (
      descriptor !== undefined &&
      'value' in descriptor &&
      descriptor.value === true
    );
  } catch {
    return false;
  }
}

export interface CallCaptainOptions {
  /**
   * Whether the Captain call's records reach the Boss pane. Defaults to
   * `'visible'`. `'hidden'` produces zero Boss-pane output while returning
   * the same {@link CaptainRunResult}.
   */
  readonly visibility?: RecordVisibility;
  /**
   * Select the Captain's backend session for this call. A string resumes the
   * named session, `false` forces a fresh session, and omission preserves the
   * runtime-owned Captain Cligent's automatic continuity.
   */
  readonly resume?: string | false;
  /**
   * Restrict the tools available during this call. An explicit empty list
   * requires a tool-free run; omission preserves configured/provider tools.
   */
  readonly allowedTools?: readonly string[];
  /**
   * Replace every configured call setting atomically for this invocation.
   * Omission preserves the runtime's configured settings.
   */
  readonly settings?: AgentCallSettings;
}

/**
 * Per-call player session selection. A string resumes that opaque backend
 * session, `false` forces a fresh session, and omission preserves the
 * player's runtime-managed auto-resume behavior.
 */
export interface CallPlayerOptions {
  readonly resume?: string | false;
  /**
   * Replace every configured call setting atomically for this invocation.
   * Omission preserves the runtime's configured settings.
   */
  readonly settings?: AgentCallSettings;
}

/**
 * tmux-play-16 / tmux-play-91: the turn-scoped surface passed to each
 * `handleBossTurn`. Every turn-scoped member — `callPlayer`,
 * `callCaptain`, `setVisiblePlayers`, `emitReply` — shares one admission
 * boundary: once the runtime resumes from `handleBossTurn`, a new call
 * rejects before emitting any record. Calls
 * admitted earlier may continue while the turn remains abortable; the runtime
 * joins and drains them before its pre-terminal fence, so no turn-bound record
 * can trail `turn_finished` / `turn_aborted`.
 */
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
   * tmux-play-16 / tmux-play-92 / tmux-play-97: emit one turn-scoped
   * conversational Captain reply. The text is rendered in the Boss/Captain
   * pane as ordinary Captain prose — the same Markdown pipeline and
   * `captain> ` prefix as visible Captain speech — not as a bracketed
   * `[status]` operational line. The emitted `captain_reply` record carries
   * this turn's id; a call after the turn has ended (or after session shutdown)
   * rejects and emits nothing.
   */
  emitReply(text: string): Promise<void>;
  /**
   * tmux-play-81: turn-scoped variant of {@link CaptainSession.setVisiblePlayers}
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
  readonly resumeToken?: string;
  readonly finalText?: string;
  readonly error?: string;
}

interface RuntimePlayerConfigBase {
  readonly id: string;
  readonly model?: string;
  readonly instruction?: string;
  readonly permissions?: PermissionPolicy;
}

type RuntimePlayerConfigByAdapter = {
  [A in PlayerAdapterName]: RuntimePlayerConfigBase & {
    readonly adapter: A;
    readonly effort?: EffortForAgent<A>;
  };
};

export type RuntimePlayerConfig<
  A extends PlayerAdapterName = PlayerAdapterName,
> = RuntimePlayerConfigByAdapter[A];

interface RuntimeCaptainConfigBase {
  readonly model?: string;
  readonly instruction?: string;
  readonly permissions?: PermissionPolicy;
}

type RuntimeCaptainConfigByAdapter = {
  [A in PlayerAdapterName]: RuntimeCaptainConfigBase & {
    readonly adapter: A;
    readonly effort?: EffortForAgent<A>;
  };
};

export type RuntimeCaptainConfig<
  A extends PlayerAdapterName = PlayerAdapterName,
> = RuntimeCaptainConfigByAdapter[A];

export interface RunTmuxPlayOptions {
  readonly captain: Captain;
  readonly captainConfig: RuntimeCaptainConfig;
  readonly players: readonly RuntimePlayerConfig[];
  readonly observers?: readonly RecordObserver[];
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly adapterImports?: PlayerAdapterImports;
}
