// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AgentCallSettingsError,
  KNOWN_PLAYER_ADAPTERS,
  isAgentCallSettingsError,
  type CaptainRunResult,
  type PlayerRunResult,
  type RunStatus,
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
