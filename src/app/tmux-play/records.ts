// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { CligentEvent } from '../../types.js';
import type {
  BossTurn,
  CaptainTelemetry,
  CaptainRunResult,
  RoleRunResult,
} from './contract.js';

export interface BaseRecord<TType extends string = string> {
  readonly type: TType;
  readonly turnId: number | null;
  readonly timestamp: number;
}

export interface TurnStartedRecord extends BaseRecord {
  readonly type: 'turn_started';
  readonly turn: BossTurn;
}

export interface TurnFinishedRecord extends BaseRecord {
  readonly type: 'turn_finished';
}

export interface TurnAbortedRecord extends BaseRecord {
  readonly type: 'turn_aborted';
  readonly reason?: string;
}

export interface RolePromptRecord extends BaseRecord {
  readonly type: 'role_prompt';
  readonly roleId: string;
  readonly prompt: string;
}

export interface RoleEventRecord extends BaseRecord {
  readonly type: 'role_event';
  readonly roleId: string;
  readonly event: CligentEvent;
}

export interface RoleFinishedRecord extends BaseRecord {
  readonly type: 'role_finished';
  readonly roleId: string;
  readonly result: RoleRunResult;
}

export interface CaptainPromptRecord extends BaseRecord {
  readonly type: 'captain_prompt';
  readonly prompt: string;
}

export interface CaptainEventRecord extends BaseRecord {
  readonly type: 'captain_event';
  readonly event: CligentEvent;
}

export interface CaptainFinishedRecord extends BaseRecord {
  readonly type: 'captain_finished';
  readonly result: CaptainRunResult;
}

export interface CaptainStatusRecord extends BaseRecord {
  readonly type: 'captain_status';
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface CaptainTelemetryRecord extends BaseRecord {
  readonly type: 'captain_telemetry';
  readonly topic: string;
  readonly payload: unknown;
}

export interface RuntimeErrorRecord extends BaseRecord {
  readonly type: 'runtime_error';
  readonly message: string;
  readonly sourceRecordType?: TmuxPlayRecordType;
  readonly observerIndex?: number;
}

export type TmuxPlayRecord =
  | TurnStartedRecord
  | TurnFinishedRecord
  | TurnAbortedRecord
  | RolePromptRecord
  | RoleEventRecord
  | RoleFinishedRecord
  | CaptainPromptRecord
  | CaptainEventRecord
  | CaptainFinishedRecord
  | CaptainStatusRecord
  | CaptainTelemetryRecord
  | RuntimeErrorRecord;

export type TmuxPlayRecordType = TmuxPlayRecord['type'];

export interface RecordObserver {
  onRecord(record: TmuxPlayRecord): void | Promise<void>;
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
  private readonly observers: RecordObserver[] = [];
  private tail: Promise<void> = Promise.resolve();
  private failure: ObserverDispatchError | undefined = undefined;

  addObserver(observer: RecordObserver): () => void {
    this.observers.push(observer);
    return () => {
      const index = this.observers.indexOf(observer);
      if (index !== -1) {
        this.observers.splice(index, 1);
      }
    };
  }

  emit(record: TmuxPlayRecord): Promise<void> {
    const result = this.tail.then(async () => {
      if (this.failure) {
        throw this.failure;
      }

      try {
        await this.dispatch(record);
      } catch (error) {
        if (error instanceof ObserverDispatchError) {
          this.failure = error;
        }
        throw error;
      }
    });

    this.tail = result.catch(() => {
      // The failure is retained and re-thrown to future callers. Swallowing
      // here keeps the internal queue chain alive.
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
    if (this.failure) {
      throw this.failure;
    }
  }

  private async dispatch(record: TmuxPlayRecord): Promise<void> {
    const observers = [...this.observers];
    for (let i = 0; i < observers.length; i++) {
      try {
        await observers[i]?.onRecord(record);
      } catch (error) {
        if (record.type !== 'runtime_error') {
          await this.dispatchRuntimeError(observers, record, i, error);
        }
        throw new ObserverDispatchError(record, i, error);
      }
    }
  }

  private async dispatchRuntimeError(
    observers: readonly RecordObserver[],
    sourceRecord: TmuxPlayRecord,
    failedObserverIndex: number,
    error: unknown,
  ): Promise<void> {
    const runtimeError: RuntimeErrorRecord = {
      type: 'runtime_error',
      turnId: sourceRecord.turnId,
      timestamp: Date.now(),
      message: errorMessage(error),
      sourceRecordType: sourceRecord.type,
      observerIndex: failedObserverIndex,
    };

    for (let i = failedObserverIndex + 1; i < observers.length; i++) {
      try {
        await observers[i]?.onRecord(runtimeError);
      } catch {
        // Best effort: DR-004 only requires notifying remaining observers
        // when possible.
      }
    }
  }
}

export function makeRecordBase<TType extends TmuxPlayRecordType>(
  type: TType,
  turnId: number | null,
  timestamp = Date.now(),
): BaseRecord<TType> {
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
