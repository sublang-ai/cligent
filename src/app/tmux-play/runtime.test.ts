// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';
import { createEvent } from '../../events.js';
import type { AgentAdapter, AgentEvent, AgentOptions } from '../../types.js';
import type { Captain, CaptainSession, PlayerRunResult } from './contract.js';
import type { PlayerViewChangedRecord, TmuxPlayRecord } from './records.js';
import type { PlayerAdapterImports, PlayerAdapterName } from './players.js';
import { createTmuxPlayRuntime } from './runtime.js';
import { createTmuxPresenter } from './presenter-tmux.js';
import { createFollowObserver } from './follow-observer.js';
import { createTimingObserver } from './timing-observer.js';
import {
  createNotificationObserver,
  type DetachedNotificationSpawner,
} from './notification-observer.js';

type RunScript = (
  prompt: string,
  options?: AgentOptions,
) => AsyncGenerator<AgentEvent, void, void>;

function adapterClass(
  agent: string,
  runScript: RunScript,
): new () => AgentAdapter {
  return class implements AgentAdapter {
    readonly agent = agent;

    run(
      prompt: string,
      options?: AgentOptions,
    ): AsyncGenerator<AgentEvent, void, void> {
      return runScript(prompt, options);
    }

    async isAvailable(): Promise<boolean> {
      return true;
    }
  };
}

function adapterImports(
  scripts: Partial<Record<PlayerAdapterName, { agent: string; run: RunScript }>>,
): PlayerAdapterImports {
  const fallback: { agent: string; run: RunScript } = {
    agent: 'test-agent',
    async *run() {
      yield doneEvent('test-agent', 'unused');
    },
  };

  return {
    claude: async () => {
      const script = scripts.claude ?? fallback;
      return adapterClass(script.agent, script.run);
    },
    codex: async () => {
      const script = scripts.codex ?? fallback;
      return adapterClass(script.agent, script.run);
    },
    gemini: async () => {
      const script = scripts.gemini ?? fallback;
      return adapterClass(script.agent, script.run);
    },
    opencode: async () => {
      const script = scripts.opencode ?? fallback;
      return adapterClass(script.agent, script.run);
    },
  };
}

function textEvent(agent: string, content: string): AgentEvent {
  return createEvent('text', agent, { content }, 'sid');
}

function doneEvent(
  agent: string,
  result: string | undefined,
  status: 'success' | 'error' | 'interrupted' = 'success',
  resumeToken?: string,
): AgentEvent {
  return createEvent(
    'done',
    agent,
    {
      status,
      result,
      resumeToken,
      usage: { inputTokens: 1, outputTokens: 1, toolUses: 0 },
      durationMs: 1,
    },
    'sid',
  );
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('TmuxPlayRuntime', () => {
  it('emits causal records around player and Captain calls', async () => {
    const records: TmuxPlayRecord[] = [];
    const prompts: string[] = [];
    const captain: Captain = {
      async handleBossTurn(turn, context) {
        const playerResult = await context.callPlayer(
          'coder',
          `implement ${turn.prompt}`,
        );
        expect(playerResult.finalText).toBe('player done');

        const captainResult = await context.callCaptain(
          `summarize ${playerResult.finalText}`,
        );
        expect(captainResult.finalText).toBe('captain done');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: {
        adapter: 'claude',
        instruction: 'Captain instruction.',
        effort: 'ultracode',
      },
      players: [
        {
          id: 'coder',
          adapter: 'codex',
          instruction: 'Player instruction.',
          effort: 'ultra',
        },
      ],
      observers: [
        {
          onRecord: (record) => records.push(record as TmuxPlayRecord),
        },
      ],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run(prompt, options) {
            prompts.push(prompt);
            expect(options?.effort).toBe('ultra');
            yield textEvent('codex', 'player text');
            yield doneEvent('codex', 'player done');
          },
        },
        claude: {
          agent: 'claude-code',
          async *run(prompt, options) {
            prompts.push(prompt);
            expect(options?.effort).toBe('ultracode');
            yield textEvent('claude-code', 'captain text');
            yield doneEvent('claude-code', 'captain done');
          },
        },
      }),
    });

    await runtime.runBossTurn('feature');

    expect(records.map((record) => record.type)).toEqual([
      'turn_started',
      'player_prompt',
      'player_event',
      'player_event',
      'player_finished',
      'captain_prompt',
      'captain_event',
      'captain_event',
      'captain_finished',
      'turn_finished',
    ]);
    expect(prompts).toEqual([
      'Player instruction.\n\nimplement feature',
      'Captain instruction.\n\nsummarize player done',
    ]);
  });

  it('tags Captain records with visibility and returns finalText for hidden calls', async () => {
    const records: TmuxPlayRecord[] = [];
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        const visible = await context.callCaptain('visible work');
        expect(visible.finalText).toBe('visible done');

        const hidden = await context.callCaptain('hidden work', {
          visibility: 'hidden',
        });
        // A hidden call runs normally and returns the same result shape.
        expect(hidden.status).toBe('ok');
        expect(hidden.finalText).toBe('hidden done');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => records.push(record as TmuxPlayRecord),
        },
      ],
      adapterImports: adapterImports({
        claude: {
          agent: 'claude-code',
          async *run(prompt) {
            const result = prompt.includes('hidden')
              ? 'hidden done'
              : 'visible done';
            yield textEvent('claude-code', result);
            yield doneEvent('claude-code', result);
          },
        },
      }),
    });

    await runtime.runBossTurn('feature');

    // Non-presenter observers receive the full trace for both calls; the
    // hidden call's records are tagged so the tmux presenter can skip them.
    const captainRecords = records.filter((record) =>
      record.type.startsWith('captain_'),
    );
    expect(captainRecords).toMatchObject([
      { type: 'captain_prompt', visibility: 'visible' },
      { type: 'captain_event', visibility: 'visible' },
      { type: 'captain_event', visibility: 'visible' },
      { type: 'captain_finished', visibility: 'visible' },
      { type: 'captain_prompt', visibility: 'hidden' },
      { type: 'captain_event', visibility: 'hidden' },
      { type: 'captain_event', visibility: 'hidden' },
      { type: 'captain_finished', visibility: 'hidden' },
    ]);
  });

  it('returns an error result and tags records hidden for a failing hidden call', async () => {
    const records: TmuxPlayRecord[] = [];
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        const hidden = await context.callCaptain('hidden work', {
          visibility: 'hidden',
        });
        // A failing hidden call still returns the full result shape — the
        // caller sees the error even though the Boss pane shows nothing.
        expect(hidden.status).toBe('error');
        expect(hidden.error).toBe('boom');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => records.push(record as TmuxPlayRecord),
        },
      ],
      adapterImports: adapterImports({
        claude: {
          agent: 'claude-code',
          async *run() {
            yield textEvent('claude-code', 'partial');
            yield doneEvent('claude-code', 'boom', 'error');
          },
        },
      }),
    });

    await runtime.runBossTurn('feature');

    // The full trace still reaches non-presenter observers, tagged hidden so
    // the tmux presenter and follow observer skip it, and the finished record
    // carries the error status.
    const captainRecords = records.filter((record) =>
      record.type.startsWith('captain_'),
    );
    expect(captainRecords).toMatchObject([
      { type: 'captain_prompt', visibility: 'hidden' },
      { type: 'captain_event', visibility: 'hidden' },
      { type: 'captain_event', visibility: 'hidden' },
      {
        type: 'captain_finished',
        visibility: 'hidden',
        result: { status: 'error', error: 'boom' },
      },
    ]);
  });

  it('serializes Boss turns', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const handled: string[] = [];
    const captain: Captain = {
      async handleBossTurn(turn) {
        handled.push(turn.prompt);
        if (turn.prompt === 'one') {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      adapterImports: adapterImports({}),
    });

    const first = runtime.runBossTurn('one');
    await firstStarted.promise;
    const second = runtime.runBossTurn('two');
    await Promise.resolve();

    expect(handled).toEqual(['one']);
    releaseFirst.resolve();
    await first;
    await second;
    expect(handled).toEqual(['one', 'two']);
  });

  it('reuses player Cligents and passes prior resume tokens across turns', async () => {
    const playerResumes: (string | undefined)[] = [];
    const playerInstanceIds: number[] = [];
    const constructedPlayerInstanceIds: number[] = [];
    let playerRuns = 0;
    const captain: Captain = {
      async handleBossTurn(turn, context) {
        await context.callPlayer('coder', `player ${turn.prompt}`);
      },
    };
    class ContinuityPlayerAdapter implements AgentAdapter {
      readonly agent = 'codex';
      readonly instanceId = constructedPlayerInstanceIds.length + 1;

      constructor() {
        constructedPlayerInstanceIds.push(this.instanceId);
      }

      async *run(
        _prompt: string,
        options?: AgentOptions,
      ): AsyncGenerator<AgentEvent, void, void> {
        playerInstanceIds.push(this.instanceId);
        playerResumes.push(options?.resume);
        playerRuns += 1;
        yield doneEvent(
          'codex',
          `player ${playerRuns}`,
          'success',
          `player-token-${playerRuns}`,
        );
      }

      async isAvailable(): Promise<boolean> {
        return true;
      }
    }
    const imports = adapterImports({});
    imports.codex = async () => ContinuityPlayerAdapter;
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      adapterImports: imports,
    });

    await runtime.runBossTurn('one');
    await runtime.runBossTurn('two');

    expect(constructedPlayerInstanceIds).toEqual([1]);
    expect(playerInstanceIds).toEqual([1, 1]);
    expect(playerResumes).toEqual([undefined, 'player-token-1']);
  });

  it('drains fire-and-forget status before finishing a turn', async () => {
    const statusStarted = deferred();
    const releaseStatus = deferred();
    const seen: string[] = [];
    let session!: CaptainSession;
    const captain: Captain = {
      async init(captainSession) {
        session = captainSession;
      },
      async handleBossTurn() {
        void session.emitStatus('working');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          async onRecord(record) {
            const tmuxPlayRecord = record as TmuxPlayRecord;
            seen.push(`${tmuxPlayRecord.type}:start`);
            if (tmuxPlayRecord.type === 'captain_status') {
              statusStarted.resolve();
              await releaseStatus.promise;
            }
            seen.push(`${tmuxPlayRecord.type}:end`);
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    const run = runtime.runBossTurn('status');
    await statusStarted.promise;

    expect(seen).not.toContain('turn_finished:start');
    releaseStatus.resolve();
    await run;
    expect(seen).toEqual([
      'turn_started:start',
      'turn_started:end',
      'captain_status:start',
      'captain_status:end',
      'turn_finished:start',
      'turn_finished:end',
    ]);
  });

  it('emits init telemetry with null turn id before turns', async () => {
    const records: TmuxPlayRecord[] = [];
    const captain: Captain = {
      async init(session) {
        await session.emitStatus('ready');
        await session.emitTelemetry({
          topic: 'metrics.ready',
          payload: { ok: true },
        });
      },
      async handleBossTurn() {
        // no-op
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => records.push(record),
        },
      ],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('after init');

    expect(records).toMatchObject([
      { type: 'captain_status', turnId: null, message: 'ready' },
      {
        type: 'captain_telemetry',
        turnId: null,
        topic: 'metrics.ready',
        payload: { ok: true },
      },
      { type: 'turn_started', turnId: 1 },
      { type: 'turn_finished', turnId: 1 },
    ]);
  });

  it('binds player calls to the active turn abort signal', async () => {
    const records: TmuxPlayRecord[] = [];
    const playerStarted = deferred<AbortSignal | undefined>();
    const playerResults: PlayerRunResult[] = [];
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        playerResults.push(await context.callPlayer('coder', 'slow work'));
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => records.push(record as TmuxPlayRecord),
        },
      ],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run(_prompt, options) {
            playerStarted.resolve(options?.abortSignal);
            await new Promise<void>((resolve) => {
              options?.abortSignal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
          },
        },
      }),
    });

    const running = runtime.runBossTurn('abort');
    const signal = await playerStarted.promise;
    expect(signal?.aborted).toBe(false);

    runtime.abortActiveTurn('stop now');
    await running;

    expect(playerResults).toMatchObject([{ status: 'aborted' }]);
    expect(records.map((record) => record.type)).toEqual([
      'turn_started',
      'player_prompt',
      'player_event',
      'player_finished',
      'turn_aborted',
    ]);
    expect(records[records.length - 1]).toMatchObject({
      type: 'turn_aborted',
      reason: 'stop now',
    });
  });

  it('lets an explicit player token override runtime auto-resume', async () => {
    const playerResumes: (string | undefined)[] = [];
    let playerRuns = 0;
    const captain: Captain = {
      async handleBossTurn(turn, context) {
        await context.callPlayer(
          'coder',
          `work ${turn.id}`,
          turn.id === 2 ? { resume: 'captain-selected-token' } : undefined,
        );
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run(_prompt, options) {
            playerResumes.push(options?.resume);
            playerRuns += 1;
            yield doneEvent(
              'codex',
              'done',
              'success',
              playerRuns === 1 ? 'runtime-auto-token' : 'selected-next-token',
            );
          },
        },
      }),
    });

    await runtime.runBossTurn('first');
    await runtime.runBossTurn('second');

    expect(playerResumes).toEqual([undefined, 'captain-selected-token']);
  });

  it('lets a Captain force a fresh player session', async () => {
    const playerResumes: (string | undefined)[] = [];
    const playerResults: PlayerRunResult[] = [];
    let playerRuns = 0;
    const captain: Captain = {
      async handleBossTurn(turn, context) {
        playerResults.push(
          await context.callPlayer(
            'coder',
            `work ${turn.id}`,
            turn.id === 2 ? { resume: false } : undefined,
          ),
        );
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run(_prompt, options) {
            playerResumes.push(options?.resume);
            playerRuns += 1;
            yield doneEvent(
              'codex',
              'done',
              'success',
              playerRuns === 1 ? 'stored-token' : 'fresh-token',
            );
          },
        },
      }),
    });

    await runtime.runBossTurn('first');
    await runtime.runBossTurn('second');

    expect(playerResults[0]?.resumeToken).toBe('stored-token');
    expect(playerResumes).toEqual([undefined, undefined]);
  });

  it('resumes a player on the next Boss turn after an ESC-aborted round', async () => {
    const records: TmuxPlayRecord[] = [];
    const playerStarted = deferred();
    const playerResumes: (string | undefined)[] = [];
    const playerResults: PlayerRunResult[] = [];
    let playerRuns = 0;
    const captain: Captain = {
      async handleBossTurn(turn, context) {
        playerResults.push(
          await context.callPlayer('coder', `work ${turn.prompt}`),
        );
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => records.push(record as TmuxPlayRecord),
        },
      ],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run(_prompt, options) {
            playerResumes.push(options?.resume);
            playerRuns += 1;
            if (playerRuns === 1) {
              const abortSeen = options?.abortSignal?.aborted
                ? Promise.resolve()
                : new Promise<void>((resolve) => {
                    options?.abortSignal?.addEventListener('abort', resolve, {
                      once: true,
                    });
                  });
              yield textEvent('codex', 'started');
              playerStarted.resolve();
              await abortSeen;
              yield textEvent('codex', 'flush after abort');
              yield doneEvent(
                'codex',
                undefined,
                'interrupted',
                'player-abort-token',
              );
              return;
            }
            yield doneEvent('codex', 'resumed');
          },
        },
      }),
    });

    const first = runtime.runBossTurn('one');
    await playerStarted.promise;
    runtime.abortActiveTurn('ESC');
    await first;

    await runtime.runBossTurn('two');

    expect(playerResumes).toEqual([undefined, 'player-abort-token']);
    expect(playerResults).toMatchObject([
      { status: 'aborted', resumeToken: 'player-abort-token' },
      { status: 'ok' },
    ]);
    expect(records.map((record) => record.type)).toEqual([
      'turn_started',
      'player_prompt',
      'player_event',
      'player_event',
      'player_finished',
      'turn_aborted',
      'turn_started',
      'player_prompt',
      'player_event',
      'player_finished',
      'turn_finished',
    ]);
    expect(records[5]).toMatchObject({ type: 'turn_aborted', reason: 'ESC' });
  });

  it('exposes a no-token interrupted player result without rewriting prompts', async () => {
    const playerStarted = deferred();
    const playerPrompts: string[] = [];
    const playerResumes: (string | undefined)[] = [];
    const playerResults: PlayerRunResult[] = [];
    let playerRuns = 0;
    const captain: Captain = {
      async handleBossTurn(turn, context) {
        playerResults.push(
          await context.callPlayer('coder', `work ${turn.prompt}`),
        );
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run(prompt, options) {
            playerPrompts.push(prompt);
            playerResumes.push(options?.resume);
            playerRuns += 1;
            if (playerRuns === 1) {
              const abortSeen = options?.abortSignal?.aborted
                ? Promise.resolve()
                : new Promise<void>((resolve) => {
                    options?.abortSignal?.addEventListener('abort', resolve, {
                      once: true,
                    });
                  });
              yield textEvent('codex', 'started');
              playerStarted.resolve();
              await abortSeen;
              yield doneEvent('codex', undefined, 'interrupted');
              return;
            }
            yield doneEvent('codex', 'second');
          },
        },
      }),
    });

    const first = runtime.runBossTurn('one');
    await playerStarted.promise;
    runtime.abortActiveTurn('ESC');
    await first;

    await runtime.runBossTurn('two');

    expect(playerResumes).toEqual([undefined, undefined]);
    expect(playerResults).toMatchObject([
      { status: 'aborted' },
      { status: 'ok' },
    ]);
    expect(playerResults[0].resumeToken).toBeUndefined();
    expect(playerPrompts).toEqual(['work one', 'work two']);
  });

  it('emits runtime_error on Captain failure and disposes once', async () => {
    const records: TmuxPlayRecord[] = [];
    let disposeCount = 0;
    const captain: Captain = {
      async handleBossTurn() {
        throw new Error('captain failed');
      },
      async dispose() {
        disposeCount += 1;
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => records.push(record as TmuxPlayRecord),
        },
      ],
      adapterImports: adapterImports({}),
    });

    await expect(runtime.runBossTurn('fail')).rejects.toThrow('captain failed');
    expect(records).toMatchObject([
      { type: 'turn_started' },
      { type: 'runtime_error', message: 'captain failed' },
      { type: 'turn_aborted', reason: 'captain failed' },
    ]);

    await runtime.dispose();
    await runtime.dispose();
    expect(disposeCount).toBe(1);
    await expect(runtime.runBossTurn('after dispose')).rejects.toThrow(
      'tmux-play runtime is disposed',
    );
  });

  it('still disposes after observer failure', async () => {
    let disposeCount = 0;
    const captain: Captain = {
      async handleBossTurn() {
        // no-op
      },
      async dispose() {
        disposeCount += 1;
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord() {
            throw new Error('observer failed');
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    await expect(runtime.runBossTurn('fail observer')).rejects.toThrow(
      'observer failed',
    );
    await runtime.dispose();

    expect(disposeCount).toBe(1);
  });

  it('aborts the session signal and rejects post-abort emissions before dispose', async () => {
    const order: string[] = [];
    let session!: CaptainSession;
    const captain: Captain = {
      async init(captainSession) {
        session = captainSession;
        session.signal.addEventListener('abort', () => {
          order.push('session-aborted');
        });
      },
      async handleBossTurn() {
        // no-op
      },
      async dispose() {
        order.push('dispose');
        await expect(session.emitStatus('late')).rejects.toThrow(
          'tmux-play session emissions are closed',
        );
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      adapterImports: adapterImports({}),
    });

    await runtime.dispose();

    expect(order).toEqual(['session-aborted', 'dispose']);
  });

  it('runs prepareDispose once inside the live emission window (TTMUX-086)', async () => {
    const order: string[] = [];
    const turnStarted = deferred();
    let session!: CaptainSession;
    let prepareCount = 0;
    let disposeCount = 0;
    const captain: Captain = {
      async init(captainSession) {
        session = captainSession;
        session.signal.addEventListener('abort', () => {
          order.push('session-aborted');
        });
      },
      async handleBossTurn(_turn, context) {
        order.push('turn:start');
        turnStarted.resolve();
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) => {
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        }
        order.push('turn:unwound');
      },
      async prepareDispose() {
        prepareCount += 1;
        order.push('prepare:start');
        expect(session.signal.aborted).toBe(false);
        await session.emitTelemetry({
          topic: 'playbook.trace',
          payload: { type: 'session.disposed' },
        });
        order.push('prepare:end');
      },
      async dispose() {
        disposeCount += 1;
        order.push('dispose');
        expect(session.signal.aborted).toBe(true);
        await expect(
          session.emitTelemetry({ topic: 'late', payload: null }),
        ).rejects.toThrow('tmux-play session emissions are closed');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord(record) {
            if (
              record.type === 'captain_telemetry' &&
              record.topic === 'playbook.trace'
            ) {
              order.push('observer:trace');
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    const turn = runtime.runBossTurn('active');
    await turnStarted.promise;
    const first = runtime.dispose();
    const second = runtime.dispose();
    expect(second).toBe(first);
    await Promise.all([turn, first, second]);
    await runtime.dispose();

    expect(order).toEqual([
      'turn:start',
      'turn:unwound',
      'prepare:start',
      'observer:trace',
      'prepare:end',
      'session-aborted',
      'dispose',
    ]);
    expect(prepareCount).toBe(1);
    expect(disposeCount).toBe(1);
  });

  it('surfaces every hook failure after completing cleanup (TTMUX-086)', async () => {
    const prepareError = new Error('prepare failed');
    const disposeError = new Error('dispose failed');
    const records: TmuxPlayRecord[] = [];
    const order: string[] = [];
    let session!: CaptainSession;
    let prepareCount = 0;
    let disposeCount = 0;
    const captain: Captain = {
      async init(captainSession) {
        session = captainSession;
        session.signal.addEventListener('abort', () => {
          order.push('session-aborted');
        });
      },
      async handleBossTurn() {
        // no-op
      },
      async prepareDispose() {
        prepareCount += 1;
        order.push('prepare');
        throw prepareError;
      },
      async dispose() {
        disposeCount += 1;
        order.push('dispose');
        expect(session.signal.aborted).toBe(true);
        throw disposeError;
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        { onRecord: (record) => records.push(record as TmuxPlayRecord) },
      ],
      adapterImports: adapterImports({}),
    });

    const first = runtime.dispose();
    const failure = await first.catch((error: unknown) => error);
    const repeatedFailure = await runtime
      .dispose()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(repeatedFailure).toBe(failure);
    expect((failure as AggregateError).errors).toEqual([
      prepareError,
      disposeError,
    ]);
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'runtime_error',
        turnId: null,
        message: 'prepare failed',
      }),
    );
    expect(order).toEqual(['prepare', 'session-aborted', 'dispose']);
    expect(prepareCount).toBe(1);
    expect(disposeCount).toBe(1);
  });

  it('finishes cleanup when a prepareDispose emission loses an observer (TTMUX-086)', async () => {
    const remainingRecords: TmuxPlayRecord[] = [];
    const order: string[] = [];
    let session!: CaptainSession;
    let disposeCount = 0;
    const captain: Captain = {
      async init(captainSession) {
        session = captainSession;
        session.signal.addEventListener('abort', () => {
          order.push('session-aborted');
        });
      },
      async handleBossTurn() {
        // no-op
      },
      async prepareDispose() {
        order.push('prepare');
        await session.emitTelemetry({
          topic: 'final',
          payload: { complete: true },
        });
      },
      async dispose() {
        disposeCount += 1;
        order.push('dispose');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord(record) {
            if (record.type === 'captain_telemetry') {
              order.push('observer:failed');
              throw new Error('observer failed during prepare');
            }
          },
        },
        {
          onRecord(record) {
            remainingRecords.push(record as TmuxPlayRecord);
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    const failure = await runtime.dispose().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: 'ObserverDispatchError',
      cause: expect.objectContaining({
        message: 'observer failed during prepare',
      }),
    });
    expect(remainingRecords).toContainEqual(
      expect.objectContaining({
        type: 'runtime_error',
        sourceRecordType: 'captain_telemetry',
        message: 'observer failed during prepare',
      }),
    );
    expect(order).toEqual([
      'prepare',
      'observer:failed',
      'session-aborted',
      'dispose',
    ]);
    expect(session.signal.aborted).toBe(true);
    expect(disposeCount).toBe(1);
  });

  it('runs live pre-close cleanup after partial initialization fails (TTMUX-086)', async () => {
    const initError = new Error('init failed after acquiring resources');
    const records: TmuxPlayRecord[] = [];
    const order: string[] = [];
    let session!: CaptainSession;
    let prepareCount = 0;
    let disposeCount = 0;
    const captain: Captain = {
      async init(captainSession) {
        session = captainSession;
        session.signal.addEventListener('abort', () => {
          order.push('session-aborted');
        });
        order.push('init');
        throw initError;
      },
      async handleBossTurn() {
        // no-op
      },
      async prepareDispose() {
        prepareCount += 1;
        order.push('prepare');
        expect(session.signal.aborted).toBe(false);
        await session.emitTelemetry({
          topic: 'final-after-init-failure',
          payload: { complete: true },
        });
      },
      async dispose() {
        disposeCount += 1;
        order.push('dispose');
        expect(session.signal.aborted).toBe(true);
      },
    };

    const failure = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord(record) {
            records.push(record as TmuxPlayRecord);
            if (record.type === 'runtime_error') {
              order.push('observer:runtime_error');
            } else if (
              record.type === 'captain_telemetry' &&
              record.topic === 'final-after-init-failure'
            ) {
              order.push('observer:final');
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    }).catch((error: unknown) => error);

    expect(failure).toBe(initError);
    expect(records).toMatchObject([
      {
        type: 'runtime_error',
        turnId: null,
        message: 'init failed after acquiring resources',
      },
      {
        type: 'captain_telemetry',
        turnId: null,
        topic: 'final-after-init-failure',
      },
    ]);
    expect(order).toEqual([
      'init',
      'observer:runtime_error',
      'prepare',
      'observer:final',
      'session-aborted',
      'dispose',
    ]);
    expect(prepareCount).toBe(1);
    expect(disposeCount).toBe(1);
  });

  it('emits one player_view_changed with the active turn id for a CaptainContext call (TTMUX-083)', async () => {
    const records: TmuxPlayRecord[] = [];
    let manifest: readonly { id: string }[] = [];
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        await context.setVisiblePlayers(['reviewer', 'coder']);
        manifest = context.players.map((player) => ({ id: player.id }));
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [
        { id: 'coder', adapter: 'codex' },
        { id: 'reviewer', adapter: 'claude' },
      ],
      observers: [{ onRecord: (record) => records.push(record) }],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('go');

    const views = records.filter(
      (record): record is PlayerViewChangedRecord =>
        record.type === 'player_view_changed',
    );
    expect(views).toHaveLength(1);
    expect(views[0]?.visiblePlayerIds).toEqual(['reviewer', 'coder']);
    expect(views[0]?.turnId).toBe(1);
    // The configured roster / players manifest is unchanged by the call.
    expect(manifest).toEqual([{ id: 'coder' }, { id: 'reviewer' }]);
  });

  it('carries the active turn id or null for a CaptainSession call by turn state (TTMUX-083)', async () => {
    const records: TmuxPlayRecord[] = [];
    let session: CaptainSession | undefined;
    const captain: Captain = {
      async init(s) {
        session = s;
        // Between turns (init): no active turn -> turnId null.
        await s.setVisiblePlayers(['coder']);
      },
      async handleBossTurn() {
        // During a turn, via the retained session ref -> active turn id.
        await session?.setVisiblePlayers(['coder', 'reviewer']);
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [
        { id: 'coder', adapter: 'codex' },
        { id: 'reviewer', adapter: 'claude' },
      ],
      observers: [{ onRecord: (record) => records.push(record) }],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('go');

    const views = records.filter(
      (record): record is PlayerViewChangedRecord =>
        record.type === 'player_view_changed',
    );
    expect(views).toHaveLength(2);
    expect(views[0]?.turnId).toBeNull();
    expect(views[0]?.visiblePlayerIds).toEqual(['coder']);
    expect(views[1]?.turnId).toBe(1);
    expect(views[1]?.visiblePlayerIds).toEqual(['coder', 'reviewer']);
  });

  it('rejects an invalid setVisiblePlayers without emitting a record and lets the Captain continue (TTMUX-083)', async () => {
    const records: TmuxPlayRecord[] = [];
    const errors: string[] = [];
    const badInputs: string[][] = [[], ['coder', 'coder'], ['ghost']];
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        for (const bad of badInputs) {
          try {
            await context.setVisiblePlayers(bad);
            errors.push('NO ERROR');
          } catch (error) {
            errors.push((error as Error).message);
          }
        }
        // The Captain continues after catching: a valid call still emits.
        await context.setVisiblePlayers(['coder']);
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [
        { id: 'coder', adapter: 'codex' },
        { id: 'reviewer', adapter: 'claude' },
      ],
      observers: [{ onRecord: (record) => records.push(record) }],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('go');

    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('at least one player');
    expect(errors[1]).toContain('duplicate player id "coder"');
    expect(errors[2]).toContain('unknown player id "ghost"');
    // Only the single valid call produced a record.
    const views = records.filter(
      (record): record is PlayerViewChangedRecord =>
        record.type === 'player_view_changed',
    );
    expect(views).toHaveLength(1);
    expect(views[0]?.visiblePlayerIds).toEqual(['coder']);
  });

  it('awaits player_view_changed observers before later player records are emitted (TTMUX-085)', async () => {
    const order: string[] = [];
    const viewStarted = deferred();
    const rebuildFinished = deferred();
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        order.push('captain:before-set-visible');
        await context.setVisiblePlayers(['reviewer']);
        order.push('captain:after-set-visible');
        await context.callPlayer('reviewer', 'start visible reviewer');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [
        { id: 'coder', adapter: 'codex' },
        { id: 'reviewer', adapter: 'claude' },
      ],
      observers: [
        {
          async onRecord(record) {
            if (record.type === 'player_view_changed') {
              order.push('layout:start');
              viewStarted.resolve(undefined);
              await rebuildFinished.promise;
              order.push('layout:done');
            }
            if (record.type === 'player_prompt') {
              order.push(`player_prompt:${record.playerId}`);
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    const turn = runtime.runBossTurn('go');
    await viewStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(order).toEqual(['captain:before-set-visible', 'layout:start']);

    rebuildFinished.resolve(undefined);
    await turn;

    expect(order).toEqual([
      'captain:before-set-visible',
      'layout:start',
      'layout:done',
      'captain:after-set-visible',
      'player_prompt:reviewer',
    ]);
  });

  it('the presenter, follow, timing, and notification observers ignore player_view_changed (TTMUX-084)', () => {
    const record = (turnId: number | null): PlayerViewChangedRecord => ({
      type: 'player_view_changed',
      turnId,
      timestamp: 0,
      visiblePlayerIds: ['coder', 'reviewer'],
    });

    // Presenter: writes nothing to the Boss or player panes.
    const bossWrites: string[] = [];
    const playerWrites: string[] = [];
    const presenter = createTmuxPresenter({
      boss: { write: (value) => bossWrites.push(value) },
      players: new Map([['coder', { write: (value) => playerWrites.push(value) }]]),
    });

    // Follow: returns no pane to its live tail.
    const followed: string[] = [];
    const follow = createFollowObserver({
      sessionName: 'sess',
      captainAdapter: 'claude',
      players: [{ id: 'coder', adapter: 'codex' }],
      tmux: {
        queryPaneTargetsByTitle: () => new Map(),
        followPane: (target) => followed.push(target),
      },
    });

    // Timing: changes no timer option and starts no interval.
    const timerOps: string[] = [];
    const intervals: number[] = [];
    const timing = createTimingObserver({
      sessionName: 'sess',
      captainAdapter: 'claude',
      players: [{ id: 'coder', adapter: 'codex' }],
      now: () => 0,
      tmux: {
        queryPaneTargetsByTitle: () => new Map(),
        setSessionOption: (_session, option) => timerOps.push(option),
        setPaneOption: (_pane, option) => timerOps.push(option),
      },
      scheduler: {
        setInterval: (_callback, ms) => {
          intervals.push(ms);
          return 0;
        },
        clearInterval: () => undefined,
      },
    });

    // Notification: emits no sound / desktop / terminal BEL.
    const outputWrites: string[] = [];
    const spawnDetached = vi.fn();
    const notification = createNotificationObserver({
      notifications: {
        player_finished: 'bell',
        turn_finished: 'desktop',
        turn_aborted: 'desktop',
      },
      output: {
        write: (value) => {
          outputWrites.push(String(value));
          return true;
        },
      },
      platform: 'darwin',
      spawnDetached: spawnDetached as unknown as DetachedNotificationSpawner,
    });

    for (const observer of [presenter, follow, timing, notification]) {
      observer.onRecord(record(1));
      observer.onRecord(record(null));
    }

    expect(bossWrites).toEqual([]);
    expect(playerWrites).toEqual([]);
    expect(followed).toEqual([]);
    expect(timerOps).toEqual([]);
    expect(intervals).toEqual([]);
    expect(outputWrites).toEqual([]);
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});
