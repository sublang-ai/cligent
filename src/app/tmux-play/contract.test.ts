// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  KNOWN_ROLE_ADAPTERS,
  defineConfig,
  type BossTurn,
  type Captain,
  type CaptainContext,
  type CaptainRunResult,
  type RoleHandle,
  type RoleRunResult,
  type RunStatus,
  type RunTmuxPlayOptions,
  type TmuxPlayConfig,
} from './index.js';

describe('tmux-play public contract', () => {
  it('accepts Captain implementations', () => {
    const captain: Captain = {
      async handleBossTurn(turn: BossTurn, context: CaptainContext) {
        expectTypeOf(turn.id).toEqualTypeOf<number>();
        expectTypeOf(context.roles).toEqualTypeOf<readonly RoleHandle[]>();

        await context.emitStatus('ready', { turnId: turn.id });
        await context.callRole('coder', turn.prompt, {
          metadata: { source: 'test' },
        });
        await context.callCaptain('summarize');
      },
      async dispose() {
        // no-op
      },
    };

    expectTypeOf(captain).toMatchTypeOf<Captain>();
  });

  it('exports runtime API option types', () => {
    expectTypeOf<RunTmuxPlayOptions>().toMatchTypeOf<{
      captain: Captain;
      roles: readonly RoleHandle[];
      cwd?: string;
      signal?: AbortSignal;
    }>();
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

  it('re-exports defineConfig and known adapters', () => {
    const config: TmuxPlayConfig = {
      captain: {
        from: '@sublang/cligent/captains/fanout',
        adapter: 'claude',
        options: {},
      },
      roles: [{ id: 'coder', adapter: 'codex' }],
    };

    expect(defineConfig(config)).toBe(config);
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
