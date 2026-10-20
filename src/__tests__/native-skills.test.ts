// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// skills-13, skills-14, and engine-133: the native-skill switch as every real
// built-in adapter prepares it, directly and through every engine path, the
// frozen discovery data through the package entry point, and the engine
// paths that hand a value to a custom adapter unchanged. Preparation precedes any SDK load or process spawn, so
// each built-in adapter gets a loader or spawner that records a reach and
// fails: a reach proves the value was admitted, its absence that it was
// rejected first.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import { KimiAdapter } from '../adapters/kimi.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { Cligent } from '../cligent.js';
import { runAgent, runParallel } from '../engine.js';
import { createEvent } from '../events.js';
import {
  NATIVE_SKILL_SUPPORT,
  getNativeSkillSupport,
  type NativeSkillSupport,
} from '../index.js';
import { AdapterRegistry } from '../registry.js';
import type { AgentAdapter, AgentEvent } from '../types.js';

const BUILT_IN_AGENTS = [
  'claude-code',
  'codex',
  'gemini',
  'kimi',
  'opencode',
] as const;
type BuiltInAgent = (typeof BUILT_IN_AGENTS)[number];

async function settle(
  run: AsyncGenerator<AgentEvent, void, void>,
): Promise<{ events: AgentEvent[]; thrown?: unknown }> {
  const events: AgentEvent[] = [];
  try {
    for await (const event of run) events.push(event);
  } catch (thrown) {
    return { events, thrown };
  }
  return { events };
}

/** The message a rejection carries, thrown or as the adapter's error terminal. */
function rejection(outcome: {
  events: AgentEvent[];
  thrown?: unknown;
}): string | undefined {
  if (outcome.thrown !== undefined) {
    return outcome.thrown instanceof Error
      ? outcome.thrown.message
      : String(outcome.thrown);
  }
  const error = outcome.events.find((event) => event.type === 'error');
  return error === undefined
    ? undefined
    : (error.payload as { message: string }).message;
}

describe('native skills through the real built-in adapters (skills-13)', () => {
  const dirs: string[] = [];
  let workspace: string;

  beforeEach(() => {
    vi.stubEnv('CLIGENT_RUNTIME_GATE', 'off');
    // Gemini builds its per-run home from the real home before it spawns,
    // so every run here mirrors a throwaway home instead of the user's.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'cligent-ns-home-')));
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'cligent-ns-ws-')));
    dirs.push(home, workspace);
    mkdirSync(join(home, '.gemini'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('GEMINI_CLI_HOME', '');
    vi.stubEnv('GEMINI_SANDBOX', '');
    vi.stubEnv('GEMINI_CLI_SYSTEM_SETTINGS_PATH', join(home, 'no-system.json'));
    vi.stubEnv(
      'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
      join(home, 'no-defaults.json'),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function builtIn(agent: BuiltInAgent): {
    adapter: AgentAdapter<string, boolean, string, string>;
    backend: string[];
  } {
    const backend: string[] = [];
    const reach = (what: string) => (): never => {
      backend.push(what);
      throw new Error(`${agent} ${what} reached`);
    };
    const adapter = (() => {
      switch (agent) {
        case 'claude-code':
          return new ClaudeCodeAdapter({ loadSdk: reach('SDK load') });
        case 'codex':
          return new CodexAdapter({ loadSdk: reach('SDK load') });
        case 'gemini':
          return new GeminiAdapter({ spawnProcess: reach('spawn') });
        case 'kimi':
          return new KimiAdapter({ spawnProcess: reach('spawn') });
        case 'opencode':
          return new OpenCodeAdapter(
            {},
            { loadSdk: reach('SDK load'), spawnProcess: reach('spawn') },
          );
      }
    })();
    return {
      adapter: adapter as unknown as AgentAdapter<
        string,
        boolean,
        string,
        string
      >,
      backend,
    };
  }

  async function runWith(agent: BuiltInAgent, nativeSkills: unknown) {
    const { adapter, backend } = builtIn(agent);
    const outcome = await settle(
      adapter.run('p', {
        cwd: workspace,
        ...(nativeSkills === undefined
          ? {}
          : { nativeSkills: nativeSkills as never }),
      }) as AsyncGenerator<AgentEvent, void, void>,
    );
    return { outcome, backend };
  }

  it.each(BUILT_IN_AGENTS)(
    'admits omitted and true on %s, reaching the backend',
    async (agent) => {
      for (const value of [undefined, true]) {
        const { outcome, backend } = await runWith(agent, value);
        expect(backend.length).toBeGreaterThan(0);
        expect(rejection(outcome)).not.toMatch(/nativeSkills/);
      }
    },
  );

  it.each(BUILT_IN_AGENTS)(
    'admits false on %s only where its descriptor accepts it',
    async (agent) => {
      const { outcome, backend } = await runWith(agent, false);
      if (agent === 'kimi') {
        expect(backend).toEqual([]);
        expect(rejection(outcome)).toBe(
          'nativeSkills: false for adapter "kimi" cannot be honored: its runtime offers no per-run lever that turns its own skill discovery off',
        );
      } else {
        expect(backend.length).toBeGreaterThan(0);
        expect(rejection(outcome)).not.toMatch(/nativeSkills/);
      }
    },
  );

  // engine-133: the instance default [engine-1], a per-run value, the
  // legacy registry, and a parallel task forward each value unchanged
  // [engine-124], so every built-in outcome [engine-132] holds on each path.
  it.each(BUILT_IN_AGENTS)(
    'selects each outcome on %s through Cligent, the registry, and runParallel',
    async (agent) => {
      const paths: Array<
        (
          adapter: AgentAdapter<string, boolean, string, string>,
          nativeSkills: unknown,
        ) => AsyncGenerator<AgentEvent, void, void>
      > = [
        (adapter, nativeSkills) =>
          new Cligent(adapter, {
            cwd: workspace,
            nativeSkills: nativeSkills as never,
          }).run('p'),
        (adapter, nativeSkills) =>
          new Cligent(adapter, { cwd: workspace }).run('p', {
            nativeSkills: nativeSkills as never,
          }),
        (adapter, nativeSkills) => {
          const registry = new AdapterRegistry();
          registry.register(adapter);
          return runAgent(
            agent,
            'p',
            { cwd: workspace, nativeSkills: nativeSkills as never },
            registry,
          );
        },
        (adapter, nativeSkills) =>
          runParallel([
            {
              adapter,
              prompt: 'p',
              options: { cwd: workspace, nativeSkills: nativeSkills as never },
            },
          ]),
      ];
      for (const path of paths) {
        for (const value of [undefined, true, false, 'false']) {
          const { adapter, backend } = builtIn(agent);
          const outcome = await settle(path(adapter, value));
          if (value === 'false') {
            expect(backend).toEqual([]);
            expect(rejection(outcome)).toBe(
              `nativeSkills for adapter "${agent}" must be a boolean`,
            );
          } else if (value === false && agent === 'kimi') {
            expect(backend).toEqual([]);
            expect(rejection(outcome)).toMatch(
              /^nativeSkills: false for adapter "kimi" cannot be honored/,
            );
          } else {
            expect(backend.length).toBeGreaterThan(0);
            expect(rejection(outcome)).not.toMatch(/nativeSkills/);
          }
        }
      }
    },
  );

  it.each(BUILT_IN_AGENTS)(
    'rejects a string, number, or object on %s before any backend',
    async (agent) => {
      for (const value of ['false', 0, {}]) {
        const { outcome, backend } = await runWith(agent, value);
        expect(backend).toEqual([]);
        expect(rejection(outcome)).toBe(
          `nativeSkills for adapter "${agent}" must be a boolean`,
        );
      }
    },
  );
});

// engine-133: the engine's direct and dynamic paths hand any value to a
// custom adapter unchanged [engine-124], which admits its own [engine-132].
describe('native skills through the engine paths (engine-133)', () => {
  function recorder(agent: string) {
    const received: unknown[] = [];
    const adapter: AgentAdapter = {
      agent,
      async *run(_prompt, options) {
        received.push(options?.nativeSkills);
        yield createEvent(
          'done',
          agent,
          { status: 'success', usage: { toolUses: 0 }, durationMs: 0 },
          'session',
        );
      },
      async isAvailable() {
        return true;
      },
    };
    return { adapter, received };
  }

  const VALUES: unknown[] = [false, true, undefined, 'off', 1];

  it('forwards every value through the direct adapter and the legacy registry', async () => {
    const direct = recorder('custom-native-direct');
    const viaRegistry = recorder('custom-native-registry');
    const registry = new AdapterRegistry();
    registry.register(viaRegistry.adapter);
    for (const value of VALUES) {
      const options =
        value === undefined ? {} : { nativeSkills: value as never };
      await settle(direct.adapter.run('p', options));
      await settle(runAgent('custom-native-registry', 'p', options, registry));
    }
    expect(direct.received).toEqual(VALUES);
    expect(viaRegistry.received).toEqual(VALUES);
  });

  it('forwards each parallel task value independently', async () => {
    const off = recorder('custom-native-off');
    const on = recorder('custom-native-on');
    const omitted = recorder('custom-native-omitted');
    await settle(
      runParallel([
        { adapter: off.adapter, prompt: 'a', options: { nativeSkills: false } },
        { adapter: on.adapter, prompt: 'b', options: { nativeSkills: true } },
        { adapter: omitted.adapter, prompt: 'c' },
      ]),
    );
    expect(off.received).toEqual([false]);
    expect(on.received).toEqual([true]);
    expect(omitted.received).toEqual([undefined]);
  });
});

// skills-14: discovery through the package entry point.
describe('native skill support metadata (skills-14)', () => {
  const matrix: Record<
    string,
    {
      project: string;
      user: string;
      disableSupported: boolean;
      notes: string;
    }
  > = {
    'claude-code': {
      project: '.claude/skills',
      user: '~/.claude/skills',
      disableSupported: true,
      notes:
        "Project, user, and synced skills dropped through a parent policy, which also adopts no plugin placed in a project or user skill folder, so that plugin's agents, hooks, MCP servers, and commands go too, bundled skills and workflows turned off, and the main thread filtered to the run's skills. Subagents still list enabled marketplace plugins' skills and managed policy skills, and, where an administrator's policy tier does not merge parent settings, the project and user skills too. A resumed session keeps the native skill listings and bodies already in its history. No evidence before the first model turn.",
    },
    codex: {
      project: '.agents/skills',
      user: '~/.agents/skills',
      disableSupported: true,
      notes:
        'Bundled skills off and every native SKILL.md found before the run disabled by its path. Skills of plugins enabled in the user configuration, which loads only without a permission policy, and of account-installed plugins stay, as does a skill written after the run starts. A resumed session keeps the native skill listings and bodies already in its history. Every disabled path appears in the process arguments. Rejects a run where a native skill root cannot be read or the disabled paths exceed the process-argument bound. No evidence before the first model turn.',
    },
    gemini: {
      project: '.agents/skills',
      user: '~/.agents/skills',
      disableSupported: true,
      notes:
        "The per-run home without the real user skills or .agents, and every workspace skill other than a run skill disabled by name. Extension and built-in skills stay unless named like a disabled workspace skill, a workspace skill with a run skill's exact name shadows it, and one whose name differs only in letter case stays listed beside it. A resumed session keeps the native skill listings and bodies already in its history. Rejects a run whose per-run home cannot be built, whose workspace skills cannot be read, whose user settings cannot take the names without changing whether the runtime validates them, or whose workspace skill name the runtime's settings expansion would change. No evidence before the first model turn.",
    },
    kimi: {
      project: '.agents/skills',
      user: '~/.agents/skills',
      disableSupported: false,
      notes: "No per-run lever reaches Kimi's skill roots.",
    },
    opencode: {
      project: '.agents/skills',
      user: '~/.agents/skills',
      disableSupported: true,
      notes:
        "Managed server only, dropping the .claude/skills and .agents/skills sources and the skill paths and URLs of configuration files. Skill folders of every configuration directory, the global one, OPENCODE_CONFIG_DIR, and .opencode, skill paths and URLs from organization or managed configuration, the built-in skill, and the caller's own inline skill entries stay. A resumed session keeps the native skill listings and bodies already in its history. External mode rejects false.",
    },
  };

  it('exposes the deeply frozen descriptor matrix', () => {
    expect(Object.keys(NATIVE_SKILL_SUPPORT).sort()).toEqual(
      Object.keys(matrix).sort(),
    );
    expect(Object.isFrozen(NATIVE_SKILL_SUPPORT)).toBe(true);
    for (const [agent, expected] of Object.entries(matrix)) {
      const descriptor: NativeSkillSupport =
        NATIVE_SKILL_SUPPORT[agent as keyof typeof NATIVE_SKILL_SUPPORT];
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.folders)).toBe(true);
      expect(descriptor.folders).toEqual({
        project: expected.project,
        user: expected.user,
      });
      expect(descriptor.disableSupported).toBe(expected.disableSupported);
      // skills-11: every clause of the matrix's notes, in full.
      expect(descriptor.notes).toBe(expected.notes);
    }
    expect(() => {
      (NATIVE_SKILL_SUPPORT as Record<string, unknown>).custom = {};
    }).toThrow(TypeError);
    expect(() => {
      (
        NATIVE_SKILL_SUPPORT.kimi as { disableSupported: boolean }
      ).disableSupported = true;
    }).toThrow(TypeError);
    expect(() => {
      (NATIVE_SKILL_SUPPORT.codex.folders as { project: string }).project =
        '.codex/skills';
    }).toThrow(TypeError);
    expect(NATIVE_SKILL_SUPPORT.kimi.disableSupported).toBe(false);
    expect(NATIVE_SKILL_SUPPORT.codex.folders.project).toBe('.agents/skills');
  });

  it('looks up canonical names, the claude alias, and unknown adapters', () => {
    for (const agent of Object.keys(matrix)) {
      expect(getNativeSkillSupport(agent)).toBe(
        NATIVE_SKILL_SUPPORT[agent as keyof typeof NATIVE_SKILL_SUPPORT],
      );
    }
    expect(getNativeSkillSupport('claude')).toBe(
      NATIVE_SKILL_SUPPORT['claude-code'],
    );
    for (const unknown of [
      'custom',
      'Claude-Code',
      'codex ',
      '',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(getNativeSkillSupport(unknown)).toBeUndefined();
    }
  });
});
