// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expectTypeOf, it } from 'vitest';
import {
  createTmuxPlayRuntime,
  launchManagedTmuxPlay,
  runManagedTmuxPlaySession,
  type AgentCallSettings,
  type BossTurn,
  type CallCaptainOptions,
  type CallPlayerOptions,
  type Captain,
  type CaptainContext,
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
  type PlayerHandle,
  type PreparedManagedTmuxPlayLaunch,
  type RecordObserver,
  type RuntimeCaptainConfig,
  type RunTmuxPlayOptions,
} from '../app/tmux-play/index.js';
import type {
  CaptainReplyRecord,
  CaptainStatusRecord,
  CaptainTelemetryRecord,
  RuntimeErrorRecord,
  TurnStartedRecord,
} from '../app/tmux-play/records.js';

describe('tmux-play public types', () => {
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
      workDirOwnedByLauncher: boolean;
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
      workDirOwnedByLauncher: boolean;
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

  it('types turn-bound records with non-null turn ids', () => {
    expectTypeOf<TurnStartedRecord['turnId']>().toEqualTypeOf<number>();
    // TMUX-092: a conversational reply is turn-bound, unlike captain_status.
    expectTypeOf<CaptainReplyRecord['turnId']>().toEqualTypeOf<number>();
    expectTypeOf<CaptainStatusRecord['turnId']>().toEqualTypeOf<
      number | null
    >();
    expectTypeOf<CaptainTelemetryRecord['turnId']>().toEqualTypeOf<
      number | null
    >();
    expectTypeOf<RuntimeErrorRecord['turnId']>().toEqualTypeOf<number | null>();
  });
});
