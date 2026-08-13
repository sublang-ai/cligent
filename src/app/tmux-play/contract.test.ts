// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AgentCallSettingsError,
  KNOWN_PLAYER_ADAPTERS,
  createTmuxPlayRuntime,
  isAgentCallSettingsError,
  launchManagedTmuxPlay,
  runManagedTmuxPlaySession,
  type AgentCallSettings,
  type BossTurn,
  type CallCaptainOptions,
  type CallPlayerOptions,
  type Captain,
  type CaptainContext,
  type CaptainRunResult,
  type CaptainSession,
  type CaptainTelemetry,
  type LaunchManagedTmuxPlayOptions,
  type ManagedTmuxPlayAfterTurnContext,
  type ManagedTmuxPlayAttachOptions,
  type ManagedTmuxPlayLaunchContext,
  type ManagedTmuxPlayLifecycle,
  type ManagedTmuxPlaySessionOptions,
  type ManagedTmuxPlayShutdownContext,
  type ManagedTmuxPlayTerminalRecord,
  type PreparedManagedTmuxPlayLaunch,
  type RecordObserver,
  type RuntimeCaptainConfig,
  type PlayerHandle,
  type PlayerRunResult,
  type RunStatus,
  type RunTmuxPlayOptions,
} from './index.js';

describe('tmux-play public contract', () => {
  it('exports a stable complete-settings rejection discriminator', () => {
    const cause = new TypeError('invalid settings');
    const error = new AgentCallSettingsError(cause.message, cause);

    expect(error).toMatchObject({
      name: 'AgentCallSettingsError',
      message: 'invalid settings',
      cause,
    });
    expect(isAgentCallSettingsError(error)).toBe(true);
    expect(isAgentCallSettingsError(new Error('provider failed'))).toBe(false);

    const errorFromAnotherPackageCopy = new Error('invalid settings');
    Object.defineProperty(
      errorFromAnotherPackageCopy,
      Symbol.for('cligent.agentCallSettingsError'),
      { value: true },
    );
    expect(isAgentCallSettingsError(errorFromAnotherPackageCopy)).toBe(true);

    let accessorCalls = 0;
    const accessorMarker = Object.defineProperty(
      new Error('accessor marker'),
      Symbol.for('cligent.agentCallSettingsError'),
      {
        get() {
          accessorCalls += 1;
          return true;
        },
      },
    );
    expect(isAgentCallSettingsError(accessorMarker)).toBe(false);
    expect(accessorCalls).toBe(0);

    const brandedPrototype = Object.defineProperty(
      {},
      Symbol.for('cligent.agentCallSettingsError'),
      { value: true },
    );
    expect(
      isAgentCallSettingsError(Object.create(brandedPrototype) as unknown),
    ).toBe(false);

    const throwingProxy = new Proxy(new Error('proxy marker'), {
      getOwnPropertyDescriptor() {
        throw new Error('proxy trap failed');
      },
    });
    expect(isAgentCallSettingsError(throwingProxy)).toBe(false);
  });

  it('accepts Captain implementations', () => {
    const captain: Captain = {
      async init(session: CaptainSession) {
        expectTypeOf(session.players).toEqualTypeOf<readonly PlayerHandle[]>();
        await session.emitStatus('ready', { phase: 'init' });
        const telemetry: CaptainTelemetry = {
          topic: 'metrics.ready',
          payload: { ok: true },
        };
        await session.emitTelemetry(telemetry);
      },
      async handleBossTurn(turn: BossTurn, context: CaptainContext) {
        expectTypeOf(turn.id).toEqualTypeOf<number>();
        expectTypeOf(context.players).toEqualTypeOf<readonly PlayerHandle[]>();

        const resume: CallPlayerOptions = { resume: 'thread-1' };
        await context.callPlayer('coder', turn.prompt, resume);
        await context.callPlayer('reviewer', turn.prompt, { resume: false });
        const captainControl: CallCaptainOptions = {
          visibility: 'hidden',
          resume: false,
          allowedTools: [] as const,
          settings: {
            model: { kind: 'provider-default' },
            effort: { kind: 'value', value: 'high' },
          },
        };
        await context.callCaptain('summarize', captainControl);
        // TMUX-092: turn-scoped conversational reply — text only, no options.
        await context.emitReply('All players have reported in.');
      },
      async prepareDispose() {
        // no-op
      },
      async dispose() {
        // no-op
      },
    };

    expectTypeOf(captain).toMatchTypeOf<Captain>();
  });

  it('exports runtime API option types', () => {
    expectTypeOf<CallPlayerOptions>().toMatchTypeOf<{
      resume?: string | false;
      settings?: AgentCallSettings;
    }>();
    expectTypeOf<CallCaptainOptions>().toMatchTypeOf<{
      visibility?: 'visible' | 'hidden';
      resume?: string | false;
      allowedTools?: readonly string[];
      settings?: AgentCallSettings;
    }>();
    expectTypeOf<RunTmuxPlayOptions>().toMatchTypeOf<{
      captain: Captain;
      captainConfig: RuntimeCaptainConfig;
      players: readonly PlayerHandle[];
      observers?: readonly RecordObserver[];
      cwd?: string;
      signal?: AbortSignal;
    }>();
    expectTypeOf(createTmuxPlayRuntime).toBeFunction();
    expectTypeOf(launchManagedTmuxPlay).toBeFunction();
    expectTypeOf(runManagedTmuxPlaySession).toBeFunction();
    expectTypeOf<LaunchManagedTmuxPlayOptions>().toMatchTypeOf<{
      sessionId: string;
      createSessionCommand: (...args: never[]) => string | Promise<string>;
      readinessTimeoutMs?: number;
      shutdownTimeoutMs?: number;
    }>();
    expectTypeOf<ManagedTmuxPlayLaunchContext>().toMatchTypeOf<{
      sessionId: string;
      sessionName: string;
      workDir: string;
      snapshotPath: string;
      readinessPath: string;
      inputGatePath: string;
      inputActivePath: string;
      shutdownRequestPath: string;
      shutdownCompletePath: string;
    }>();
    expectTypeOf<ManagedTmuxPlayAttachOptions>().toMatchTypeOf<{
      signal?: AbortSignal;
      beforeNativeAttach?: () => void;
    }>();
    expectTypeOf<PreparedManagedTmuxPlayLaunch>().toMatchTypeOf<{
      sessionId: string;
      attach(options?: ManagedTmuxPlayAttachOptions): Promise<void>;
      cancel(): Promise<void>;
    }>();
    expectTypeOf<ManagedTmuxPlaySessionOptions>().toMatchTypeOf<{
      sessionId: string;
      workDir: string;
      readinessPath: string;
      inputGatePath: string;
      inputActivePath: string;
      shutdownRequestPath: string;
      shutdownCompletePath: string;
      lifecycle: ManagedTmuxPlayLifecycle;
    }>();
    expectTypeOf<
      ManagedTmuxPlayAfterTurnContext['terminal']
    >().toEqualTypeOf<ManagedTmuxPlayTerminalRecord>();
    expectTypeOf<ManagedTmuxPlayLifecycle['shutdown']>()
      .parameter(0)
      .toEqualTypeOf<ManagedTmuxPlayShutdownContext>();
  });

  it('uses stable run result status values', () => {
    const status: RunStatus = 'ok';
    const playerResult: PlayerRunResult = {
      status,
      playerId: 'coder',
      turnId: 1,
      resumeToken: 'thread-1',
      finalText: 'done',
    };
    const captainResult: CaptainRunResult = {
      status: 'error',
      turnId: 1,
      error: 'failed',
    };
    const resumableCaptainResult: CaptainRunResult = {
      status: 'ok',
      turnId: 2,
      resumeToken: 'captain-thread-1',
      finalText: 'done',
    };

    expect(playerResult.status).toBe('ok');
    expect(playerResult.resumeToken).toBe('thread-1');
    expect(captainResult.status).toBe('error');
    expect(resumableCaptainResult.resumeToken).toBe('captain-thread-1');
  });

  it('re-exports known adapters', () => {
    expect(KNOWN_PLAYER_ADAPTERS).toEqual([
      'claude',
      'codex',
      'gemini',
      'kimi',
      'opencode',
    ]);
  });

  it('wires the package subpath export', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as {
      exports: Record<string, { import: string; types: string }>;
    };

    expect(pkg.exports['./tmux-play']).toEqual({
      import: './dist/app/tmux-play/index.js',
      types: './dist/app/tmux-play/index.d.ts',
    });
  });
});
