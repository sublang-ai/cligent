// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { CligentEvent } from '../../types.js';
import type {
  BossTurn,
  CaptainTelemetry,
  CaptainRunResult,
  PlayerRunResult,
  RecordVisibility,
} from './contract.js';

export interface BaseRecord<
  TType extends string = string,
  TTurnId extends number | null = number,
> {
  readonly type: TType;
  readonly turnId: TTurnId;
  readonly timestamp: number;
}

export interface TurnStartedRecord extends BaseRecord<'turn_started'> {
  readonly turn: BossTurn;
}

export type TurnFinishedRecord = BaseRecord<'turn_finished'>;

export interface TurnAbortedRecord extends BaseRecord<'turn_aborted'> {
  readonly reason?: string;
}

export interface PlayerPromptRecord extends BaseRecord<'player_prompt'> {
  readonly playerId: string;
  readonly prompt: string;
}

export interface PlayerEventRecord extends BaseRecord<'player_event'> {
  readonly playerId: string;
  readonly event: CligentEvent;
}

export interface PlayerFinishedRecord extends BaseRecord<'player_finished'> {
  readonly playerId: string;
  readonly result: PlayerRunResult;
}

export interface CaptainPromptRecord extends BaseRecord<'captain_prompt'> {
  readonly prompt: string;
  // Presentation visibility for this Captain call's records. Absent or
  // 'visible' renders to the Boss pane; 'hidden' is skipped by the tmux
  // presenter while non-presenter observers keep the full trace.
  readonly visibility?: RecordVisibility;
}

export interface CaptainEventRecord extends BaseRecord<'captain_event'> {
  readonly event: CligentEvent;
  readonly visibility?: RecordVisibility;
}

export interface CaptainFinishedRecord extends BaseRecord<'captain_finished'> {
  readonly result: CaptainRunResult;
  readonly visibility?: RecordVisibility;
}

/**
 * tmux-play-92 / tmux-play-97: emitted once per
 * {@link CaptainContext.emitReply} call. Carries a conversational Captain reply
 * the tmux presenter renders as ordinary Captain prose (glow Markdown under the
 * `captain> ` prefix), unlike the bracketed `[status]` operational line of
 * `captain_status`. Turn-bound: it always carries the emitting context's turn
 * id.
 */
export interface CaptainReplyRecord extends BaseRecord<'captain_reply'> {
  readonly text: string;
}

export interface CaptainStatusRecord
  extends BaseRecord<'captain_status', number | null> {
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface CaptainTelemetryRecord
  extends BaseRecord<'captain_telemetry', number | null> {
  readonly topic: string;
  readonly payload: unknown;
}

/**
 * tmux-play-82: emitted once per accepted {@link CaptainSession.setVisiblePlayers}
 * / {@link CaptainContext.setVisiblePlayers} call. Carries the requested
 * visible player ids in order; the tmux-play-83 layout observer consumes it to
 * reconcile the visible player panes. Carries the active turn id when emitted
 * during a turn, else `null` (session-scoped between-turn calls).
 */
export interface PlayerViewChangedRecord
  extends BaseRecord<'player_view_changed', number | null> {
  readonly visiblePlayerIds: readonly string[];
}

export interface RuntimeErrorRecord
  extends BaseRecord<'runtime_error', number | null> {
  readonly message: string;
  readonly sourceRecordType?: TmuxPlayRecordType;
  readonly observerIndex?: number;
}

export type TmuxPlayRecord =
  | TurnStartedRecord
  | TurnFinishedRecord
  | TurnAbortedRecord
  | PlayerPromptRecord
  | PlayerEventRecord
  | PlayerFinishedRecord
  | CaptainPromptRecord
  | CaptainEventRecord
  | CaptainFinishedRecord
  | CaptainReplyRecord
  | CaptainStatusRecord
  | CaptainTelemetryRecord
  | PlayerViewChangedRecord
  | RuntimeErrorRecord;

export type TmuxPlayRecordType = TmuxPlayRecord['type'];
export type NullableTurnIdRecordType =
  | 'captain_status'
  | 'captain_telemetry'
  | 'player_view_changed'
  | 'runtime_error';
export type TurnBoundRecordType = Exclude<
  TmuxPlayRecordType,
  NullableTurnIdRecordType
>;

export interface RecordObserver {
  onRecord(record: TmuxPlayRecord): void | Promise<void>;
}

interface ObserverRegistration {
  readonly observer: RecordObserver;
}

export class ObserverDispatchError extends Error {
  readonly record: TmuxPlayRecord;
  readonly observerIndex: number;
  readonly cause: unknown;

  constructor(record: TmuxPlayRecord, observerIndex: number, cause: unknown) {
    super(
      `Record observer ${observerIndex} failed while handling ${record.type}: ` +
        errorMessage(cause),
    );
    this.name = 'ObserverDispatchError';
    this.record = record;
    this.observerIndex = observerIndex;
    this.cause = cause;
  }
}

export class RecordDispatcher {
  private readonly observers: ObserverRegistration[] = [];
  private tail: Promise<void> = Promise.resolve();
  private pendingFailure: ObserverDispatchError | undefined = undefined;

  addObserver(observer: RecordObserver): () => void {
    const registration = { observer };
    this.observers.push(registration);
    return () => {
      this.removeObserver(registration);
    };
  }

  emit(record: TmuxPlayRecord): Promise<void> {
    const result = this.tail.then(async () => {
      try {
        await this.dispatch(record);
      } catch (error) {
        if (error instanceof ObserverDispatchError) {
          this.pendingFailure ??= error;
        }
        throw error;
      }
    });

    this.tail = result.catch(() => {
      // Keep the ordered queue live so later source records still reach the
      // healthy observers. drain() reports the pending failure once.
    });
    result.catch(() => {
      // Mark fire-and-forget status emissions as handled while preserving
      // rejection for callers that await the returned promise.
    });
    return result;
  }

  emitStatus(record: CaptainStatusRecord): Promise<void> {
    return this.emit(record);
  }

  emitTelemetry(record: CaptainTelemetryRecord): Promise<void> {
    return this.emit(record);
  }

  async drain(): Promise<void> {
    await this.tail;
    if (this.pendingFailure) {
      const failure = this.pendingFailure;
      this.pendingFailure = undefined;
      throw failure;
    }
  }

  private async dispatch(record: TmuxPlayRecord): Promise<void> {
    const observers = [...this.observers];
    const failedObservers = new Set<ObserverRegistration>();
    let firstFailure: ObserverDispatchError | undefined;

    for (let i = 0; i < observers.length; i++) {
      const registration = observers[i];
      if (!registration) continue;

      try {
        await registration.observer.onRecord(record);
      } catch (error) {
        failedObservers.add(registration);
        this.removeObserver(registration);
        firstFailure ??= new ObserverDispatchError(record, i, error);
      }
    }

    if (!firstFailure) return;

    if (record.type !== 'runtime_error') {
      await this.dispatchRuntimeError(
        observers,
        failedObservers,
        record,
        firstFailure,
      );
    }
    throw firstFailure;
  }

  private async dispatchRuntimeError(
    observers: readonly ObserverRegistration[],
    failedObservers: ReadonlySet<ObserverRegistration>,
    sourceRecord: TmuxPlayRecord,
    failure: ObserverDispatchError,
  ): Promise<void> {
    const runtimeError: RuntimeErrorRecord = {
      type: 'runtime_error',
      turnId:
        sourceRecord.type === 'turn_finished' ||
        sourceRecord.type === 'turn_aborted'
          ? null
          : sourceRecord.turnId,
      timestamp: Date.now(),
      message: errorMessage(failure.cause),
      sourceRecordType: sourceRecord.type,
      observerIndex: failure.observerIndex,
    };

    for (let i = failure.observerIndex + 1; i < observers.length; i++) {
      const registration = observers[i];
      if (!registration || failedObservers.has(registration)) continue;

      try {
        await registration.observer.onRecord(runtimeError);
      } catch {
        // A diagnostic observer failure cannot recursively produce another
        // diagnostic, but it is still isolated from later source records.
        this.removeObserver(registration);
      }
    }
  }

  private removeObserver(registration: ObserverRegistration): void {
    const index = this.observers.indexOf(registration);
    if (index !== -1) {
      this.observers.splice(index, 1);
    }
  }
}

export function makeRecordBase<TType extends TurnBoundRecordType>(
  type: TType,
  turnId: number,
  timestamp?: number,
): BaseRecord<TType>;
export function makeRecordBase<TType extends NullableTurnIdRecordType>(
  type: TType,
  turnId: number | null,
  timestamp?: number,
): BaseRecord<TType, number | null>;
export function makeRecordBase(
  type: TmuxPlayRecordType,
  turnId: number | null,
  timestamp = Date.now(),
): BaseRecord<TmuxPlayRecordType, number | null> {
  return { type, turnId, timestamp };
}

export function telemetryRecord(
  telemetry: CaptainTelemetry,
  turnId: number | null,
  timestamp = Date.now(),
): CaptainTelemetryRecord {
  return {
    ...makeRecordBase('captain_telemetry', turnId, timestamp),
    topic: telemetry.topic,
    payload: telemetry.payload,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
