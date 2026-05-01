// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createEvent } from '../../events.js';
import type { AgentAdapter, AgentEvent, AgentOptions } from '../../types.js';
import type { Captain, CaptainSession, RoleRunResult } from './contract.js';
import type { TmuxPlayRecord } from './records.js';
import type { RoleAdapterImports, RoleAdapterName } from './roles.js';
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
  scripts: Partial<Record<RoleAdapterName, { agent: string; run: RunScript }>>,
): RoleAdapterImports {
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
  it('emits causal records around role and Captain calls', async () => {
    const records: TmuxPlayRecord[] = [];
    const prompts: string[] = [];
    const captain: Captain = {
      async handleBossTurn(turn, context) {
        const roleResult = await context.callRole(
          'coder',
          `implement ${turn.prompt}`,
        );
        expect(roleResult.finalText).toBe('role done');

        const captainResult = await context.callCaptain(
          `summarize ${roleResult.finalText}`,
        );
        expect(captainResult.finalText).toBe('captain done');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: {
        adapter: 'claude',
        instruction: 'Captain instruction.',
      },
      roles: [
        {
          id: 'coder',
          adapter: 'codex',
          instruction: 'Role instruction.',
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
          async *run(prompt) {
            prompts.push(prompt);
            yield textEvent('codex', 'role text');
            yield doneEvent('codex', 'role done');
          },
        },
        claude: {
          agent: 'claude-code',
          async *run(prompt) {
            prompts.push(prompt);
            yield textEvent('claude-code', 'captain text');
            yield doneEvent('claude-code', 'captain done');
          },
        },
      }),
    });

    await runtime.runBossTurn('feature');

    expect(records.map((record) => record.type)).toEqual([
      'turn_started',
      'role_prompt',
      'role_event',
      'role_event',
      'role_finished',
      'captain_prompt',
      'captain_event',
      'captain_event',
      'captain_finished',
      'turn_finished',
    ]);
    expect(prompts).toEqual([
      'Role instruction.\n\nimplement feature',
      'Captain instruction.\n\nsummarize role done',
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
      roles: [{ id: 'coder', adapter: 'codex' }],
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

  it('keeps role and Captain Cligents across turns', async () => {
    const roleResumes: (string | undefined)[] = [];
    const captainResumes: (string | undefined)[] = [];
    let roleRuns = 0;
    let captainRuns = 0;
    const captain: Captain = {
      async handleBossTurn(turn, context) {
        await context.callRole('coder', `role ${turn.prompt}`);
        await context.callCaptain(`captain ${turn.prompt}`);
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      roles: [{ id: 'coder', adapter: 'codex' }],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run(_prompt, options) {
            roleResumes.push(options?.resume);
            roleRuns += 1;
            yield doneEvent('codex', `role ${roleRuns}`, 'success', 'role-token');
          },
        },
        claude: {
          agent: 'claude-code',
          async *run(_prompt, options) {
            captainResumes.push(options?.resume);
            captainRuns += 1;
            yield doneEvent(
              'claude-code',
              `captain ${captainRuns}`,
              'success',
              'captain-token',
            );
          },
        },
      }),
    });

    await runtime.runBossTurn('one');
    await runtime.runBossTurn('two');

    expect(roleResumes).toEqual([undefined, 'role-token']);
    expect(captainResumes).toEqual([undefined, 'captain-token']);
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
      roles: [{ id: 'coder', adapter: 'codex' }],
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
      roles: [{ id: 'coder', adapter: 'codex' }],
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

  it('binds role calls to the active turn abort signal', async () => {
    const records: TmuxPlayRecord[] = [];
    const roleStarted = deferred<AbortSignal | undefined>();
    const roleResults: RoleRunResult[] = [];
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        roleResults.push(await context.callRole('coder', 'slow work'));
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      roles: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => records.push(record as TmuxPlayRecord),
        },
      ],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run(_prompt, options) {
            roleStarted.resolve(options?.abortSignal);
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
    const signal = await roleStarted.promise;
    expect(signal?.aborted).toBe(false);

    runtime.abortActiveTurn('stop now');
    await running;

    expect(roleResults).toMatchObject([{ status: 'aborted' }]);
    expect(records.map((record) => record.type)).toEqual([
      'turn_started',
      'role_prompt',
      'role_event',
      'role_finished',
      'turn_aborted',
    ]);
    expect(records[records.length - 1]).toMatchObject({
      type: 'turn_aborted',
      reason: 'stop now',
    });
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
      roles: [{ id: 'coder', adapter: 'codex' }],
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
      roles: [{ id: 'coder', adapter: 'codex' }],
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
      roles: [{ id: 'coder', adapter: 'codex' }],
      adapterImports: adapterImports({}),
    });

    await runtime.dispose();

    expect(order).toEqual(['session-aborted', 'dispose']);
  });
});
