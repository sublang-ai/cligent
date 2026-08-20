// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';
import { createEvent } from '../../events.js';
import { isPermissionPolicyReset } from '../../internal/permission-reset.js';
import type { AgentAdapter, AgentEvent, AgentOptions } from '../../types.js';
import {
  AgentCallSettingsError,
  isAgentCallSettingsError,
} from './contract.js';
import type {
  Captain,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  PlayerRunResult,
} from './contract.js';
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
  scripts: Partial<
    Record<PlayerAdapterName, { agent: string; run: RunScript }>
  >,
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
    kimi: async () => {
      const script = scripts.kimi ?? fallback;
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
      usage: {
        toolUses: 0,
      },
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

async function expectAgentCallSettingsRejection(
  call: Promise<unknown>,
  diagnostic: string,
): Promise<void> {
  const rejection = await call.catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(AgentCallSettingsError);
  expect(isAgentCallSettingsError(rejection)).toBe(true);
  expect(rejection).toMatchObject({
    message: expect.stringContaining(diagnostic),
    cause: expect.objectContaining({
      message: expect.stringContaining(diagnostic),
    }),
  });
}

describe('TmuxPlayRuntime', () => {
  it('separates whole captured messages when done brings no result', async () => {
    let playerResult: PlayerRunResult | undefined;
    const captain: Captain = {
      async handleBossTurn(turn, context) {
        playerResult = await context.callPlayer('coder', turn.prompt);
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run() {
            yield textEvent('codex', 'Reworked the small packages.');
            yield textEvent('codex', 'Commit: abc123');
            yield doneEvent('codex', undefined);
          },
        },
        claude: {
          agent: 'claude-code',
          async *run() {
            yield doneEvent('claude-code', 'unused');
          },
        },
      }),
    });

    await runtime.runBossTurn('feature');

    expect(playerResult?.status).toBe('ok');
    expect(playerResult?.finalText).toBe(
      'Reworked the small packages.\nCommit: abc123',
    );
    const commitLines = playerResult?.finalText
      ?.split('\n')
      .filter((line) => line.startsWith('Commit: '));
    expect(commitLines).toEqual(['Commit: abc123']);
  });

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

  it.each([
    ['claude', 'claude-code', 'high', false],
    ['codex', 'codex', 'high', 'existing-session'],
    ['gemini', 'gemini', 'high', 'existing-session'],
    ['kimi', 'kimi', 'on', false],
  ] as const)(
    'forwards explicit provider defaults to %s by omitting configured tuning',
    async (adapter, agent, configuredEffort, resume) => {
      const observed: Array<AgentOptions | undefined> = [];
      const captain: Captain = {
        async handleBossTurn(_turn, context) {
          await context.callPlayer('dev.worker', 'work', {
            resume,
            settings: {
              model: { kind: 'provider-default' },
              effort: { kind: 'provider-default' },
            },
          });
        },
      };
      const runtime = await createTmuxPlayRuntime({
        captain,
        captainConfig: { adapter: 'claude' },
        players: [
          {
            id: 'dev.worker',
            adapter,
            model: 'configured-model',
            effort: configuredEffort,
            instruction: 'Configured instruction.',
            permissions: { mode: 'auto' },
          },
        ] as never,
        adapterImports: adapterImports({
          [adapter]: {
            agent,
            async *run(prompt, options) {
              observed.push(options);
              expect(prompt).toBe('work');
              yield doneEvent(agent, 'done', 'success', 'next-session');
            },
          },
        }),
      });

      await runtime.runBossTurn('go');

      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        resume: resume === false ? undefined : resume,
      });
      expect(observed[0]?.model).toBeUndefined();
      expect(observed[0]?.effort).toBeUndefined();
      expect(observed[0]?.permissions).toBeUndefined();
    },
  );

  it('keeps one resume selection when a terminal observer reenters the same player', async () => {
    const observed: Array<{
      prompt: string;
      options: AgentOptions | undefined;
    }> = [];
    let context!: CaptainContext;
    let reentrantCall: Promise<PlayerRunResult> | undefined;
    const runtime = await createTmuxPlayRuntime({
      captain: {
        async handleBossTurn(_turn, currentContext) {
          context = currentContext;
          await context.callPlayer('dev.kimi', 'seed');
          if (!reentrantCall) throw new Error('observer did not reenter');
          await reentrantCall;
        },
      },
      captainConfig: { adapter: 'claude' },
      players: [
        {
          id: 'dev.kimi',
          adapter: 'kimi',
          model: 'kimi-configured',
          effort: 'on',
          permissions: { mode: 'auto' },
        },
      ],
      observers: [
        {
          onRecord(record) {
            if (
              reentrantCall === undefined &&
              record.type === 'player_event' &&
              record.event.type === 'done'
            ) {
              reentrantCall = context.callPlayer(
                'dev.kimi',
                'provider defaults',
                {
                  settings: {
                    model: { kind: 'provider-default' },
                    effort: { kind: 'provider-default' },
                  },
                },
              );
            }
          },
        },
      ],
      adapterImports: adapterImports({
        kimi: {
          agent: 'kimi',
          async *run(prompt, options) {
            observed.push({ prompt, options });
            yield doneEvent('kimi', 'done', 'success', 'kimi-session');
          },
        },
      }),
    });

    await runtime.runBossTurn('go');

    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({
      prompt: 'seed',
      options: {
        resume: undefined,
        model: 'kimi-configured',
        effort: 'on',
        permissions: { mode: 'auto' },
      },
    });
    expect(observed[1]).toMatchObject({
      prompt: 'provider defaults',
      options: {
        resume: undefined,
        model: undefined,
        effort: undefined,
        permissions: undefined,
      },
    });
  });

  it('fails closed for a resumed Claude default-model reset before records and preserves continuity', async () => {
    const records: TmuxPlayRecord[] = [];
    const observed: AgentOptions[] = [];
    const runtime = await createTmuxPlayRuntime({
      captain: {
        async handleBossTurn(_turn, context) {
          await context.callPlayer('dev.worker', 'seed');
          await expectAgentCallSettingsRejection(
            context.callPlayer('dev.worker', 'reset model', {
              settings: {
                model: { kind: 'provider-default' },
                effort: { kind: 'provider-default' },
              },
            }),
            'Claude cannot restore the provider-default model on a resumed session',
          );
          await context.callPlayer('dev.worker', 'continue');
        },
      },
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'dev.worker', adapter: 'claude' }],
      observers: [{ onRecord: (record) => records.push(record) }],
      adapterImports: adapterImports({
        claude: {
          agent: 'claude-code',
          async *run(_prompt, options) {
            observed.push(options ?? {});
            yield doneEvent(
              'claude-code',
              'done',
              'success',
              'kept-claude-session',
            );
          },
        },
      }),
    });

    await runtime.runBossTurn('go');

    expect(observed).toHaveLength(2);
    expect(observed[1]).toMatchObject({ resume: 'kept-claude-session' });
    expect(
      records
        .filter((record) => record.type === 'player_prompt')
        .map((record) => record.prompt),
    ).toEqual(['seed', 'continue']);
  });

  it('fails closed for resumed OpenCode default-model reset and clears omitted permissions with a concrete model', async () => {
    const records: TmuxPlayRecord[] = [];
    const observed: AgentOptions[] = [];
    const runtime = await createTmuxPlayRuntime({
      captain: {
        async handleBossTurn(_turn, context) {
          await context.callPlayer('dev.worker', 'install policy', {
            settings: {
              model: { kind: 'value', value: 'openai/gpt-5' },
              effort: { kind: 'value', value: 'high' },
              permissions: { mode: 'auto', fileWrite: 'allow' },
            },
          });
          await context.callPlayer('dev.worker', 'preserve configured policy');
          await expectAgentCallSettingsRejection(
            context.callPlayer('dev.worker', 'reset model', {
              settings: {
                model: { kind: 'provider-default' },
                effort: { kind: 'provider-default' },
              },
            }),
            'OpenCode cannot restore the provider-default model on a resumed session',
          );
          await context.callPlayer('dev.worker', 'clear policy', {
            settings: {
              model: { kind: 'value', value: 'openai/gpt-5' },
              effort: { kind: 'provider-default' },
            },
          });
        },
      },
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'dev.worker', adapter: 'opencode' }],
      observers: [{ onRecord: (record) => records.push(record) }],
      adapterImports: adapterImports({
        opencode: {
          agent: 'opencode',
          async *run(_prompt, options) {
            observed.push(options ?? {});
            yield doneEvent(
              'opencode',
              'done',
              'success',
              'kept-opencode-session',
            );
          },
        },
      }),
    });

    await runtime.runBossTurn('go');

    expect(observed).toHaveLength(3);
    expect(observed[1]).toMatchObject({
      resume: 'kept-opencode-session',
      permissions: undefined,
    });
    expect(isPermissionPolicyReset(observed[1]?.permissions)).toBe(false);
    expect(observed[2]).toMatchObject({
      resume: 'kept-opencode-session',
      model: 'openai/gpt-5',
      effort: undefined,
    });
    expect(isPermissionPolicyReset(observed[2]?.permissions)).toBe(true);
    expect(
      records
        .filter((record) => record.type === 'player_prompt')
        .map((record) => record.prompt),
    ).toEqual(['install policy', 'preserve configured policy', 'clear policy']);
  });

  it('snapshots complete player and Captain settings without merging configured values', async () => {
    const observed: Array<{
      prompt: string;
      options: AgentOptions | undefined;
    }> = [];
    const playerPermissions = {
      fileWrite: 'allow' as const,
      writablePaths: ['generated'],
    };
    const playerSettings = {
      model: { kind: 'value' as const, value: 'codex-current' },
      effort: { kind: 'value' as const, value: 'xhigh' as const },
      instruction: 'Current player instruction.',
      permissions: playerPermissions,
    };
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        const playerCall = context.callPlayer('dev.coder', 'implement', {
          settings: playerSettings,
        });
        playerSettings.model.value = 'mutated-model';
        playerPermissions.writablePaths.push('mutated');
        await playerCall;

        await context.callCaptain('summarize', {
          settings: {
            model: { kind: 'value', value: 'claude-current' },
            effort: { kind: 'value', value: 'high' },
          },
        });
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: {
        adapter: 'claude',
        model: 'claude-configured',
        effort: 'ultracode',
        instruction: 'Configured Captain instruction.',
        permissions: { mode: 'auto' },
      },
      players: [
        {
          id: 'dev.coder',
          adapter: 'codex',
          model: 'codex-configured',
          effort: 'ultra',
          instruction: 'Configured player instruction.',
          permissions: { mode: 'auto' },
        },
      ],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run(prompt, options) {
            observed.push({ prompt, options });
            yield doneEvent('codex', 'done');
          },
        },
        claude: {
          agent: 'claude-code',
          async *run(prompt, options) {
            observed.push({ prompt, options });
            yield doneEvent('claude-code', 'done');
          },
        },
      }),
    });

    await runtime.runBossTurn('go');

    expect(observed).toEqual([
      {
        prompt: 'Current player instruction.\n\nimplement',
        options: expect.objectContaining({
          model: 'codex-current',
          effort: 'xhigh',
          permissions: {
            fileWrite: 'allow',
            writablePaths: ['generated'],
          },
        }),
      },
      {
        prompt: 'summarize',
        options: expect.objectContaining({
          model: 'claude-current',
          effort: 'high',
          permissions: undefined,
        }),
      },
    ]);
  });

  it('returns to configured settings after a complete provider-default player call', async () => {
    const observed: Array<{
      prompt: string;
      options: AgentOptions | undefined;
    }> = [];
    const runtime = await createTmuxPlayRuntime({
      captain: {
        async handleBossTurn(_turn, context) {
          await context.callPlayer('dev.coder', 'configured first');
          await context.callPlayer('dev.coder', 'provider defaults', {
            settings: {
              model: { kind: 'provider-default' },
              effort: { kind: 'provider-default' },
            },
          });
          await context.callPlayer('dev.coder', 'configured again');
        },
      },
      captainConfig: { adapter: 'claude' },
      players: [
        {
          id: 'dev.coder',
          adapter: 'codex',
          model: 'gpt-5.6-codex',
          effort: 'high',
          instruction: 'Configured instruction.',
          permissions: { mode: 'auto' },
        },
      ],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run(prompt, options) {
            observed.push({ prompt, options });
            yield doneEvent(
              'codex',
              'done',
              'success',
              `codex-session-${observed.length}`,
            );
          },
        },
      }),
    });

    await runtime.runBossTurn('go');

    expect(observed).toEqual([
      {
        prompt: 'Configured instruction.\n\nconfigured first',
        options: expect.objectContaining({
          resume: undefined,
          model: 'gpt-5.6-codex',
          effort: 'high',
          permissions: { mode: 'auto' },
        }),
      },
      {
        prompt: 'provider defaults',
        options: expect.objectContaining({
          resume: 'codex-session-1',
          model: undefined,
          effort: undefined,
          permissions: undefined,
        }),
      },
      {
        prompt: 'Configured instruction.\n\nconfigured again',
        options: expect.objectContaining({
          resume: 'codex-session-2',
          model: 'gpt-5.6-codex',
          effort: 'high',
          permissions: { mode: 'auto' },
        }),
      },
    ]);
  });

  it.each([
    [
      'unknown fields',
      {
        model: { kind: 'value', value: 'gpt-5.6-codex' },
        effort: { kind: 'value', value: 'high' },
        extra: true,
      },
      'unknown field "extra"',
    ],
    [
      'a missing model selection',
      { effort: { kind: 'value', value: 'high' } },
      'model must be a tuning selection',
    ],
    [
      'an incomplete effort selection',
      {
        model: { kind: 'value', value: 'gpt-5.6-codex' },
        effort: { kind: 'value' },
      },
      'effort must select a non-empty value or provider-default',
    ],
  ])(
    'rejects complete settings with %s as a typed preflight failure',
    async (_case, settings, diagnostic) => {
      const records: TmuxPlayRecord[] = [];
      let providerRuns = 0;
      const runtime = await createTmuxPlayRuntime({
        captain: {
          async handleBossTurn(_turn, context) {
            await expectAgentCallSettingsRejection(
              context.callPlayer('dev.coder', 'work', {
                settings: settings as never,
              }),
              diagnostic,
            );
          },
        },
        captainConfig: { adapter: 'claude' },
        players: [{ id: 'dev.coder', adapter: 'codex' }],
        observers: [{ onRecord: (record) => records.push(record) }],
        adapterImports: adapterImports({
          codex: {
            agent: 'codex',
            async *run() {
              providerRuns += 1;
              yield doneEvent('codex', 'done');
            },
          },
        }),
      });

      await runtime.runBossTurn('go');

      expect(providerRuns).toBe(0);
      expect(records.some((record) => record.type === 'player_prompt')).toBe(
        false,
      );
    },
  );

  it('rejects accessor-backed complete settings before a prompt record or provider run', async () => {
    const records: TmuxPlayRecord[] = [];
    let providerRuns = 0;
    let rejection: unknown;
    const settings = Object.defineProperty(
      {
        effort: { kind: 'value' as const, value: 'high' as const },
      },
      'model',
      {
        enumerable: true,
        get() {
          return { kind: 'value', value: 'gpt-5.6-codex' };
        },
      },
    );
    const runtime = await createTmuxPlayRuntime({
      captain: {
        async handleBossTurn(_turn, context) {
          rejection = await context
            .callPlayer('dev.coder', 'work', { settings })
            .catch((error: unknown) => error);
        },
      },
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'dev.coder', adapter: 'codex' }],
      observers: [{ onRecord: (record) => records.push(record) }],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run() {
            providerRuns += 1;
            yield doneEvent('codex', 'done');
          },
        },
      }),
    });

    await runtime.runBossTurn('go');

    expect(rejection).toBeInstanceOf(AgentCallSettingsError);
    expect(isAgentCallSettingsError(rejection)).toBe(true);
    expect(rejection).toMatchObject({
      message: expect.stringContaining('model must not be an accessor'),
      cause: expect.objectContaining({
        name: 'TypeError',
        message: expect.stringContaining('model must not be an accessor'),
      }),
    });
    expect(providerRuns).toBe(0);
    expect(records.some((record) => record.type === 'player_prompt')).toBe(
      false,
    );
  });

  it('classifies only complete-settings preflight rejections', async () => {
    const records: TmuxPlayRecord[] = [];
    let captainRejection: unknown;
    let unknownPlayerRejection: unknown;
    let providerResult: PlayerRunResult | undefined;
    const runtime = await createTmuxPlayRuntime({
      captain: {
        async handleBossTurn(_turn, context) {
          captainRejection = await context
            .callCaptain('invalid tuning', {
              settings: {
                model: { kind: 'value', value: 'claude-opus-5' },
                effort: { kind: 'value', value: 'invalid' },
              } as never,
            })
            .catch((error: unknown) => error);
          unknownPlayerRejection = await context
            .callPlayer('missing', 'invalid route', {
              settings: {} as never,
            })
            .catch((error: unknown) => error);
          providerResult = await context.callPlayer(
            'dev.coder',
            'provider failure',
          );
        },
      },
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'dev.coder', adapter: 'codex' }],
      observers: [{ onRecord: (record) => records.push(record) }],
      adapterImports: adapterImports({
        claude: {
          agent: 'claude-code',
          async *run() {
            yield doneEvent('claude-code', 'unused');
          },
        },
        codex: {
          agent: 'codex',
          async *run() {
            throw new Error('provider failed');
          },
        },
      }),
    });

    await runtime.runBossTurn('go');

    expect(captainRejection).toBeInstanceOf(AgentCallSettingsError);
    expect(isAgentCallSettingsError(captainRejection)).toBe(true);
    expect(captainRejection).toMatchObject({
      message:
        'Unsupported claude-code effort "invalid" in tmux-play call settings',
      cause: expect.objectContaining({
        message:
          'Unsupported claude-code effort "invalid" in tmux-play call settings',
      }),
    });
    expect(isAgentCallSettingsError(unknownPlayerRejection)).toBe(false);
    expect(unknownPlayerRejection).toMatchObject({
      message: 'Unknown player: missing',
    });
    expect(providerResult).toMatchObject({
      status: 'error',
      error: 'provider failed',
    });
    expect(isAgentCallSettingsError(providerResult)).toBe(false);
    expect(
      records
        .filter((record) => record.type === 'player_prompt')
        .map((record) => record.prompt),
    ).toEqual(['provider failure']);
    expect(records.some((record) => record.type === 'captain_prompt')).toBe(
      false,
    );
  });

  it('rejects unsupported Kimi resume resets and un-enforceable effort mappings before records or provider work', async () => {
    const records: TmuxPlayRecord[] = [];
    const kimiOptions: AgentOptions[] = [];
    let geminiRuns = 0;
    let openCodeRuns = 0;
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        await context.callPlayer('dev.kimi', 'first');
        await expectAgentCallSettingsRejection(
          context.callPlayer('dev.kimi', 'reset', {
            settings: {
              model: { kind: 'provider-default' },
              effort: { kind: 'provider-default' },
            },
          }),
          'Kimi cannot restore provider-default',
        );
        await expectAgentCallSettingsRejection(
          context.callPlayer('dev.kimi', 'reset permissions', {
            settings: {
              model: { kind: 'value', value: 'kimi-k2-current' },
              effort: { kind: 'value', value: 'off' },
            },
          }),
          'or permissions on a resumed session',
        );
        await context.callPlayer('dev.kimi', 'retune', {
          settings: {
            model: { kind: 'value', value: 'kimi-k2-current' },
            effort: { kind: 'value', value: 'off' },
            permissions: { mode: 'auto' },
          },
        });
        await expectAgentCallSettingsRejection(
          context.callPlayer('dev.gemini', 'invalid mapping', {
            settings: {
              model: { kind: 'provider-default' },
              effort: { kind: 'value', value: 'high' },
            },
          }),
          'Gemini requires a supported concrete model',
        );
        await expectAgentCallSettingsRejection(
          context.callPlayer('dev.opencode', 'invalid mapping', {
            settings: {
              model: { kind: 'value', value: 'unsupported/model' },
              effort: { kind: 'value', value: 'high' },
            },
          }),
          'OpenCode requires a supported provider/model',
        );
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [
        {
          id: 'dev.kimi',
          adapter: 'kimi',
          model: 'kimi-configured',
          effort: 'on',
        },
        {
          id: 'dev.gemini',
          adapter: 'gemini',
          model: 'gemini-3-pro',
          effort: 'high',
        },
        {
          id: 'dev.opencode',
          adapter: 'opencode',
        },
      ],
      observers: [{ onRecord: (record) => records.push(record) }],
      adapterImports: adapterImports({
        kimi: {
          agent: 'kimi',
          async *run(_prompt, options) {
            kimiOptions.push(options ?? {});
            yield doneEvent('kimi', 'done', 'success', 'kimi-session');
          },
        },
        gemini: {
          agent: 'gemini',
          async *run() {
            geminiRuns += 1;
            yield doneEvent('gemini', 'done');
          },
        },
        opencode: {
          agent: 'opencode',
          async *run() {
            openCodeRuns += 1;
            yield doneEvent('opencode', 'done');
          },
        },
      }),
    });

    await runtime.runBossTurn('go');

    expect(kimiOptions).toHaveLength(2);
    expect(kimiOptions[1]).toMatchObject({
      resume: 'kimi-session',
      model: 'kimi-k2-current',
      effort: 'off',
    });
    expect(geminiRuns).toBe(0);
    expect(openCodeRuns).toBe(0);
    expect(
      records.filter((record) => record.type === 'player_prompt'),
    ).toMatchObject([
      { playerId: 'dev.kimi', prompt: 'first' },
      { playerId: 'dev.kimi', prompt: 'retune' },
    ]);
  });

  it.each([
    ['mode', 'unattended'],
    ['fileWrite', 'sometimes'],
    ['shellExecute', true],
    ['networkAccess', 'prompt'],
    ['writablePaths', ['../outside']],
  ])(
    'rejects invalid complete-settings permission %s before prompt records and provider work',
    async (field, value) => {
      const records: TmuxPlayRecord[] = [];
      let providerRuns = 0;
      const captain: Captain = {
        async handleBossTurn(_turn, context) {
          await expectAgentCallSettingsRejection(
            context.callPlayer('dev.coder', 'work', {
              settings: {
                model: { kind: 'value', value: 'gpt-5.6-codex' },
                effort: { kind: 'value', value: 'high' },
                permissions: { [field]: value } as never,
              },
            }),
            `permissions.${field}`,
          );
        },
      };
      const runtime = await createTmuxPlayRuntime({
        captain,
        captainConfig: { adapter: 'claude' },
        players: [{ id: 'dev.coder', adapter: 'codex' }],
        observers: [{ onRecord: (record) => records.push(record) }],
        adapterImports: adapterImports({
          codex: {
            agent: 'codex',
            async *run() {
              providerRuns += 1;
              yield doneEvent('codex', 'done');
            },
          },
        }),
      });

      await runtime.runBossTurn('go');

      expect(providerRuns).toBe(0);
      expect(records.some((record) => record.type === 'player_prompt')).toBe(
        false,
      );
    },
  );

  it.each([
    [
      'kimi',
      { model: 'kimi-k2', effort: 'on', permissions: {} },
      'requires permissions.mode "auto"',
    ],
    [
      'kimi',
      {
        model: 'kimi-k2',
        effort: 'on',
        permissions: { fileWrite: 'allow' },
      },
      'requires permissions.mode "auto"',
    ],
    [
      'kimi',
      { model: 'kimi-k2', effort: 'on', permissions: { mode: 'bypass' } },
      'yolo mode is not an unchecked bypass',
    ],
    [
      'opencode',
      {
        model: 'openai/gpt-5',
        effort: 'high',
        permissions: { mode: 'bypass' },
      },
      "does not support PermissionPolicy.mode: 'bypass'",
    ],
    [
      'codex',
      {
        model: 'gpt-5.6-codex',
        effort: 'high',
        permissions: { fileWrite: 'deny', writablePaths: ['.git'] },
      },
      'cannot combine non-empty writablePaths with read-only local access',
    ],
  ] as const)(
    'rejects adapter-unenforceable %s permissions before records or provider work without losing continuity',
    async (adapter, invalid, message) => {
      const records: TmuxPlayRecord[] = [];
      const observed: AgentOptions[] = [];
      const agent = adapter === 'kimi' ? 'kimi' : adapter;
      const runtime = await createTmuxPlayRuntime({
        captain: {
          async handleBossTurn(_turn, context) {
            await context.callPlayer('dev.worker', 'first');
            await expectAgentCallSettingsRejection(
              context.callPlayer('dev.worker', 'invalid', {
                settings: {
                  model: { kind: 'value', value: invalid.model },
                  effort: { kind: 'value', value: invalid.effort },
                  permissions: invalid.permissions,
                } as never,
              }),
              message,
            );
            await context.callPlayer('dev.worker', 'after');
          },
        },
        captainConfig: { adapter: 'claude' },
        players: [{ id: 'dev.worker', adapter }] as never,
        observers: [{ onRecord: (record) => records.push(record) }],
        adapterImports: adapterImports({
          [adapter]: {
            agent,
            async *run(_prompt, options) {
              observed.push(options ?? {});
              yield doneEvent(agent, 'done', 'success', 'kept-session');
            },
          },
        } as never),
      });

      await runtime.runBossTurn('go');

      expect(observed).toHaveLength(2);
      expect(observed[1]).toMatchObject({ resume: 'kept-session' });
      expect(
        records
          .filter((record) => record.type === 'player_prompt')
          .map((record) => record.prompt),
      ).toEqual(['first', 'after']);
    },
  );

  it('rejects an accessor-backed writablePaths index without invoking it', async () => {
    const records: TmuxPlayRecord[] = [];
    const indexGetter = vi.fn(() => '../outside');
    const writablePaths: string[] = [];
    Object.defineProperty(writablePaths, '0', {
      enumerable: true,
      configurable: true,
      get: indexGetter,
    });
    writablePaths.length = 1;
    let providerRuns = 0;
    const runtime = await createTmuxPlayRuntime({
      captain: {
        async handleBossTurn(_turn, context) {
          await expectAgentCallSettingsRejection(
            context.callPlayer('dev.coder', 'work', {
              settings: {
                model: { kind: 'value', value: 'gpt-5.6-codex' },
                effort: { kind: 'value', value: 'high' },
                permissions: { writablePaths },
              },
            }),
            'writablePaths[0] must not be an accessor',
          );
        },
      },
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'dev.coder', adapter: 'codex' }],
      observers: [{ onRecord: (record) => records.push(record) }],
      adapterImports: adapterImports({
        codex: {
          agent: 'codex',
          async *run() {
            providerRuns += 1;
            yield doneEvent('codex', 'done');
          },
        },
      }),
    });

    await runtime.runBossTurn('go');

    expect(indexGetter).not.toHaveBeenCalled();
    expect(providerRuns).toBe(0);
    expect(records.some((record) => record.type === 'player_prompt')).toBe(
      false,
    );
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

  it('forwards fresh and tool-restricted Captain call controls', async () => {
    const captured: Array<AgentOptions | undefined> = [];
    const readonlyTools = ['Read'] as const;
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        await context.callCaptain('establish continuity');
        await context.callCaptain('reuse continuity');
        await context.callCaptain('tool-free control', {
          resume: false,
          allowedTools: [],
        });
        await context.callCaptain('restricted control', {
          resume: false,
          allowedTools: readonlyTools,
        });
      },
    };
    let call = 0;
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      adapterImports: adapterImports({
        claude: {
          agent: 'claude-code',
          async *run(_prompt, options) {
            captured.push(options);
            call++;
            yield doneEvent(
              'claude-code',
              `captain ${call}`,
              'success',
              call <= 2 ? 'captain-session' : undefined,
            );
          },
        },
      }),
    });

    await runtime.runBossTurn('route');

    expect(captured).toHaveLength(4);
    expect(captured[0]?.resume).toBeUndefined();
    expect(captured[0]?.allowedTools).toBeUndefined();
    expect(captured[1]?.resume).toBe('captain-session');
    expect(captured[1]?.allowedTools).toBeUndefined();
    expect(captured[2]?.resume).toBeUndefined();
    expect(captured[2]?.allowedTools).toEqual([]);
    expect(captured[3]?.resume).toBeUndefined();
    expect(captured[3]?.allowedTools).toEqual(['Read']);
    expect(captured[3]?.allowedTools).not.toBe(readonlyTools);
  });

  it('passes the Captain call resumeToken through CaptainRunResult and omits it when absent', async () => {
    const records: TmuxPlayRecord[] = [];
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        const withToken = await context.callCaptain('token work');
        // Parity with PlayerRunResult: the terminal done's resumeToken is
        // exposed on the result...
        expect(withToken.status).toBe('ok');
        expect(withToken.resumeToken).toBe('captain-session-token');

        const withoutToken = await context.callCaptain('tokenless work', {
          resume: false,
        });
        // ...and a call whose terminal done carries none omits the field.
        expect(withoutToken.status).toBe('ok');
        expect(withoutToken.resumeToken).toBeUndefined();
        expect('resumeToken' in withoutToken).toBe(false);
      },
    };
    let call = 0;
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
            call++;
            yield doneEvent(
              'claude-code',
              `captain ${call}`,
              'success',
              call === 1 ? 'captain-session-token' : undefined,
            );
          },
        },
      }),
    });

    await runtime.runBossTurn('feature');

    // The captain_finished records carry the same results observers rely on.
    const finished = records.filter(
      (record) => record.type === 'captain_finished',
    );
    expect(finished).toMatchObject([
      { result: { status: 'ok', resumeToken: 'captain-session-token' } },
      { result: { status: 'ok' } },
    ]);
    expect(
      (finished[1] as { result: { resumeToken?: string } }).result.resumeToken,
    ).toBeUndefined();
  });

  it('keeps a fire-and-forget call inside its turn, terminal record last', async () => {
    const records: TmuxPlayRecord[] = [];
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        // Never awaited: handleBossTurn returns while both calls are still
        // running, and the turn owes their records ahead of turn_finished.
        void context.callPlayer('coder', 'go');
        void context.callCaptain('think');
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
          async *run() {
            await new Promise((resolve) => setTimeout(resolve, 20));
            yield doneEvent('codex', 'player done');
          },
        },
      }),
    });

    await runtime.runBossTurn('chat');

    const types = records.map((record) => record.type);
    expect(types).toContain('player_finished');
    expect(types).toContain('captain_finished');
    expect(types[types.length - 1]).toBe('turn_finished');
    expect(
      records.every((record) => record.turnId === null || record.turnId === 1),
    ).toBe(true);
  });

  it('closes admission before a failed turn fires its abort listeners', async () => {
    let fromListener: Promise<unknown> | undefined;
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        // The runtime aborts this signal on the failure path, and abort
        // listeners run synchronously — so this listener is the last thing
        // that could slip a call in behind a Captain run that already ended.
        context.signal.addEventListener('abort', () => {
          fromListener = context.callPlayer('coder', 'from the listener').then(
            () => 'resolved',
            (error: unknown) => error,
          );
        });
        throw new Error('captain exploded');
      },
    };
    const records: TmuxPlayRecord[] = [];
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

    await expect(runtime.runBossTurn('chat')).rejects.toThrow(
      'captain exploded',
    );

    expect(fromListener).toBeDefined();
    const outcome = await fromListener;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('turn-scoped');
    expect(records.some((record) => record.type === 'player_prompt')).toBe(
      false,
    );
  });

  it('closes every turn-scoped surface once the Captain run resumes', async () => {
    const late: Record<string, unknown> = {};
    let stashed: CaptainContext | undefined;
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        stashed = context;
        // Leaves a call in flight, so the records below dispatch while the
        // turn is joining — after admission closed, before the terminal
        // record. Every surface must refuse there, not just the calls.
        void context.callPlayer('coder', 'go');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => {
            if (record.type !== 'player_finished' || !stashed) {
              return;
            }
            const capture = (name: string, promise: Promise<void>): void => {
              late[name] = promise.then(
                () => 'resolved',
                (error: unknown) => error,
              );
            };
            capture('emitReply', stashed.emitReply('late prose'));
            capture('setVisiblePlayers', stashed.setVisiblePlayers(['coder']));
            capture('callPlayer', stashed.callPlayer('coder', 'late'));
            capture('callCaptain', stashed.callCaptain('late'));
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('chat');

    const settled = Object.fromEntries(
      await Promise.all(
        Object.entries(late).map(async ([name, promise]) => [
          name,
          await promise,
        ]),
      ),
    );
    expect(Object.keys(settled).sort()).toEqual([
      'callCaptain',
      'callPlayer',
      'emitReply',
      'setVisiblePlayers',
    ]);
    for (const [name, outcome] of Object.entries(settled)) {
      expect(outcome, `${name} should have rejected`).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain('turn-scoped');
    }
  });

  it('lets an abort unwind a turn joining a fire-and-forget call', async () => {
    const records: TmuxPlayRecord[] = [];
    let playerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      playerStarted = resolve;
    });
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        void context.callPlayer('coder', 'slow work');
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
            playerStarted();
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 5000);
              options?.abortSignal?.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve();
              });
            });
            yield doneEvent('codex', 'player done');
          },
        },
      }),
    });

    const turn = runtime.runBossTurn('chat');
    await started;
    // The join is under way: admission is closed, but the turn must still be
    // reachable or ESC cannot cancel the call it is waiting for.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abortedAt = Date.now();
    runtime.abortActiveTurn('user cancelled');
    await turn;

    expect(Date.now() - abortedAt).toBeLessThan(2000);
    expect(records[records.length - 1]).toMatchObject({
      type: 'turn_aborted',
      turnId: 1,
    });
  }, 20000);

  it('marks a dropped rejecting call handled so the host survives', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const captain: Captain = {
        async handleBossTurn(_turn, context) {
          // Never awaited, and its dispatch fails: tmux-play-22 supports this
          // style, so the rejection must not take the host down.
          void context.callPlayer('coder', 'go');
        },
      };
      const runtime = await createTmuxPlayRuntime({
        captain,
        captainConfig: { adapter: 'claude' },
        players: [{ id: 'coder', adapter: 'codex' }],
        observers: [
          {
            onRecord: (record) => {
              if (record.type === 'player_prompt') {
                throw new Error('observer failed on player_prompt');
              }
            },
          },
        ],
        adapterImports: adapterImports({}),
      });

      await runtime.runBossTurn('chat').catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('still rejects a dropped call to a Captain that awaits it', async () => {
    let observed: unknown;
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        // `handled` must not swallow the rejection for a caller that looks.
        observed = await context
          .callPlayer('coder', 'go')
          .then(() => undefined)
          .catch((error: unknown) => error);
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => {
            if (record.type === 'player_prompt') {
              throw new Error('observer failed on player_prompt');
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('chat').catch(() => {});

    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toContain('observer failed');
    expect(isAgentCallSettingsError(observed)).toBe(false);
  });

  it('emits a turn-bound captain_reply for a context emitReply call', async () => {
    const records: TmuxPlayRecord[] = [];
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        await context.emitReply('Looking into it now.');
        // Fire-and-forget replies drain on the ordered dispatch path before
        // the turn closes, like fire-and-forget status emissions.
        void context.emitReply('Second thought.');
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

    await runtime.runBossTurn('chat');

    expect(records).toMatchObject([
      { type: 'turn_started', turnId: 1 },
      { type: 'captain_reply', turnId: 1, text: 'Looking into it now.' },
      { type: 'captain_reply', turnId: 1, text: 'Second thought.' },
      { type: 'turn_finished', turnId: 1 },
    ]);
  });

  it('rejects emitReply outside its originating turn and emits no record', async () => {
    const records: TmuxPlayRecord[] = [];
    let staleContext!: CaptainContext;
    const captain: Captain = {
      async handleBossTurn(turn, context) {
        if (turn.id === 1) {
          staleContext = context;
          return;
        }
        // A context stashed from an earlier turn is out of scope even while
        // another turn is active...
        await expect(staleContext.emitReply('late')).rejects.toThrow(
          'turn-scoped',
        );
        // ...while the active turn's own context still emits.
        await context.emitReply('current turn reply');
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

    await runtime.runBossTurn('first');
    // Between turns no turn is active: the stashed context rejects.
    await expect(staleContext.emitReply('between turns')).rejects.toThrow(
      'turn-scoped',
    );
    await runtime.runBossTurn('second');
    await runtime.dispose();
    // After shutdown the session gate rejects first, mirroring emitStatus.
    await expect(staleContext.emitReply('after dispose')).rejects.toThrow(
      'tmux-play session emissions are closed',
    );

    const replies = records.filter((record) => record.type === 'captain_reply');
    expect(replies).toMatchObject([{ turnId: 2, text: 'current turn reply' }]);
  });

  it('rejects a stashed emitReply once turn_finished dispatches, keeping the terminal record last', async () => {
    const records: TmuxPlayRecord[] = [];
    let stashedContext!: CaptainContext;
    let lateReply!: Promise<void>;
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        stashedContext = context;
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => {
            records.push(record as TmuxPlayRecord);
            if (record.type === 'turn_finished') {
              // A stashed context firing while the terminal record is being
              // dispatched: from this point no captain_reply may follow the
              // turn's terminal record.
              lateReply = stashedContext.emitReply('escaped');
              lateReply.catch(() => {
                // Settled below; keep the rejection handled either way.
              });
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('chat');
    const outcome = await lateReply.then(
      () => 'emitted',
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );

    // Terminal-last ordering: the trace ends at turn_finished with no record
    // after it, and the late call rejected with the turn-scope error.
    expect(records.map((record) => record.type)).toEqual([
      'turn_started',
      'turn_finished',
    ]);
    expect(outcome).toContain('turn-scoped');
  });

  it('rejects a stashed emitReply once a failed turn dispatches turn_aborted', async () => {
    const records: TmuxPlayRecord[] = [];
    let stashedContext!: CaptainContext;
    let lateReply!: Promise<void>;
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        stashedContext = context;
        throw new Error('boom');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => {
            records.push(record as TmuxPlayRecord);
            if (record.type === 'turn_aborted') {
              lateReply = stashedContext.emitReply('escaped');
              lateReply.catch(() => {
                // Settled below; keep the rejection handled either way.
              });
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    await expect(runtime.runBossTurn('chat')).rejects.toThrow('boom');
    const outcome = await lateReply.then(
      () => 'emitted',
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );

    // The failure path's terminal record is fenced the same way.
    expect(records.map((record) => record.type)).toEqual([
      'turn_started',
      'runtime_error',
      'turn_aborted',
    ]);
    expect(outcome).toContain('turn-scoped');
  });

  it('stamps late session emitStatus/emitTelemetry on the null session lane once the terminal record dispatches', async () => {
    const records: TmuxPlayRecord[] = [];
    let session!: CaptainSession;
    let lateStatus!: Promise<void>;
    let lateTelemetry!: Promise<void>;
    const captain: Captain = {
      async init(captainSession) {
        session = captainSession;
      },
      async handleBossTurn() {
        // A mid-turn emission keeps the active turn's id and drains before
        // the terminal record, exactly as before the unified fence.
        void session.emitStatus('mid-turn');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => {
            records.push(record as TmuxPlayRecord);
            if (record.type === 'turn_finished') {
              // A session emission fired while the terminal record dispatches
              // lands after the turn: tmux-play-17 permits it at any point during
              // the session, and per tmux-play-21 it is outside an active turn,
              // so it stamps turnId null — the session lane, which tmux-play-24
              // dispatches in emission order without a turn boundary. It must
              // not carry the closed turn's id past its terminal record.
              lateStatus = session.emitStatus('late status');
              lateStatus.catch(() => {});
              lateTelemetry = session.emitTelemetry({
                topic: 'late.topic',
                payload: { late: true },
              });
              lateTelemetry.catch(() => {});
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('status');
    await Promise.all([lateStatus, lateTelemetry]);

    expect(records).toMatchObject([
      { type: 'turn_started', turnId: 1 },
      { type: 'captain_status', turnId: 1, message: 'mid-turn' },
      { type: 'turn_finished', turnId: 1 },
      { type: 'captain_status', turnId: null, message: 'late status' },
      { type: 'captain_telemetry', turnId: null, topic: 'late.topic' },
    ]);
  });

  it('stamps a late session setVisiblePlayers null once the terminal record dispatches', async () => {
    const records: TmuxPlayRecord[] = [];
    let session!: CaptainSession;
    let lateView!: Promise<void>;
    const captain: Captain = {
      async init(captainSession) {
        session = captainSession;
      },
      async handleBossTurn() {
        // stash only
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => {
            records.push(record as TmuxPlayRecord);
            if (record.type === 'turn_finished') {
              // The session-scoped surface stays usable between turns per
              // tmux-play-17 / tmux-play-81; once the turn is fenced the call is a
              // between-turns call and stamps turnId null per tmux-play-21.
              lateView = session.setVisiblePlayers(['coder']);
              lateView.catch(() => {});
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('go');
    await lateView;

    expect(records).toMatchObject([
      { type: 'turn_started', turnId: 1 },
      { type: 'turn_finished', turnId: 1 },
      {
        type: 'player_view_changed',
        turnId: null,
        visiblePlayerIds: ['coder'],
      },
    ]);
  });

  it('rejects a stashed context setVisiblePlayers once turn_finished dispatches, keeping the terminal record last', async () => {
    const records: TmuxPlayRecord[] = [];
    let stashedContext!: CaptainContext;
    let lateView!: Promise<void>;
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        stashedContext = context;
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => {
            records.push(record as TmuxPlayRecord);
            if (record.type === 'turn_finished') {
              // The turn-scoped surface shares emitReply's fence: from the
              // terminal dispatch on, the call rejects and emits nothing, so
              // no player_view_changed can trail the terminal record carrying
              // the closed turn's id.
              lateView = stashedContext.setVisiblePlayers(['coder']);
              lateView.catch(() => {});
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('go');
    const outcome = await lateView.then(
      () => 'emitted',
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );

    expect(records.map((record) => record.type)).toEqual([
      'turn_started',
      'turn_finished',
    ]);
    expect(outcome).toContain('turn-scoped');
  });

  it('rejects a stashed context callPlayer once turn_finished dispatches, keeping the terminal record last', async () => {
    const records: TmuxPlayRecord[] = [];
    let stashedContext!: CaptainContext;
    let lateCall!: Promise<PlayerRunResult>;
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        stashedContext = context;
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => {
            records.push(record as TmuxPlayRecord);
            if (record.type === 'turn_finished') {
              // Same ordering class as the emitReply escape: an unfenced call
              // here would run a whole player call after the turn's terminal
              // record, all of its records stamped with the closed turn's id.
              lateCall = stashedContext.callPlayer('coder', 'late work');
              lateCall.catch(() => {});
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('go');
    const outcome = await lateCall.then(
      () => 'ran',
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );

    expect(records.map((record) => record.type)).toEqual([
      'turn_started',
      'turn_finished',
    ]);
    expect(outcome).toContain('turn-scoped');
  });

  it('rejects a stashed context callCaptain once turn_finished dispatches, keeping the terminal record last', async () => {
    const records: TmuxPlayRecord[] = [];
    let stashedContext!: CaptainContext;
    let lateCall!: Promise<CaptainRunResult>;
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        stashedContext = context;
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => {
            records.push(record as TmuxPlayRecord);
            if (record.type === 'turn_finished') {
              lateCall = stashedContext.callCaptain('late control');
              lateCall.catch(() => {});
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    await runtime.runBossTurn('go');
    const outcome = await lateCall.then(
      () => 'ran',
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );

    expect(records.map((record) => record.type)).toEqual([
      'turn_started',
      'turn_finished',
    ]);
    expect(outcome).toContain('turn-scoped');
  });

  it('rejects stashed context calls once a failed turn dispatches turn_aborted', async () => {
    const records: TmuxPlayRecord[] = [];
    let stashedContext!: CaptainContext;
    const outcomes: Promise<string>[] = [];
    const settle = (promise: Promise<unknown>): Promise<string> =>
      promise.then(
        () => 'ran',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
    const captain: Captain = {
      async handleBossTurn(_turn, context) {
        stashedContext = context;
        throw new Error('boom');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [{ id: 'coder', adapter: 'codex' }],
      observers: [
        {
          onRecord: (record) => {
            records.push(record as TmuxPlayRecord);
            if (record.type === 'turn_aborted') {
              // The failure path's terminal record fences every turn-scoped
              // surface, not only emitReply.
              outcomes.push(
                settle(stashedContext.callPlayer('coder', 'late work')),
                settle(stashedContext.callCaptain('late control')),
                settle(stashedContext.setVisiblePlayers(['coder'])),
              );
            }
          },
        },
      ],
      adapterImports: adapterImports({}),
    });

    await expect(runtime.runBossTurn('go')).rejects.toThrow('boom');
    const settled = await Promise.all(outcomes);

    expect(records.map((record) => record.type)).toEqual([
      'turn_started',
      'runtime_error',
      'turn_aborted',
    ]);
    expect(settled).toHaveLength(3);
    for (const outcome of settled) {
      expect(outcome).toContain('turn-scoped');
    }
  });

  it('rejects stale-context calls outside their originating turn and after shutdown', async () => {
    const records: TmuxPlayRecord[] = [];
    let staleContext!: CaptainContext;
    const captain: Captain = {
      async handleBossTurn(turn, context) {
        if (turn.id === 1) {
          staleContext = context;
          return;
        }
        // A context stashed from an earlier turn is out of scope even while
        // another turn is active: without the identity check its records
        // would emit into turn 2 stamped with turn 1's id...
        await expect(
          staleContext.callPlayer('coder', 'stale work'),
        ).rejects.toThrow('turn-scoped');
        await expect(staleContext.callCaptain('stale control')).rejects.toThrow(
          'turn-scoped',
        );
        await expect(staleContext.setVisiblePlayers(['coder'])).rejects.toThrow(
          'turn-scoped',
        );
        // ...while the active turn's own context still works.
        await context.setVisiblePlayers(['coder']);
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

    await runtime.runBossTurn('first');
    // Between turns no turn is active: the stashed context rejects.
    await expect(
      staleContext.callPlayer('coder', 'between turns'),
    ).rejects.toThrow('turn-scoped');
    await expect(staleContext.setVisiblePlayers(['coder'])).rejects.toThrow(
      'turn-scoped',
    );
    await runtime.runBossTurn('second');
    await runtime.dispose();
    // After shutdown the session gate rejects first, mirroring emitStatus.
    await expect(
      staleContext.callPlayer('coder', 'after dispose'),
    ).rejects.toThrow('tmux-play session emissions are closed');
    const closedScopeError = await staleContext
      .callCaptain('after dispose', { settings: {} as never })
      .catch((error: unknown) => error);
    expect(closedScopeError).toMatchObject({
      message: 'tmux-play session emissions are closed',
    });
    expect(isAgentCallSettingsError(closedScopeError)).toBe(false);

    const views = records.filter(
      (record) => record.type === 'player_view_changed',
    );
    expect(views).toMatchObject([{ turnId: 2, visiblePlayerIds: ['coder'] }]);
    const playerRecords = records.filter((record) =>
      record.type.startsWith('player_p'),
    );
    expect(playerRecords).toEqual([]);
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

  it('runs prepareDispose once inside the live emission window (tmux-play-186)', async () => {
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

  it('surfaces every hook failure after completing cleanup (tmux-play-186)', async () => {
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

  it('finishes cleanup when a prepareDispose emission loses an observer (tmux-play-186)', async () => {
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

  it('runs live pre-close cleanup after partial initialization fails (tmux-play-186)', async () => {
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

  it('emits one player_view_changed with the active turn id for a CaptainContext call (tmux-play-183)', async () => {
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

  it('carries the active turn id or null for a CaptainSession call by turn state (tmux-play-183)', async () => {
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

  it('runs a Captain-only session with empty manifests and accepted empty visibility records (tmux-play-29, tmux-play-183)', async () => {
    const records: TmuxPlayRecord[] = [];
    let sessionPlayers: readonly { id: string }[] | undefined;
    let contextPlayers: readonly { id: string }[] | undefined;
    const captain: Captain = {
      async init(session) {
        sessionPlayers = session.players.map(({ id }) => ({ id }));
        await session.setVisiblePlayers([]);
      },
      async handleBossTurn(_turn, context) {
        contextPlayers = context.players.map(({ id }) => ({ id }));
        await context.setVisiblePlayers([]);
        const result = await context.callCaptain('work without players');
        expect(result.finalText).toBe('captain-only result');
      },
    };
    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: { adapter: 'claude' },
      players: [],
      observers: [{ onRecord: (record) => records.push(record) }],
      adapterImports: adapterImports({
        claude: {
          agent: 'claude-code',
          async *run(prompt) {
            expect(prompt).toBe('work without players');
            yield textEvent('claude-code', 'captain-only text');
            yield doneEvent('claude-code', 'captain-only result');
          },
        },
      }),
    });

    await runtime.runBossTurn('go');

    expect(sessionPlayers).toEqual([]);
    expect(contextPlayers).toEqual([]);
    const views = records.filter(
      (record): record is PlayerViewChangedRecord =>
        record.type === 'player_view_changed',
    );
    expect(
      views.map(({ turnId, visiblePlayerIds }) => ({
        turnId,
        visiblePlayerIds,
      })),
    ).toEqual([
      { turnId: null, visiblePlayerIds: [] },
      { turnId: 1, visiblePlayerIds: [] },
    ]);
    expect(records.map((record) => record.type)).toEqual([
      'player_view_changed',
      'turn_started',
      'player_view_changed',
      'captain_prompt',
      'captain_event',
      'captain_event',
      'captain_finished',
      'turn_finished',
    ]);
    expect(
      records.some(
        (record) =>
          record.type.startsWith('player_') &&
          record.type !== 'player_view_changed',
      ),
    ).toBe(false);
  });

  it('rejects an invalid setVisiblePlayers without emitting a record and lets the Captain continue (tmux-play-183)', async () => {
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
    expect(errors[0]).toContain(
      'may be empty only when the configured players roster is empty',
    );
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

  it('awaits player_view_changed observers before later player records are emitted (tmux-play-185)', async () => {
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

  it('the presenter, follow, timing, and notification observers ignore player_view_changed (tmux-play-184)', () => {
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
      players: new Map([
        ['coder', { write: (value) => playerWrites.push(value) }],
      ]),
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
