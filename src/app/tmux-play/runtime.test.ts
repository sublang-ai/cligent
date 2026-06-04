// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createEvent } from '../../events.js';
import type { AgentAdapter, AgentEvent, AgentOptions } from '../../types.js';
import type { Captain, CaptainSession, PlayerRunResult } from './contract.js';
import type { TmuxPlayRecord } from './records.js';
import type { PlayerAdapterImports, PlayerAdapterName } from './players.js';
import { createTmuxPlayRuntime } from './runtime.js';

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
        reasoningEffort: 'high',
      },
      players: [
        {
          id: 'coder',
          adapter: 'codex',
          instruction: 'Player instruction.',
          reasoningEffort: 'low',
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
            expect(options?.reasoningEffort).toBe('low');
            yield textEvent('codex', 'player text');
            yield doneEvent('codex', 'player done');
          },
        },
        claude: {
          agent: 'claude-code',
          async *run(prompt, options) {
            prompts.push(prompt);
            expect(options?.reasoningEffort).toBe('high');
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
});
