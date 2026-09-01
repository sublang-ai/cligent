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
  KimiEffort,
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

type FastModeOf<T, A extends PlayerAdapterName> =
  Extract<T, { adapter: A }> extends infer Config
    ? Config extends { fastMode?: infer FM }
      ? FM | undefined
      : never
    : never;

type FastModeMap<T> = {
  [A in PlayerAdapterName]: FastModeOf<T, A>;
};

type ExpectedEffortMap = {
  claude: ClaudeEffort | undefined;
  codex: CodexEffort | undefined;
  gemini: GeminiEffort | undefined;
  kimi: KimiEffort | undefined;
  opencode: OpenCodeEffort | undefined;
};

type ConfigSurfaceEfforts = {
  captain: EffortMap<CaptainConfig>;
  player: EffortMap<PlayerConfig>;
  runtimeCaptain: EffortMap<RuntimeCaptainConfig>;
  runtimePlayer: EffortMap<RuntimePlayerConfig>;
};

type ExpectedFastModeMap = {
  claude: boolean | undefined;
  codex: boolean | undefined;
  gemini: undefined;
  kimi: undefined;
  opencode: undefined;
};

type ConfigSurfaceFastModes = {
  captain: FastModeMap<CaptainConfig>;
  player: FastModeMap<PlayerConfig>;
  runtimeCaptain: FastModeMap<RuntimeCaptainConfig>;
  runtimePlayer: FastModeMap<RuntimePlayerConfig>;
};

describe('tmux-play effort types (tmux-play-190)', () => {
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
      fastMode: true,
      model: 'example-model',
      instruction: 'Coordinate the players.',
      permissions,
      options: { strategy: 'fanout', retries: 2 },
    } satisfies CaptainConfig;
    const player = {
      id: 'reviewer',
      adapter: 'codex',
      effort: 'ultra',
      fastMode: false,
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
      fastMode: true,
    });
    const codex = createPlayerCligent('codex', {
      effort: 'ultra',
      fastMode: false,
    });
    const gemini = createPlayerCligent('gemini', {
      effort: 'max',
    });
    const opencode = createPlayerCligent('opencode', {
      effort: 'minimal',
    });
    const kimi = createPlayerCligent('kimi', {
      effort: 'on',
    });

    expectTypeOf(claude).toEqualTypeOf<
      Promise<Cligent<ClaudeEffort, boolean>>
    >();
    expectTypeOf(codex).toEqualTypeOf<
      Promise<Cligent<CodexEffort, boolean>>
    >();
    expectTypeOf(gemini).toEqualTypeOf<Promise<Cligent<GeminiEffort>>>();
    expectTypeOf(kimi).toEqualTypeOf<Promise<Cligent<KimiEffort>>>();
    expectTypeOf(opencode).toEqualTypeOf<Promise<Cligent<OpenCodeEffort>>>();

    // @ts-expect-error - Codex-only ultra cannot configure Claude
    void createPlayerCligent('claude', { effort: 'ultra' });
    // @ts-expect-error - Claude-only ultracode cannot configure Codex
    void createPlayerCligent('codex', { effort: 'ultracode' });
    // @ts-expect-error - Gemini accepts only portable effort values
    void createPlayerCligent('gemini', { effort: 'ultra' });
    // @ts-expect-error - OpenCode accepts only portable effort values
    void createPlayerCligent('opencode', { effort: 'ultracode' });
    // @ts-expect-error - Kimi accepts only its binary effort values
    void createPlayerCligent('kimi', { effort: 'high' });
    // @ts-expect-error - unsupported adapters expose no fast-mode request
    void createPlayerCligent('gemini', { fastMode: false });
  });
});

describe('tmux-play fast-mode types (tmux-play-209)', () => {
  it('keeps every config surface adapter-discriminated', () => {
    expectTypeOf<ConfigSurfaceFastModes>().toEqualTypeOf<{
      captain: ExpectedFastModeMap;
      player: ExpectedFastModeMap;
      runtimeCaptain: ExpectedFastModeMap;
      runtimePlayer: ExpectedFastModeMap;
    }>();
  });

  it('accepts supported roles and rejects unsupported roles', () => {
    const runtimeCaptain = {
      adapter: 'claude',
      fastMode: false,
      model: 'example-model',
      instruction: 'Coordinate the players.',
      permissions: { mode: 'auto' },
      effort: 'high',
    } satisfies RuntimeCaptainConfig;
    const runtimePlayer = {
      id: 'reviewer',
      adapter: 'codex',
      fastMode: true,
      model: 'example-model',
      instruction: 'Review the answer.',
      permissions: { mode: 'auto' },
      effort: 'high',
    } satisfies RuntimePlayerConfig;

    // @ts-expect-error - Gemini Captain does not support fast mode
    const invalidCaptain: CaptainConfig = {
      from: '@example/captain', adapter: 'gemini', fastMode: false, options: {},
    };
    // @ts-expect-error - OpenCode player does not support fast mode
    const invalidPlayer: PlayerConfig = {
      id: 'reviewer', adapter: 'opencode', fastMode: true,
    };
    // @ts-expect-error - Kimi runtime Captain does not support fast mode
    const invalidRuntimeCaptain: RuntimeCaptainConfig = {
      adapter: 'kimi', fastMode: false,
    };
    // @ts-expect-error - Gemini runtime player does not support fast mode
    const invalidRuntimePlayer: RuntimePlayerConfig = {
      id: 'reviewer', adapter: 'gemini', fastMode: true,
    };

    void [
      runtimeCaptain,
      runtimePlayer,
      invalidCaptain,
      invalidPlayer,
      invalidRuntimeCaptain,
      invalidRuntimePlayer,
    ];
  });
});
