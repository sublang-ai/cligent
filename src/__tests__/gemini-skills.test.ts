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
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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
  cwd: process.cwd(),
  home,
  trust: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? null,
  lowerTrust: process.env.gemini_cli_trust_workspace ?? null,
  lowerHome: process.env.gemini_cli_home ?? null,
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
  cwd: string;
  home: string;
  trust: string | null;
  lowerTrust: string | null;
  lowerHome: string | null;
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

/**
 * The working directory a child started in `path` reports: its real path,
 * or the path itself on Windows (gemini-34).
 */
function childCwdOf(path: string): string {
  return process.platform === 'win32' ? path : realpathSync.native(path);
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

type SystemFileAdmission = (
  path: string,
) => Promise<'admitted' | 'rejected' | 'unknown'>;

/**
 * The rejection of a run whose decision depends on whether the runtime's
 * validation accepts a settings file holding one coerced string (gemini-51).
 */
function coercionRefusal(
  file: string,
  setting: string,
  decision: string,
): string {
  return `skills for adapter "gemini" cannot be delivered while the runtime's coercion of ${setting} in the Gemini ${file} would change ${decision}, because the runtime coerces that string only where the whole file validates, which this adapter does not check`;
}

/**
 * Admits every system file and records each path checked: a test cannot
 * create the root-owned files the runtime's own check admits (gemini-34).
 */
function admitAll(checked: string[] = []): SystemFileAdmission {
  return async (path) => {
    checked.push(path);
    return 'admitted';
  };
}

/**
 * A fixture-backed adapter; `admissionPlatform` selects the platform whose
 * admission rule the adapter's own check applies, and `environmentPlatform`
 * the platform whose rules for naming variables the child's environment
 * follows (gemini-56).
 */
function fixtureAdapter(
  spawned: string[][] = [],
  admitsSystemSettingsFile?: SystemFileAdmission,
  admissionPlatform?: NodeJS.Platform,
  environmentPlatform?: NodeJS.Platform,
): GeminiAdapter {
  return new GeminiAdapter({
    ...(admitsSystemSettingsFile ? { admitsSystemSettingsFile } : {}),
    ...(admissionPlatform ? { admissionPlatform } : {}),
    ...(environmentPlatform ? { environmentPlatform } : {}),
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
  admitsSystemSettingsFile?: SystemFileAdmission,
  admissionPlatform?: NodeJS.Platform,
  environmentPlatform?: NodeJS.Platform,
): Promise<{ events: AgentEvent[]; captured: Captured }> {
  const events = await collect(
    fixtureAdapter(
      [],
      admitsSystemSettingsFile,
      admissionPlatform,
      environmentPlatform,
    ).run('Use the skills', { cwd, ...options }),
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
      // A colon names no skill, the runtime replacing each `:` in a skill's
      // name, and, still a string, keeps the runtime's validation of the
      // file failing as it did (gemini-34).
      label: "a run skill's case variant",
      disabled: 'Alpha',
      expected: { skills: { disabled: ':', kept: 1 } },
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

  it('drops each skills.disabled entry whose expanded value names a run skill, writing the others as given (gemini-51)', async () => {
    // Expanded first, then folded as Gemini compares skill names.
    vi.stubEnv('RUN_SKILL', 'ALPHA');
    vi.stubEnv('OTHER_SKILL', 'gamma');
    const userSettings = JSON.stringify({
      skills: { disabled: ['$RUN_SKILL', '${OTHER_SKILL}'] },
    });
    mkdirSync(realGemini);
    writeFileSync(join(realGemini, 'settings.json'), userSettings);

    const { captured } = await runFixture({ skills: runSkills() });

    // gemini-34: the entry naming ALPHA once expanded is dropped; the entry
    // naming another skill stays as written.
    expect(captured.settings).toEqual({
      skills: { disabled: ['${OTHER_SKILL}'] },
    });
    expect(readFileSync(join(realGemini, 'settings.json'), 'utf8')).toBe(
      userSettings,
    );
    expect(overlaysLeft()).toEqual([]);
  });

  it.each([
    {
      label: "a workspace's null tools over a user sandbox request",
      user: { tools: { sandbox: true } },
      workspace: { tools: null },
    },
    {
      label: 'an enabled sandbox object with an empty command',
      user: { tools: { sandbox: { enabled: true, command: '' } } },
    },
    {
      label: 'a sandbox of ${USE_SANDBOX:-false} with USE_SANDBOX unset',
      user: { tools: { sandbox: '${USE_SANDBOX:-false}' } },
    },
    {
      // Layer order: the system settings override the workspace.
      label: 'admitted system settings disabling a trusted workspace request',
      system: { tools: { sandbox: false } },
      workspace: { tools: { sandbox: true } },
    },
    {
      // An array replaces the object rather than merging into it.
      label: 'a trusted workspace sandbox list over a user docker object',
      user: { tools: { sandbox: { enabled: true, command: 'docker' } } },
      workspace: { tools: { sandbox: [] } },
    },
    {
      // Expanded, then made a boolean, in the workspace layer too.
      label:
        'a trusted workspace sandbox of ${WS_SANDBOX:-true} with WS_SANDBOX=false',
      workspace: { tools: { sandbox: '${WS_SANDBOX:-true}' } },
      env: { WS_SANDBOX: 'false' },
    },
    {
      // A variable set to the empty string takes that value, not the default.
      label: 'a sandbox of ${EMPTY_SANDBOX:-docker} with EMPTY_SANDBOX empty',
      user: { tools: { sandbox: '${EMPTY_SANDBOX:-docker}' } },
      env: { EMPTY_SANDBOX: '' },
    },
  ] satisfies {
    label: string;
    user?: Record<string, unknown>;
    workspace?: Record<string, unknown>;
    system?: Record<string, unknown>;
    env?: Record<string, string>;
  }[])(
    'delivers skills where the evaluated, merged settings start no sandbox: $label (gemini-34)',
    async (layers) => {
      vi.stubEnv('USE_SANDBOX', undefined);
      for (const [name, value] of Object.entries(
        'env' in layers ? layers.env : {},
      )) {
        vi.stubEnv(name, value);
      }
      if ('user' in layers) {
        writeJson(join(realGemini, 'settings.json'), layers.user);
      }
      // The default GEMINI_CLI_TRUST_WORKSPACE trusts the workspace.
      if ('workspace' in layers) {
        writeJson(join(cwd, '.gemini', 'settings.json'), layers.workspace);
      }
      if ('system' in layers) {
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, layers.system);
      }

      const { captured } = await runFixture(
        { skills: runSkills() },
        admitAll(),
      );

      expect(captured.skills!.map((entry) => entry.name).sort()).toEqual([
        'alpha',
        'beta',
        'my-tool',
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it('skips a __proto__ key in user settings, leaving Object.prototype unchanged (gemini-34)', async () => {
    mkdirSync(realGemini);
    writeFileSync(
      join(realGemini, 'settings.json'),
      '{"__proto__":{"tools":{"sandbox":true}}}',
    );

    try {
      const { captured } = await runFixture({ skills: runSkills() });

      // No sandbox request merges, so the skills are delivered.
      expect(captured.skills!.map((entry) => entry.name).sort()).toEqual([
        'alpha',
        'beta',
        'my-tool',
      ]);
      expect(Object.prototype).not.toHaveProperty('tools');
    } finally {
      delete (Object.prototype as Record<string, unknown>).tools;
    }
    expect(overlaysLeft()).toEqual([]);
  });

  // Other platforms find no sandbox command for a value neither true nor a
  // string; the host stands in for each.
  it.skipIf(process.platform === 'win32').each([
    { platform: 'darwin' as const, rejected: true },
    { platform: 'linux' as const, rejected: false },
  ])(
    'treats a numeric tools.sandbox as a request only on macOS, whose sandbox-exec always exists ($platform, gemini-34, gemini-51)',
    async ({ platform, rejected }) => {
      writeJson(join(realGemini, 'settings.json'), { tools: { sandbox: 1 } });
      const host = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...host, value: platform });
      const spawned: string[][] = [];
      let events: AgentEvent[];
      try {
        events = await collect(
          fixtureAdapter(spawned).run('Use the skills', {
            cwd,
            skills: [writeSkill(sources, 'alpha', 'alpha')],
          }),
        );
      } finally {
        Object.defineProperty(process, 'platform', host);
      }

      if (rejected) {
        expect((events[1]!.payload as { message: string }).message).toBe(
          'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled',
        );
        expect(spawned).toEqual([]);
      } else {
        expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
        expect(spawned).toHaveLength(1);
      }
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.each(['false', 'FALSE', '${UNSET_TRUST:-false}'])(
    'rejects user settings setting folder trust to %j, which the runtime coerces only where the whole file validates (gemini-34, gemini-51, gemini-55)',
    async (enabled) => {
      // Expanded before it is read.
      vi.stubEnv('UNSET_TRUST', undefined);
      // Present but neither 'true' nor 'false': the trust settings decide.
      vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      writeJson(join(realGemini, 'settings.json'), {
        security: { folderTrust: { enabled } },
      });
      writeJson(join(cwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol'],
      });
      const spawned: string[][] = [];

      const events = await collect(
        fixtureAdapter(spawned).run('Use the skills', {
          cwd,
          skills: [writeSkill(sources, 'alpha', 'alpha')],
        }),
      );

      // Coerced, folder trust is off and the workspace policyPaths merge;
      // as written, the string turns folder trust on, no rule trusts the
      // workspace, and the user policy directory is the source.
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      expect(events[1]!.payload).toMatchObject({
        code: 'GEMINI_STREAM_ERROR',
        recoverable: false,
      });
      expect((events[1]!.payload as { message: string }).message).toBe(
        coercionRefusal(
          `user settings at ${join(realGemini, 'settings.json')}`,
          'security.folderTrust.enabled',
          'its policy sources',
        ),
      );
      expect(events[2]!.payload).toMatchObject({ status: 'error' });
      expect(spawned).toEqual([]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.each([
    { label: 'a rule trusting the run cwd', trusted: true },
    { label: 'no rule', trusted: false },
  ])(
    'reads a user folder trust of "TRUE" alike as written and coerced, the trusted-folders file deciding with $label (gemini-34, gemini-51, gemini-55)',
    async ({ trusted }) => {
      // Present but neither 'true' nor 'false': the trust settings decide.
      vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      writeJson(join(realGemini, 'settings.json'), {
        security: { folderTrust: { enabled: 'TRUE' } },
      });
      if (trusted) {
        writeJson(join(realGemini, 'trustedFolders.json'), {
          '.': 'TRUST_FOLDER',
        });
      }
      writeJson(join(cwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol'],
      });

      const { captured } = await runFixture({
        skills: [writeSkill(sources, 'alpha', 'alpha')],
      });

      // Truthy either way, folder trust is on, so no rejection names the
      // string and the trusted-folders file decides.
      expect(captured.policies.slice(1)).toEqual(
        trusted
          ? [join(childCwdOf(cwd), 'ws-pol')]
          : [join(realGemini, 'policies')],
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
      // gemini-34: every layer expands its strings.
      writeJson(join(system, 'system-defaults.json'), {
        policyPaths: [
          join(fixtureRoot, 'defaults-pol'),
          '$CLIGENT_POLICY_ROOT/defaults-env-pol',
        ],
      });
      writeJson(join(realGemini, 'settings.json'), {
        policyPaths: ['~/user-pol', '$CLIGENT_POLICY_ROOT/env-pol', shared],
      });
      writeJson(join(cwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol', shared, '${CLIGENT_POLICY_ROOT}/ws-env-pol'],
      });
      // A lone value counts as a one-entry list.
      writeJson(join(system, 'settings.json'), {
        policyPaths: join(fixtureRoot, 'system-pol'),
      });
      writeJson(join(realGemini, 'trustedFolders.json'), {
        [trust === 'trusted' ? cwd : join(fixtureRoot, 'elsewhere')]:
          'TRUST_FOLDER',
      });

      const { captured } = await runFixture(
        { skills: runSkills() },
        admitAll(),
      );

      expect(captured.policy).toBe(ACTIVATE_SKILL_RULE);
      expect(captured.trust).toBe('');
      expect(captured.policies.slice(1)).toEqual([
        join(fixtureRoot, 'defaults-pol'),
        join(policyRoot, 'defaults-env-pol'),
        join(realHome, 'user-pol'),
        join(policyRoot, 'env-pol'),
        shared,
        ...(trust === 'trusted'
          ? [join(childCwdOf(cwd), 'ws-pol'), join(policyRoot, 'ws-env-pol')]
          : []),
        join(fixtureRoot, 'system-pol'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it('unions a lone system-defaults policyPaths value with the user list, each path once (gemini-34, gemini-55)', async () => {
    const first = join(fixtureRoot, 'first-pol');
    const second = join(fixtureRoot, 'second-pol');
    // gemini-34: the schema's empty list seeds the merge, so even the first
    // layer's lone value joins it.
    writeJson(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, {
      policyPaths: first,
    });
    writeJson(join(realGemini, 'settings.json'), {
      policyPaths: [second, first],
    });

    const { captured } = await runFixture(
      { skills: [writeSkill(sources, 'alpha', 'alpha')] },
      admitAll(),
    );

    expect(captured.policies.slice(1)).toEqual([first, second]);
    expect(overlaysLeft()).toEqual([]);
  });

  it('splices a policyPaths home prefix onto the home as spelled before normalizing (gemini-55)', async () => {
    // The child's resolvePath appends the rest to GEMINI_CLI_HOME verbatim,
    // so the trailing separator keeps the entry inside the home.
    vi.stubEnv('GEMINI_CLI_HOME', `${realHome}/`);
    writeJson(join(realGemini, 'settings.json'), {
      policyPaths: ['%USERPROFILE%pol'],
    });

    const { captured } = await runFixture({
      skills: [writeSkill(sources, 'alpha', 'alpha')],
    });

    expect(captured.policies.slice(1)).toEqual([join(realHome, 'pol')]);
    expect(overlaysLeft()).toEqual([]);
  });

  it('drops empty and null policyPaths entries without falling back to the user policy directory (gemini-55)', async () => {
    mkdirSync(join(realGemini, 'policies'), { recursive: true });
    // A non-empty merged list replaces the user policy directory even where
    // the child resolves every entry empty and filters it out.
    writeJson(join(realGemini, 'settings.json'), { policyPaths: ['', null] });

    const { captured } = await runFixture({
      skills: [writeSkill(sources, 'alpha', 'alpha')],
    });

    expect(captured.policy).toBe(ACTIVATE_SKILL_RULE);
    expect(captured.policies.slice(1)).toEqual([]);
    expect(overlaysLeft()).toEqual([]);
  });

  it.each([{ platform: 'win32' as const }, { platform: process.platform }])(
    'matches a settings variable named in another letter case only on Windows, which names variables case-insensitively ($platform, gemini-56, gemini-34, gemini-55)',
    async ({ platform }) => {
      const root = join(fixtureRoot, 'mixed-root');
      vi.stubEnv('Cligent_Mixed_Root', root);
      writeJson(join(realGemini, 'settings.json'), {
        policyPaths: ['$CLIGENT_MIXED_ROOT/pol'],
      });

      const { captured } = await runFixture(
        { skills: [writeSkill(sources, 'alpha', 'alpha')] },
        undefined,
        undefined,
        platform,
      );

      // Elsewhere the variable is unset, so the entry stays as written.
      expect(captured.policies.slice(1)).toEqual([
        platform === 'win32'
          ? join(root, 'pol')
          : join(childCwdOf(cwd), '$CLIGENT_MIXED_ROOT', 'pol'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it('expands policyPaths in the environment the child gets, an unset variable staying as written (gemini-34, gemini-55)', async () => {
    vi.stubEnv('UNSET_POLICY_VAR', undefined);
    // GEMINI_CLI_TRUST_WORKSPACE is unset here, so the child gets 'true'.
    writeJson(join(realGemini, 'settings.json'), {
      policyPaths: [
        '$UNSET_POLICY_VAR/pol',
        join(fixtureRoot, 'trust-$GEMINI_CLI_TRUST_WORKSPACE'),
      ],
    });

    const { captured } = await runFixture({
      skills: [writeSkill(sources, 'alpha', 'alpha')],
    });

    expect(captured.policies.slice(1)).toEqual([
      join(childCwdOf(cwd), '$UNSET_POLICY_VAR', 'pol'),
      join(fixtureRoot, 'trust-true'),
    ]);
    expect(overlaysLeft()).toEqual([]);
  });

  it('reads the system defaults beside the system settings where GEMINI_CLI_SYSTEM_DEFAULTS_PATH is empty (gemini-34)', async () => {
    vi.stubEnv('GEMINI_CLI_SYSTEM_DEFAULTS_PATH', '');
    writeJson(join(fixtureRoot, 'system', 'system-defaults.json'), {
      policyPaths: [join(fixtureRoot, 'defaults-pol')],
    });

    const { captured } = await runFixture(
      { skills: [writeSkill(sources, 'alpha', 'alpha')] },
      admitAll(),
    );

    expect(captured.policies.slice(1)).toEqual([
      join(fixtureRoot, 'defaults-pol'),
    ]);
    expect(overlaysLeft()).toEqual([]);
  });

  it.each([
    { label: 'unset', env: {}, expanded: 'true' },
    // Only a non-empty value stops the relaunch, which sets it to 'true'.
    {
      label: 'set to the empty string',
      env: { GEMINI_CLI_NO_RELAUNCH: '' },
      expanded: 'true',
    },
    // No relaunch inside a sandbox, so the variable stays unset.
    {
      label: 'unset under a SANDBOX',
      env: { SANDBOX: 'docker' },
      expanded: '$GEMINI_CLI_NO_RELAUNCH',
    },
  ])(
    'expands GEMINI_CLI_NO_RELAUNCH as the process the runtime relaunches to load its settings holds it: $label (gemini-34, gemini-55)',
    async ({ env, expanded }) => {
      vi.stubEnv('GEMINI_CLI_NO_RELAUNCH', undefined);
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      writeJson(join(realGemini, 'settings.json'), {
        policyPaths: [join(fixtureRoot, 'relaunch-$GEMINI_CLI_NO_RELAUNCH')],
      });

      const { captured } = await runFixture({
        skills: [writeSkill(sources, 'alpha', 'alpha')],
      });

      expect(captured.policies.slice(1)).toEqual([
        join(fixtureRoot, `relaunch-${expanded}`),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads a settings variable as the first of its case variants spawn keeps on Windows (gemini-56, gemini-34, gemini-55)',
    async () => {
      // Spawn sorts the names, so the upper-case variant comes first and is
      // the one a Windows child holds.
      vi.stubEnv('CLIGENT_ROOT', join(fixtureRoot, 'upper-root'));
      vi.stubEnv('cligent_root', join(fixtureRoot, 'lower-root'));
      writeJson(join(realGemini, 'settings.json'), {
        policyPaths: ['$cligent_root/pol'],
      });

      const { captured } = await runFixture(
        { skills: [writeSkill(sources, 'alpha', 'alpha')] },
        undefined,
        undefined,
        'win32',
      );

      expect(captured.policies.slice(1)).toEqual([
        join(fixtureRoot, 'upper-root', 'pol'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps a lower-case gemini_cli_trust_workspace=false on Windows, adding no default and reading it as false (gemini-10, gemini-34, gemini-55)',
    async () => {
      vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', undefined);
      vi.stubEnv('gemini_cli_trust_workspace', 'false');
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      // The rule and the default 'true' would each trust the workspace.
      writeJson(join(realGemini, 'trustedFolders.json'), {
        '.': 'TRUST_FOLDER',
      });
      writeJson(join(cwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol'],
      });

      const { captured } = await runFixture(
        { skills: [writeSkill(sources, 'alpha', 'alpha')] },
        undefined,
        undefined,
        'win32',
      );

      expect(captured.trust).toBeNull();
      expect(captured.lowerTrust).toBe('false');
      // Untrusted, the workspace policyPaths stay unmerged.
      expect(captured.policies.slice(1)).toEqual([
        join(realGemini, 'policies'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads a lower-case gemini_cli_home as the real home on Windows and replaces it with the overlay (gemini-56, gemini-34)',
    async () => {
      vi.stubEnv('GEMINI_CLI_HOME', undefined);
      vi.stubEnv('gemini_cli_home', realHome);
      // The operating-system home, were the variant not read, is elsewhere.
      vi.stubEnv('HOME', join(fixtureRoot, 'os-home'));
      writeJson(join(realGemini, 'settings.json'), { custom: 'real' });

      const { captured } = await runFixture(
        { skills: [writeSkill(sources, 'alpha', 'alpha')] },
        undefined,
        undefined,
        'win32',
      );

      // The overlay holds the real home's settings, and the child receives
      // only the overlay under that name.
      expect(captured.settings).toEqual({ custom: 'real' });
      expect(captured.home).not.toBe(realHome);
      expect(captured.lowerHome).toBeNull();
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it('honors a lower-case gemini_cli_system_settings_path override on Windows (gemini-56, gemini-34, gemini-55)', async () => {
    const systemPath = join(fixtureRoot, 'lower-system', 'settings.json');
    vi.stubEnv('GEMINI_CLI_SYSTEM_SETTINGS_PATH', undefined);
    vi.stubEnv('gemini_cli_system_settings_path', systemPath);
    writeJson(systemPath, { policyPaths: [join(fixtureRoot, 'system-pol')] });
    const checked: string[] = [];

    const { captured } = await runFixture(
      { skills: [writeSkill(sources, 'alpha', 'alpha')] },
      admitAll(checked),
      undefined,
      'win32',
    );

    expect(checked).toContain(systemPath);
    expect(captured.policies.slice(1)).toEqual([
      join(fixtureRoot, 'system-pol'),
    ]);
    expect(overlaysLeft()).toEqual([]);
  });

  /** Writes a `.env` file, creating its directory. */
  function writeEnvFile(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  const sandboxRefusal =
    'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled';
  it.each([
    {
      label: 'a trusted workspace .gemini/.env setting GEMINI_SANDBOX=docker',
      arrange: () => {
        writeEnvFile(join(cwd, '.gemini', '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: sandboxRefusal,
    },
    {
      // Only authentication variables load into an untrusted workspace.
      label:
        'that .gemini/.env in a workspace GEMINI_CLI_TRUST_WORKSPACE=false distrusts, beside its .env',
      arrange: () => {
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', 'false');
        writeEnvFile(join(cwd, '.gemini', '.env'), 'GEMINI_SANDBOX=docker\n');
        writeEnvFile(join(cwd, '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: 'delivered',
    },
    {
      // The runtime loads its .env trusting the workspace as the merged
      // settings decide, the trusted workspace's own folder-trust setting
      // included: here it turns folder trust back on, and no rule trusts.
      label:
        'that .gemini/.env in a workspace trusted by user settings disabling folder trust, whose own settings enable it under file-based trust with no rule',
      arrange: () => {
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
        writeJson(join(realGemini, 'settings.json'), {
          security: { folderTrust: { enabled: false } },
        });
        writeJson(join(cwd, '.gemini', 'settings.json'), {
          security: { folderTrust: { enabled: true } },
        });
        writeEnvFile(join(cwd, '.gemini', '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: 'delivered',
    },
    {
      // A variable the child already holds keeps its value.
      label: 'that .gemini/.env beside a parent GEMINI_SANDBOX=false',
      arrange: () => {
        vi.stubEnv('GEMINI_SANDBOX', 'false');
        writeEnvFile(join(cwd, '.gemini', '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: 'delivered',
    },
    {
      label: 'a project .env setting GEMINI_SANDBOX=docker',
      arrange: () => {
        writeEnvFile(join(cwd, '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: sandboxRefusal,
    },
    {
      label:
        'that project .env under user advanced.excludedEnvVars naming GEMINI_SANDBOX',
      arrange: () => {
        writeJson(join(realGemini, 'settings.json'), {
          advanced: { excludedEnvVars: ['GEMINI_SANDBOX'] },
        });
        writeEnvFile(join(cwd, '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: 'delivered',
    },
    {
      // The exclusions apply only to a file whose path lacks .gemini.
      label:
        'a .gemini/.env under user advanced.excludedEnvVars naming GEMINI_SANDBOX',
      arrange: () => {
        writeJson(join(realGemini, 'settings.json'), {
          advanced: { excludedEnvVars: ['GEMINI_SANDBOX'] },
        });
        writeEnvFile(join(cwd, '.gemini', '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: sandboxRefusal,
    },
    {
      // The union with the schema's default list makes the lone string one
      // entry, not a string GEMINI_SANDBOX is a part of.
      label:
        'that project .env under a lone-string user advanced.excludedEnvVars of GEMINI_SANDBOX_OTHER',
      arrange: () => {
        writeJson(join(realGemini, 'settings.json'), {
          advanced: { excludedEnvVars: 'GEMINI_SANDBOX_OTHER' },
        });
        writeEnvFile(join(cwd, '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: sandboxRefusal,
    },
    {
      label: 'that project .env under user advanced.ignoreLocalEnv',
      arrange: () => {
        writeJson(join(realGemini, 'settings.json'), {
          advanced: { ignoreLocalEnv: true },
        });
        writeEnvFile(join(cwd, '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: 'delivered',
    },
    {
      label: 'a .gemini/.env under user advanced.ignoreLocalEnv',
      arrange: () => {
        writeJson(join(realGemini, 'settings.json'), {
          advanced: { ignoreLocalEnv: true },
        });
        writeEnvFile(join(cwd, '.gemini', '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: sandboxRefusal,
    },
    {
      // gemini-34, gemini-51: coerced, the string loads the project .env;
      // as written, it ignores it.
      label: 'that project .env under user advanced.ignoreLocalEnv of "false"',
      arrange: () => {
        writeJson(join(realGemini, 'settings.json'), {
          advanced: { ignoreLocalEnv: 'false' },
        });
        writeEnvFile(join(cwd, '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: () =>
        coercionRefusal(
          `user settings at ${join(realGemini, 'settings.json')}`,
          'advanced.ignoreLocalEnv',
          'whether its native sandbox starts',
        ),
    },
    {
      // gemini-34, gemini-51: an exact "false" at a top-level tools.sandbox
      // requests no sandbox as written or coerced, so only the
      // advanced.ignoreLocalEnv string is named.
      label:
        'that project .env under user advanced.ignoreLocalEnv of "false" beside a tools.sandbox of "false"',
      arrange: () => {
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: 'false' },
          advanced: { ignoreLocalEnv: 'false' },
        });
        writeEnvFile(join(cwd, '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: () =>
        coercionRefusal(
          `user settings at ${join(realGemini, 'settings.json')}`,
          'advanced.ignoreLocalEnv',
          'whether its native sandbox starts',
        ),
    },
    {
      // The search climbs from the run cwd.
      label: 'a project .env two directories above the run cwd',
      arrange: () => {
        writeEnvFile(join(cwd, '.env'), 'GEMINI_SANDBOX=docker\n');
        const runCwd = join(cwd, 'a', 'b');
        mkdirSync(runCwd, { recursive: true });
        return runCwd;
      },
      outcome: sandboxRefusal,
    },
    {
      // The first file found in a directory is the one loaded.
      label:
        'a trusted workspace .gemini/.env setting another variable beside a project .env setting GEMINI_SANDBOX=docker',
      arrange: () => {
        writeEnvFile(join(cwd, '.gemini', '.env'), 'OTHER_VAR=1\n');
        writeEnvFile(join(cwd, '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: 'delivered',
    },
    {
      // Past the root, the home's files are the fallback.
      label:
        "the home's .gemini/.env setting GEMINI_SANDBOX=docker, the run cwd outside the home",
      arrange: () => {
        writeEnvFile(join(realGemini, '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: sandboxRefusal,
    },
    {
      label:
        "the home's .env setting GEMINI_SANDBOX=docker, the run cwd outside the home",
      arrange: () => {
        writeEnvFile(join(realHome, '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: sandboxRefusal,
    },
    {
      // Climbing through the home as the child spells it, its .env loads
      // despite advanced.ignoreLocalEnv, before the .gemini/.env above it.
      label:
        "the home's .env under user advanced.ignoreLocalEnv, the run cwd inside the home, beside a .gemini/.env above the home",
      arrange: () => {
        vi.stubEnv('GEMINI_CLI_HOME', childCwdOf(realHome));
        writeJson(join(realGemini, 'settings.json'), {
          advanced: { ignoreLocalEnv: true },
        });
        writeEnvFile(join(realHome, '.env'), 'GEMINI_SANDBOX=docker\n');
        writeEnvFile(join(fixtureRoot, '.gemini', '.env'), 'OTHER_VAR=1\n');
        const runCwd = join(realHome, 'proj');
        mkdirSync(runCwd);
        return runCwd;
      },
      outcome: sandboxRefusal,
    },
    {
      // A variable present, even empty, is never replaced.
      label:
        'a .gemini/.env setting GEMINI_SANDBOX=docker beside a parent GEMINI_SANDBOX set to the empty string',
      arrange: () => {
        vi.stubEnv('GEMINI_SANDBOX', '');
        writeEnvFile(join(cwd, '.gemini', '.env'), 'GEMINI_SANDBOX=docker\n');
      },
      outcome: 'delivered',
    },
    {
      label:
        'an export-prefixed, double-quoted GEMINI_SANDBOX of false with a comment, beside a user sandbox request',
      arrange: () => {
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: true },
        });
        writeEnvFile(
          join(cwd, '.gemini', '.env'),
          '# comment\nexport GEMINI_SANDBOX="false" # trailing\n',
        );
      },
      outcome: 'delivered',
    },
    {
      label:
        "a single-quoted GEMINI_SANDBOX of 'false', beside a user sandbox request",
      arrange: () => {
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: true },
        });
        writeEnvFile(join(cwd, '.gemini', '.env'), "GEMINI_SANDBOX='false'\n");
      },
      outcome: 'delivered',
    },
    {
      label:
        'a CRLF file setting GEMINI_SANDBOX: false, beside a user sandbox request',
      arrange: () => {
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: true },
        });
        writeEnvFile(
          join(cwd, '.gemini', '.env'),
          'OTHER=1\r\nGEMINI_SANDBOX: false\r\n',
        );
      },
      outcome: 'delivered',
    },
    {
      // The child takes itself to be inside a sandbox already.
      label: 'SANDBOX=1, beside a user sandbox request',
      arrange: () => {
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: true },
        });
        writeEnvFile(join(cwd, '.gemini', '.env'), 'SANDBOX=1\n');
      },
      outcome: 'delivered',
    },
  ] satisfies {
    label: string;
    // Returns the run cwd where it is not the default.
    arrange: () => string | void;
    outcome: string | (() => string);
  }[])(
    'decides the sandbox in the environment the child loads its .env into: $label (gemini-34, gemini-51)',
    async ({ arrange, outcome }) => {
      const runCwd = arrange() ?? cwd;
      const spawned: string[][] = [];

      const events = await collect(
        fixtureAdapter(spawned).run('Use the skills', {
          cwd: runCwd,
          skills: [writeSkill(sources, 'alpha', 'alpha')],
        }),
      );

      const expected = typeof outcome === 'function' ? outcome() : outcome;
      if (expected === 'delivered') {
        expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
        expect(spawned).toHaveLength(1);
      } else {
        expect(events.map((event) => event.type)).toEqual([
          'init',
          'error',
          'done',
        ]);
        expect(events[1]!.payload).toMatchObject({
          code: 'GEMINI_STREAM_ERROR',
          recoverable: false,
        });
        expect((events[1]!.payload as { message: string }).message).toBe(
          expected,
        );
        expect(events[2]!.payload).toMatchObject({ status: 'error' });
        expect(spawned).toEqual([]);
      }
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps a parent lower-case gemini_sandbox=false on Windows over a .gemini/.env setting GEMINI_SANDBOX=docker (gemini-56, gemini-34)',
    async () => {
      vi.stubEnv('gemini_sandbox', 'false');
      writeEnvFile(join(cwd, '.gemini', '.env'), 'GEMINI_SANDBOX=docker\n');
      const spawned: string[][] = [];

      // The variable is present in another letter case, so the file's
      // value never loads and the parent's disables the sandbox.
      const events = await collect(
        fixtureAdapter(spawned, undefined, undefined, 'win32').run(
          'Use the skills',
          { cwd, skills: [writeSkill(sources, 'alpha', 'alpha')] },
        ),
      );

      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      expect(spawned).toHaveLength(1);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it('appends no policy source where the user tier has none (gemini-55)', async () => {
    const { captured } = await runFixture({ skills: runSkills() });
    expect(captured.policy).toBe(ACTIVATE_SKILL_RULE);
    expect(captured.policies).toHaveLength(1);
  });

  /**
   * System settings and defaults that request the sandbox, disable folder
   * trust, and name policyPaths, beside a workspace naming its own
   * policyPaths in a workspace no trusted-folders rule trusts.
   */
  function writeSystemLayers(
    settingsPath: string,
    defaultsPath: string,
    sandbox: boolean,
  ): void {
    const tools = sandbox ? { tools: { sandbox: true } } : {};
    writeJson(settingsPath, {
      ...tools,
      security: { folderTrust: { enabled: false } },
      policyPaths: [join(fixtureRoot, 'system-pol')],
    });
    writeJson(defaultsPath, {
      ...tools,
      security: { folderTrust: { enabled: false } },
      policyPaths: [join(fixtureRoot, 'defaults-pol')],
    });
    writeJson(join(cwd, '.gemini', 'settings.json'), {
      policyPaths: ['ws-pol'],
    });
    mkdirSync(join(realGemini, 'policies'), { recursive: true });
    // Present but neither 'true' nor 'false': the trust settings decide.
    vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
  }

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'ignores user-owned system settings and defaults the runtime would not admit (gemini-34, gemini-55)',
    async () => {
      const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
      const defaultsPath = process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!;
      writeSystemLayers(settingsPath, defaultsPath, true);
      for (const path of [settingsPath, defaultsPath]) {
        expect(statSync(path).uid).toBe(process.getuid!());
      }

      // The adapter's own admission check decides.
      const { captured } = await runFixture({ skills: runSkills() });

      // gemini-34: no sandbox request, so the skills are delivered.
      expect(captured.skills!.map((entry) => entry.name).sort()).toEqual([
        'alpha',
        'beta',
        'my-tool',
      ]);
      // gemini-55: folder trust stays on, leaving the workspace untrusted and
      // its policyPaths unmerged, and no system policyPaths are imported, so
      // the user's default policy directory is appended instead.
      expect(captured.policy).toBe(ACTIVATE_SKILL_RULE);
      expect(captured.policies.slice(1)).toEqual([
        join(realGemini, 'policies'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it('honors the folder trust and policyPaths of admitted system settings and defaults (gemini-34, gemini-55)', async () => {
    const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
    const defaultsPath = process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!;
    writeSystemLayers(settingsPath, defaultsPath, false);
    const checked: string[] = [];

    const { captured } = await runFixture(
      { skills: runSkills() },
      admitAll(checked),
    );

    expect(new Set(checked)).toEqual(new Set([settingsPath, defaultsPath]));
    // gemini-55: folder trust off trusts the workspace, merging its
    // policyPaths between the system defaults' and the system settings'.
    expect(captured.policies.slice(1)).toEqual([
      join(fixtureRoot, 'defaults-pol'),
      join(childCwdOf(cwd), 'ws-pol'),
      join(fixtureRoot, 'system-pol'),
    ]);
    expect(overlaysLeft()).toEqual([]);
  });

  /**
   * A run cwd at <fixtureRoot>/link, a symbolic link to the directory
   * <fixtureRoot>/data/proj, so a path climbing out of it with `..` names a
   * different file for the child, whose working directory is the physical
   * one, than lexical resolution names (gemini-34).
   */
  function linkedRunCwd(): { runCwd: string; data: string } {
    const data = join(fixtureRoot, 'data');
    mkdirSync(join(data, 'proj'), { recursive: true });
    const runCwd = join(fixtureRoot, 'link');
    symlinkSync(join(data, 'proj'), runCwd, 'dir');
    return { runCwd, data: realpathSync(data) };
  }

  // On Windows the child's working directory is the run cwd as given.
  it.skipIf(process.platform === 'win32')(
    'resolves relative system, trusted-folders, and home overrides against the physical run cwd (gemini-34, gemini-55)',
    async () => {
      const { runCwd, data } = linkedRunCwd();
      // Each override climbs out of the run cwd; a decoy waits where lexical
      // resolution from the link lands.
      vi.stubEnv('GEMINI_CLI_SYSTEM_SETTINGS_PATH', '../sys/settings.json');
      vi.stubEnv('GEMINI_CLI_SYSTEM_DEFAULTS_PATH', '../sys/defaults.json');
      vi.stubEnv('GEMINI_CLI_TRUSTED_FOLDERS_PATH', '../trusted.json');
      vi.stubEnv('GEMINI_CLI_HOME', '../home');
      vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
      for (const [root, tag] of [
        [data, 'real'],
        [fixtureRoot, 'decoy'],
      ] as const) {
        writeJson(join(root, 'sys', 'settings.json'), {
          policyPaths: [join(fixtureRoot, `${tag}-system-pol`)],
        });
        writeJson(join(root, 'sys', 'defaults.json'), {
          policyPaths: [join(fixtureRoot, `${tag}-defaults-pol`)],
        });
        writeJson(join(root, 'trusted.json'), {
          [join(data, 'proj')]:
            tag === 'real' ? 'TRUST_FOLDER' : 'DO_NOT_TRUST',
        });
        writeJson(join(root, 'home', '.gemini', 'settings.json'), {
          policyPaths: [`~/${tag}-user-pol`],
        });
      }
      writeJson(join(runCwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol'],
      });
      const checked: string[] = [];

      const { captured } = await runFixture(
        { cwd: runCwd, skills: [writeSkill(sources, 'alpha', 'alpha')] },
        admitAll(checked),
      );

      // gemini-34: each system override is read under the physical run cwd.
      expect(new Set(checked)).toEqual(
        new Set([
          join(data, 'sys', 'settings.json'),
          join(data, 'sys', 'defaults.json'),
        ]),
      );
      // gemini-34, gemini-55: the home and trusted-folders overrides resolve
      // there too, so the real home's user policyPaths are merged and the
      // workspace is trusted.
      expect(captured.policies.slice(1)).toEqual([
        join(fixtureRoot, 'real-defaults-pol'),
        join(data, 'home', 'real-user-pol'),
        join(data, 'proj', 'ws-pol'),
        join(fixtureRoot, 'real-system-pol'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'resolves trusted-folders keys and policyPaths against the physical run cwd (gemini-55)',
    async () => {
      const { runCwd, data } = linkedRunCwd();
      // Lexical resolution of the key from the link lands on this decoy.
      mkdirSync(join(fixtureRoot, 'proj'));
      vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      writeJson(join(realGemini, 'trustedFolders.json'), {
        '../proj': 'TRUST_FOLDER',
      });
      writeJson(join(runCwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol', '../ws-pol'],
      });

      const { captured } = await runFixture({
        cwd: runCwd,
        skills: [writeSkill(sources, 'alpha', 'alpha')],
      });

      // The key trusts the physical run cwd, and each workspace entry resolves
      // against it.
      expect(captured.policies.slice(1)).toEqual([
        join(data, 'proj', 'ws-pol'),
        join(data, 'ws-pol'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads the files of the directory a `..` after a symbolic link names for the child (gemini-34, gemini-55)',
    async () => {
      // <fixtureRoot>/link names <fixtureRoot>/data/sub, so the operating
      // system runs the child of <fixtureRoot>/link/.. in <fixtureRoot>/data,
      // while lexical resolution lands on <fixtureRoot>, where decoys wait.
      const data = join(fixtureRoot, 'data');
      mkdirSync(join(data, 'sub'), { recursive: true });
      symlinkSync(join(data, 'sub'), join(fixtureRoot, 'link'), 'dir');
      const physical = realpathSync(data);
      vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
      vi.stubEnv('GEMINI_CLI_TRUSTED_FOLDERS_PATH', 'trusted.json');
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      writeJson(join(data, 'trusted.json'), { [physical]: 'TRUST_FOLDER' });
      writeJson(join(data, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol'],
      });
      writeJson(join(fixtureRoot, 'trusted.json'), {
        [realpathSync(fixtureRoot)]: 'TRUST_FOLDER',
      });
      writeJson(join(fixtureRoot, '.gemini', 'settings.json'), {
        tools: { sandbox: true },
        policyPaths: ['decoy-pol'],
      });

      const { captured } = await runFixture({
        cwd: `${join(fixtureRoot, 'link')}/..`,
        skills: [writeSkill(sources, 'alpha', 'alpha')],
      });

      // gemini-34: the child runs in the physical directory, whose relative
      // trusted-folders override trusts it, so its workspace policyPaths
      // merge; the decoy's sandbox request and policyPaths count nowhere
      // (gemini-55).
      expect(captured.cwd).toBe(physical);
      expect(captured.policies.slice(1)).toEqual([join(physical, 'ws-pol')]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  /**
   * A link `jump` in the run cwd naming <fixtureRoot>/far/inner, so the
   * child opens `jump/../<name>` at <fixtureRoot>/far/<name>, while lexical
   * resolution lands on <run cwd>/<name> (gemini-34).
   */
  function jumpInRunCwd(): string {
    const far = join(fixtureRoot, 'far');
    mkdirSync(join(far, 'inner'), { recursive: true });
    symlinkSync(join(far, 'inner'), join(cwd, 'jump'), 'dir');
    return far;
  }

  it.skipIf(process.platform === 'win32')(
    'reads a trusted-folders override climbing out of a link in the run cwd where the child opens it (gemini-55)',
    async () => {
      const far = jumpInRunCwd();
      vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
      vi.stubEnv('GEMINI_CLI_TRUSTED_FOLDERS_PATH', 'jump/../trusted.json');
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      writeJson(join(far, 'trusted.json'), {
        [childCwdOf(cwd)]: 'TRUST_FOLDER',
      });
      // The decoy waits where lexical resolution lands.
      writeJson(join(cwd, 'trusted.json'), {
        [childCwdOf(cwd)]: 'DO_NOT_TRUST',
      });
      writeJson(join(cwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol'],
      });

      const { captured } = await runFixture({
        skills: [writeSkill(sources, 'alpha', 'alpha')],
      });

      // The file the child opens trusts the workspace, merging its
      // policyPaths.
      expect(captured.policies.slice(1)).toEqual([
        join(childCwdOf(cwd), 'ws-pol'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads no system settings at an override naming a file with a trailing slash, which the child finds nothing at (gemini-34)',
    async () => {
      const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
      writeJson(settingsPath, { tools: { sandbox: true } });
      // The file's real path can be read, but the spelling names no file.
      vi.stubEnv('GEMINI_CLI_SYSTEM_SETTINGS_PATH', `${settingsPath}/`);
      const checked: string[] = [];

      const { captured } = await runFixture(
        { skills: [writeSkill(sources, 'alpha', 'alpha')] },
        admitAll(checked),
      );

      // No sandbox request is read, so the skills are delivered.
      expect(checked).toEqual([]);
      expect(captured.skills!.map((entry) => entry.name)).toEqual(['alpha']);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads no rules at a trusted-folders override naming a file with a trailing slash (gemini-34, gemini-55)',
    async () => {
      const trustedPath = join(fixtureRoot, 'trusted.json');
      writeJson(trustedPath, { [childCwdOf(cwd)]: 'TRUST_FOLDER' });
      vi.stubEnv('GEMINI_CLI_TRUSTED_FOLDERS_PATH', `${trustedPath}/`);
      vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      writeJson(join(cwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol'],
      });

      const { captured } = await runFixture({
        skills: [writeSkill(sources, 'alpha', 'alpha')],
      });

      // The child finds no rules, leaving the workspace untrusted and the
      // user policy directory in place of its policyPaths.
      expect(captured.policies.slice(1)).toEqual([
        join(realGemini, 'policies'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads no system settings where the child opens none, beside a decoy where lexical resolution lands (gemini-34)',
    async () => {
      jumpInRunCwd();
      vi.stubEnv(
        'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
        'jump/../sys/settings.json',
      );
      writeJson(join(cwd, 'sys', 'settings.json'), {
        tools: { sandbox: true },
      });
      const checked: string[] = [];

      const { captured } = await runFixture(
        { skills: [writeSkill(sources, 'alpha', 'alpha')] },
        admitAll(checked),
      );

      // Nothing is checked or read, so the decoy's request counts nowhere.
      expect(checked).toEqual([]);
      expect(captured.skills!.map((entry) => entry.name)).toEqual(['alpha']);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads the system defaults the child joins lexically beside a system settings override climbing out of a link (gemini-34)',
    async () => {
      const far = jumpInRunCwd();
      vi.stubEnv(
        'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
        'jump/../sys/settings.json',
      );
      vi.stubEnv('GEMINI_CLI_SYSTEM_DEFAULTS_PATH', undefined);
      // The joined path drops `jump/..`, so it never reaches the link.
      writeJson(join(cwd, 'sys', 'system-defaults.json'), {
        policyPaths: [join(fixtureRoot, 'lexical-pol')],
      });
      writeJson(join(far, 'sys', 'system-defaults.json'), {
        policyPaths: [join(fixtureRoot, 'link-pol')],
      });
      const checked: string[] = [];

      const { captured } = await runFixture(
        { skills: [writeSkill(sources, 'alpha', 'alpha')] },
        admitAll(checked),
      );

      expect(new Set(checked)).toEqual(
        new Set([join(childCwdOf(cwd), 'sys', 'system-defaults.json')]),
      );
      expect(captured.policies.slice(1)).toEqual([
        join(fixtureRoot, 'lexical-pol'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([
    { decoy: false, counted: true },
    { decoy: true, counted: false },
  ])(
    'reads system overrides climbing out of a link in the run cwd where the child opens them, checking admission lexically (decoy: $decoy, gemini-34, gemini-55)',
    async ({ decoy, counted }) => {
      const far = jumpInRunCwd();
      vi.stubEnv(
        'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
        'jump/../sys/settings.json',
      );
      vi.stubEnv(
        'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
        'jump/../sys/defaults.json',
      );
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      const roots: [string, string][] = [[far, 'real']];
      // A user-owned decoy waits where lexical resolution lands.
      if (decoy) roots.push([cwd, 'decoy']);
      for (const [root, tag] of roots) {
        writeJson(join(root, 'sys', 'settings.json'), {
          policyPaths: [join(fixtureRoot, `${tag}-system-pol`)],
        });
        writeJson(join(root, 'sys', 'defaults.json'), {
          policyPaths: [join(fixtureRoot, `${tag}-defaults-pol`)],
        });
      }

      // The adapter's own admission check decides.
      const { captured } = await runFixture({
        skills: [writeSkill(sources, 'alpha', 'alpha')],
      });

      // gemini-34: the runtime admits a file absent at the lexical path, so
      // the user-owned files the child opens count, and skips both where a
      // user-owned file waits there; gemini-55: counted, their policyPaths
      // replace the user policy directory.
      expect(captured.policies.slice(1)).toEqual(
        counted
          ? [
              join(fixtureRoot, 'real-defaults-pol'),
              join(fixtureRoot, 'real-system-pol'),
            ]
          : [join(realGemini, 'policies')],
      );
      expect(overlaysLeft()).toEqual([]);
    },
  );

  const caseInsensitive =
    process.platform === 'darwin' || process.platform === 'win32';
  it.each([
    {
      label: 'keyed "."',
      arrange: () => ({ rules: { '.': 'TRUST_FOLDER' } }),
      trusted: true,
    },
    {
      label: "keyed the parent process's cwd",
      arrange: () => {
        // Only a key resolved against the run cwd, not the parent's, trusts.
        expect(cwd.startsWith(process.cwd())).toBe(false);
        return { rules: { [process.cwd()]: 'TRUST_FOLDER' } };
      },
      trusted: false,
    },
    {
      // Both keys normalize to one rule, whose level the later one sets.
      label: 'keyed "." and then the run cwd\'s real path distrusting it',
      arrange: () => ({
        rules: { '.': 'TRUST_FOLDER', [childCwdOf(cwd)]: 'DO_NOT_TRUST' },
      }),
      trusted: false,
    },
    {
      label: "keyed the run cwd's real path in upper case",
      arrange: () => ({
        rules: { [childCwdOf(cwd).toUpperCase()]: 'TRUST_FOLDER' },
      }),
      trusted: caseInsensitive,
    },
    {
      // On POSIX the key resolves as one name under the run cwd; replacing
      // its backslash then lets the real-path reading climb out of it.
      label: "keyed the run cwd's name below `..` with a backslash",
      arrange: () => ({
        rules: { [`..\\${basename(childCwdOf(cwd))}`]: 'TRUST_FOLDER' },
      }),
      trusted: true,
    },
    {
      // Absolute only on Windows: on POSIX it is a name under the run cwd.
      label: "keyed the run cwd's real path with backslash separators",
      arrange: () => ({
        rules: { [childCwdOf(cwd).replace(/\//g, '\\')]: 'TRUST_FOLDER' },
      }),
      trusted: process.platform === 'win32',
    },
    {
      label: 'keyed a child of the run cwd under TRUST_PARENT',
      arrange: () => ({
        rules: { [join(childCwdOf(cwd), 'child')]: 'TRUST_PARENT' },
      }),
      trusted: true,
    },
    {
      // The longer key decides, wherever it is listed.
      label: 'keyed the run cwd distrusting it and then its parent trusting it',
      arrange: () => ({
        rules: {
          [childCwdOf(cwd)]: 'DO_NOT_TRUST',
          [dirname(childCwdOf(cwd))]: 'TRUST_FOLDER',
        },
      }),
      trusted: false,
    },
    {
      // The runtime's real-path reading keeps the key's spelling, so it
      // never names a directory spelled in the other Unicode form.
      label: 'keyed in NFC for a run cwd named in NFD',
      arrange: () => {
        const runCwd = join(fixtureRoot, 'cafe\u0301');
        mkdirSync(runCwd);
        return {
          runCwd,
          rules: {
            [join(childCwdOf(fixtureRoot), 'caf\u00e9')]: 'TRUST_FOLDER',
          },
        };
      },
      trusted: false,
    },
    {
      // A Seatbelt sandbox moves the runtime directory under .cache.
      label: 'keyed the run cwd in the Seatbelt runtime directory',
      arrange: () => {
        vi.stubEnv('SANDBOX', 'sandbox-exec');
        writeJson(join(realGemini, 'trustedFolders.json'), {
          [cwd]: 'DO_NOT_TRUST',
        });
        return {
          rules: { [cwd]: 'TRUST_FOLDER' },
          rulesPath: join(realHome, '.cache', '.gemini', 'trustedFolders.json'),
        };
      },
      trusted: true,
    },
    {
      // Only a Seatbelt sandbox moves the runtime directory.
      label: 'keyed the run cwd in the .gemini file under another SANDBOX',
      arrange: () => {
        vi.stubEnv('SANDBOX', 'docker');
        writeJson(join(realHome, '.cache', '.gemini', 'trustedFolders.json'), {
          [cwd]: 'DO_NOT_TRUST',
        });
        return { rules: { [cwd]: 'TRUST_FOLDER' } };
      },
      trusted: true,
    },
    {
      // Rules rank by normalized key, whose `.` segments are gone: the
      // longer raw key is the shorter normalized one.
      label:
        'keyed the run cwd plus `/.` segments distrusting it and then a child of the run cwd under TRUST_PARENT',
      arrange: () => ({
        rules: {
          [`${childCwdOf(cwd)}/./././././././.`]: 'DO_NOT_TRUST',
          [join(childCwdOf(cwd), 'child')]: 'TRUST_PARENT',
        },
      }),
      trusted: true,
    },
    {
      label: 'keyed the run cwd trusting it beside a rule of an invalid level',
      arrange: () => ({
        rules: {
          [childCwdOf(cwd)]: 'TRUST_FOLDER',
          [join(fixtureRoot, 'elsewhere')]: 'TRUST_ALWAYS',
        },
      }),
      trusted: false,
    },
  ] satisfies {
    label: string;
    arrange: () => {
      runCwd?: string;
      rules: Record<string, string>;
      rulesPath?: string;
    };
    trusted: boolean;
  }[])(
    'matches a trusted-folders rule $label as the runtime does (gemini-55)',
    async ({ arrange, trusted }) => {
      // Present but neither 'true' nor 'false': the trusted-folders file
      // decides, under the default folder-trust setting.
      vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      const arranged = arrange();
      const runCwd = 'runCwd' in arranged ? arranged.runCwd : cwd;
      writeJson(
        ('rulesPath' in arranged ? arranged.rulesPath : undefined) ??
          join(realGemini, 'trustedFolders.json'),
        arranged.rules,
      );
      writeJson(join(runCwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol'],
      });

      const { captured } = await runFixture({
        cwd: runCwd,
        skills: [writeSkill(sources, 'alpha', 'alpha')],
      });

      // A trusted run cwd merges its workspace policyPaths; an untrusted one
      // leaves the user's default policy directory in their place.
      expect(captured.policies.slice(1)).toEqual(
        trusted
          ? [join(childCwdOf(runCwd), 'ws-pol')]
          : [join(realGemini, 'policies')],
      );
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32').each([
    { first: 'TRUST_FOLDER', second: 'DO_NOT_TRUST', trusted: true },
    { first: 'DO_NOT_TRUST', second: 'TRUST_FOLDER', trusted: false },
  ] as const)(
    'lets the first listed of two equally long matching keys decide: the run cwd $first, then a link to it $second (gemini-55)',
    async ({ first, second, trusted }) => {
      // Both keys' real paths are the run cwd's, and their normalized keys
      // are equally long.
      const real = childCwdOf(cwd);
      const link = join(dirname(real), 'wlnk');
      expect(link).toHaveLength(real.length);
      symlinkSync(real, link, 'dir');
      vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      writeJson(join(realGemini, 'trustedFolders.json'), {
        [real]: first,
        [link]: second,
      });
      writeJson(join(cwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol'],
      });

      const { captured } = await runFixture({
        skills: [writeSkill(sources, 'alpha', 'alpha')],
      });

      expect(captured.policies.slice(1)).toEqual(
        trusted ? [join(real, 'ws-pol')] : [join(realGemini, 'policies')],
      );
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.each([
    {
      // GEMINI_RESTRICTED_MODE outranks the default 'true' the child gets.
      label:
        'GEMINI_RESTRICTED_MODE=true under the default GEMINI_CLI_TRUST_WORKSPACE, with a rule trusting the run cwd',
      arrange: () => {
        vi.stubEnv('GEMINI_RESTRICTED_MODE', 'true');
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', undefined);
        writeJson(join(realGemini, 'trustedFolders.json'), {
          '.': 'TRUST_FOLDER',
        });
      },
    },
    {
      label:
        'GEMINI_CLI_TRUST_WORKSPACE=false, with a rule trusting the run cwd',
      arrange: () => {
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', 'false');
        writeJson(join(realGemini, 'trustedFolders.json'), {
          '.': 'TRUST_FOLDER',
        });
      },
    },
    {
      // Folder trust merges last-wins, so the user settings turn it back on
      // and the trusted-folders file, holding no rule, decides.
      label:
        'system defaults disabling folder trust and user settings enabling it',
      arrange: () => {
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
        writeJson(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, {
          security: { folderTrust: { enabled: false } },
        });
        writeJson(join(realGemini, 'settings.json'), {
          security: { folderTrust: { enabled: true } },
        });
      },
    },
    {
      label:
        'user settings disabling folder trust and system settings enabling it',
      arrange: () => {
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
        writeJson(join(realGemini, 'settings.json'), {
          security: { folderTrust: { enabled: false } },
        });
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
          security: { folderTrust: { enabled: true } },
        });
      },
    },
    {
      // The user settings' null security replaces the system defaults',
      // leaving folder trust on.
      label:
        'user settings with a null security over system defaults disabling folder trust',
      arrange: () => {
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
        writeJson(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, {
          security: { folderTrust: { enabled: false } },
        });
        writeJson(join(realGemini, 'settings.json'), { security: null });
      },
    },
    {
      // A truncated file whose text names a trusting rule.
      label: 'a malformed trusted-folders file',
      arrange: () => {
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
        mkdirSync(realGemini, { recursive: true });
        writeFileSync(
          join(realGemini, 'trustedFolders.json'),
          `{${JSON.stringify(childCwdOf(cwd))}: "TRUST_FOLDER"`,
        );
      },
    },
    {
      // A directory in its place cannot be read as a file.
      label: 'an unreadable trusted-folders file',
      arrange: () => {
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
        mkdirSync(join(realGemini, 'trustedFolders.json'), {
          recursive: true,
        });
      },
    },
  ])(
    'leaves the workspace untrusted under $label (gemini-55)',
    async ({ arrange }) => {
      mkdirSync(join(realGemini, 'policies'), { recursive: true });
      arrange();
      writeJson(join(cwd, '.gemini', 'settings.json'), {
        policyPaths: ['ws-pol'],
      });

      // Admitted system files carry the folder-trust settings.
      const { captured } = await runFixture(
        { skills: [writeSkill(sources, 'alpha', 'alpha')] },
        admitAll(),
      );

      // The workspace policyPaths stay unmerged, leaving the user's default
      // policy directory in their place.
      expect(captured.policies.slice(1)).toEqual([
        join(realGemini, 'policies'),
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.each([
    {
      label:
        'a system settings file naming neither policyPaths nor folder trust',
      arrange: () => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
          ui: { theme: 'Default' },
        });
      },
      workspace: false,
    },
    { label: 'absent system files', arrange: () => {}, workspace: false },
    {
      // Counted or skipped, it adds no policy path.
      label: 'a system settings file with empty policyPaths',
      arrange: () => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
          policyPaths: [],
        });
      },
      workspace: false,
    },
    {
      // GEMINI_CLI_TRUST_WORKSPACE defaults to 'true', so folder trust never
      // reaches the trust decision and the workspace is trusted either way.
      label: 'a system-defaults file disabling folder trust',
      arrange: () => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, {
          security: { folderTrust: { enabled: false } },
        });
        writeJson(join(cwd, '.gemini', 'settings.json'), {
          policyPaths: ['ws-pol'],
        });
      },
      workspace: true,
    },
  ])(
    'delivers skills under Windows admission with $label (gemini-34, gemini-55)',
    async ({ arrange, workspace }) => {
      arrange();
      mkdirSync(join(realGemini, 'policies'), { recursive: true });

      // The adapter's own check applies the Windows admission rule.
      const { captured } = await runFixture(
        { skills: runSkills() },
        undefined,
        'win32',
      );

      expect(captured.skills!.map((entry) => entry.name).sort()).toEqual([
        'alpha',
        'beta',
        'my-tool',
      ]);
      expect(captured.policy).toBe(ACTIVATE_SKILL_RULE);
      expect(captured.policies.slice(1)).toEqual(
        workspace
          ? [join(childCwdOf(cwd), 'ws-pol')]
          : [join(realGemini, 'policies')],
      );
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it('counts a system settings file of unknown Windows admission for a run without skills selecting the browser (gemini-34, gemini-48)', async () => {
    // Counted, the file disables the sandbox the user settings request.
    writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
      tools: { sandbox: false },
    });
    writeJson(join(realGemini, 'settings.json'), { tools: { sandbox: true } });
    browserPreparation.mockResolvedValue({
      type: 'stdio',
      command: 'cligent-browser',
    });

    const { captured } = await runFixture(
      { browser: true },
      undefined,
      'win32',
    );

    // gemini-48: no sandbox, so the browser is prepared and delivered.
    expect(browserPreparation).toHaveBeenCalledTimes(1);
    expect(captured.settings).toMatchObject({
      mcpServers: {
        cligent_browser: { command: 'cligent-browser', args: [], trust: true },
      },
    });
    expect(captured.policies).toEqual([]);
    expect(overlaysLeft()).toEqual([]);
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
      label: 'admitted system settings requesting the native sandbox',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
          tools: { sandbox: true },
        });
        return {};
      },
      admits: true,
      message:
        'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled',
    },
    {
      label: 'admitted system defaults requesting the native sandbox',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, {
          tools: { sandbox: true },
        });
        return {};
      },
      admits: true,
      message:
        'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled',
    },
    {
      // gemini-34: the workspace's object merges into the user settings'.
      label:
        'user settings enabling a docker sandbox object a trusted workspace object completes',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: { enabled: true, command: 'docker' } },
        });
        writeJson(join(cwd, '.gemini', 'settings.json'), {
          tools: { sandbox: { networkAccess: false } },
        });
        return {};
      },
      message:
        'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled',
    },
    {
      // gemini-34, gemini-51: counted or skipped, the system settings'
      // object leaves the user settings' request enabled, so the sandbox
      // rejects without naming the file.
      label:
        'system settings completing the docker sandbox object user settings enable, under Windows admission',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
          tools: { sandbox: { networkAccess: false } },
        });
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: { enabled: true, command: 'docker' } },
        });
        return {};
      },
      platform: 'win32' as const,
      message: (): string =>
        'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled',
    },
    {
      label: 'a sandbox of ${USE_SANDBOX:-false} with USE_SANDBOX=true',
      setup: (): AgentOptions<GeminiEffort> => {
        vi.stubEnv('USE_SANDBOX', 'true');
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: '${USE_SANDBOX:-false}' },
        });
        return {};
      },
      message:
        'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled',
    },
    {
      // gemini-34: the system settings override the trusted workspace.
      label:
        'admitted system settings requesting the sandbox a trusted workspace disables',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
          tools: { sandbox: true },
        });
        writeJson(join(cwd, '.gemini', 'settings.json'), {
          tools: { sandbox: false },
        });
        return {};
      },
      admits: true,
      message:
        'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled',
    },
    {
      // gemini-34: a null command counts as true.
      label: 'an enabled sandbox object with a null command',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: { enabled: true, command: null } },
        });
        return {};
      },
      message:
        'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled',
    },
    {
      // gemini-34: the unset variable takes its default in the workspace.
      label:
        'a trusted workspace sandbox of ${WS_SANDBOX:-true} with WS_SANDBOX unset',
      setup: (): AgentOptions<GeminiEffort> => {
        vi.stubEnv('WS_SANDBOX', undefined);
        writeJson(join(cwd, '.gemini', 'settings.json'), {
          tools: { sandbox: '${WS_SANDBOX:-true}' },
        });
        return {};
      },
      message:
        'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled',
    },
    {
      // gemini-34, gemini-51: coerced, folder trust is off, the workspace is
      // trusted, and its request counts; as written, folder trust is on and
      // no rule trusts the workspace, so its request drops out.
      label:
        'user settings setting folder trust to "false" beside a workspace sandbox request under file-based trust with no rule',
      setup: (): AgentOptions<GeminiEffort> => {
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
        writeJson(join(realGemini, 'settings.json'), {
          security: { folderTrust: { enabled: 'false' } },
        });
        writeJson(join(cwd, '.gemini', 'settings.json'), {
          tools: { sandbox: true },
        });
        return {};
      },
      message: (): string =>
        coercionRefusal(
          `user settings at ${join(realGemini, 'settings.json')}`,
          'security.folderTrust.enabled',
          'whether its native sandbox starts',
        ),
    },
    {
      // gemini-34, gemini-51: coerced, the string disables the sandbox; as
      // written, it names a sandbox command.
      label: 'a user sandbox of "FALSE"',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: 'FALSE' },
        });
        return {};
      },
      message: (): string =>
        coercionRefusal(
          `user settings at ${join(realGemini, 'settings.json')}`,
          'tools.sandbox',
          'whether its native sandbox starts',
        ),
    },
    {
      // gemini-34, gemini-51: coerced, the object is disabled; as written,
      // its truthy enabled turns it on.
      label: 'a user sandbox object whose enabled is "false"',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: { enabled: 'false' } },
        });
        return {};
      },
      message: (): string =>
        coercionRefusal(
          `user settings at ${join(realGemini, 'settings.json')}`,
          'tools.sandbox.enabled',
          'whether its native sandbox starts',
        ),
    },
    {
      // Nothing exists at the override relative to the parent's cwd.
      label: 'a relative system settings override requesting the sandbox',
      setup: (): AgentOptions<GeminiEffort> => {
        vi.stubEnv(
          'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
          join('sys', 'settings.json'),
        );
        writeJson(join(cwd, 'sys', 'settings.json'), {
          tools: { sandbox: true },
        });
        return {};
      },
      admits: true,
      message:
        'skills for adapter "gemini" cannot be delivered while its native sandbox is enabled',
    },
    {
      // gemini-51: counted, the system settings disable the sandbox the user
      // settings request; skipped, they leave that request in force. The
      // existing system defaults change nothing, so they go unnamed.
      label:
        'system settings disabling the sandbox user settings request beside inert system defaults under Windows admission',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
          tools: { sandbox: false },
        });
        writeJson(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, {
          ui: { theme: 'Default' },
        });
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: true },
        });
        return {};
      },
      platform: 'win32' as const,
      message: (): string =>
        `skills for adapter "gemini" cannot be delivered while the runtime's admission of the Gemini system settings at ${process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!} would change whether its native sandbox starts, because this adapter does not run the runtime's PowerShell check of that file's ownership and write access`,
    },
    {
      // gemini-51: skipping the system settings changes the result only
      // while the system defaults count, and skipping the system defaults
      // only while the system settings are skipped, so both are named.
      label:
        'system settings disabling and system defaults requesting the sandbox under Windows admission',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
          tools: { sandbox: false },
        });
        writeJson(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, {
          tools: { sandbox: true },
        });
        return {};
      },
      platform: 'win32' as const,
      message: (): string =>
        `skills for adapter "gemini" cannot be delivered while the runtime's admission of the Gemini system defaults at ${process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!} and the runtime's admission of the Gemini system settings at ${process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!} would change whether its native sandbox starts, because this adapter does not run the runtime's PowerShell check of those files' ownership and write access`,
    },
    {
      // gemini-34, gemini-51: counted, the system defaults disable folder
      // trust, trusting the workspace, whose settings disable the sandbox;
      // skipped, no trusted-folders rule trusts it, so its settings drop out
      // and the user settings' request starts the sandbox.
      label:
        'system defaults whose folder trust decides whether workspace settings disable the sandbox user settings request, under file-based trust and Windows admission',
      setup: (): AgentOptions<GeminiEffort> => {
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
        writeJson(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, {
          security: { folderTrust: { enabled: false } },
        });
        writeJson(join(cwd, '.gemini', 'settings.json'), {
          tools: { sandbox: false },
        });
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: true },
        });
        return {};
      },
      platform: 'win32' as const,
      message: (): string =>
        `skills for adapter "gemini" cannot be delivered while the runtime's admission of the Gemini system defaults at ${process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!} would change whether its native sandbox starts, because this adapter does not run the runtime's PowerShell check of that file's ownership and write access`,
    },
    {
      label: 'system settings naming policyPaths under Windows admission',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
          policyPaths: [join(fixtureRoot, 'system-pol')],
        });
        return {};
      },
      platform: 'win32' as const,
      message: (): string =>
        `skills for adapter "gemini" cannot be delivered while the runtime's admission of the Gemini system settings at ${process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!} would change its policy sources, because this adapter does not run the runtime's PowerShell check of that file's ownership and write access`,
    },
    {
      // gemini-55: under file-based trust with no rule, counting it trusts
      // the workspace and merges its policyPaths; skipping it does not.
      label:
        'system defaults disabling folder trust under file-based trust and Windows admission',
      setup: (): AgentOptions<GeminiEffort> => {
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', '');
        writeJson(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, {
          security: { folderTrust: { enabled: false } },
        });
        writeJson(join(cwd, '.gemini', 'settings.json'), {
          policyPaths: ['ws-pol'],
        });
        return {};
      },
      platform: 'win32' as const,
      message: (): string =>
        `skills for adapter "gemini" cannot be delivered while the runtime's admission of the Gemini system defaults at ${process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!} would change its policy sources, because this adapter does not run the runtime's PowerShell check of that file's ownership and write access`,
    },
    {
      // gemini-34, gemini-51: read by its truthiness, "TRUE" reads alike as
      // written and coerced, so only the sandbox string is named.
      label:
        'a user sandbox of "FALSE" beside advanced.ignoreLocalEnv of "TRUE"',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: 'FALSE' },
          advanced: { ignoreLocalEnv: 'TRUE' },
        });
        return {};
      },
      message: (): string =>
        coercionRefusal(
          `user settings at ${join(realGemini, 'settings.json')}`,
          'tools.sandbox',
          'whether its native sandbox starts',
        ),
    },
    {
      // gemini-51: skipped, the system settings leave the user settings'
      // string to decide; under the coerced string, counting them requests
      // the sandbox. The files are named in merge order.
      label:
        'a user sandbox of "FALSE" beside system settings requesting the sandbox under Windows admission',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
          tools: { sandbox: true },
        });
        writeJson(join(realGemini, 'settings.json'), {
          tools: { sandbox: 'FALSE' },
        });
        return {};
      },
      platform: 'win32' as const,
      message: (): string =>
        `skills for adapter "gemini" cannot be delivered while the runtime's coercion of tools.sandbox in the Gemini user settings at ${join(realGemini, 'settings.json')} and the runtime's admission of the Gemini system settings at ${process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!} would change whether its native sandbox starts, because the runtime coerces that string only where the whole file validates, which this adapter does not check, and this adapter does not run the runtime's PowerShell check of that file's ownership and write access`,
    },
    {
      // gemini-51: skipping and coercing the file each drop the request its
      // string makes as written, so it is named once for both.
      label:
        'system defaults with a sandbox of "FALSE" under Windows admission',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, {
          tools: { sandbox: 'FALSE' },
        });
        return {};
      },
      platform: 'win32' as const,
      message: (): string =>
        `skills for adapter "gemini" cannot be delivered while the runtime's admission of the Gemini system defaults at ${process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!} and its coercion of tools.sandbox there would change whether its native sandbox starts, because this adapter does not run the runtime's PowerShell check of that file's ownership and write access, and the runtime coerces that string only where the whole file validates, which this adapter does not check`,
    },
    {
      // gemini-51: the default GEMINI_CLI_TRUST_WORKSPACE trusts the
      // workspace however the folder-trust string reads, so only skipping
      // the file changes the result and its coercion goes unnamed.
      label:
        'system settings requesting the sandbox and setting folder trust to "false" under the default trust and Windows admission',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, {
          tools: { sandbox: true },
          security: { folderTrust: { enabled: 'false' } },
        });
        return {};
      },
      platform: 'win32' as const,
      message: (): string =>
        `skills for adapter "gemini" cannot be delivered while the runtime's admission of the Gemini system settings at ${process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!} would change whether its native sandbox starts, because this adapter does not run the runtime's PowerShell check of that file's ownership and write access`,
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
      // gemini-34: the runtime makes the string false only where the whole
      // file validates.
      label: 'user settings setting skills.enabled to "false"',
      setup: (): AgentOptions<GeminiEffort> => {
        writeJson(join(realGemini, 'settings.json'), {
          skills: { enabled: 'false' },
        });
        return {};
      },
      message: (): string =>
        `skills for adapter "gemini" cannot be delivered while the Gemini user settings at ${join(realGemini, 'settings.json')} set skills.enabled to "false", a string the runtime coerces to false only where the whole file validates, which this adapter does not check`,
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
    async ({ setup, message, admits, platform }) => {
      const spawned: string[][] = [];
      const events = await collect(
        fixtureAdapter(spawned, admits ? admitAll() : undefined, platform).run(
          'Use the skills',
          {
            cwd,
            browser: true,
            skills: runSkills(),
            ...setup(),
          },
        ),
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
      const reported = (events[1]!.payload as { message: string }).message;
      if (typeof message === 'function') expect(reported).toBe(message());
      else expect(reported).toContain(message);
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
