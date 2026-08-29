// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import {
  ObserverDispatchError,
  RecordDispatcher,
  type CaptainTelemetryRecord,
  type CaptainStatusRecord,
  type RecordObserver,
  type TmuxPlayRecord,
} from './records.js';

function turnStarted(turnId = 1): TmuxPlayRecord {
  return {
    type: 'turn_started',
    turnId,
    timestamp: 100,
    turn: {
      id: turnId,
      prompt: 'build',
      timestamp: 100,
    },
  };
}

function turnFinished(turnId = 1): TmuxPlayRecord {
  return {
    type: 'turn_finished',
    turnId,
    timestamp: 200,
  };
}

function status(
  message: string,
  turnId: number | null = 1,
): CaptainStatusRecord {
  return {
    type: 'captain_status',
    turnId,
    timestamp: 150,
    message,
  };
}

function telemetry(
  topic: string,
  payload: unknown,
  turnId: number | null = 1,
): CaptainTelemetryRecord {
  return {
    type: 'captain_telemetry',
    turnId,
    timestamp: 150,
    topic,
    payload,
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('RecordDispatcher', () => {
  it('delivers each record to observers in registration order', async () => {
    const dispatcher = new RecordDispatcher();
    const seen: string[] = [];

    dispatcher.addObserver({
      onRecord(record) {
        seen.push(`first:${record.type}`);
      },
    });
    dispatcher.addObserver({
      onRecord(record) {
        seen.push(`second:${record.type}`);
      },
    });

    await dispatcher.emit(turnStarted());
    await dispatcher.emit(turnFinished());

    expect(seen).toEqual([
      'first:turn_started',
      'second:turn_started',
      'first:turn_finished',
      'second:turn_finished',
    ]);
  });

  it('awaits an observer before delivering to the next observer', async () => {
    const dispatcher = new RecordDispatcher();
    const gate = deferred();
    const seen: string[] = [];

    dispatcher.addObserver({
      async onRecord() {
        seen.push('first:start');
        await gate.promise;
        seen.push('first:end');
      },
    });
    dispatcher.addObserver({
      onRecord() {
        seen.push('second');
      },
    });

    const emitted = dispatcher.emit(turnStarted());
    await Promise.resolve();
    expect(seen).toEqual(['first:start']);

    gate.resolve();
    await emitted;
    expect(seen).toEqual(['first:start', 'first:end', 'second']);
  });

  it('queues fire-and-forget status before subsequent records', async () => {
    const dispatcher = new RecordDispatcher();
    const gate = deferred();
    const seen: string[] = [];

    dispatcher.addObserver({
      async onRecord(record) {
        seen.push(`${record.type}:start`);
        if (record.type === 'captain_status') {
          await gate.promise;
        }
        seen.push(`${record.type}:end`);
      },
    });

    void dispatcher.emitStatus(status('inspector ready'));
    const finished = dispatcher.emit(turnFinished());

    await Promise.resolve();
    expect(seen).toEqual(['captain_status:start']);

    gate.resolve();
    await finished;
    expect(seen).toEqual([
      'captain_status:start',
      'captain_status:end',
      'turn_finished:start',
      'turn_finished:end',
    ]);
  });

  it('drains queued status records before resolving drain', async () => {
    const dispatcher = new RecordDispatcher();
    const gate = deferred();
    const seen: string[] = [];

    dispatcher.addObserver({
      async onRecord(record) {
        await gate.promise;
        seen.push(record.type);
      },
    });

    void dispatcher.emitStatus(status('working'));
    const drained = dispatcher.drain();
    await Promise.resolve();
    expect(seen).toEqual([]);

    gate.resolve();
    await drained;
    expect(seen).toEqual(['captain_status']);
  });

  it('queues status and telemetry on the same session lane', async () => {
    const dispatcher = new RecordDispatcher();
    const seen: TmuxPlayRecord[] = [];

    dispatcher.addObserver({
      onRecord(record) {
        seen.push(record);
      },
    });

    void dispatcher.emitStatus(status('ready', null));
    void dispatcher.emitTelemetry(
      telemetry('metrics.ready', { ok: true }, null),
    );
    await dispatcher.drain();

    expect(seen).toMatchObject([
      { type: 'captain_status', turnId: null, message: 'ready' },
      {
        type: 'captain_telemetry',
        turnId: null,
        topic: 'metrics.ready',
        payload: { ok: true },
      },
    ]);
  });

  it('isolates a failed observer after completing source delivery (tmux-play-111)', async () => {
    const dispatcher = new RecordDispatcher();
    const seen: string[] = [];

    dispatcher.addObserver({
      onRecord(record) {
        seen.push(`first:${record.type}`);
      },
    });
    dispatcher.addObserver({
      onRecord(record) {
        seen.push(`failed:${record.type}`);
        throw new Error('observer failed');
      },
    });
    dispatcher.addObserver({
      onRecord(record) {
        seen.push(`third:${record.type}:${record.turnId}`);
      },
    });

    await expect(dispatcher.emit(turnStarted())).rejects.toThrow(
      ObserverDispatchError,
    );
    await dispatcher.emit(turnFinished());

    expect(seen).toEqual([
      'first:turn_started',
      'failed:turn_started',
      'third:turn_started:1',
      'third:runtime_error:1',
      'first:turn_finished',
      'third:turn_finished:1',
    ]);
  });

  it('surfaces a fire-and-forget observer failure from drain once (tmux-play-111)', async () => {
    const dispatcher = new RecordDispatcher();
    const seen: string[] = [];

    dispatcher.addObserver({
      onRecord(record) {
        if (record.type === 'captain_status') {
          throw new Error('status observer failed');
        }
      },
    });
    dispatcher.addObserver({
      onRecord(record) {
        seen.push(record.type);
      },
    });

    void dispatcher.emitStatus(status('bad'));
    const queued = dispatcher.emit(turnFinished());

    await expect(dispatcher.drain()).rejects.toThrow(ObserverDispatchError);
    await expect(queued).resolves.toBeUndefined();
    await expect(dispatcher.drain()).resolves.toBeUndefined();
    expect(seen).toEqual(['captain_status', 'runtime_error', 'turn_finished']);
  });

  it('supports observer unsubscription', async () => {
    const dispatcher = new RecordDispatcher();
    const seen: string[] = [];
    const observer: RecordObserver = {
      onRecord(record) {
        seen.push(record.type);
      },
    };

    const unsubscribe = dispatcher.addObserver(observer);
    unsubscribe();
    await dispatcher.emit(turnStarted());

    expect(seen).toEqual([]);
  });
});
