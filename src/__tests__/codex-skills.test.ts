// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// codex-76: skills reach Codex as a run-private plugin in the Codex home's
// plugin cache. The installed SDK spawns a recording fixture in place of the
// native CLI; the fixture snapshots the plugin cache while the run holds it
// and, where asked, renders the installed executable's offline prompt input
// under the same overrides, so the catalog evidence comes from the real
// runtime rather than from this adapter's own reading of its layout.

import { spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexAdapter } from '../adapters/codex.js';
import { probeCodexExecutable } from '../adapters/codex-executable.js';
import * as skillFiles from '../skills.js';
import type { AgentEvent, DonePayload, ErrorPayload } from '../types.js';

const fixturePaths = vi.hoisted(() => ({ codex: '' }));
vi.mock('../adapters/codex-executable.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../adapters/codex-executable.js')>();
  return {
    ...actual,
    resolveCodexBinPath: () =>
      fixturePaths.codex || actual.resolveCodexBinPath(),
  };
});

// A forced removal failure for the paths a test names, as skills-4 cases need.
const removal = vi.hoisted(() => ({
  fails: (_path: string): boolean => false,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) =>
      removal.fails(String(path))
        ? Promise.reject(
            Object.assign(
              new Error(`EACCES: forced removal failure, rm '${String(path)}'`),
              { code: 'EACCES' },
            ),
          )
        : actual.rm(path, options),
  };
});

const THREAD_ID = 'codex-skills-thread';
const MANIFEST = '{"name":"cligent","version":"1.0.0","skills":"./skills/"}';
const ALPHA_DESCRIPTION = 'Alpha fixture skill for the Codex plugin carrier.';
const BETA_DESCRIPTION = 'Beta fixture skill named by its SKILL.md path.';
const materialize = skillFiles.materializeSkills;
const roots: string[] = [];

afterEach(async () => {
  removal.fails = () => false;
  fixturePaths.codex = '';
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const FIXTURE = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME || join(homedir(), '.codex');
const cache = join(home, 'plugins', 'cache');
const walk = (dir, prefix) => readdirSync(dir).sort().flatMap((name) => {
  const path = join(dir, name);
  const rel = prefix ? prefix + '/' + name : name;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return [{ path: rel, type: 'link', target: readlinkSync(path) }];
  if (stats.isDirectory()) return [{ path: rel, type: 'dir' }, ...walk(path, rel)];
  return [{ path: rel, type: 'file', mode: stats.mode & 0o777, content: readFileSync(path, 'utf8') }];
});
const configs = args.flatMap((arg, index) => (args[index - 1] === '--config' ? [arg] : []));
const cwd = args[args.indexOf('--cd') + 1];
const render = (overrides) => execFileSync(
  process.env.CLIGENT_SKILLS_CATALOG,
  ['debug', 'prompt-input', ...overrides.flatMap((override) => ['-c', override]), 'probe'],
  {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: process.env.PATH ?? '', HOME: homedir(), CODEX_HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp' },
  },
);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const record = { args, prompt, home, cache: existsSync(cache) ? walk(cache, '') : [] };
  if (process.env.CLIGENT_SKILLS_CATALOG) {
    record.catalog = {
      cache: realpathSync(cache),
      withOverride: render(configs),
      withoutOverride: render(configs.filter((config) => !config.startsWith('plugins.'))),
    };
  }
  appendFileSync(process.env.CLIGENT_SKILLS_RECORDING, JSON.stringify(record) + '\\n');
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  send({ type: 'thread.started', thread_id: '${THREAD_ID}' });
  const mode = process.env.CLIGENT_SKILLS_MODE;
  if (mode === 'fail') {
    process.stderr.write('fixture failure');
    process.exitCode = 1;
    return;
  }
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'exhaust') return;
  if (mode === 'turn-failed') {
    send({ type: 'turn.failed', error: { message: 'fixture turn failure' } });
    process.exitCode = 1;
    return;
  }
  send({ type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: 'received' } });
  send({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
});
`;

interface CacheEntry {
  path: string;
  type: 'dir' | 'file' | 'link';
  mode?: number;
  content?: string;
  target?: string;
}

interface Recording {
  args: string[];
  prompt: string;
  home: string;
  cache: CacheEntry[];
  catalog?: { cache: string; withOverride: string; withoutOverride: string };
}

interface FixtureState {
  mode: 'success' | 'fail' | 'hang' | 'exhaust' | 'turn-failed';
  catalog: boolean;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cligent-codex-skills-'));
  roots.push(root);
  const home = join(root, 'codex-home');
  const workspace = join(root, 'workspace');
  const sources = join(root, 'sources');
  await mkdir(home);
  await mkdir(workspace);
  await mkdir(join(sources, 'alpha-skill', 'scripts'), { recursive: true });
  await mkdir(join(sources, 'beta-skill'), { recursive: true });
  const alpha = `---\nname: alpha-skill\ndescription: ${ALPHA_DESCRIPTION}\n---\n\nAlpha body.\n`;
  const beta = `---\nname: beta-skill\ndescription: ${BETA_DESCRIPTION}\n---\n\nBeta body.\n`;
  await writeFile(join(sources, 'alpha-skill', 'SKILL.md'), alpha);
  await writeFile(join(sources, 'alpha-skill', 'scripts', 'run.sh'), 'echo');
  await writeFile(join(sources, 'beta-skill', 'SKILL.md'), beta);
  await chmod(join(sources, 'alpha-skill', 'SKILL.md'), 0o644);
  await chmod(join(sources, 'alpha-skill', 'scripts', 'run.sh'), 0o755);
  await chmod(join(sources, 'beta-skill', 'SKILL.md'), 0o644);
  const config = '# user configuration\nmodel = "gpt-5"\n';
  await writeFile(join(home, 'config.toml'), config);

  fixturePaths.codex = join(root, 'codex-fixture.mjs');
  await writeFile(fixturePaths.codex, FIXTURE);
  await chmod(fixturePaths.codex, 0o755);
  const recording = join(root, 'recording.jsonl');
  const state: FixtureState = { mode: 'success', catalog: false };
  const constructed: unknown[] = [];
  const adapter = new CodexAdapter({
    loadSdk: async () => ({
      Codex: class extends Codex {
        constructor(options?: ConstructorParameters<typeof Codex>[0]) {
          constructed.push(options);
          const executable = probeCodexExecutable();
          super({
            ...options,
            // A permission policy runs through the generated wrapper, which
            // launches the fixture in place of the Codex CLI entry.
            codexPathOverride: options?.codexPathOverride ?? fixturePaths.codex,
            env: {
              ...inheritedEnvironment(),
              CLIGENT_SKILLS_RECORDING: recording,
              CLIGENT_SKILLS_MODE: state.mode,
              ...(state.catalog && executable.state === 'present'
                ? { CLIGENT_SKILLS_CATALOG: executable.path }
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
    workspace,
    sources,
    config,
    adapter,
    state,
    constructed,
    skills: [join(sources, 'alpha-skill'), '../sources/beta-skill/SKILL.md'],
    recordings: async (): Promise<Recording[]> =>
      existsSync(recording)
        ? (await readFile(recording, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Recording)
        : [],
  };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OWN_MARKETPLACE = new RegExp(
  `^cligent-${escapeRegExp(skillFiles.carrierHostToken())}-${process.pid}-[0-9a-f]{20}$`,
);

/** The run's single plugin override and the marketplace it names (codex-75). */
function pluginOverride(args: readonly string[]) {
  const overrides = args.filter(
    (arg, index) => args[index - 1] === '--config' && arg.startsWith('plugins'),
  );
  expect(overrides).toHaveLength(1);
  const match = /^plugins\.cligent@([^.]+)\.enabled=true$/.exec(overrides[0]!);
  expect(match, overrides[0]).not.toBeNull();
  const marketplace = match![1]!;
  expect(marketplace).toMatch(OWN_MARKETPLACE);
  return { override: overrides[0]!, marketplace };
}

function expectPluginLayout(cache: readonly CacheEntry[], marketplace: string) {
  const root = `${marketplace}/cligent/1.0.0`;
  const layout = cache
    .filter((entry) => entry.path.startsWith(`${marketplace}/`))
    .sort((a, b) => a.path.localeCompare(b.path));
  expect(layout).toEqual(
    [
      { path: `${marketplace}/cligent`, type: 'dir' },
      { path: root, type: 'dir' },
      { path: `${root}/.codex-plugin`, type: 'dir' },
      {
        path: `${root}/.codex-plugin/plugin.json`,
        type: 'file',
        mode: expect.any(Number),
        content: MANIFEST,
      },
      { path: `${root}/skills`, type: 'dir' },
      { path: `${root}/skills/alpha-skill`, type: 'dir' },
      {
        path: `${root}/skills/alpha-skill/SKILL.md`,
        type: 'file',
        mode: 0o644,
        content: expect.stringContaining(ALPHA_DESCRIPTION),
      },
      { path: `${root}/skills/alpha-skill/scripts`, type: 'dir' },
      {
        path: `${root}/skills/alpha-skill/scripts/run.sh`,
        type: 'file',
        mode: 0o755,
        content: 'echo',
      },
      { path: `${root}/skills/beta-skill`, type: 'dir' },
      {
        path: `${root}/skills/beta-skill/SKILL.md`,
        type: 'file',
        mode: 0o644,
        content: expect.stringContaining(BETA_DESCRIPTION),
      },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  );
  // Materialization finished: no staging entry beside the plugin.
  expect(cache.map((entry) => entry.path)).toContain(marketplace);
  expect(
    cache.filter((entry) => entry.path.startsWith(`${marketplace}/.`)),
  ).toEqual([]);
}

/**
 * The prompt input's catalog entries for the `cligent` namespace, each with
 * its description and the absolute SKILL.md path its root alias expands to.
 */
function cligentCatalog(rendered: string) {
  const text = (JSON.parse(rendered) as unknown[])
    .map((item) => JSON.stringify(item))
    .join('\n')
    .replace(/\\n/g, '\n');
  const roots = new Map(
    [...text.matchAll(/^- `(r\d+)` = `([^`]+)`$/gm)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  );
  return Object.fromEntries(
    [
      ...text.matchAll(
        /^- cligent:([a-z0-9-]+): (.*) \(file: (r\d+)\/(.+)\)$/gm,
      ),
    ].map((match) => [
      match[1]!,
      { description: match[2]!, file: `${roots.get(match[3]!)}/${match[4]!}` },
    ]),
  );
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  expect(skillFiles.isProcessRunning(child.pid)).toBe(false);
  return child.pid;
}

function suffix(): string {
  return skillFiles.carrierSuffix();
}

describe.skipIf(process.platform === 'win32')(
  'Codex run-private skill plugin through the installed SDK (codex-76)',
  () => {
    it('materializes, enables, sweeps, renders, and removes the plugin across fresh and resumed threads (codex-75, codex-78)', async () => {
      const fixture = await setup();
      vi.stubEnv('CODEX_HOME', fixture.home);
      const cache = join(fixture.home, 'plugins', 'cache');
      const host = skillFiles.carrierHostToken();
      const stale = `cligent-${host}-${deadPid()}-${suffix()}`;
      const failing = `cligent-${host}-${deadPid()}-${suffix()}`;
      const live = `cligent-${host}-${process.ppid}-${suffix()}`;
      const foreign = `cligent-foreign-${host}-x-${deadPid()}-${suffix()}`;
      for (const name of [stale, failing, live, foreign]) {
        await mkdir(join(cache, name, 'cligent', '1.0.0'), { recursive: true });
      }
      removal.fails = (path) => path === join(cache, failing);

      fixture.state.catalog = true;
      const fresh = await collect(
        fixture.adapter.run('Use the run skills.', {
          cwd: fixture.workspace,
          skills: fixture.skills,
        }),
      );
      expect(fresh.at(-1)?.payload).toMatchObject({
        status: 'success',
        resumeToken: THREAD_ID,
      });
      fixture.state.catalog = false;
      const resumed = await collect(
        fixture.adapter.run('Continue with the run skills.', {
          cwd: fixture.workspace,
          skills: fixture.skills,
          resume: THREAD_ID,
          permissions: { mode: 'auto' },
        }),
      );
      expect(resumed.at(-1)?.payload).toMatchObject({ status: 'success' });
      const control = await collect(
        fixture.adapter.run('Continue with the run skills.', {
          cwd: fixture.workspace,
          resume: THREAD_ID,
          permissions: { mode: 'auto' },
        }),
      );
      expect(control.at(-1)?.payload).toMatchObject({ status: 'success' });

      const [first, second, third] = await fixture.recordings();
      expect(first?.home).toBe(fixture.home);
      const { marketplace: firstMarketplace } = pluginOverride(first!.args);
      const { override, marketplace: secondMarketplace } = pluginOverride(
        second!.args,
      );
      expect(secondMarketplace).not.toBe(firstMarketplace);
      expect(first!.args).not.toContain('resume');
      expect(second!.args).toEqual(
        expect.arrayContaining(['resume', THREAD_ID]),
      );
      expectPluginLayout(first!.cache, firstMarketplace);
      expectPluginLayout(second!.cache, secondMarketplace);

      // The sweep ran before materializing: the dead process's marketplace
      // is gone, while a failed removal, a live process, and another host's
      // entry stay without failing the run.
      const topLevel = (entries: readonly CacheEntry[]) =>
        entries
          .filter((entry) => !entry.path.includes('/'))
          .map((entry) => entry.path)
          .sort();
      expect(topLevel(first!.cache)).toEqual(
        [failing, live, foreign, firstMarketplace].sort(),
      );

      // One unquoted enable override, and nothing else changes: the skill
      // filters, configuration isolation, and every other argument match the
      // same resumed run without skills.
      expect(second!.args).toContain('--ignore-user-config');
      expect(first!.args).not.toContain('--ignore-user-config');
      expect(
        second!.args.filter(
          (arg, index) =>
            arg !== override && second!.args[index + 1] !== override,
        ),
      ).toEqual(third!.args);
      expect(third!.args.some((arg) => arg.startsWith('plugins'))).toBe(false);
      expect(
        [...first!.args, ...second!.args].some((arg) =>
          /^skills[.=]/.test(arg),
        ),
      ).toBe(false);

      // The installed executable lists the run skills from the plugin root
      // under the same override, and not without it.
      const catalog = first!.catalog!;
      expect(
        catalog,
        'the installed Codex executable is required',
      ).toBeDefined();
      const pluginSkills = join(
        catalog.cache,
        firstMarketplace,
        'cligent',
        '1.0.0',
        'skills',
      );
      expect(cligentCatalog(catalog.withOverride)).toEqual({
        'alpha-skill': {
          description: ALPHA_DESCRIPTION,
          file: join(pluginSkills, 'alpha-skill', 'SKILL.md'),
        },
        'beta-skill': {
          description: BETA_DESCRIPTION,
          file: join(pluginSkills, 'beta-skill', 'SKILL.md'),
        },
      });
      expect(catalog.withoutOverride).not.toContain('cligent:');

      // codex-78: each run removed its own plugin root and marketplace; the
      // workspace and config.toml are untouched.
      for (const marketplace of [firstMarketplace, secondMarketplace]) {
        expect(existsSync(join(cache, marketplace))).toBe(false);
      }
      expect((await readdir(cache)).sort()).toEqual(
        [failing, live, foreign].sort(),
      );
      expect(await readdir(fixture.workspace)).toEqual([]);
      expect(await readFile(join(fixture.home, 'config.toml'), 'utf8')).toBe(
        fixture.config,
      );
    }, 120_000);

    it('falls back to ~/.codex and removes the parents the run created while empty (codex-75, codex-78)', async () => {
      const fixture = await setup();
      const userHome = join(fixture.root, 'user-home');
      await mkdir(userHome);
      vi.stubEnv('CODEX_HOME', undefined);
      vi.stubEnv('HOME', userHome);
      const events = await collect(
        fixture.adapter.run('Use the run skills.', {
          cwd: fixture.workspace,
          skills: fixture.skills,
        }),
      );
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      const [record] = await fixture.recordings();
      expect(record?.home).toBe(join(userHome, '.codex'));
      const { marketplace } = pluginOverride(record!.args);
      expectPluginLayout(record!.cache, marketplace);
      expect(readdirSync(userHome)).toEqual([]);
      expect(await readdir(fixture.workspace)).toEqual([]);
    });

    it('removes the plugin after SDK failure, exhaustion, turn failure, and abort terminals (codex-24, codex-25, codex-26, codex-27, codex-78)', async () => {
      const fixture = await setup();
      vi.stubEnv('CODEX_HOME', fixture.home);
      const cache = join(fixture.home, 'plugins', 'cache');
      const run = async (mode: FixtureState['mode']) => {
        fixture.state.mode = mode;
        const events = await collect(
          fixture.adapter.run(`Mode ${mode}.`, {
            cwd: fixture.workspace,
            skills: fixture.skills,
          }),
        );
        // codex-78: the marketplace is gone once the adapter's own stream
        // completes, whichever terminal the SDK stream selected.
        const [record] = (await fixture.recordings()).slice(-1);
        const { marketplace } = pluginOverride(record!.args);
        expectPluginLayout(record!.cache, marketplace);
        expect(existsSync(join(cache, marketplace))).toBe(false);
        return events;
      };
      const errorOf = (events: readonly AgentEvent[]) =>
        events.filter((event) => event.type === 'error')[0]?.payload;

      const failed = await run('fail');
      expect(errorOf(failed)).toMatchObject({
        code: 'SDK_STREAM_ERROR',
      } satisfies Partial<ErrorPayload>);
      expect(failed.at(-1)?.payload).toMatchObject({ status: 'error' });

      const exhausted = await run('exhaust');
      expect(errorOf(exhausted)).toEqual({
        code: 'MISSING_TURN_DONE',
        message:
          'Protocol violation: Codex stream ended without turn.completed',
        recoverable: false,
      } satisfies ErrorPayload);
      expect(exhausted.at(-1)).toMatchObject({
        type: 'done',
        payload: { status: 'error', resumeToken: THREAD_ID },
      });

      const turnFailed = await run('turn-failed');
      expect(
        turnFailed
          .filter((event) => event.type === 'error')
          .map((e) => e.payload),
      ).toEqual([
        { message: 'fixture turn failure', recoverable: false },
      ] satisfies ErrorPayload[]);
      expect(turnFailed.at(-1)).toMatchObject({
        type: 'done',
        payload: { status: 'error', resumeToken: THREAD_ID },
      });
      expect(turnFailed.at(-1)?.payload).not.toHaveProperty('result');

      fixture.state.mode = 'hang';
      const controller = new AbortController();
      const aborted: AgentEvent[] = [];
      for await (const event of fixture.adapter.run('Hang.', {
        cwd: fixture.workspace,
        skills: fixture.skills,
        abortSignal: controller.signal,
      })) {
        aborted.push(event);
        if (event.type === 'init') controller.abort();
      }
      expect(aborted.at(-1)?.payload).toMatchObject({
        status: 'interrupted',
        resumeToken: THREAD_ID,
      } satisfies Partial<DonePayload>);

      const recordings = await fixture.recordings();
      expect(recordings).toHaveLength(4);
      for (const record of recordings) {
        const { marketplace } = pluginOverride(record.args);
        expectPluginLayout(record.cache, marketplace);
        expect(existsSync(join(cache, marketplace))).toBe(false);
      }
      // The run created plugins/cache, so it removed both once empty.
      expect(await readdir(fixture.home)).toEqual(['config.toml']);
    });

    it('rejects a CODEX_HOME naming no directory with the runtime message before any write (codex-75)', async () => {
      const fixture = await setup();
      const executable = probeCodexExecutable();
      expect(
        executable.state,
        'the installed Codex executable is required',
      ).toBe('present');
      const before = (await readdir(fixture.root)).sort();
      const file = join(fixture.root, 'home-file');
      await writeFile(file, 'not a directory');
      const missing = join(fixture.root, 'missing-home');
      const cases = [
        [missing, 'does not exist'],
        [file, 'is not a directory'],
      ] as const;
      for (const [home, reason] of cases) {
        vi.stubEnv('CODEX_HOME', home);
        const message = `CODEX_HOME points to ${JSON.stringify(home)}, but that path ${reason}`;
        // The installed runtime refuses the same home with the same message.
        const runtime = spawnSync(
          executable.state === 'present' ? executable.path : '',
          ['debug', 'prompt-input', 'probe'],
          {
            cwd: fixture.workspace,
            encoding: 'utf8',
            timeout: 60_000,
            env: {
              PATH: process.env.PATH ?? '',
              HOME: fixture.root,
              CODEX_HOME: home,
            },
          },
        );
        expect(runtime.status).not.toBe(0);
        expect(runtime.stderr).toContain(`Error: ${message}\n`);

        const controller = new AbortController();
        await expect(
          collect(
            fixture.adapter.run('Use the run skills.', {
              cwd: fixture.workspace,
              skills: fixture.skills,
              abortSignal: controller.signal,
            }),
          ),
        ).rejects.toThrow(new RegExp(`^${escapeRegExp(message)}$`));
        // The run released its abort registration before rejecting.
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      }
      expect(existsSync(missing)).toBe(false);
      expect(await readFile(file, 'utf8')).toBe('not a directory');
      expect((await readdir(fixture.root)).sort()).toEqual(
        [...before, 'home-file'].sort(),
      );
      expect(await readdir(fixture.home)).toEqual(['config.toml']);
      expect(await readdir(fixture.workspace)).toEqual([]);
      expect(fixture.constructed).toEqual([]);
      expect(await fixture.recordings()).toEqual([]);
    });

    it('rejects an unsupported effort before sweeping or writing the Codex home (codex-75)', async () => {
      const fixture = await setup();
      vi.stubEnv('CODEX_HOME', fixture.home);
      const cache = join(fixture.home, 'plugins', 'cache');
      const stale = `cligent-${skillFiles.carrierHostToken()}-${deadPid()}-${suffix()}`;
      await mkdir(join(cache, stale, 'cligent', '1.0.0'), { recursive: true });
      const tree = () => readdirSync(fixture.home, { recursive: true }).sort();
      const before = tree();
      const materializing = vi.spyOn(skillFiles, 'materializeSkills');

      await expect(
        collect(
          fixture.adapter.run('Use the run skills.', {
            cwd: fixture.workspace,
            skills: fixture.skills,
            effort: 'ultracode' as never,
          }),
        ),
      ).rejects.toThrow(/^effort for adapter "codex" must be one of: /);
      expect(tree()).toEqual(before);
      expect(existsSync(join(cache, stale))).toBe(true);
      expect(materializing).not.toHaveBeenCalled();
      expect(fixture.constructed).toEqual([]);
      expect(await fixture.recordings()).toEqual([]);
    });

    it('removes the plugin and keeps the run error when the wrapper cleanup fails (codex-78)', async () => {
      const fixture = await setup();
      vi.stubEnv('CODEX_HOME', fixture.home);
      const cache = join(fixture.home, 'plugins', 'cache');
      const seen: { wrapper: string; marketplace: string; held: boolean }[] =
        [];
      const failing = (stage: 'construct' | 'start') =>
        new CodexAdapter({
          loadSdk: async () => ({
            Codex: class {
              constructor(options?: ConstructorParameters<typeof Codex>[0]) {
                // A permission policy runs through the generated wrapper,
                // whose cleanup this run forces to fail.
                const wrapper = dirname(options!.codexPathOverride!);
                roots.push(wrapper);
                removal.fails = (path) => path === wrapper;
                const override = (options!.configOverrides as string[]).find(
                  (entry) => entry.startsWith('plugins.'),
                );
                const marketplace =
                  /^plugins\.cligent@([^.]+)\.enabled=true$/.exec(
                    override ?? '',
                  )?.[1];
                expect(marketplace).toMatch(OWN_MARKETPLACE);
                seen.push({
                  wrapper,
                  marketplace: marketplace!,
                  held: existsSync(join(cache, marketplace!)),
                });
                if (stage === 'construct') {
                  throw new Error('constructor failure');
                }
              }

              startThread() {
                throw new Error('thread start failure');
              }
            } as unknown as typeof Codex,
          }),
        });
      const run = (stage: 'construct' | 'start') =>
        collect(
          failing(stage).run('Use the run skills.', {
            cwd: fixture.workspace,
            skills: fixture.skills,
            permissions: { mode: 'auto' },
          }),
        );

      await expect(run('construct')).rejects.toThrow(
        /^CodexAdapter failed to initialize: constructor failure$/,
      );
      await expect(run('start')).rejects.toThrow(/^thread start failure$/);
      expect(seen).toHaveLength(2);
      for (const { wrapper, marketplace, held } of seen) {
        expect(held).toBe(true);
        expect(existsSync(wrapper)).toBe(true);
        expect(existsSync(join(cache, marketplace))).toBe(false);
      }
      expect(await readdir(fixture.home)).toEqual(['config.toml']);
    });

    it('interrupts cancelled skill preparation without invoking the SDK and removes what it materialized (codex-69, codex-78)', async () => {
      const fixture = await setup();
      vi.stubEnv('CODEX_HOME', fixture.home);
      const cache = join(fixture.home, 'plugins', 'cache');

      const before = new AbortController();
      before.abort();
      const validation = await collect(
        fixture.adapter.run('Cancelled.', {
          cwd: fixture.workspace,
          skills: fixture.skills,
          abortSignal: before.signal,
          resume: THREAD_ID,
        }),
      );
      expect(validation).toHaveLength(1);
      expect(validation[0]).toMatchObject({
        type: 'done',
        payload: {
          status: 'interrupted',
          resumeToken: THREAD_ID,
          usage: { toolUses: 0 },
        },
      });
      expect(existsSync(join(fixture.home, 'plugins'))).toBe(false);

      const during = new AbortController();
      let held: string[] = [];
      vi.spyOn(skillFiles, 'materializeSkills').mockImplementationOnce(
        async (skills, options) => {
          held = readdirSync(cache);
          during.abort();
          return materialize(skills, options);
        },
      );
      const materializing = await collect(
        fixture.adapter.run('Cancelled.', {
          cwd: fixture.workspace,
          skills: fixture.skills,
          abortSignal: during.signal,
        }),
      );
      expect(materializing).toHaveLength(1);
      const done = materializing[0]!.payload as DonePayload;
      expect(materializing[0]?.type).toBe('done');
      expect(done).toMatchObject({
        status: 'interrupted',
        usage: { toolUses: 0 },
      });
      expect(done).not.toHaveProperty('resumeToken');
      expect(done).not.toHaveProperty('result');
      expect(done.durationMs).toBeGreaterThanOrEqual(0);
      expect(held).toHaveLength(1);
      expect(held[0]).toMatch(OWN_MARKETPLACE);
      expect(existsSync(join(fixture.home, 'plugins'))).toBe(false);
      expect(fixture.constructed).toEqual([]);
      expect(await fixture.recordings()).toEqual([]);
    });

    it('suppresses a removal failure after done and names it on a rejection (codex-78)', async () => {
      const fixture = await setup();
      vi.stubEnv('CODEX_HOME', fixture.home);
      const cache = join(fixture.home, 'plugins', 'cache');
      // Fail only the removal of the plugin root and its marketplace.
      removal.fails = (path) => {
        if (!path.startsWith(`${cache}/`)) return false;
        const [marketplace, ...rest] = path.slice(cache.length + 1).split('/');
        return (
          OWN_MARKETPLACE.test(marketplace!) &&
          ['', 'cligent/1.0.0'].includes(rest.join('/'))
        );
      };

      const events = await collect(
        fixture.adapter.run('Use the run skills.', {
          cwd: fixture.workspace,
          skills: fixture.skills,
        }),
      );
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      const [record] = await fixture.recordings();
      const { marketplace } = pluginOverride(record!.args);
      expect(existsSync(join(cache, marketplace))).toBe(true);

      const rejecting = new CodexAdapter({
        loadSdk: async () => ({
          Codex: class {
            constructor() {
              throw new Error('constructor failure');
            }
          } as unknown as typeof Codex,
        }),
      });
      const rejection = collect(
        rejecting.run('Use the run skills.', {
          cwd: fixture.workspace,
          skills: fixture.skills,
        }),
      );
      await expect(rejection).rejects.toThrow(
        new RegExp(
          `^CodexAdapter failed to initialize: constructor failure \\(skill carrier cleanup failed: ${escapeRegExp(cache)}/cligent-[^:]+/cligent/1\\.0\\.0: EACCES`,
        ),
      );
      removal.fails = () => false;
    });
  },
);
