// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  KNOWN_ROLE_ADAPTERS,
  createTmuxPlayRuntime,
  type BossTurn,
  type Captain,
  type CaptainContext,
  type CaptainRunResult,
  type CaptainSession,
  type CaptainTelemetry,
  type RecordObserver,
  type RuntimeCaptainConfig,
  type RoleHandle,
  type RoleRunResult,
  type RunStatus,
  type RunTmuxPlayOptions,
} from './index.js';

describe('tmux-play public contract', () => {
  it('accepts Captain implementations', () => {
    const captain: Captain = {
      async init(session: CaptainSession) {
        expectTypeOf(session.roles).toEqualTypeOf<readonly RoleHandle[]>();
        await session.emitStatus('ready', { phase: 'init' });
        const telemetry: CaptainTelemetry = {
          topic: 'metrics.ready',
          payload: { ok: true },
        };
        await session.emitTelemetry(telemetry);
      },
      async handleBossTurn(turn: BossTurn, context: CaptainContext) {
        expectTypeOf(turn.id).toEqualTypeOf<number>();
        expectTypeOf(context.roles).toEqualTypeOf<readonly RoleHandle[]>();

        await context.callRole('coder', turn.prompt);
        await context.callCaptain('summarize');
      },
      async dispose() {
        // no-op
      },
    };

    expectTypeOf(captain).toMatchTypeOf<Captain>();
  });

  it('exports runtime API option types', () => {
    expectTypeOf<RuntimeCaptainConfig>().toMatchTypeOf<{
      adapter: RoleHandle['adapter'];
      model?: string;
      instruction?: string;
    }>();
    expectTypeOf<RunTmuxPlayOptions>().toMatchTypeOf<{
      captain: Captain;
      captainConfig: RuntimeCaptainConfig;
      roles: readonly RoleHandle[];
      observers?: readonly RecordObserver[];
      cwd?: string;
      signal?: AbortSignal;
    }>();
    expectTypeOf(createTmuxPlayRuntime).toBeFunction();
  });

  it('uses stable run result status values', () => {
    const status: RunStatus = 'ok';
    const roleResult: RoleRunResult = {
      status,
      roleId: 'coder',
      turnId: 1,
      finalText: 'done',
    };
    const captainResult: CaptainRunResult = {
      status: 'error',
      turnId: 1,
      error: 'failed',
    };

    expect(roleResult.status).toBe('ok');
    expect(captainResult.status).toBe('error');
  });

  it('re-exports known adapters', () => {
    expect(KNOWN_ROLE_ADAPTERS).toEqual([
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
