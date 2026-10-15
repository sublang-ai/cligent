// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// opencode-68: the managed skill carrier, its inline configuration, the
// server's skill listing, and carrier removal, through the installed SDK and
// a recording `opencode serve` fixture that discovers skills from the inline
// configuration it was spawned with.

import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';

import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeAdapter, wrapOpencodeClient } from '../adapters/opencode.js';
import type * as SkillsModule from '../skills.js';
import type { AgentEvent, AgentOptions, OpenCodeEffort } from '../types.js';

const browserPreparation = vi.hoisted(() => vi.fn());
vi.mock('../browser.js', () => ({
  prepareBrowserServer: browserPreparation,
  releaseBrowserServer: async () => {},
}));

type Materialize = typeof SkillsModule.materializeSkills;

// A test may wrap the shared snapshot to observe it mid-copy; otherwise the
// adapter's call passes straight through.
const materializeHook = vi.hoisted(() => ({
  current: undefined as
    | ((
        actual: Materialize,
        ...parameters: Parameters<Materialize>
      ) => ReturnType<Materialize>)
    | undefined,
}));
vi.mock('../skills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SkillsModule>();
  return {
    ...actual,
    materializeSkills: (...parameters: Parameters<Materialize>) =>
      materializeHook.current
        ? materializeHook.current(actual.materializeSkills, ...parameters)
        : actual.materializeSkills(...parameters),
  };
});

const SESSION_ID = 'skill-session';

/** How long the fixture server takes to close after a signal. */
const CLOSE_DELAY_MS = 50;

const RUNS_AS_ROOT = process.getuid?.() === 0;

type ListingMode =
  | 'every'
  | 'displace'
  | 'omit'
  | 'reject'
  | 'malformed'
  | 'malformed-entry'
  | 'hang'
  | 'exit';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly directory: string | null;
  readonly body?: unknown;
}

interface CarrierSnapshot {
  readonly base: string;
  readonly baseMode: number;
  readonly baseEntries: string[];
  readonly rootEntries: string[];
  readonly skillFiles: Record<string, string>;
}

class FixtureServeProcess extends EventEmitter {
  readonly stdout = new PassThrough();

  readonly stderr = new PassThrough();

  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  /** Whether the carrier existed when 'close' fired; undefined before it fires. */
  carrierPresentAtClose: boolean | undefined;

  private closeScheduled = false;

  private closed = false;

  constructor(private readonly carrierPresent: () => boolean) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (!this.closeScheduled) {
      // A real server takes a moment to exit, so a carrier removed before
      // teardown completes would show as absent at close.
      this.closeScheduled = true;
      setTimeout(() => {
        this.exit(null, typeof signal === 'string' ? signal : null);
      }, CLOSE_DELAY_MS);
    }
    return true;
  }

  /** End the streams and fire 'close' once, recording the carrier's presence. */
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.carrierPresentAtClose = this.carrierPresent();
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptionsWithoutStdio;
  readonly process: FixtureServeProcess;
}

/** The skill paths a spawned server reads from its inline configuration. */
function configuredSkillPaths(env: NodeJS.ProcessEnv | undefined): string[] {
  const content = env?.OPENCODE_CONFIG_CONTENT;
  if (!content) return [];
  const skills = (JSON.parse(content) as { skills?: unknown }).skills;
  const entries = Array.isArray(skills)
    ? skills
    : ((skills as { paths?: unknown[] } | undefined)?.paths ?? []);
  return entries.filter(
    (entry): entry is string =>
      typeof entry === 'string' &&
      !/^https?:\/\//i.test(entry) &&
      isAbsolute(entry) &&
      existsSync(entry),
  );
}

/** The private temporary directory holding the run's carrier root. */
function carrierBaseOf(env: NodeJS.ProcessEnv | undefined): string | undefined {
  const [first] = configuredSkillPaths(env);
  return first === undefined ? undefined : dirname(dirname(first));
}

function findSkillFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findSkillFiles(path));
    else if (entry.name === 'SKILL.md') found.push(path);
  }
  return found;
}

/** What OpenCode 1.18.33 lists for configured paths: each `**\/SKILL.md`, keyed by name. */
function discoverSkills(env: NodeJS.ProcessEnv | undefined) {
  return configuredSkillPaths(env).flatMap((path) =>
    findSkillFiles(path).map((location) => {
      const content = readFileSync(location, 'utf8');
      return {
        name: /^name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? '',
        description: /^description:\s*(.+)$/m.exec(content)?.[1]?.trim(),
        location,
        content,
      };
    }),
  );
}

function snapshotCarrier(
  env: NodeJS.ProcessEnv | undefined,
): CarrierSnapshot | undefined {
  const [first] = configuredSkillPaths(env);
  if (!first) return undefined;
  const root = dirname(first);
  const base = dirname(root);
  const rootEntries = readdirSync(root).sort();
  return {
    base,
    baseMode: statSync(base).mode & 0o777,
    baseEntries: readdirSync(base).sort(),
    rootEntries,
    skillFiles: Object.fromEntries(
      rootEntries.map((name) => [
        name,
        readFileSync(join(root, name, 'SKILL.md'), 'utf8'),
      ]),
    ),
  };
}

async function startFixture(listingMode: ListingMode = 'every') {
  const requests: RecordedRequest[] = [];
  const snapshots: CarrierSnapshot[] = [];
  const subscribers = new Set<ServerResponse>();
  const hanging = new Set<ServerResponse>();
  const spawns: SpawnRecord[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://localhost');
      let text = '';
      for await (const chunk of request) text += String(chunk);
      requests.push({
        method: request.method!,
        path: url.pathname,
        directory: url.searchParams.get('directory'),
        ...(text ? { body: JSON.parse(text) as unknown } : {}),
      });
      if (url.pathname === '/event') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"type":"server.connected","properties":{}}\n\n');
        subscribers.add(response);
        response.on('close', () => subscribers.delete(response));
        return;
      }
      if (url.pathname === '/skill') {
        const env = spawns.at(-1)?.options.env;
        const snapshot = snapshotCarrier(env);
        if (snapshot) snapshots.push(snapshot);
        if (listingMode === 'hang') {
          hanging.add(response);
          return;
        }
        if (listingMode === 'reject') {
          response.writeHead(500, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              name: 'UnknownError',
              data: { message: 'fixture listing failure' },
            }),
          );
          return;
        }
        if (listingMode === 'exit') {
          // The server ends while the listing is still pending.
          hanging.add(response);
          spawns.at(-1)?.process.exit(1, null);
          return;
        }
        let listing: unknown = discoverSkills(env);
        if (listingMode === 'malformed') listing = { skills: 'not a list' };
        if (listingMode === 'malformed-entry') listing = [{ name: 'alpha' }];
        if (listingMode === 'omit') {
          listing = (listing as Array<{ name: string }>).filter(
            (skill) => skill.name !== 'beta',
          );
        }
        if (listingMode === 'displace') {
          listing = (listing as Array<{ name: string }>).map((skill) =>
            skill.name === 'beta'
              ? { ...skill, location: '/elsewhere/beta/SKILL.md' }
              : skill,
          );
        }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(listing));
        return;
      }
      if (
        request.method === 'POST' &&
        (url.pathname.endsWith('/prompt_async') ||
          url.pathname.endsWith('/message'))
      ) {
        response.writeHead(204).end();
        for (const subscriber of subscribers) {
          subscriber.write(
            `data: {"type":"session.idle","properties":{"sessionID":"${SESSION_ID}"}}\n\n`,
          );
        }
        return;
      }
      let data: unknown = true;
      if (url.pathname === '/global/health') {
        data = { healthy: true, version: '1.18.33' };
      } else if (url.pathname === '/session' && request.method === 'POST') {
        data = { id: SESSION_ID, title: 'Cligent run' };
      } else if (url.pathname.endsWith('/children')) {
        data = [];
      } else if (url.pathname === `/session/${SESSION_ID}`) {
        data = { id: SESSION_ID, title: 'Cligent run' };
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(data));
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const url = `http://127.0.0.1:${address.port}`;

  const spawnProcess = (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ): ChildProcessWithoutNullStreams => {
    const base = carrierBaseOf(options.env);
    const child = new FixtureServeProcess(
      () => base !== undefined && existsSync(base),
    );
    spawns.push({ command, args, options, process: child });
    setImmediate(() => {
      child.stdout.write(`opencode server listening on ${url}\n`);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };

  return {
    url,
    requests,
    snapshots,
    spawns,
    spawnProcess,
    async close() {
      for (const subscriber of subscribers) subscriber.end();
      for (const response of hanging) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/**
 * Iterate by hand, listing the temporary directory the moment each error and
 * terminal arrives, before the consumer asks for anything further.
 */
async function collectObservingCarrier(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  const carrierAtArrival: Array<{ type: string; entries: string[] }> = [];
  for await (const event of stream) {
    if (event.type === 'error' || event.type === 'done') {
      carrierAtArrival.push({
        type: event.type,
        entries: readdirSync(carrierTmp),
      });
    }
    events.push(event);
  }
  return { events, carrierAtArrival };
}

const SKILL_TEXT = {
  alpha:
    '---\nname: alpha\ndescription: Alpha fixture skill.\n---\n\nSay alpha.\n',
  beta: '---\nname: beta\ndescription: Beta fixture skill.\n---\n\nSay beta.\n',
  gamma:
    '---\nname: gamma\ndescription: Gamma fixture skill.\n---\n\nSay gamma.\n',
} as const;

const dirs: string[] = [];
/** Carrier directories a test made unremovable, restored before cleanup. */
const lockedBases: string[] = [];
let cwd: string;
let carrierTmp: string;

function lockCarrier(base: string) {
  lockedBases.push(base);
  chmodSync(base, 0o500);
}

async function writeSkill(name: keyof typeof SKILL_TEXT): Promise<string> {
  const directory = join(cwd, 'skills-src', name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), SKILL_TEXT[name]);
  return directory;
}

beforeEach(async () => {
  vi.stubEnv('CLIGENT_RUNTIME_GATE', 'off');
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', undefined);
  browserPreparation.mockReset();
  materializeHook.current = undefined;
  const realTmp = realpathSync(tmpdir());
  cwd = await mkdtemp(join(realTmp, 'cligent-opencode-skills-cwd-'));
  carrierTmp = await mkdtemp(join(realTmp, 'cligent-opencode-skills-tmp-'));
  dirs.push(cwd, carrierTmp);
  // The adapter creates its private carrier under the operating-system
  // temporary directory, which this test observes through TMPDIR.
  vi.stubEnv('TMPDIR', carrierTmp);
  await writeSkill('alpha');
  await writeSkill('beta');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  materializeHook.current = undefined;
  for (const base of lockedBases.splice(0)) {
    if (existsSync(base)) chmodSync(base, 0o700);
  }
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

type Fixture = Awaited<ReturnType<typeof startFixture>>;
type SpawnProcess = Fixture['spawnProcess'];

function managedAdapter(
  fixture: Fixture,
  spawnProcess: SpawnProcess = fixture.spawnProcess,
) {
  return new OpenCodeAdapter(
    { mode: 'managed', serverUrl: 'http://127.0.0.1:0' },
    {
      spawnProcess,
      managedServerTermGraceMs: 200,
      managedServerKillGraceMs: 200,
    },
  );
}

/** A spawn that fails once the carrier holds the run's skills. */
function failingSpawn(onCarrier?: (base: string) => void): SpawnProcess {
  return (_command, _args, options) => {
    const base = carrierBaseOf(options.env);
    expect(base).toBeDefined();
    onCarrier?.(base!);
    throw new Error('fixture spawn failure');
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runOptions(
  extra: AgentOptions<OpenCodeEffort> = {},
): AgentOptions<OpenCodeEffort> {
  return {
    cwd,
    skills: ['skills-src/alpha', 'skills-src/beta/SKILL.md'],
    ...extra,
  };
}

function errorMessages(events: readonly AgentEvent[]): string[] {
  return events
    .filter((event) => event.type === 'error')
    .map((event) => String((event.payload as { message?: unknown }).message));
}

function expectNoCarrierLeft() {
  expect(readdirSync(carrierTmp)).toEqual([]);
}

describe('OpenCode managed skills (opencode-68)', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])(
    'delivers skills through a private carrier when the caller configuration is %s',
    async (_label, callerValue) => {
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', callerValue);
      vi.stubEnv('CLIGENT_SKILL_FIXTURE_PASSTHROUGH', 'kept');
      const materialized: Array<{ root: string; staging: string }> = [];
      materializeHook.current = (actual, skills, options) => {
        materialized.push({ root: options.root, staging: options.staging });
        return actual(skills, options);
      };
      const fixture = await startFixture('every');
      try {
        const events = await collect(
          managedAdapter(fixture).run(
            'Use the alpha skill.',
            runOptions({ permissions: { fileWrite: 'allow' } }),
          ),
        );
        expect(errorMessages(events)).toEqual([]);
        expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
        expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });

        // Carrier layout, as the server saw it while listing (opencode-67).
        expect(fixture.spawns).toHaveLength(1);
        const spawn = fixture.spawns[0]!;
        expect(spawn.command).toBe('opencode');
        expect(spawn.args).toEqual([
          'serve',
          '--hostname',
          '127.0.0.1',
          '--port',
          '0',
        ]);
        expect(spawn.options.cwd).toBe(cwd);
        expect(fixture.snapshots).toHaveLength(1);
        const snapshot = fixture.snapshots[0]!;
        expect(dirname(snapshot.base)).toBe(carrierTmp);
        expect(basename(snapshot.base)).toMatch(/^cligent-opencode-skills-/);
        expect(snapshot.baseMode).toBe(0o700);
        expect(snapshot.baseEntries).toEqual(['skills']);
        expect(snapshot.rootEntries).toEqual(['alpha', 'beta']);
        expect(snapshot.skillFiles).toEqual({
          alpha: SKILL_TEXT.alpha,
          beta: SKILL_TEXT.beta,
        });
        const root = join(snapshot.base, 'skills');
        // The temporary-name writes go to the root's staging sibling, which
        // is gone by the time the server lists.
        expect(materialized).toEqual([
          { root, staging: join(snapshot.base, 'staging') },
        ]);

        // Exact merged environment: the parent environment plus the run's
        // paths in a configuration of their own.
        const env = spawn.options.env!;
        expect(env.OPENCODE_CONFIG_CONTENT).toBe(
          JSON.stringify({
            skills: { paths: [join(root, 'alpha'), join(root, 'beta')] },
          }),
        );
        expect(env).toEqual({
          ...process.env,
          OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT,
        });
        expect(env.CLIGENT_SKILL_FIXTURE_PASSTHROUGH).toBe('kept');

        // The listing precedes session creation and names the run directory
        // (opencode-69); the session carries no generated skill rule.
        const paths = fixture.requests.map(
          (request) => `${request.method} ${request.path}`,
        );
        const listing = paths.indexOf('GET /skill');
        expect(listing).toBeGreaterThanOrEqual(0);
        expect(listing).toBeLessThan(paths.indexOf('POST /session'));
        expect(fixture.requests[listing]?.directory).toBe(cwd);
        const created = fixture.requests.find(
          (request) => request.method === 'POST' && request.path === '/session',
        );
        const rules = (created?.body as { permission?: unknown })?.permission;
        expect(Array.isArray(rules)).toBe(true);
        expect(
          (rules as Array<{ permission: string }>).map(
            (rule) => rule.permission,
          ),
        ).toContain('edit');
        expect(
          (rules as Array<{ permission: string }>).some(
            (rule) => rule.permission === 'skill',
          ),
        ).toBe(false);

        // Removal follows teardown: the carrier outlives the server's close
        // and is gone once the stream completes (opencode-71).
        expect(spawn.process.killSignals).toEqual(['SIGTERM']);
        expect(spawn.process.carrierPresentAtClose).toBe(true);
        expect(existsSync(snapshot.base)).toBe(false);
        expectNoCarrierLeft();
      } finally {
        await fixture.close();
      }
    },
  );

  it.each([
    [
      'object form with skills.paths, in JSONC',
      `{
  // caller configuration
  "model": "fixture/model",
  "skills": {
    "paths": ["./caller-skills", "{env:CALLER_SKILL_DIR}"],
    "urls": ["https://example.test/skills/"],
  },
}`,
      (runPaths: string[]) => ({
        model: 'fixture/model',
        skills: {
          paths: ['./caller-skills', '{env:CALLER_SKILL_DIR}', ...runPaths],
          urls: ['https://example.test/skills/'],
        },
      }),
    ],
    [
      'array form holding a placeholder that resolves to an HTTPS URL',
      '{"skills": ["{env:SKILL_INDEX_URL}", "./local-skills"], "share": "disabled"}',
      (runPaths: string[]) => ({
        skills: ['{env:SKILL_INDEX_URL}', './local-skills', ...runPaths],
        share: 'disabled',
      }),
    ],
    [
      'object without skills',
      '{"model": "fixture/model", "skills_note": "{env:UNUSED}"}',
      (runPaths: string[]) => ({
        model: 'fixture/model',
        skills_note: '{env:UNUSED}',
        skills: { paths: runPaths },
      }),
    ],
    [
      'skills object holding only urls',
      '{"skills":{"urls":["https://example.test/"]}}',
      (runPaths: string[]) => ({
        skills: { urls: ['https://example.test/'], paths: runPaths },
      }),
    ],
  ])(
    'appends the run paths to a caller configuration in %s',
    async (_label, callerValue, expected) => {
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', callerValue);
      vi.stubEnv('SKILL_INDEX_URL', 'https://example.test/.well-known/skills/');
      const fixture = await startFixture('every');
      try {
        const events = await collect(
          managedAdapter(fixture).run('Use the skills.', runOptions()),
        );
        expect(errorMessages(events)).toEqual([]);
        expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
        const root = join(fixture.snapshots[0]!.base, 'skills');
        const env = fixture.spawns[0]!.options.env!;
        expect(env.OPENCODE_CONFIG_CONTENT).toBe(
          JSON.stringify(expected([join(root, 'alpha'), join(root, 'beta')])),
        );
        // The placeholder stays for the runtime's own substitution.
        expect(env.SKILL_INDEX_URL).toBe(
          'https://example.test/.well-known/skills/',
        );
        expectNoCarrierLeft();
      } finally {
        await fixture.close();
      }
    },
  );

  it.each([
    ['an array', '["alpha"]', 'parses to an array'],
    ['a string', '"text"', 'parses to a string'],
    ['null', 'null', 'parses to null'],
    ['broken JSONC', '{ "skills": [', 'does not parse as JSONC'],
    ['a comma after an opening brace', '{,}', 'does not parse as JSONC'],
    [
      'a comma after an opening bracket',
      '{"skills":[,]}',
      'does not parse as JSONC',
    ],
    ['a skills string', '{"skills": "alpha"}', 'its skills is a string'],
    ['a null skills', '{"skills":null}', 'its skills is null'],
    [
      'a skills object with string paths',
      '{"skills":{"paths":"x"}}',
      'its skills.paths is a string',
    ],
  ])(
    'fails setup before spawn when the caller configuration is %s',
    async (_label, callerValue, fragment) => {
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', callerValue);
      const fixture = await startFixture('every');
      try {
        const { events, carrierAtArrival } = await collectObservingCarrier(
          managedAdapter(fixture).run('Use the skills.', runOptions()),
        );
        const messages = errorMessages(events);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('OPENCODE_CONFIG_CONTENT');
        expect(messages[0]).toContain(fragment);
        expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
        expect(fixture.spawns).toHaveLength(0);
        expect(fixture.requests).toHaveLength(0);
        // No carrier exists when the error and the terminal arrive.
        expect(carrierAtArrival).toEqual([
          { type: 'error', entries: [] },
          { type: 'done', entries: [] },
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  it('removes the carrier before the terminal when spawning fails (opencode-71)', async () => {
    const fixture = await startFixture('every');
    let spawnedBase: string | undefined;
    try {
      const { events, carrierAtArrival } = await collectObservingCarrier(
        managedAdapter(
          fixture,
          failingSpawn((base) => {
            spawnedBase = base;
          }),
        ).run('Use the skills.', runOptions()),
      );
      // The carrier existed when the spawn was attempted.
      expect(spawnedBase).toBeDefined();
      expect(errorMessages(events)).toEqual(['fixture spawn failure']);
      expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
      expect(carrierAtArrival).toEqual([
        { type: 'error', entries: [] },
        { type: 'done', entries: [] },
      ]);
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    [
      'displaces a skill',
      'displace' as const,
      'beta is listed at /elsewhere/beta/SKILL.md instead of',
    ],
    ['omits a skill', 'omit' as const, 'beta is missing'],
    ['rejects the request', 'reject' as const, 'OpenCode skill listing failed'],
    [
      'returns a malformed body',
      'malformed' as const,
      'OpenCode skill listing is malformed',
    ],
    [
      'returns an entry without a location',
      'malformed-entry' as const,
      'OpenCode skill listing is malformed',
    ],
    [
      'stays unsettled past five seconds',
      'hang' as const,
      'OpenCode skill listing did not settle within 5000 ms',
    ],
    [
      "ends with the server's exit",
      'exit' as const,
      'OpenCode skill listing failed: OpenCode server exited unexpectedly (code=1, signal=null)',
    ],
  ])(
    'fails setup before session work when the listing %s (opencode-69)',
    async (_label, listingMode, fragment) => {
      const fixture = await startFixture(listingMode);
      try {
        const started = performance.now();
        const events = await collect(
          managedAdapter(fixture).run('Use the skills.', runOptions()),
        );
        const elapsed = performance.now() - started;
        const messages = errorMessages(events);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(fragment);
        expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
        expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
        if (listingMode === 'hang') {
          expect(elapsed).toBeGreaterThanOrEqual(4_900);
        }
        expect(fixture.snapshots).toHaveLength(1);
        expect(
          fixture.requests.filter(
            (request) =>
              request.path === '/session' ||
              request.path === '/event' ||
              request.path.endsWith('/prompt_async') ||
              request.path.endsWith('/message'),
          ),
        ).toEqual([]);
        // A server that already exited takes no signal (opencode-36).
        const spawn = fixture.spawns[0]!;
        expect(spawn.process.killSignals).toEqual(
          listingMode === 'exit' ? [] : ['SIGTERM'],
        );
        expect(spawn.process.carrierPresentAtClose).toBe(true);
        expectNoCarrierLeft();
      } finally {
        await fixture.close();
      }
    },
    15_000,
  );

  it('fails setup before session work when the client has no listing route (opencode-69)', async () => {
    const fixture = await startFixture('every');
    try {
      const adapter = new OpenCodeAdapter(
        { mode: 'managed', serverUrl: 'http://127.0.0.1:0' },
        {
          spawnProcess: fixture.spawnProcess,
          managedServerTermGraceMs: 200,
          managedServerKillGraceMs: 200,
          loadSdk: async () => ({
            createClient: ({ baseUrl } = {}) => {
              const real = createOpencodeClient({ baseUrl });
              Object.defineProperty(real.app, 'skills', { value: undefined });
              return wrapOpencodeClient(
                real as unknown as Record<string, unknown>,
                { apiVersion: 'v2' },
              );
            },
          }),
        },
      );
      const events = await collect(
        adapter.run('Use the skills.', runOptions()),
      );
      const messages = errorMessages(events);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('cannot list skills');
      expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
      expect(
        fixture.requests.filter((request) => request.path === '/session'),
      ).toEqual([]);
      expect(fixture.spawns[0]?.process.killSignals).toEqual(['SIGTERM']);
      expect(fixture.spawns[0]?.process.carrierPresentAtClose).toBe(true);
      expectNoCarrierLeft();
    } finally {
      await fixture.close();
    }
  });

  it('rejects a non-empty list on an external server before browser preparation (opencode-67)', async () => {
    const fixture = await startFixture('every');
    const loadSdk = vi.fn();
    try {
      const adapter = new OpenCodeAdapter(
        { mode: 'external', serverUrl: fixture.url },
        { loadSdk },
      );
      await expect(
        collect(adapter.run('Use the skills.', runOptions({ browser: true }))),
      ).rejects.toThrow('OpenCode skills require managed mode');
      expect(loadSdk).not.toHaveBeenCalled();
      expect(browserPreparation).not.toHaveBeenCalled();
      expect(fixture.requests).toEqual([]);

      // An empty list asks nothing of the external server's skills.
      const external = new OpenCodeAdapter({
        mode: 'external',
        serverUrl: fixture.url,
      });
      const events = await collect(
        external.run('No skills.', { cwd, skills: [] }),
      );
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      expect(
        fixture.requests.some((request) => request.path === '/skill'),
      ).toBe(false);
      expectNoCarrierLeft();
    } finally {
      await fixture.close();
    }
  });

  it('stops skill preparation once the first file lands on cancellation (opencode-9)', async () => {
    const gamma = await writeSkill('gamma');
    const FILE_COUNT = 40;
    for (let index = 0; index < FILE_COUNT; index++) {
      await writeFile(
        join(gamma, `file-${String(index).padStart(2, '0')}.txt`),
        `gamma ${index}\n`,
      );
    }
    const fixture = await startFixture('every');
    const abort = new AbortController();
    let stagingAtAbort: string[] | undefined;
    let landedAtAbort: number | undefined;
    let checksAfterAbort = 0;
    let preparation:
      | { error: unknown; rootEntries: string[]; stagingLeft: boolean }
      | undefined;
    materializeHook.current = async (actual, skills, options) => {
      const signal = options.signal!;
      const landed = () =>
        existsSync(options.staging)
          ? readdirSync(options.staging, {
              recursive: true,
              withFileTypes: true,
            }).filter((entry) => entry.isFile()).length
          : 0;
      // The shared snapshot checks its signal before every copied entry;
      // the first check that finds a landed file aborts the caller signal.
      const observed = new Proxy(signal, {
        get(target, property) {
          if (property === 'throwIfAborted') {
            return () => {
              if (landedAtAbort !== undefined) {
                checksAfterAbort++;
              } else if (landed() > 0) {
                landedAtAbort = landed();
                stagingAtAbort = readdirSync(options.staging);
                abort.abort();
              }
              target.throwIfAborted();
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      try {
        return await actual(skills, { ...options, signal: observed });
      } catch (error) {
        preparation = {
          error,
          rootEntries: readdirSync(options.root),
          stagingLeft: existsSync(options.staging),
        };
        throw error;
      }
    };
    try {
      const { events, carrierAtArrival } = await collectObservingCarrier(
        managedAdapter(fixture).run(
          'Use the skills.',
          runOptions({
            skills: ['skills-src/gamma', 'skills-src/alpha'],
            abortSignal: abort.signal,
          }),
        ),
      );
      // Preparation stopped at the next entry after the first file landed:
      // gamma's copy never finished and alpha's never began.
      expect(landedAtAbort).toBe(1);
      expect(stagingAtAbort).toEqual([expect.stringMatching(/^gamma-/)]);
      expect(checksAfterAbort).toBe(0);
      expect(preparation).toMatchObject({
        error: expect.objectContaining({ name: 'AbortError' }),
        rootEntries: [],
        stagingLeft: false,
      });

      // No child, client, session, or prompt work, and one interrupted
      // terminal with no carrier left when it arrives.
      expect(errorMessages(events)).toEqual([]);
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(events.at(-1)?.payload).toMatchObject({ status: 'interrupted' });
      expect(carrierAtArrival).toEqual([{ type: 'done', entries: [] }]);
      expect(fixture.spawns).toHaveLength(0);
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('rejects an invalid skill before SDK loading, browser preparation, or spawning (opencode-67)', async () => {
    const fixture = await startFixture('every');
    const loadSdk = vi.fn();
    try {
      const adapter = new OpenCodeAdapter(
        { mode: 'managed', serverUrl: 'http://127.0.0.1:0' },
        { loadSdk, spawnProcess: fixture.spawnProcess },
      );
      await expect(
        collect(
          adapter.run('Use the skills.', {
            cwd,
            browser: true,
            skills: ['skills-src/alpha', 'skills-src/missing'],
          }),
        ),
      ).rejects.toThrow(
        'skills[1] for adapter "opencode" must name a skill directory',
      );
      expect(loadSdk).not.toHaveBeenCalled();
      expect(browserPreparation).not.toHaveBeenCalled();
      expect(fixture.spawns).toHaveLength(0);
      expect(fixture.requests).toEqual([]);
      expectNoCarrierLeft();
    } finally {
      await fixture.close();
    }
  });

  describe.skipIf(process.platform === 'win32' || RUNS_AS_ROOT)(
    'with an unremovable carrier (opencode-71)',
    () => {
      it('ends a failing unspawned run with the cleanup note naming the root', async () => {
        const fixture = await startFixture('every');
        let root: string | undefined;
        try {
          const { events, carrierAtArrival } = await collectObservingCarrier(
            managedAdapter(
              fixture,
              failingSpawn((base) => {
                root = join(base, 'skills');
                lockCarrier(base);
              }),
            ).run('Use the skills.', runOptions()),
          );
          const messages = errorMessages(events);
          expect(messages).toHaveLength(1);
          expect(messages[0]).toMatch(
            new RegExp(
              `^fixture spawn failure; SKILL_CARRIER_CLEANUP_FAILED: ${escapeRegExp(root!)}: [^;]+$`,
            ),
          );
          expect(events.filter((event) => event.type === 'done')).toHaveLength(
            1,
          );
          expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
          // The removal was attempted before the error arrived and failed.
          expect(carrierAtArrival.map((arrival) => arrival.type)).toEqual([
            'error',
            'done',
          ]);
          expect(existsSync(root!)).toBe(true);
        } finally {
          await fixture.close();
        }
      });

      it('suppresses the cleanup failure of an unspawned run after a caller abort', async () => {
        const fixture = await startFixture('every');
        const abort = new AbortController();
        let root: string | undefined;
        try {
          const events = await collect(
            managedAdapter(
              fixture,
              failingSpawn((base) => {
                root = join(base, 'skills');
                lockCarrier(base);
                abort.abort();
              }),
            ).run('Use the skills.', runOptions({ abortSignal: abort.signal })),
          );
          expect(errorMessages(events)).toEqual([]);
          expect(JSON.stringify(events)).not.toContain(
            'SKILL_CARRIER_CLEANUP_FAILED',
          );
          expect(events.filter((event) => event.type === 'done')).toHaveLength(
            1,
          );
          expect(events.at(-1)?.payload).toMatchObject({
            status: 'interrupted',
          });
          expect(existsSync(root!)).toBe(true);
        } finally {
          await fixture.close();
        }
      });

      it('keeps a spawned run terminal unchanged when removal fails after teardown', async () => {
        const fixture = await startFixture('every');
        let root: string | undefined;
        try {
          const spawnLockingAtClose: SpawnProcess = (
            command,
            args,
            options,
          ) => {
            const child = fixture.spawnProcess(command, args, options);
            const base = carrierBaseOf(options.env)!;
            root = join(base, 'skills');
            // Registered before the adapter's own close listener, so the
            // carrier is unremovable once teardown observes the close.
            child.once('close', () => lockCarrier(base));
            return child;
          };
          const events = await collect(
            managedAdapter(fixture, spawnLockingAtClose).run(
              'Use the skills.',
              runOptions(),
            ),
          );
          expect(errorMessages(events)).toEqual([]);
          expect(events.filter((event) => event.type === 'done')).toHaveLength(
            1,
          );
          expect(events.at(-1)?.type).toBe('done');
          expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
          expect(JSON.stringify(events)).not.toContain(
            'SKILL_CARRIER_CLEANUP_FAILED',
          );
          expect(fixture.spawns[0]?.process.carrierPresentAtClose).toBe(true);
          // The removal really failed: the root is still there.
          expect(existsSync(root!)).toBe(true);
        } finally {
          await fixture.close();
        }
      });
    },
  );

  it('spawns a run without skills with the inherited environment', async () => {
    const fixture = await startFixture('every');
    try {
      const events = await collect(
        managedAdapter(fixture).run('No skills.', { cwd }),
      );
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      expect(fixture.spawns[0]?.options.env).toBeUndefined();
      expect(
        fixture.requests.some((request) => request.path === '/skill'),
      ).toBe(false);
      expectNoCarrierLeft();
    } finally {
      await fixture.close();
    }
  });
});
