// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// gemini-53: a real fixture subprocess stands in for Gemini CLI and records
// the per-run settings home, its skills directory, and the policy files the
// adapter hands it, so each check reads what a real child would read.

import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeminiAdapter } from '../adapters/gemini.js';
import type { AgentEvent, AgentOptions, GeminiEffort } from '../types.js';

const hooks = vi.hoisted(() => ({
  beforePrepare: undefined as (() => void) | undefined,
  beforeMaterialize: undefined as (() => void) | undefined,
}));
const browserPreparation = vi.hoisted(() => vi.fn());
vi.mock('../browser.js', () => ({
  prepareBrowserServer: browserPreparation,
  releaseBrowserServer: async () => {},
}));
// The real preparation and materialization run; the hooks only let a test
// cancel the run once either has begun.
vi.mock('../skills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skills.js')>();
  return {
    ...actual,
    prepareSkills: (...args: Parameters<typeof actual.prepareSkills>) => {
      hooks.beforePrepare?.();
      return actual.prepareSkills(...args);
    },
    materializeSkills: (
      ...args: Parameters<typeof actual.materializeSkills>
    ) => {
      hooks.beforeMaterialize?.();
      return actual.materializeSkills(...args);
    },
  };
});

const FIXTURE = `
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const [capture, ...args] = process.argv.slice(2);
const home = process.env.GEMINI_CLI_HOME;
const skillsDir = join(home, '.gemini', 'skills');
const tree = (root, dir = root) => readdirSync(dir).sort().flatMap((name) => {
  const path = join(dir, name);
  const stats = lstatSync(path);
  const row = [relative(root, path), stats.isSymbolicLink() ? 'link:' + readlinkSync(path) : stats.isDirectory() ? 'dir' : 'file', stats.mode & 0o777];
  return stats.isDirectory() ? [row, ...tree(root, path)] : [row];
});
const entry = (name) => {
  const path = join(skillsDir, name);
  const link = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  return {
    name,
    link,
    skill: existsSync(join(path, 'SKILL.md')) ? readFileSync(join(path, 'SKILL.md'), 'utf8') : null,
    tree: link === null && statSync(path).isDirectory() ? tree(path) : null,
  };
};
const settingsPath = join(home, '.gemini', 'settings.json');
const policies = args.filter((arg) => arg.startsWith('--policy=')).map((arg) => arg.slice('--policy='.length));
writeFileSync(capture, JSON.stringify({
  args,
  home,
  trust: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? null,
  homeEntries: readdirSync(home).sort(),
  settings: existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null,
  skillsIsLink: existsSync(skillsDir) ? lstatSync(skillsDir).isSymbolicLink() : null,
  skills: existsSync(skillsDir) ? readdirSync(skillsDir).sort().map(entry) : null,
  policy: policies.length > 0 ? readFileSync(policies[0], 'utf8') : null,
  policies,
}));
if (process.env.CLIGENT_FIXTURE_REMOVE_GEMINI) {
  rmSync(process.env.CLIGENT_FIXTURE_REMOVE_GEMINI, { recursive: true, force: true });
  writeFileSync(join(home, '.gemini', 'state.json'), '{}');
}
if (process.env.CLIGENT_FIXTURE_ADD_SKILL) {
  mkdirSync(join(skillsDir, 'added-skill'));
  writeFileSync(join(skillsDir, 'added-skill', 'SKILL.md'), '---\\nname: added-skill\\ndescription: Added during the run\\n---\\nBody\\n');
  writeFileSync(join(skillsDir, 'alpha', 'scratch.txt'), 'run only');
}
console.log(JSON.stringify({ type: 'init', session_id: 'gemini-skills' }));
console.log(JSON.stringify({ type: 'result', status: 'success', result: 'done' }));
`;

const ACTIVATE_SKILL_RULE = [
  '[[rule]]',
  'toolName = "activate_skill"',
  'decision = "allow"',
  'priority = 999',
  'interactive = false',
  '',
].join('\n');

interface SkillEntry {
  name: string;
  link: string | null;
  skill: string | null;
  tree: [string, string, number][] | null;
}

interface Captured {
  args: string[];
  home: string;
  trust: string | null;
  homeEntries: string[];
  settings: Record<string, unknown> | null;
  skillsIsLink: boolean | null;
  skills: SkillEntry[] | null;
  policy: string | null;
  policies: string[];
}

let fixtureRoot: string;
let realHome: string;
let realGemini: string;
let overlayTmp: string;
let cwd: string;
let sources: string;
let script: string;
let capture: string;

function overlaysLeft(): string[] {
  return readdirSync(overlayTmp).filter((name) =>
    name.startsWith('cligent-gemini-home-'),
  );
}

function skillFile(name: string, description: string, body = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

/** A skill directory named `directory` whose frontmatter names `name`. */
function writeSkill(
  root: string,
  directory: string,
  name: string,
  body = '',
): string {
  const path = join(root, directory);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'SKILL.md'),
    skillFile(name, `The ${name} skill`, body),
  );
  return path;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** The run's skills: alpha with a script and a relative link, beta, my-tool. */
function runSkills(): string[] {
  const alpha = writeSkill(sources, 'alpha', 'alpha', 'Alpha body\n');
  mkdirSync(join(alpha, 'scripts'));
  writeFileSync(join(alpha, 'scripts', 'run.sh'), '#!/bin/sh\necho alpha\n');
  chmodSync(join(alpha, 'scripts', 'run.sh'), 0o755);
  symlinkSync('SKILL.md', join(alpha, 'ref.md'));
  writeSkill(sources, 'beta', 'beta');
  writeSkill(sources, 'my-tool', 'my-tool');
  // A directory, its SKILL.md, and a path relative to the run cwd.
  return [alpha, join(sources, 'beta', 'SKILL.md'), '../sources/my-tool'];
}

async function collect(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function fixtureAdapter(spawned: string[][] = []): GeminiAdapter {
  return new GeminiAdapter({
    spawnProcess: (
      _command: string,
      args: readonly string[],
      options: SpawnOptionsWithoutStdio,
    ): ChildProcessWithoutNullStreams => {
      spawned.push([...args]);
      return spawn(process.execPath, [script, capture, ...args], {
        ...options,
        stdio: 'pipe',
      });
    },
  });
}

async function runFixture(
  options: AgentOptions<GeminiEffort>,
): Promise<{ events: AgentEvent[]; captured: Captured }> {
  const events = await collect(
    fixtureAdapter().run('Use the skills', { cwd, ...options }),
  );
  expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
  return {
    events,
    captured: JSON.parse(readFileSync(capture, 'utf8')) as Captured,
  };
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'cligent-gemini-skills-'));
  realHome = join(fixtureRoot, 'home');
  realGemini = join(realHome, '.gemini');
  overlayTmp = join(fixtureRoot, 'tmp');
  cwd = join(fixtureRoot, 'work');
  sources = join(fixtureRoot, 'sources');
  script = join(fixtureRoot, 'gemini-fixture.mjs');
  capture = join(fixtureRoot, 'captured.json');
  for (const dir of [realHome, overlayTmp, cwd, sources]) mkdirSync(dir);
  writeFileSync(script, FIXTURE);
  vi.stubEnv('CLIGENT_RUNTIME_GATE', 'off');
  vi.stubEnv('GEMINI_CLI_HOME', realHome);
  vi.stubEnv('TMPDIR', overlayTmp);
  vi.stubEnv('TMP', overlayTmp);
  vi.stubEnv('TEMP', overlayTmp);
  vi.stubEnv('GEMINI_SANDBOX', undefined);
  vi.stubEnv('SANDBOX', undefined);
  vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', undefined);
  vi.stubEnv('GEMINI_RESTRICTED_MODE', undefined);
  vi.stubEnv('GEMINI_CLI_TRUSTED_FOLDERS_PATH', undefined);
  vi.stubEnv('CLIGENT_FIXTURE_ADD_SKILL', undefined);
  vi.stubEnv('CLIGENT_FIXTURE_REMOVE_GEMINI', undefined);
  vi.stubEnv(
    'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
    join(fixtureRoot, 'system', 'settings.json'),
  );
  vi.stubEnv(
    'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
    join(fixtureRoot, 'system', 'system-defaults.json'),
  );
  browserPreparation.mockReset();
  hooks.beforePrepare = undefined;
  hooks.beforeMaterialize = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Gemini per-run skills (gemini-53)', () => {
  it('delivers run skills through the overlay beside the user skills none of them shadows', async () => {
    const realSkills = join(realGemini, 'skills');
    // Same entry name under another skill name, a shadowing name, case
    // variants of entry and skill names, and a name Gemini sanitizes.
    writeSkill(realSkills, 'alpha', 'real-alpha', 'Real alpha\n');
    writeSkill(realSkills, 'shadow', 'alpha');
    writeSkill(realSkills, 'case-variant', 'BETA');
    writeSkill(realSkills, 'Beta', 'unrelated-beta');
    writeSkill(realSkills, 'colon', 'my:tool');
    writeFileSync(join(realSkills, 'SKILL.md'), skillFile('beta', 'Root'));
    // Entries that shadow nothing.
    writeSkill(realSkills, 'other', 'other');
    mkdirSync(join(realSkills, 'notes'));
    mkdirSync(join(realSkills, 'broken'));
    writeFileSync(join(realSkills, 'broken', 'SKILL.md'), 'no frontmatter\n');
    writeFileSync(join(realSkills, 'README.md'), 'readme\n');
    mkdirSync(join(realGemini, 'policies'));
    writeFileSync(join(realGemini, 'policies', 'user.toml'), '');
    const userSettings = JSON.stringify({
      custom: 'keep',
      skills: { disabled: ['ALPHA', 'beta', 'unrelated'], kept: 1 },
    });
    writeFileSync(join(realGemini, 'settings.json'), userSettings);
    const realBefore = readdirSync(realSkills).sort();
    vi.stubEnv('CLIGENT_FIXTURE_ADD_SKILL', '1');

    const { captured } = await runFixture({ skills: runSkills() });

    // gemini-51: a real skills directory holding the run's skills and one
    // link per user entry whose entry and skill names differ from them.
    expect(captured.skillsIsLink).toBe(false);
    const entries = new Map(
      captured.skills!.map((entry) => [entry.name, entry]),
    );
    expect([...entries.keys()].sort()).toEqual(
      [
        'README.md',
        'alpha',
        'beta',
        'broken',
        'my-tool',
        'notes',
        'other',
      ].sort(),
    );
    for (const name of ['README.md', 'broken', 'notes', 'other']) {
      expect(entries.get(name)!.link).toBe(join(realSkills, name));
    }
    for (const name of ['alpha', 'beta', 'my-tool']) {
      const entry = entries.get(name)!;
      expect(entry.link).toBeNull();
      expect(entry.skill).toBe(
        readFileSync(join(sources, name, 'SKILL.md'), 'utf8'),
      );
    }
    expect(entries.get('alpha')!.tree).toEqual([
      ['SKILL.md', 'file', expect.any(Number)],
      ['ref.md', 'link:SKILL.md', expect.any(Number)],
      ['scripts', 'dir', expect.any(Number)],
      ['scripts/run.sh', 'file', 0o755],
    ]);
    expect(captured.homeEntries).not.toContain('.cligent-staging');

    // gemini-51: the user-scope disables naming a run skill, in any case,
    // are gone; everything else is kept, and the real file is untouched.
    expect(captured.settings).toEqual({
      custom: 'keep',
      skills: { disabled: ['unrelated'], kept: 1 },
    });
    expect(readFileSync(join(realGemini, 'settings.json'), 'utf8')).toBe(
      userSettings,
    );
    // gemini-51: trust is unchanged.
    expect(captured.trust).toBe('true');

    // gemini-52, gemini-55: the skills-only policy, then the user tier's own
    // policy directory, which the run's --policy would otherwise replace.
    expect(captured.policy).toBe(ACTIVATE_SKILL_RULE);
    expect(captured.policies.slice(1)).toEqual([join(realGemini, 'policies')]);

    // gemini-45: the entry Gemini added reaches the real skills; the run's
    // skills, and what the run wrote into them, stay behind.
    expect(readdirSync(realSkills).sort()).toEqual(
      [...realBefore, 'added-skill'].sort(),
    );
    expect(
      readFileSync(join(realSkills, 'added-skill', 'SKILL.md'), 'utf8'),
    ).toContain('name: added-skill');
    expect(readdirSync(join(realSkills, 'alpha')).sort()).toEqual(['SKILL.md']);
    expect(readFileSync(join(realSkills, 'alpha', 'SKILL.md'), 'utf8')).toBe(
      skillFile('real-alpha', 'The real-alpha skill', 'Real alpha\n'),
    );
    expect(existsSync(join(realSkills, 'my-tool'))).toBe(false);

    // gemini-35: the overlay is removed after the run.
    expect(existsSync(captured.home)).toBe(false);
    expect(overlaysLeft()).toEqual([]);
  });

  it.each([
    {
      label: "a run skill's case variant",
      disabled: 'Alpha',
      expected: { skills: { kept: 1 } },
    },
    {
      label: 'no run skill',
      disabled: 'unrelated',
      expected: { skills: { disabled: 'unrelated', kept: 1 } },
    },
  ])(
    'rewrites a lone-string skills.disabled naming $label (gemini-51)',
    async ({ disabled, expected }) => {
      const userSettings = JSON.stringify({ skills: { disabled, kept: 1 } });
      mkdirSync(realGemini);
      writeFileSync(join(realGemini, 'settings.json'), userSettings);

      const { captured } = await runFixture({ skills: runSkills() });

      // Gemini reads a lone string as a one-entry list.
      expect(captured.settings).toEqual(expected);
      expect(readFileSync(join(realGemini, 'settings.json'), 'utf8')).toBe(
        userSettings,
      );
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it('delivers skills into an untrusted workspace without changing its trust', async () => {
    vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', 'false');
    const { captured } = await runFixture({ skills: runSkills() });
    expect(captured.trust).toBe('false');
    expect(captured.skills!.map((entry) => entry.name).sort()).toEqual([
      'alpha',
      'beta',
      'my-tool',
    ]);
    expect(captured.policy).toBe(ACTIVATE_SKILL_RULE);
    expect(captured.policies).toHaveLength(1);
    expect(overlaysLeft()).toEqual([]);
  });

  it.each(['trusted', 'untrusted'] as const)(
    'appends the merged policyPaths of a %s workspace beside the skills-only policy (gemini-55)',
    async (trust) => {
      const policyRoot = join(fixtureRoot, 'policy-root');
      const shared = join(fixtureRoot, 'shared-pol');
      const system = join(fixtureRoot, 'system');
      vi.stubEnv('CLIGENT_POLICY_ROOT', policyRoot);
      // Present but neither 'true' nor 'false': the trusted-folders file
      // decides whether Gemini merges the workspace settings.
      vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
      // A user policy directory the merged paths replace.
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      writeJson(join(system, 'system-defaults.json'), {
        policyPaths: [join(fixtureRoot, 'defaults-pol')],
      });
      writeJson(join(realGemini, 'settings.json'), {
        policyPaths: ['~/user-pol', '$CLIGENT_POLICY_ROOT/env-pol', shared],
      });
      writeJson(join(cwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol', shared],
      });
      // A lone value counts as a one-entry list.
      writeJson(join(system, 'settings.json'), {
        policyPaths: join(fixtureRoot, 'system-pol'),
      });
      writeJson(join(realGemini, 'trustedFolders.json'), {
        [trust === 'trusted' ? cwd : join(fixtureRoot, 'elsewhere')]:
          'TRUST_FOLDER',
      });

      const { captured } = await runFixture({ skills: runSkills() });

      expect(captured.policy).toBe(ACTIVATE_SKILL_RULE);
      expect(captured.trust).toBe('');
      expect(captured.policies.slice(1)).toEqual([
        join(fixtureRoot, 'defaults-pol'),
        join(realHome, 'user-pol'),
        join(policyRoot, 'env-pol'),
        shared,
        ...(trust === 'trusted' ? [join(cwd, 'ws-pol')] : []),
        join(fixtureRoot, 'system-pol'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it('appends no policy source where the user tier has none (gemini-55)', async () => {
    const { captured } = await runFixture({ skills: runSkills() });
    expect(captured.policy).toBe(ACTIVATE_SKILL_RULE);
    expect(captured.policies).toHaveLength(1);
  });

  const policyCases: {
    label: string;
    options: AgentOptions<GeminiEffort>;
    rules: string[];
    appended: boolean;
    denyFirst?: string;
  }[] = [
    {
      label: 'a permission-bearing policy',
      options: { permissions: { fileWrite: 'allow' } },
      rules: ['write_file', 'run_shell_command'],
      appended: false,
    },
    {
      label: 'an allowlist naming activate_skill',
      options: { allowedTools: ['read_file', 'activate_skill'] },
      rules: ['read_file', '*'],
      appended: false,
    },
    {
      label: 'auto mode',
      options: { permissions: { mode: 'auto' } },
      rules: [],
      appended: true,
    },
    {
      label: 'a disallowedTools list',
      options: { disallowedTools: ['run_shell_command'] },
      rules: ['run_shell_command'],
      appended: false,
      denyFirst: 'run_shell_command',
    },
  ];
  it.each(policyCases)(
    'opens activate_skill once beside $label (gemini-52)',
    async ({ options, rules, appended, denyFirst }) => {
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      const { captured } = await runFixture({
        skills: runSkills(),
        ...options,
      });
      expect(
        captured.policy!.split('toolName = "activate_skill"'),
      ).toHaveLength(2);
      expect(captured.policy).toContain(
        [
          'toolName = "activate_skill"',
          'decision = "allow"',
          'priority = 999',
          'interactive = false',
        ].join('\n'),
      );
      for (const tool of rules) {
        expect(captured.policy).toContain(`toolName = "${tool}"`);
      }
      if (denyFirst) {
        // gemini-29: a same-priority deny is serialized before the allow.
        const deny = captured.policy!.indexOf(
          [
            `toolName = "${denyFirst}"`,
            'decision = "deny"',
            'priority = 999',
            'interactive = false',
          ].join('\n'),
        );
        expect(deny).toBeGreaterThanOrEqual(0);
        expect(deny).toBeLessThan(
          captured.policy!.indexOf('toolName = "activate_skill"'),
        );
      }
      // gemini-55: the runtime's sources follow only a skills-only policy.
      expect(captured.policies.slice(1)).toEqual(
        appended ? [join(realGemini, 'policies')] : [],
      );
    },
  );

  it.each([undefined, []])(
    'generates no policy file without skills (%j, gemini-12)',
    async (skills) => {
      const { captured } = await runFixture(skills ? { skills } : {});
      expect(captured.policies).toEqual([]);
      expect(captured.args.some((arg) => arg.startsWith('--policy'))).toBe(
        false,
      );
    },
  );

  it.each([
    {
      label: 'a real-home working directory',
      setup: (): AgentOptions<GeminiEffort> => ({ cwd: realHome }),
      message:
        'skills for adapter "gemini" require a working directory different from its user home',
    },
    {
      label: 'a requested native sandbox',
      setup: (): AgentOptions<GeminiEffort> => {
        vi.stubEnv('GEMINI_SANDBOX', 'true');
        return {};
      },
      message:
        'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled',
    },
    {
      label: 'user settings disabling skills',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(join(realGemini, 'settings.json'), {
          skills: { enabled: false },
        });
        return {};
      },
      message: 'set skills.enabled to false',
    },
    {
      label: 'a skill path that fails preparation',
      setup: (): AgentOptions<GeminiEffort> => ({
        skills: [join(sources, 'missing')],
      }),
      message: 'skills[0] for adapter "gemini" must name a skill directory',
    },
  ])(
    'rejects $label before browser preparation (gemini-19, gemini-51)',
    async ({ setup, message }) => {
      const spawned: string[][] = [];
      const events = await collect(
        fixtureAdapter(spawned).run('Use the skills', {
          cwd,
          browser: true,
          skills: runSkills(),
          ...setup(),
        }),
      );
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      expect(events[1]!.payload).toMatchObject({
        code: 'GEMINI_STREAM_ERROR',
        recoverable: false,
      });
      expect((events[1]!.payload as { message: string }).message).toContain(
        message,
      );
      expect(events[2]!.payload).toMatchObject({ status: 'error' });
      expect(events[2]!.payload).not.toHaveProperty('result');
      expect(spawned).toEqual([]);
      expect(browserPreparation).not.toHaveBeenCalled();
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.each([
    {
      tools: { allowedTools: [] },
      message: 'require allowedTools to name activate_skill',
    },
    {
      tools: { allowedTools: ['read_file'] },
      message: 'require allowedTools to name activate_skill',
    },
    {
      tools: { disallowedTools: ['activate_skill'] },
      message: 'cannot be delivered while disallowedTools names activate_skill',
    },
  ])(
    'rejects a tool list excluding activate_skill: $tools (gemini-52)',
    async ({ tools, message }) => {
      const spawned: string[][] = [];
      const events: AgentEvent[] = [];
      let thrown: unknown;
      try {
        for await (const event of fixtureAdapter(spawned).run(
          'Use the skills',
          { cwd, browser: true, skills: runSkills(), ...tools },
        )) {
          events.push(event);
        }
      } catch (error) {
        thrown = error;
      }
      // Thrown before any event, as an invalid tool name is (gemini-13).
      expect(events).toEqual([]);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        `skills for adapter "gemini" ${message}`,
      );
      expect(spawned).toEqual([]);
      expect(browserPreparation).not.toHaveBeenCalled();
    },
  );

  it.each([
    { phase: 'skill preparation', hook: 'beforePrepare' as const },
    { phase: 'settings setup', hook: 'beforeMaterialize' as const },
  ])(
    'interrupts a run cancelled during $phase without spawning (gemini-51)',
    async ({ hook }) => {
      const abort = new AbortController();
      let reached = false;
      hooks[hook] = () => {
        reached = true;
        abort.abort();
      };
      const spawned: string[][] = [];
      const events = await collect(
        fixtureAdapter(spawned).run('Use the skills', {
          cwd,
          skills: runSkills(),
          abortSignal: abort.signal,
        }),
      );
      expect(reached).toBe(true);
      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(events[1]!.payload).toMatchObject({ status: 'interrupted' });
      expect(spawned).toEqual([]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.each(['comma,pol', 'trailing-pol '])(
    'rejects a policyPaths entry --policy would split or trim: %j (gemini-55)',
    async (entry) => {
      const path = join(fixtureRoot, entry);
      writeJson(join(realGemini, 'settings.json'), { policyPaths: [path] });
      const spawned: string[][] = [];
      const events = await collect(
        fixtureAdapter(spawned).run('Use the skills', {
          cwd,
          skills: runSkills(),
        }),
      );
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      expect(events[1]!.payload).toMatchObject({
        code: 'GEMINI_STREAM_ERROR',
        recoverable: false,
      });
      expect((events[1]!.payload as { message: string }).message).toContain(
        `Gemini policy path ${JSON.stringify(path)} cannot be passed through --policy`,
      );
      expect(events[2]!.payload).toMatchObject({ status: 'error' });
      expect(spawned).toEqual([]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it('rejects a per-run policy file under a comma-bearing temporary directory (gemini-55)', async () => {
    overlayTmp = join(fixtureRoot, 'tmp,dir');
    mkdirSync(overlayTmp);
    vi.stubEnv('TMPDIR', overlayTmp);
    vi.stubEnv('TMP', overlayTmp);
    vi.stubEnv('TEMP', overlayTmp);
    const spawned: string[][] = [];
    const events = await collect(
      fixtureAdapter(spawned).run('Use the skills', {
        cwd,
        skills: runSkills(),
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);
    const message = (events[1]!.payload as { message: string }).message;
    // The message names the per-run file, which lies under the directory.
    expect(message).toMatch(/^Gemini policy path "(.+)" cannot be passed/);
    const named = /^Gemini policy path "(.+?)"/.exec(message)![1]!;
    expect(named.startsWith(join(overlayTmp, 'cligent-gemini-policy-'))).toBe(
      true,
    );
    expect(named.endsWith('policy.toml')).toBe(true);
    expect(spawned).toEqual([]);
    // gemini-35: the overlay and the per-run policy file are both removed.
    expect(readdirSync(overlayTmp)).toEqual([]);
  });

  it('creates a missing real skills directory for an entry Gemini adds (gemini-45)', async () => {
    mkdirSync(realGemini);
    vi.stubEnv('CLIGENT_FIXTURE_ADD_SKILL', '1');

    await runFixture({ skills: runSkills() });

    expect(readdirSync(join(realGemini, 'skills'))).toEqual(['added-skill']);
    expect(
      readFileSync(
        join(realGemini, 'skills', 'added-skill', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('name: added-skill');
    expect(overlaysLeft()).toEqual([]);
  });

  it('never recreates a real .gemini removed during the run (gemini-45)', async () => {
    vi.stubEnv('CLIGENT_FIXTURE_REMOVE_GEMINI', realGemini);
    vi.stubEnv('CLIGENT_FIXTURE_ADD_SKILL', '1');
    const events: AgentEvent[] = [];
    let thrown: unknown;
    try {
      for await (const event of fixtureAdapter().run('Use the skills', {
        cwd,
        skills: runSkills(),
      })) {
        events.push(event);
      }
    } catch (error) {
      thrown = error;
    }

    // The run completes; only its cleanup rejects, naming each entry.
    expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(
      (thrown as AggregateError).errors.map((error: Error) => error.message),
    ).toEqual([
      expect.stringContaining(
        `Unable to reconcile Gemini home entry ${join(realGemini, 'state.json')}: `,
      ),
      expect.stringContaining(
        `Unable to reconcile Gemini home entry ${join(realGemini, 'skills', 'added-skill')}: `,
      ),
    ]);
    expect(existsSync(realGemini)).toBe(false);
    expect(overlaysLeft()).toEqual([]);
  });
});
