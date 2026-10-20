// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// gemini-59: a real fixture subprocess stands in for Gemini CLI and records
// the per-run home and working directory a run selecting `nativeSkills:
// false` hands it, so each check reads the user tier and the settings a real
// child would read (gemini-58).

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

const browserPreparation = vi.hoisted(() => vi.fn());
vi.mock('../browser.js', () => ({
  prepareBrowserServer: browserPreparation,
  releaseBrowserServer: async () => {},
}));

const FIXTURE = `
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [capture] = process.argv.slice(2);
const home = process.env.GEMINI_CLI_HOME;
const kind = (path) => {
  const stats = lstatSync(path);
  return stats.isSymbolicLink() ? 'link:' + readlinkSync(path) : stats.isDirectory() ? 'dir' : 'file';
};
const entries = (dir) => existsSync(dir)
  ? Object.fromEntries(readdirSync(dir).sort().map((name) => [name, kind(join(dir, name))]))
  : null;
const skillsDir = join(home, '.gemini', 'skills');
const bodies = existsSync(skillsDir)
  ? Object.fromEntries(readdirSync(skillsDir).sort().flatMap((name) => {
      const path = join(skillsDir, name);
      return !lstatSync(path).isSymbolicLink() && statSync(path).isDirectory() && existsSync(join(path, 'SKILL.md'))
        ? [[name, readFileSync(join(path, 'SKILL.md'), 'utf8')]]
        : [];
    }))
  : null;
const settingsPath = join(home, '.gemini', 'settings.json');
writeFileSync(capture, JSON.stringify({
  cwd: process.cwd(),
  home,
  homeEntries: entries(home),
  skillsDir: existsSync(skillsDir) ? kind(skillsDir) : null,
  skills: entries(skillsDir),
  bodies,
  settings: existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null,
}));
console.log(JSON.stringify({ type: 'init', session_id: 'gemini-native-skills' }));
console.log(JSON.stringify({ type: 'result', status: 'success', result: 'done' }));
`;

interface Captured {
  cwd: string;
  home: string;
  /** Each overlay home entry: `dir`, `file`, or `link:<target>`. */
  homeEntries: Record<string, string>;
  /** The overlay's `.gemini/skills` itself, as `homeEntries` records one. */
  skillsDir: string | null;
  skills: Record<string, string> | null;
  /** The SKILL.md of each real skill directory in the overlay. */
  bodies: Record<string, string> | null;
  settings: Record<string, unknown> | null;
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

/** A skill directory named `directory` whose frontmatter names `name`. */
function writeSkill(root: string, directory: string, name: string): string {
  const path = join(root, directory);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n---\nBody of ${name}\n`,
  );
  return path;
}

function writeUserSettings(settings: unknown): string {
  const content = JSON.stringify(settings);
  writeFileSync(join(realGemini, 'settings.json'), content);
  return content;
}

/**
 * The working directory a child started in `path` reports: its real path,
 * or the path itself on Windows (gemini-34).
 */
function childCwdOf(path: string): string {
  return process.platform === 'win32' ? path : realpathSync.native(path);
}

/** The run's skills: alpha, with a script, and beta given by its SKILL.md. */
function runSkills(): string[] {
  const alpha = writeSkill(sources, 'alpha', 'alpha');
  mkdirSync(join(alpha, 'scripts'));
  writeFileSync(join(alpha, 'scripts', 'run.sh'), '#!/bin/sh\necho alpha\n');
  chmodSync(join(alpha, 'scripts', 'run.sh'), 0o755);
  writeSkill(sources, 'beta', 'beta');
  return [alpha, join(sources, 'beta', 'SKILL.md')];
}

/**
 * Workspace skills in both directories the runtime scans: one named like the
 * run skill alpha in another letter case, one whose name the runtime
 * sanitizes, an entry holding no skill, a dot entry and a SKILL.md without
 * frontmatter, neither of which the runtime loads, a root SKILL.md, a
 * duplicate of a kept name in another letter case, and one naming an unset
 * variable, which the runtime's settings expansion keeps as written.
 */
function writeWorkspaceSkills(): void {
  const gemini = join(cwd, '.gemini', 'skills');
  writeSkill(gemini, 'Alpha-case', 'ALPHA');
  writeSkill(gemini, 'colon', 'ws:colon');
  mkdirSync(join(gemini, 'notes'));
  writeSkill(gemini, '.hidden', 'ws-hidden');
  mkdirSync(join(gemini, 'broken'));
  writeFileSync(join(gemini, 'broken', 'SKILL.md'), 'No frontmatter here.\n');
  writeSkill(gemini, 'ws-gem', 'ws-gem');
  const agents = join(cwd, '.agents', 'skills');
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    join(agents, 'SKILL.md'),
    '---\nname: root-agent\ndescription: A root skill\n---\nBody\n',
  );
  writeSkill(agents, 'dup', 'WS-GEM');
  writeSkill(agents, 'unset-var', '$CLIGENT_UNSET_SKILL_VAR');
  writeSkill(agents, 'ws-agent', 'ws-agent');
}

/**
 * The names the runtime gives the workspace skills, in its discovery order,
 * each once, without `ALPHA` beside the run skill alpha (gemini-58).
 */
function workspaceNames(withRunSkills: boolean): string[] {
  return [
    ...(withRunSkills ? [] : ['ALPHA']),
    'ws-colon',
    'ws-gem',
    'root-agent',
    '$CLIGENT_UNSET_SKILL_VAR',
    'ws-agent',
  ];
}

/** User `.gemini/skills` and `.agents/skills` skills and other home state. */
function writeUserSkills(): void {
  writeSkill(join(realGemini, 'skills'), 'user-gem', 'user-gem');
  writeFileSync(join(realGemini, 'skills', 'README.md'), 'readme\n');
  writeSkill(join(realHome, '.agents', 'skills'), 'user-agent', 'user-agent');
  mkdirSync(join(realHome, 'other-state'));
}

async function collect(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function fixtureAdapter(
  spawned: string[][] = [],
  environmentPlatform?: NodeJS.Platform,
): GeminiAdapter {
  return new GeminiAdapter({
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
): Promise<Captured> {
  const events = await collect(
    fixtureAdapter().run('Use the skills', { cwd, ...options }),
  );
  expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
  return JSON.parse(readFileSync(capture, 'utf8')) as Captured;
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'cligent-gemini-native-skills-'));
  realHome = join(fixtureRoot, 'home');
  realGemini = join(realHome, '.gemini');
  overlayTmp = join(fixtureRoot, 'tmp');
  cwd = join(fixtureRoot, 'work');
  sources = join(fixtureRoot, 'sources');
  script = join(fixtureRoot, 'gemini-fixture.mjs');
  capture = join(fixtureRoot, 'captured.json');
  for (const dir of [realGemini, overlayTmp, cwd, sources]) {
    mkdirSync(dir, { recursive: true });
  }
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
  vi.stubEnv('CLIGENT_UNSET_SKILL_VAR', undefined);
  vi.stubEnv(
    'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
    join(fixtureRoot, 'system', 'settings.json'),
  );
  vi.stubEnv(
    'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
    join(fixtureRoot, 'system', 'system-defaults.json'),
  );
  browserPreparation.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Gemini native skills off (gemini-59)', () => {
  it.each([
    {
      label: 'with run skills under user settings without skills',
      withRunSkills: true,
      user: { custom: 'keep' },
      expected: (names: string[]) => ({
        custom: 'keep',
        skills: { disabled: names },
      }),
    },
    {
      label: 'without run skills under a user skills.disabled list',
      withRunSkills: false,
      user: { custom: 'keep', skills: { disabled: ['user-own'], kept: 1 } },
      expected: (names: string[]) => ({
        custom: 'keep',
        skills: { disabled: ['user-own', ...names], kept: 1 },
      }),
    },
    {
      // gemini-58 admits what gemini-51 rejects for a skills run: no skill
      // loads either way.
      label:
        'without run skills under user settings turning skills.enabled off',
      withRunSkills: false,
      user: { skills: { enabled: false } },
      expected: (names: string[]) => ({
        skills: { enabled: false, disabled: names },
      }),
    },
    {
      // gemini-51 first drops the entry naming a run skill, in any case.
      label:
        'with run skills under a user skills.disabled list naming one of them',
      withRunSkills: true,
      user: { skills: { disabled: ['Beta', 'user-own'] } },
      expected: (names: string[]) => ({
        skills: { disabled: ['user-own', ...names] },
      }),
    },
  ])(
    'isolates the user tier and disables every other workspace skill, $label (gemini-58)',
    async ({ withRunSkills, user, expected }) => {
      writeUserSkills();
      const userSettings = writeUserSettings(user);
      writeWorkspaceSkills();

      const captured = await runFixture({
        nativeSkills: false,
        ...(withRunSkills ? { skills: runSkills() } : {}),
      });

      // The child runs in the working directory, under the per-run home.
      expect(captured.cwd).toBe(childCwdOf(cwd));
      expect(captured.home).not.toBe(realHome);

      // gemini-58: a real skills directory holding only the run's skills,
      // with no link to the real user skills.
      expect(captured.skillsDir).toBe('dir');
      const runNames = withRunSkills ? ['alpha', 'beta'] : [];
      expect(captured.skills).toEqual(
        Object.fromEntries(runNames.map((name) => [name, 'dir'])),
      );
      expect(captured.bodies).toEqual(
        Object.fromEntries(
          runNames.map((name) => [
            name,
            readFileSync(join(sources, name, 'SKILL.md'), 'utf8'),
          ]),
        ),
      );

      // gemini-58: no `.agents` entry; every other home entry still links
      // to the real home's.
      expect(captured.homeEntries).toEqual({
        '.gemini': 'dir',
        'other-state': `link:${join(realHome, 'other-state')}`,
      });

      // gemini-58: the workspace names appended after the user's own, the
      // real settings untouched.
      expect(captured.settings).toEqual(
        expected(workspaceNames(withRunSkills)),
      );
      expect(readFileSync(join(realGemini, 'settings.json'), 'utf8')).toBe(
        userSettings,
      );

      // gemini-35: the overlay is removed, the real user skills unchanged.
      expect(existsSync(captured.home)).toBe(false);
      expect(overlaysLeft()).toEqual([]);
      expect(readdirSync(join(realGemini, 'skills')).sort()).toEqual([
        'README.md',
        'user-gem',
      ]);
      expect(readdirSync(join(realHome, '.agents', 'skills'))).toEqual([
        'user-agent',
      ]);
    },
  );

  it.each([
    {
      label: 'a lone-string skills.disabled',
      user: { skills: { disabled: 'user-own' } },
    },
    { label: 'a non-object skills', user: { skills: ['user-own'] } },
  ])(
    'keeps $label where the workspace holds no skill to name (gemini-58)',
    async ({ user }) => {
      writeUserSkills();
      writeUserSettings(user);

      const captured = await runFixture({ nativeSkills: false });

      expect(captured.skillsDir).toBe('dir');
      expect(captured.skills).toEqual({});
      expect(captured.homeEntries).not.toHaveProperty('.agents');
      expect(captured.settings).toEqual(user);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  const settingsPath = (): string => join(realGemini, 'settings.json');

  it.each([
    {
      label: 'user settings holding a lone-string skills.disabled',
      setup: (): AgentOptions<GeminiEffort> => {
        writeUserSettings({ skills: { disabled: 'user-own' } });
        return {};
      },
      message: (): string =>
        `nativeSkills: false for adapter "gemini" cannot be honored while the Gemini user settings at ${settingsPath()} hold skills.disabled as "user-own", because adding names to it would change whether the runtime's validation accepts the file`,
    },
    {
      label: 'user settings holding a non-object skills',
      setup: (): AgentOptions<GeminiEffort> => {
        writeUserSettings({ skills: ['user-own'] });
        return {};
      },
      message: (): string =>
        `nativeSkills: false for adapter "gemini" cannot be honored while the Gemini user settings at ${settingsPath()} hold skills as ["user-own"], because adding names to skills.disabled would change whether the runtime's validation accepts the file`,
    },
    {
      // The runtime would expand the name before matching it.
      label: 'a workspace skill whose name holds $HOME, beside run skills',
      setup: (): AgentOptions<GeminiEffort> => {
        writeSkill(join(cwd, '.agents', 'skills'), 'home-var', '$HOME-skill');
        return { skills: runSkills() };
      },
      message: (): string =>
        `nativeSkills: false for adapter "gemini" cannot be honored while the workspace skill name "$HOME-skill" changes under the runtime's settings expansion, which would read another name`,
    },
    {
      label: 'a working directory that is the real home',
      setup: (): AgentOptions<GeminiEffort> => ({ cwd: realHome }),
      message: (): string =>
        'nativeSkills: false for adapter "gemini" requires a working directory different from its user home',
    },
    {
      label: 'a working directory linking to the real home',
      setup: (): AgentOptions<GeminiEffort> => {
        const link = join(fixtureRoot, 'home-link');
        symlinkSync(realHome, link, 'junction');
        return { cwd: link };
      },
      message: (): string =>
        'nativeSkills: false for adapter "gemini" requires a working directory different from its user home',
    },
    {
      label: 'a requested native sandbox',
      setup: (): AgentOptions<GeminiEffort> => {
        vi.stubEnv('GEMINI_SANDBOX', 'true');
        return {};
      },
      message: (): string =>
        'nativeSkills: false for adapter "gemini" cannot be honored while its native sandbox is enabled',
    },
    {
      label: 'a child environment naming no home, its HOME empty',
      setup: (): AgentOptions<GeminiEffort> => {
        vi.stubEnv('GEMINI_CLI_HOME', undefined);
        vi.stubEnv('HOME', '');
        return {};
      },
      environmentPlatform: 'linux' as const,
      message: (): string =>
        `nativeSkills: false for adapter "gemini" cannot be honored: Gemini's user home cannot be derived from the HOME of "" in its environment, which names no home for this adapter to overlay`,
    },
  ])(
    'rejects $label before browser preparation (gemini-58)',
    async ({ setup, message, environmentPlatform }) => {
      writeUserSkills();
      writeWorkspaceSkills();
      const options = setup();
      const userSettings = existsSync(settingsPath())
        ? readFileSync(settingsPath(), 'utf8')
        : undefined;
      const spawned: string[][] = [];

      const events = await collect(
        fixtureAdapter(spawned, environmentPlatform).run('Use the skills', {
          cwd,
          browser: true,
          nativeSkills: false,
          ...options,
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
      expect((events[1]!.payload as { message: string }).message).toBe(
        message(),
      );
      expect(events[2]!.payload).toMatchObject({ status: 'error' });
      expect(spawned).toEqual([]);
      expect(browserPreparation).not.toHaveBeenCalled();
      expect(overlaysLeft()).toEqual([]);
      if (userSettings !== undefined) {
        expect(readFileSync(settingsPath(), 'utf8')).toBe(userSettings);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rejects an unreadable workspace skill before browser preparation, naming it (gemini-58)',
    async () => {
      writeWorkspaceSkills();
      const locked = join(cwd, '.agents', 'skills', 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      const spawned: string[][] = [];
      try {
        const events = await collect(
          fixtureAdapter(spawned).run('Use the skills', {
            cwd,
            browser: true,
            nativeSkills: false,
          }),
        );
        expect(events.map((event) => event.type)).toEqual([
          'init',
          'error',
          'done',
        ]);
        expect((events[1]!.payload as { message: string }).message).toMatch(
          new RegExp(
            `^nativeSkills: false for adapter "gemini" cannot be honored: failed to read ${join(childCwdOf(cwd), '.agents', 'skills', 'locked').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
          ),
        );
      } finally {
        chmodSync(locked, 0o700);
      }
      expect(spawned).toEqual([]);
      expect(browserPreparation).not.toHaveBeenCalled();
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.each([undefined, true])(
    'keeps the links to the real user skills and .agents in a run with skills and nativeSkills %j (gemini-58)',
    async (nativeSkills) => {
      writeUserSkills();
      writeUserSettings({ custom: 'keep' });
      writeWorkspaceSkills();

      const captured = await runFixture({
        skills: [writeSkill(sources, 'alpha', 'alpha')],
        ...(nativeSkills === undefined ? {} : { nativeSkills }),
      });

      // gemini-51: the run skill beside a link per real user skill entry.
      expect(captured.skillsDir).toBe('dir');
      expect(captured.skills).toEqual({
        'README.md': `link:${join(realGemini, 'skills', 'README.md')}`,
        alpha: 'dir',
        'user-gem': `link:${join(realGemini, 'skills', 'user-gem')}`,
      });
      // gemini-34: the real `.agents` linked like every other home entry.
      expect(captured.homeEntries).toEqual({
        '.agents': `link:${join(realHome, '.agents')}`,
        '.gemini': 'dir',
        'other-state': `link:${join(realHome, 'other-state')}`,
      });
      // No workspace skill named for the user settings.
      expect(captured.settings).toEqual({ custom: 'keep' });
      expect(existsSync(captured.home)).toBe(false);
      expect(overlaysLeft()).toEqual([]);
    },
  );
});
