// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ReasoningEffort } from '../../types.js';
import {
  KNOWN_PLAYER_ADAPTERS,
  createTmuxPlayRuntime,
  type BossTurn,
  type CallPlayerOptions,
  type Captain,
  type CaptainContext,
  type CaptainRunResult,
  type CaptainSession,
  type CaptainTelemetry,
  type RecordObserver,
  type RuntimeCaptainConfig,
  type RuntimePlayerConfig,
  type PlayerHandle,
  type PlayerRunResult,
  type RunStatus,
  type RunTmuxPlayOptions,
} from './index.js';

describe('tmux-play public contract', () => {
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
        await context.callCaptain('summarize');
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
    }>();
    expectTypeOf<RuntimeCaptainConfig>().toMatchTypeOf<{
      adapter: PlayerHandle['adapter'];
      model?: string;
      instruction?: string;
      reasoningEffort?: ReasoningEffort;
    }>();
    expectTypeOf<RuntimePlayerConfig>().toMatchTypeOf<{
      id: string;
      adapter: PlayerHandle['adapter'];
      model?: string;
      instruction?: string;
      reasoningEffort?: ReasoningEffort;
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

    expect(playerResult.status).toBe('ok');
    expect(playerResult.resumeToken).toBe('thread-1');
    expect(captainResult.status).toBe('error');
  });

  it('re-exports known adapters', () => {
    expect(KNOWN_PLAYER_ADAPTERS).toEqual([
      'claude',
      'codex',
      'gemini',
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
