// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// codex-83: `nativeSkills: false` reaches Codex as configuration overrides.
// The installed SDK spawns a recording fixture in place of the native CLI,
// under a throwaway Codex home and a throwaway HOME; the fixture records the
// run's arguments and, where asked, renders the installed executable's
// offline prompt input under the run's overrides and without the two
// native-skill overrides, so the catalog evidence comes from the real runtime
// rather than from this adapter's own reading of the skill roots.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexAdapter } from '../adapters/codex.js';
import { probeCodexExecutable } from '../adapters/codex-executable.js';
import type { AgentEvent } from '../types.js';

// Managed-browser preparation, recorded so a rejection can show it never ran.
const browserPreparation = vi.hoisted(() => vi.fn());
vi.mock('../browser.js', () => ({
  prepareBrowserServer: browserPreparation,
  releaseBrowserServer: async () => {},
}));

// A hook each directory read reaches, so a test can abort a run while the
// adapter reads a native root (codex-82).
const reads = vi.hoisted(() => ({ onReaddir: (_path: string): void => {} }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = actual.readdir as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readdir: (path: unknown, ...rest: unknown[]) => {
      reads.onReaddir(String(path));
      return readdir(path, ...rest);
    },
  };
});

const THREAD_ID = 'codex-native-skills-thread';
const RUN_SKILL = 'run-skill';
const BUNDLED_OFF = 'skills.bundled.enabled=false';
/** codex-82's bound on the `skills.config` override off Windows, in UTF-8 bytes. */
const POSIX_SKILLS_CONFIG_BOUND = 131_071;
const roots: string[] = [];

afterEach(async () => {
  reads.onReaddir = () => {};
  browserPreparation.mockReset();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const FIXTURE = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const configs = args.flatMap((arg, index) => (args[index - 1] === '--config' ? [arg] : []));
const cwd = args[args.indexOf('--cd') + 1];
const nativeOverride = (config) =>
  config === '${BUNDLED_OFF}' || config.startsWith('skills.config=');
const render = (overrides) => execFileSync(
  process.env.CLIGENT_NATIVE_CATALOG,
  ['debug', 'prompt-input', ...overrides.flatMap((override) => ['-c', override]), 'probe'],
  {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: process.env.PATH ?? '', HOME: homedir(), CODEX_HOME: codexHome, TMPDIR: process.env.TMPDIR ?? '/tmp' },
  },
);
process.stdin.resume();
process.stdin.on('end', () => {
  const record = { args, home: homedir(), codexHome };
  if (process.env.CLIGENT_NATIVE_CATALOG) {
    record.catalog = {
      withOverrides: render(configs),
      withoutNative: render(configs.filter((config) => !nativeOverride(config))),
    };
  }
  appendFileSync(process.env.CLIGENT_NATIVE_RECORDING, JSON.stringify(record) + '\\n');
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  send({ type: 'thread.started', thread_id: '${THREAD_ID}' });
  send({ type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: 'received' } });
  send({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
});
`;

interface Recording {
  args: string[];
  home: string;
  codexHome: string;
  catalog?: { withOverrides: string; withoutNative: string };
}

async function writeSkill(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'SKILL.md');
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: ${name} fixture skill.\n---\n\n${name} body.\n`,
  );
  return file;
}

/**
 * A throwaway HOME and Codex home, a recording fixture standing in for the
 * native CLI, and one run skill outside every native root.
 */
async function setup() {
  // Canonical from the start: macOS tmpdir() is /var/..., a link to /private/var.
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'cligent-codex-native-skills-'),
  );
  roots.push(root);
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  await mkdir(codexHome, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('CODEX_HOME', codexHome);
  const runSkill = join(root, 'sources', RUN_SKILL);
  await writeSkill(runSkill, RUN_SKILL);

  const fixture = join(root, 'codex-fixture.mjs');
  await writeFile(fixture, FIXTURE);
  await chmod(fixture, 0o755);
  const recording = join(root, 'recording.jsonl');
  const state = { catalog: false };
  const constructed: unknown[] = [];
  const adapter = new CodexAdapter({
    probeExecutable: () => ({ state: 'present', path: fixture }),
    loadSdk: async () => ({
      Codex: class extends Codex {
        constructor(options?: ConstructorParameters<typeof Codex>[0]) {
          constructed.push(options);
          const executable = probeCodexExecutable();
          super({
            ...options,
            // The transport wrapper launches the recording fixture in place
            // of the native CLI; a permission policy's arguments ride along.
            codexPathOverride: options?.codexPathOverride ?? fixture,
            env: {
              ...inheritedEnvironment(),
              CLIGENT_NATIVE_RECORDING: recording,
              ...(state.catalog && executable.state === 'present'
                ? { CLIGENT_NATIVE_CATALOG: executable.path }
                : {}),
            },
          });
        }
      },
    }),
  });
  return {
    root,
    home,
    codexHome,
    runSkill,
    adapter,
    state,
    constructed,
    recordings: async (): Promise<Recording[]> =>
      existsSync(recording)
        ? (await readFile(recording, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Recording)
        : [],
  };
}

/**
 * codex-83's tree: a working directory two levels below a repository root
 * inside the throwaway HOME, as a project under a real home sits, so the
 * home's `.agents/skills` and the Codex home's `skills` are also ancestor
 * roots. Returns the loadable skills' real paths by name and the names that
 * no root loads.
 */
async function nativeTree(root: string, home: string, codexHome: string) {
  const repo = join(home, 'repo');
  const mid = join(repo, 'mid');
  const cwd = join(mid, 'work');
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(cwd, { recursive: true });
  const target = join(root, 'targets', 'native-linked');
  const loadable: Record<string, string> = {
    'native-root-agents': await writeSkill(
      join(repo, '.agents', 'skills', 'native-root-agents'),
      'native-root-agents',
    ),
    'native-root-codex': await writeSkill(
      join(repo, '.codex', 'skills', 'native-root-codex'),
      'native-root-codex',
    ),
    'native-mid-agents': await writeSkill(
      join(mid, '.agents', 'skills', 'native-mid-agents'),
      'native-mid-agents',
    ),
    'native-mid-codex': await writeSkill(
      join(mid, '.codex', 'skills', 'native-mid-codex'),
      'native-mid-codex',
    ),
    // Six directory levels below its root: a/b/c/d/e/native-six-deep.
    'native-six-deep': await writeSkill(
      join(
        repo,
        '.agents',
        'skills',
        'a',
        'b',
        'c',
        'd',
        'e',
        'native-six-deep',
      ),
      'native-six-deep',
    ),
    // Reached only through a link to a directory outside every root.
    'native-linked': await writeSkill(target, 'native-linked'),
    'native-codex-home': await writeSkill(
      join(codexHome, 'skills', 'native-codex-home'),
      'native-codex-home',
    ),
    'native-user-home': await writeSkill(
      join(home, '.agents', 'skills', 'native-user-home'),
      'native-user-home',
    ),
  };
  await symlink(target, join(mid, '.agents', 'skills', 'linked'), 'dir');
  // Seven levels below its root, and below a dot-directory under a root.
  await writeSkill(
    join(
      repo,
      '.agents',
      'skills',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'native-seven-deep',
    ),
    'native-seven-deep',
  );
  await writeSkill(
    join(repo, '.codex', 'skills', '.hidden', 'native-dot-dir'),
    'native-dot-dir',
  );
  return {
    cwd,
    loadable,
    unloadable: ['native-seven-deep', 'native-dot-dir'],
  };
}

/** The entries of the Codex home's plugin cache, where a plugin root opens. */
async function pluginCacheEntries(codexHome: string): Promise<string[]> {
  const cache = join(codexHome, 'plugins', 'cache');
  return existsSync(cache) ? await readdir(cache) : [];
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function configs(args: readonly string[]): string[] {
  return args.filter((_arg, index) => args[index - 1] === '--config');
}

/** The real paths one `skills.config` override disables, in its order. */
function disabledPaths(override: string): string[] {
  const body = /^skills\.config=\[(.*)\]$/.exec(override)?.[1];
  expect(body, override).toBeDefined();
  const entries = [
    ...body!.matchAll(/\{path=("(?:[^"\\]|\\.)*"),enabled=false\}/g),
  ];
  // Nothing but the entries, comma-joined.
  expect(entries.map((entry) => entry[0]).join(',')).toBe(body);
  return entries.map((entry) => JSON.parse(entry[1]!) as string);
}

/**
 * The prompt input's skill catalog: each listed skill name with the absolute
 * SKILL.md path its root alias expands to.
 */
function catalogSkills(rendered: string): Map<string, string> {
  const text = (JSON.parse(rendered) as unknown[])
    .map((item) => JSON.stringify(item))
    .join('\n')
    .replace(/\\n/g, '\n');
  const block =
    /<skills_instructions>([\s\S]*?)<\/skills_instructions>/.exec(text)?.[1] ??
    '';
  const aliases = new Map(
    [...block.matchAll(/^- `(r\d+)` = `([^`]+)`$/gm)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  );
  return new Map(
    [...block.matchAll(/^- (\S+?): .* \(file: (r\d+)\/(.+)\)$/gm)].map(
      (match) => [match[1]!, `${aliases.get(match[2]!)}/${match[3]!}`],
    ),
  );
}

/**
 * Roots the adapter walks that lie outside the fixture: `.agents/skills` and
 * `.codex/skills` in each ancestor of the fixture root, and the
 * administrator's skills. A skill there is the machine's, not the fixture's.
 */
function ambientRoots(root: string): string[] {
  const found = ['/etc/codex/skills'];
  for (let current = dirname(root); ; current = dirname(current)) {
    found.push(join(current, '.agents', 'skills'));
    found.push(join(current, '.codex', 'skills'));
    if (dirname(current) === current) break;
  }
  return found.map((path) => (existsSync(path) ? realpathSync(path) : path));
}

describe.skipIf(process.platform === 'win32')(
  'Codex native-skill switch through the installed SDK (codex-83)',
  () => {
    it('disables every native skill a root loads, by real path, and leaves only the run skill in the runtime catalog (codex-82)', async () => {
      const fixture = await setup();
      const tree = await nativeTree(
        fixture.root,
        fixture.home,
        fixture.codexHome,
      );
      const executable = probeCodexExecutable();
      expect(
        executable.state,
        'the installed Codex executable is required',
      ).toBe('present');

      fixture.state.catalog = true;
      const events = await collect(
        fixture.adapter.run('Use the run skill.', {
          cwd: tree.cwd,
          skills: [fixture.runSkill],
          nativeSkills: false,
        }),
      );
      expect(events.at(-1)?.payload).toMatchObject({
        status: 'success',
        resumeToken: THREAD_ID,
      });

      const [record] = await fixture.recordings();
      // The throwaway homes reached the runtime's child.
      expect(record?.home).toBe(fixture.home);
      expect(record?.codexHome).toBe(fixture.codexHome);
      const overrides = configs(record!.args);
      expect(overrides.filter((value) => value === BUNDLED_OFF)).toHaveLength(
        1,
      );
      const listing = overrides.filter((value) =>
        value.startsWith('skills.config='),
      );
      expect(listing).toHaveLength(1);
      const paths = disabledPaths(listing[0]!);
      expect(new Set(paths).size).toBe(paths.length);
      const inFixture = paths.filter((path) =>
        path.startsWith(`${fixture.root}${sep}`),
      );
      expect(new Set(inFixture)).toEqual(new Set(Object.values(tree.loadable)));
      const ambient = ambientRoots(fixture.root);
      for (const path of paths.filter((entry) => !inFixture.includes(entry))) {
        expect(
          ambient.some((rootPath) => path.startsWith(`${rootPath}${sep}`)),
          path,
        ).toBe(true);
      }
      // Real paths throughout: the linked skill by its target.
      for (const path of inFixture) expect(realpathSync(path)).toBe(path);

      const catalog = record!.catalog!;
      expect(
        catalog,
        'the installed Codex executable is required',
      ).toBeDefined();
      // Under the run's overrides the runtime lists the run skill alone.
      expect([...catalogSkills(catalog.withOverrides).keys()]).toEqual([
        `cligent:${RUN_SKILL}`,
      ]);
      // Without the two native-skill overrides it lists every loadable
      // native skill, at the path the run disabled, and neither the skill
      // seven levels down nor the one below a dot-directory.
      const listed = catalogSkills(catalog.withoutNative);
      expect(listed.has(`cligent:${RUN_SKILL}`)).toBe(true);
      for (const [name, path] of Object.entries(tree.loadable)) {
        expect(listed.has(name), name).toBe(true);
        expect(realpathSync(listed.get(name)!), name).toBe(path);
      }
      for (const name of tree.unloadable) {
        expect(listed.has(name), name).toBe(false);
      }
    }, 120_000);

    it('adds only the bundled override without run skills where no native skill exists (codex-82)', async () => {
      const fixture = await setup();
      const cwd = join(fixture.root, 'workspace');
      await mkdir(cwd);
      const events = await collect(
        fixture.adapter.run('No skills.', { cwd, nativeSkills: false }),
      );
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      const [record] = await fixture.recordings();
      expect(record?.home).toBe(fixture.home);
      const overrides = configs(record!.args);
      expect(
        overrides.filter((value) => /^skills[.=]/.test(value)),
        'native skill roots outside the fixture must hold no SKILL.md',
      ).toEqual([BUNDLED_OFF]);
      expect(overrides.some((value) => value.startsWith('plugins.'))).toBe(
        false,
      );
    });

    it('adds neither native-skill override when nativeSkills is omitted (codex-82)', async () => {
      const fixture = await setup();
      const tree = await nativeTree(
        fixture.root,
        fixture.home,
        fixture.codexHome,
      );
      const events = await collect(
        fixture.adapter.run('Use the run skill.', {
          cwd: tree.cwd,
          skills: [fixture.runSkill],
        }),
      );
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      const [record] = await fixture.recordings();
      const overrides = configs(record!.args);
      expect(overrides).not.toContain(BUNDLED_OFF);
      expect(
        overrides.filter((value) => value.startsWith('skills.config=')),
      ).toEqual([]);
      // The run skill still travels as its plugin.
      expect(
        overrides.filter((value) => value.startsWith('plugins.cligent@')),
      ).toHaveLength(1);
    });

    it.skipIf(process.getuid?.() === 0)(
      'rejects an unreadable directory below a native root before browser preparation, a plugin root, or SDK invocation, naming it (codex-82)',
      async () => {
        const fixture = await setup();
        const cwd = join(fixture.root, 'workspace');
        const locked = join(cwd, '.agents', 'skills', 'locked');
        await mkdir(locked, { recursive: true });
        await chmod(locked, 0o000);
        try {
          await expect(
            collect(
              fixture.adapter.run('Locked.', {
                cwd,
                browser: true,
                skills: [fixture.runSkill],
                nativeSkills: false,
              }),
            ),
          ).rejects.toThrow(
            `nativeSkills: false for adapter "codex" cannot be honored: failed to read ${locked}`,
          );
        } finally {
          await chmod(locked, 0o700);
        }
        expect(browserPreparation).not.toHaveBeenCalled();
        expect(fixture.constructed).toEqual([]);
        expect(await fixture.recordings()).toEqual([]);
        expect(await pluginCacheEntries(fixture.codexHome)).toEqual([]);
      },
    );

    it('rejects native skill paths beyond the process-argument bound before browser preparation, a plugin root, or SDK invocation, naming the count (codex-82)', async () => {
      const fixture = await setup();
      const cwd = join(fixture.root, 'workspace');
      const nativeRoot = join(cwd, '.agents', 'skills');
      // Long shared directories keep each path under macOS's 1,024-byte
      // limit while few skills fill the bound.
      const levels = Math.min(
        5,
        Math.floor((1000 - nativeRoot.length - 32) / 201),
      );
      const shared = join(
        nativeRoot,
        ...Array.from({ length: levels }, (_, index) =>
          String.fromCharCode(97 + index).repeat(200),
        ),
      );
      let bytes = 'skills.config=[]'.length;
      let count = 0;
      while (bytes <= POSIX_SKILLS_CONFIG_BOUND) {
        const file = await writeSkill(
          join(shared, `native-${count}`),
          `native-${count}`,
        );
        bytes +=
          Buffer.byteLength(`{path=${JSON.stringify(file)},enabled=false}`) + 1;
        count += 1;
      }

      let message = '';
      try {
        await collect(
          fixture.adapter.run('Too many.', {
            cwd,
            browser: true,
            skills: [fixture.runSkill],
            nativeSkills: false,
          }),
        );
      } catch (error) {
        message = (error as Error).message;
      }
      const match =
        /^nativeSkills: false for adapter "codex" cannot be honored: the paths of (\d+) native skills make a skills\.config override of (\d+) bytes, beyond the 131071-byte process-argument bound$/.exec(
          message,
        );
      expect(match, message).not.toBeNull();
      // Every fixture skill, and any the host machine holds (ambientRoots).
      expect(Number(match![1])).toBeGreaterThanOrEqual(count);
      expect(Number(match![2])).toBeGreaterThan(POSIX_SKILLS_CONFIG_BOUND);
      expect(browserPreparation).not.toHaveBeenCalled();
      expect(fixture.constructed).toEqual([]);
      expect(await fixture.recordings()).toEqual([]);
      expect(await pluginCacheEntries(fixture.codexHome)).toEqual([]);
    });

    it('ends with the interrupted terminal when the caller aborts before the run (codex-82)', async () => {
      const fixture = await setup();
      const cwd = join(fixture.root, 'workspace');
      await mkdir(cwd);
      const controller = new AbortController();
      controller.abort();
      const events = await collect(
        fixture.adapter.run('Aborted.', {
          cwd,
          nativeSkills: false,
          abortSignal: controller.signal,
        }),
      );
      expect(events.map((event) => event.type)).toEqual(['done']);
      expect(events[0]!.payload).toMatchObject({ status: 'interrupted' });
      expect(fixture.constructed).toEqual([]);
      expect(await fixture.recordings()).toEqual([]);
    });

    it('ends with the interrupted terminal and no plugin root when the caller aborts while enumeration reads a native root (codex-82)', async () => {
      const fixture = await setup();
      const cwd = join(fixture.root, 'workspace');
      const nativeRoot = join(cwd, '.agents', 'skills');
      await writeSkill(join(nativeRoot, 'native-skill'), 'native-skill');
      const cache = join(fixture.codexHome, 'plugins', 'cache');
      const controller = new AbortController();
      let cacheAtRead: string[] | undefined;
      reads.onReaddir = (path) => {
        if (path !== nativeRoot || cacheAtRead) return;
        // No plugin root exists while enumeration runs.
        cacheAtRead = existsSync(cache) ? readdirSync(cache) : [];
        controller.abort();
      };
      const events = await collect(
        fixture.adapter.run('Aborted.', {
          cwd,
          skills: [fixture.runSkill],
          nativeSkills: false,
          abortSignal: controller.signal,
        }),
      );
      expect(cacheAtRead).toEqual([]);
      expect(events.map((event) => event.type)).toEqual(['done']);
      expect(events[0]!.payload).toMatchObject({ status: 'interrupted' });
      expect(fixture.constructed).toEqual([]);
      expect(await fixture.recordings()).toEqual([]);
      expect(await pluginCacheEntries(fixture.codexHome)).toEqual([]);
    });

    it('rejects a non-boolean nativeSkills before the fixture spawns (skills-10)', async () => {
      const fixture = await setup();
      const cwd = join(fixture.root, 'workspace');
      await mkdir(cwd);
      await expect(
        collect(
          fixture.adapter.run('Malformed.', {
            cwd,
            skills: [fixture.runSkill],
            nativeSkills: 'no' as never,
          }),
        ),
      ).rejects.toThrow(/^nativeSkills for adapter "codex" must be a boolean$/);
      expect(fixture.constructed).toEqual([]);
      expect(await fixture.recordings()).toEqual([]);
      expect(existsSync(join(fixture.codexHome, 'plugins'))).toBe(false);
    });
  },
);
