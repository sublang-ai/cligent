// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expectTypeOf, it } from 'vitest';
import { Cligent } from '../cligent.js';
import {
  createPlayerCligent,
  type PlayerAdapterImports,
  type PlayerAdapterName,
} from '../app/tmux-play/players.js';
import type {
  CaptainConfig,
  PlayerConfig,
  RuntimeCaptainConfig,
  RuntimePlayerConfig,
} from '../app/tmux-play/index.js';
import type {
  ClaudeEffort,
  CodexEffort,
  GeminiEffort,
  OpenCodeEffort,
  PermissionPolicy,
} from '../types.js';

type EffortOf<T, A extends PlayerAdapterName> =
  Extract<T, { adapter: A }> extends infer Config
    ? Config extends { effort?: infer E }
      ? E | undefined
      : never
    : never;

type EffortMap<T> = {
  [A in PlayerAdapterName]: EffortOf<T, A>;
};

type ExpectedEffortMap = {
  claude: ClaudeEffort | undefined;
  codex: CodexEffort | undefined;
  gemini: GeminiEffort | undefined;
  opencode: OpenCodeEffort | undefined;
};

type NativeEffortLeaks<T> = {
  claudeAcceptsUltra: 'ultra' extends EffortOf<T, 'claude'> ? true : false;
  codexAcceptsUltracode: 'ultracode' extends EffortOf<T, 'codex'>
    ? true
    : false;
  geminiAcceptsUltra: 'ultra' extends EffortOf<T, 'gemini'> ? true : false;
  geminiAcceptsUltracode: 'ultracode' extends EffortOf<T, 'gemini'>
    ? true
    : false;
  opencodeAcceptsUltra: 'ultra' extends EffortOf<T, 'opencode'> ? true : false;
  opencodeAcceptsUltracode: 'ultracode' extends EffortOf<T, 'opencode'>
    ? true
    : false;
};

type NoNativeEffortLeaks = {
  [K in keyof NativeEffortLeaks<unknown>]: false;
};

describe('tmux-play effort types (TTMUX-090)', () => {
  it('keeps every config surface adapter-discriminated', () => {
    expectTypeOf<EffortMap<CaptainConfig>>().toEqualTypeOf<ExpectedEffortMap>();
    expectTypeOf<EffortMap<PlayerConfig>>().toEqualTypeOf<ExpectedEffortMap>();
    expectTypeOf<
      EffortMap<RuntimeCaptainConfig>
    >().toEqualTypeOf<ExpectedEffortMap>();
    expectTypeOf<
      EffortMap<RuntimePlayerConfig>
    >().toEqualTypeOf<ExpectedEffortMap>();

    expectTypeOf<
      NativeEffortLeaks<CaptainConfig>
    >().toEqualTypeOf<NoNativeEffortLeaks>();
    expectTypeOf<
      NativeEffortLeaks<PlayerConfig>
    >().toEqualTypeOf<NoNativeEffortLeaks>();
    expectTypeOf<
      NativeEffortLeaks<RuntimeCaptainConfig>
    >().toEqualTypeOf<NoNativeEffortLeaks>();
    expectTypeOf<
      NativeEffortLeaks<RuntimePlayerConfig>
    >().toEqualTypeOf<NoNativeEffortLeaks>();
  });

  it('accepts each own vocabulary while retaining non-effort fields', () => {
    const permissions: PermissionPolicy = {
      mode: 'auto',
      fileWrite: 'allow',
      shellExecute: 'ask',
      networkAccess: 'deny',
      writablePaths: ['generated'],
    };
    const captainFields = {
      from: '@example/captain',
      model: 'example-model',
      instruction: 'Coordinate the players.',
      permissions,
      options: { strategy: 'fanout', retries: 2 },
    };
    const playerFields = {
      id: 'reviewer',
      model: 'example-model',
      instruction: 'Review the answer.',
      permissions,
    };
    const runtimeCaptainFields = {
      model: 'example-model',
      instruction: 'Coordinate the players.',
      permissions,
    };
    const runtimePlayerFields = {
      id: 'reviewer',
      model: 'example-model',
      instruction: 'Review the answer.',
      permissions,
    };

    const captains = [
      { ...captainFields, adapter: 'claude', effort: 'ultracode' },
      { ...captainFields, adapter: 'codex', effort: 'ultra' },
      { ...captainFields, adapter: 'gemini', effort: 'minimal' },
      { ...captainFields, adapter: 'opencode', effort: 'max' },
    ] satisfies readonly CaptainConfig[];
    const players = [
      { ...playerFields, adapter: 'claude', effort: 'ultracode' },
      { ...playerFields, adapter: 'codex', effort: 'ultra' },
      { ...playerFields, adapter: 'gemini', effort: 'low' },
      { ...playerFields, adapter: 'opencode', effort: 'xhigh' },
    ] satisfies readonly PlayerConfig[];
    const runtimeCaptains = [
      { ...runtimeCaptainFields, adapter: 'claude', effort: 'ultracode' },
      { ...runtimeCaptainFields, adapter: 'codex', effort: 'ultra' },
      { ...runtimeCaptainFields, adapter: 'gemini', effort: 'medium' },
      { ...runtimeCaptainFields, adapter: 'opencode', effort: 'high' },
    ] satisfies readonly RuntimeCaptainConfig[];
    const runtimePlayers = [
      { ...runtimePlayerFields, adapter: 'claude', effort: 'ultracode' },
      { ...runtimePlayerFields, adapter: 'codex', effort: 'ultra' },
      { ...runtimePlayerFields, adapter: 'gemini', effort: 'xhigh' },
      { ...runtimePlayerFields, adapter: 'opencode', effort: 'minimal' },
    ] satisfies readonly RuntimePlayerConfig[];

    expectTypeOf(captains).toMatchTypeOf<readonly CaptainConfig[]>();
    expectTypeOf(players).toMatchTypeOf<readonly PlayerConfig[]>();
    expectTypeOf(runtimeCaptains).toMatchTypeOf<
      readonly RuntimeCaptainConfig[]
    >();
    expectTypeOf(runtimePlayers).toMatchTypeOf<
      readonly RuntimePlayerConfig[]
    >();
  });

  it('correlates createPlayerCligent inputs and returns for all adapters', () => {
    const permissions: PermissionPolicy = { mode: 'auto' };
    const adapterImports = {} as PlayerAdapterImports;

    const claude = createPlayerCligent('claude', {
      adapterImports,
      cwd: '/workspace',
      model: 'claude-model',
      role: 'captain',
      permissions,
      effort: 'ultracode',
    });
    const codex = createPlayerCligent('codex', {
      effort: 'ultra',
    });
    const gemini = createPlayerCligent('gemini', {
      effort: 'max',
    });
    const opencode = createPlayerCligent('opencode', {
      effort: 'minimal',
    });

    expectTypeOf(claude).toEqualTypeOf<Promise<Cligent<ClaudeEffort>>>();
    expectTypeOf(codex).toEqualTypeOf<Promise<Cligent<CodexEffort>>>();
    expectTypeOf(gemini).toEqualTypeOf<Promise<Cligent<GeminiEffort>>>();
    expectTypeOf(opencode).toEqualTypeOf<Promise<Cligent<OpenCodeEffort>>>();

    // @ts-expect-error - Codex-only ultra cannot configure Claude
    void createPlayerCligent('claude', { effort: 'ultra' });
    // @ts-expect-error - Claude-only ultracode cannot configure Codex
    void createPlayerCligent('codex', { effort: 'ultracode' });
    // @ts-expect-error - Gemini accepts only portable effort values
    void createPlayerCligent('gemini', { effort: 'ultra' });
    // @ts-expect-error - Gemini accepts only portable effort values
    void createPlayerCligent('gemini', { effort: 'ultracode' });
    // @ts-expect-error - OpenCode accepts only portable effort values
    void createPlayerCligent('opencode', { effort: 'ultra' });
    // @ts-expect-error - OpenCode accepts only portable effort values
    void createPlayerCligent('opencode', { effort: 'ultracode' });
  });
});
