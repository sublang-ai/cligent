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

type ConfigSurfaceEfforts = {
  captain: EffortMap<CaptainConfig>;
  player: EffortMap<PlayerConfig>;
  runtimeCaptain: EffortMap<RuntimeCaptainConfig>;
  runtimePlayer: EffortMap<RuntimePlayerConfig>;
};

describe('tmux-play effort types (TTMUX-090)', () => {
  it('keeps every config surface adapter-discriminated', () => {
    expectTypeOf<ConfigSurfaceEfforts>().toEqualTypeOf<{
      captain: ExpectedEffortMap;
      player: ExpectedEffortMap;
      runtimeCaptain: ExpectedEffortMap;
      runtimePlayer: ExpectedEffortMap;
    }>();
  });

  it('accepts representative configs with their non-effort fields', () => {
    const permissions: PermissionPolicy = {
      mode: 'auto',
      fileWrite: 'allow',
      shellExecute: 'ask',
      networkAccess: 'deny',
      writablePaths: ['generated'],
    };
    const captain = {
      from: '@example/captain',
      adapter: 'claude',
      effort: 'ultracode',
      model: 'example-model',
      instruction: 'Coordinate the players.',
      permissions,
      options: { strategy: 'fanout', retries: 2 },
    } satisfies CaptainConfig;
    const player = {
      id: 'reviewer',
      adapter: 'codex',
      effort: 'ultra',
      model: 'example-model',
      instruction: 'Review the answer.',
      permissions,
    } satisfies PlayerConfig;
    const runtimeCaptain = {
      adapter: 'gemini',
      effort: 'medium',
      model: 'example-model',
      instruction: 'Coordinate the players.',
      permissions,
    } satisfies RuntimeCaptainConfig;
    const runtimePlayer = {
      id: 'reviewer',
      adapter: 'opencode',
      effort: 'xhigh',
      model: 'example-model',
      instruction: 'Review the answer.',
      permissions,
    } satisfies RuntimePlayerConfig;

    void [captain, player, runtimeCaptain, runtimePlayer];
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
    // @ts-expect-error - OpenCode accepts only portable effort values
    void createPlayerCligent('opencode', { effort: 'ultracode' });
  });
});
