// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// opencode-73: the per-run native skill switch (opencode-72) through the
// installed SDK and a recording `opencode serve` fixture. Managed runs select
// `nativeSkills` false and omitted, with and without run skills, under each
// caller `OPENCODE_CONFIG_CONTENT` form, beside an inherited
// `OPENCODE_DISABLE_EXTERNAL_SKILLS=TRUE` that a real server would refuse.

import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeAdapter } from '../adapters/opencode.js';
import type { AgentEvent, AgentOptions, OpenCodeEffort } from '../types.js';

const browserPreparation = vi.hoisted(() => vi.fn());
vi.mock('../browser.js', () => ({
  prepareBrowserServer: browserPreparation,
  releaseBrowserServer: async () => {},
}));

const SESSION_ID = 'native-skills-session';

/** How long the fixture server takes to close after a signal. */
const CLOSE_DELAY_MS = 50;

/** A caller spelling the runtime's strict boolean parse would refuse. */
const INHERITED_FLAG = 'TRUE';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
}

class FixtureServeProcess extends EventEmitter {
  readonly stdout = new PassThrough();

  readonly stderr = new PassThrough();

  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  private closed = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    setTimeout(() => {
      if (this.closed) return;
      this.closed = true;
      this.stdout.end();
      this.stderr.end();
      this.emit('close', null, typeof signal === 'string' ? signal : null);
    }, CLOSE_DELAY_MS);
    return true;
  }
}

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptionsWithoutStdio;
  /** The temporary directory's entries when the server was spawned. */
  readonly carrierEntries: readonly string[];
}

/** The existing absolute skill paths a spawned server reads inline. */
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

/** What OpenCode lists for configured paths: each `SKILL.md`, keyed by name. */
function discoverSkills(env: NodeJS.ProcessEnv | undefined) {
  return configuredSkillPaths(env).flatMap((path) => {
    const location = join(path, 'SKILL.md');
    if (!existsSync(location)) return [];
    const content = readFileSync(location, 'utf8');
    return [
      {
        name: /^name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? '',
        location,
        content,
      },
    ];
  });
}

async function startFixture() {
  const requests: RecordedRequest[] = [];
  const subscribers = new Set<ServerResponse>();
  const spawns: SpawnRecord[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://localhost');
      await once(request.resume(), 'end');
      requests.push({ method: request.method!, path: url.pathname });
      if (url.pathname === '/event') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"type":"server.connected","properties":{}}\n\n');
        subscribers.add(response);
        response.on('close', () => subscribers.delete(response));
        return;
      }
      if (url.pathname === '/skill') {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(discoverSkills(spawns.at(-1)?.options.env)));
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
    const child = new FixtureServeProcess();
    spawns.push({
      command,
      args,
      options,
      carrierEntries: readdirSync(carrierTmp),
    });
    setImmediate(() => {
      child.stdout.write(`opencode server listening on ${url}\n`);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };

  return {
    url,
    requests,
    spawns,
    spawnProcess,
    async close() {
      for (const subscriber of subscribers) subscriber.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Fixture = Awaited<ReturnType<typeof startFixture>>;

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function errorMessages(events: readonly AgentEvent[]): string[] {
  return events
    .filter((event) => event.type === 'error')
    .map((event) => String((event.payload as { message?: unknown }).message));
}

const SKILL_TEXT = {
  alpha:
    '---\nname: alpha\ndescription: Alpha fixture skill.\n---\n\nSay alpha.\n',
  beta: '---\nname: beta\ndescription: Beta fixture skill.\n---\n\nSay beta.\n',
} as const;

const dirs: string[] = [];
let cwd: string;
let carrierTmp: string;

beforeEach(async () => {
  vi.stubEnv('CLIGENT_RUNTIME_GATE', 'off');
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', undefined);
  vi.stubEnv('OPENCODE_DISABLE_EXTERNAL_SKILLS', INHERITED_FLAG);
  browserPreparation.mockReset();
  const realTmp = realpathSync(tmpdir());
  cwd = await mkdtemp(join(realTmp, 'cligent-opencode-native-skills-cwd-'));
  carrierTmp = await mkdtemp(
    join(realTmp, 'cligent-opencode-native-skills-tmp-'),
  );
  dirs.push(cwd, carrierTmp);
  // The adapter creates its private carrier under the operating-system
  // temporary directory, which this test observes through TMPDIR.
  vi.stubEnv('TMPDIR', carrierTmp);
  for (const name of ['alpha', 'beta'] as const) {
    const directory = join(cwd, 'skills-src', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), SKILL_TEXT[name]);
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function managedAdapter(fixture: Fixture) {
  return new OpenCodeAdapter(
    { mode: 'managed', serverUrl: 'http://127.0.0.1:0' },
    {
      spawnProcess: fixture.spawnProcess,
      managedServerTermGraceMs: 200,
      managedServerKillGraceMs: 200,
    },
  );
}

const RUN_SKILLS = ['skills-src/alpha', 'skills-src/beta/SKILL.md'] as const;

function runOptions(
  nativeSkills: false | undefined,
  withSkills: boolean,
): AgentOptions<OpenCodeEffort> {
  return {
    cwd,
    ...(withSkills ? { skills: [...RUN_SKILLS] } : {}),
    ...(nativeSkills === false ? { nativeSkills } : {}),
  };
}

/** The run's `<carrier root>/<name>` paths, from the carrier the spawn saw. */
function runSkillPaths(spawn: SpawnRecord): string[] {
  expect(spawn.carrierEntries).toHaveLength(1);
  const root = join(carrierTmp, spawn.carrierEntries[0]!, 'skills');
  return [join(root, 'alpha'), join(root, 'beta')];
}

function parsedConfig(env: NodeJS.ProcessEnv): unknown {
  const content = env.OPENCODE_CONFIG_CONTENT;
  expect(content).toBeDefined();
  return JSON.parse(content!);
}

interface CallerCase {
  readonly label: string;
  readonly value: string | undefined;
  /** The inline configuration a `nativeSkills: false` run spawns with. */
  readonly off: (runPaths: string[]) => unknown;
  /** The inline configuration an omitted run with skills spawns with (opencode-67). */
  readonly omitted: (runPaths: string[]) => unknown;
}

const CALLER_CASES: readonly CallerCase[] = [
  {
    label: 'absent',
    value: undefined,
    off: (runPaths) => ({ skills: { paths: runPaths, urls: [] } }),
    omitted: (runPaths) => ({ skills: { paths: runPaths } }),
  },
  {
    label: 'empty',
    value: '',
    off: (runPaths) => ({ skills: { paths: runPaths, urls: [] } }),
    omitted: (runPaths) => ({ skills: { paths: runPaths } }),
  },
  {
    label: 'an object skills with paths',
    value:
      '{"model": "fixture/model", "skills": {"paths": ["./caller-skills", "{env:CALLER_SKILL_DIR}"]}}',
    off: (runPaths) => ({
      model: 'fixture/model',
      skills: {
        paths: ['./caller-skills', '{env:CALLER_SKILL_DIR}', ...runPaths],
        urls: [],
      },
    }),
    omitted: (runPaths) => ({
      model: 'fixture/model',
      skills: {
        paths: ['./caller-skills', '{env:CALLER_SKILL_DIR}', ...runPaths],
      },
    }),
  },
  {
    label: 'an object skills with paths and urls, in JSONC',
    value: `{
  // caller configuration
  "skills": {
    "urls": ["https://example.test/skills/"],
    "paths": ["./caller-skills"],
  },
}`,
    off: (runPaths) => ({
      skills: {
        urls: ['https://example.test/skills/'],
        paths: ['./caller-skills', ...runPaths],
      },
    }),
    omitted: (runPaths) => ({
      skills: {
        urls: ['https://example.test/skills/'],
        paths: ['./caller-skills', ...runPaths],
      },
    }),
  },
  {
    label: 'an array skills',
    value:
      '{"skills": ["./caller-skills", "https://example.test/skills/"], "share": "disabled"}',
    off: (runPaths) => ({
      skills: ['./caller-skills', 'https://example.test/skills/', ...runPaths],
      share: 'disabled',
    }),
    omitted: (runPaths) => ({
      skills: ['./caller-skills', 'https://example.test/skills/', ...runPaths],
      share: 'disabled',
    }),
  },
];

/** Malformed only where native discovery is off (opencode-72). */
const STRING_URLS_CASE: CallerCase = {
  label: 'holding a string skills.urls',
  value: '{"skills": {"urls": "https://example.test/"}}',
  off: () => {
    throw new Error('a nativeSkills: false run fails on this value');
  },
  omitted: (runPaths) => ({
    skills: { urls: 'https://example.test/', paths: runPaths },
  }),
};

describe('OpenCode per-run native skill switch (opencode-73)', () => {
  describe.each([
    ['without run skills', false],
    ['with run skills', true],
  ])('a managed nativeSkills: false run %s', (_label, withSkills) => {
    it.each(CALLER_CASES.map((entry) => [entry.label, entry] as const))(
      'replaces the inherited flag and sets both skill arrays when the caller configuration is %s',
      async (_caseLabel, callerCase) => {
        vi.stubEnv('OPENCODE_CONFIG_CONTENT', callerCase.value);
        const fixture = await startFixture();
        try {
          const events = await collect(
            managedAdapter(fixture).run(
              'Use the skills.',
              runOptions(false, withSkills),
            ),
          );
          expect(errorMessages(events)).toEqual([]);
          expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
          expect(fixture.spawns).toHaveLength(1);
          const spawn = fixture.spawns[0]!;
          const env = spawn.options.env!;
          expect(env).toBeDefined();

          // The strict runtime flag replaces the caller's spelling
          // (opencode-72).
          expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe('1');

          // Inline skill arrays replace the configuration files' arrays, the
          // caller's entries ahead of the run's (opencode-72).
          const runPaths = withSkills ? runSkillPaths(spawn) : [];
          if (!withSkills) expect(spawn.carrierEntries).toEqual([]);
          expect(parsedConfig(env)).toEqual(callerCase.off(runPaths));

          // Nothing else in the parent environment changes.
          expect(env).toEqual({
            ...process.env,
            OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
            OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT,
          });

          // Only a run with skills asks the server for its listing.
          expect(
            fixture.requests.some((request) => request.path === '/skill'),
          ).toBe(withSkills);
          expect(readdirSync(carrierTmp)).toEqual([]);
        } finally {
          await fixture.close();
        }
      },
    );

    it.each([
      ['does not parse', '{ "skills": [', 'does not parse as JSONC'],
      ['parses to a string', '"text"', 'parses to a string'],
      ['holds a null skills', '{"skills": null}', 'its skills is null'],
      [
        'holds a string skills.paths',
        '{"skills": {"paths": "x"}}',
        'its skills.paths is a string',
      ],
      [
        'holds a string skills.urls',
        '{"skills": {"paths": [], "urls": "https://example.test/"}}',
        'its skills.urls is a string',
      ],
    ])(
      'fails setup before spawn when the caller configuration %s',
      async (_caseLabel, callerValue, fragment) => {
        vi.stubEnv('OPENCODE_CONFIG_CONTENT', callerValue);
        const fixture = await startFixture();
        try {
          const events = await collect(
            managedAdapter(fixture).run(
              'Use the skills.',
              runOptions(false, withSkills),
            ),
          );
          const messages = errorMessages(events);
          expect(messages).toHaveLength(1);
          expect(messages[0]).toContain('OPENCODE_CONFIG_CONTENT');
          expect(messages[0]).toContain(fragment);
          expect(events.filter((event) => event.type === 'done')).toHaveLength(
            1,
          );
          expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
          expect(fixture.spawns).toHaveLength(0);
          expect(fixture.requests).toEqual([]);
          expect(readdirSync(carrierTmp)).toEqual([]);
        } finally {
          await fixture.close();
        }
      },
    );
  });

  describe('a managed run with nativeSkills omitted', () => {
    it.each([
      ...CALLER_CASES.map((entry) => [entry.label, entry.value] as const),
      ['unparsable', '{ "skills": ['],
    ])(
      'spawns without skills on the inherited environment when the caller configuration is %s',
      async (_caseLabel, callerValue) => {
        vi.stubEnv('OPENCODE_CONFIG_CONTENT', callerValue);
        const fixture = await startFixture();
        try {
          const events = await collect(
            managedAdapter(fixture).run(
              'No skills.',
              runOptions(undefined, false),
            ),
          );
          expect(errorMessages(events)).toEqual([]);
          expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
          // No environment of its own: the child inherits the caller's flag
          // and inline configuration untouched.
          expect(fixture.spawns).toHaveLength(1);
          expect(fixture.spawns[0]!.options.env).toBeUndefined();
          expect(process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe(
            INHERITED_FLAG,
          );
          expect(
            fixture.requests.some((request) => request.path === '/skill'),
          ).toBe(false);
        } finally {
          await fixture.close();
        }
      },
    );

    it.each(
      [...CALLER_CASES, STRING_URLS_CASE].map(
        (entry) => [entry.label, entry] as const,
      ),
    )(
      'adds only the run paths and no flag when the caller configuration is %s',
      async (_caseLabel, callerCase) => {
        vi.stubEnv('OPENCODE_CONFIG_CONTENT', callerCase.value);
        const fixture = await startFixture();
        try {
          const events = await collect(
            managedAdapter(fixture).run(
              'Use the skills.',
              runOptions(undefined, true),
            ),
          );
          expect(errorMessages(events)).toEqual([]);
          expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
          const spawn = fixture.spawns[0]!;
          const env = spawn.options.env!;
          // The inherited flag passes through unchanged, and the inline
          // skills gain no urls array.
          expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe(INHERITED_FLAG);
          expect(parsedConfig(env)).toEqual(
            callerCase.omitted(runSkillPaths(spawn)),
          );
          expect(env).toEqual({
            ...process.env,
            OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT,
          });
          expect(readdirSync(carrierTmp)).toEqual([]);
        } finally {
          await fixture.close();
        }
      },
    );
  });

  it('rejects nativeSkills: false on an external server before browser preparation', async () => {
    const fixture = await startFixture();
    const loadSdk = vi.fn();
    try {
      const adapter = new OpenCodeAdapter(
        { mode: 'external', serverUrl: fixture.url },
        { loadSdk },
      );
      await expect(
        collect(
          adapter.run('No native skills.', {
            cwd,
            nativeSkills: false,
            browser: true,
          }),
        ),
      ).rejects.toThrow(
        /^OpenCode nativeSkills: false requires managed mode\b/,
      );
      expect(loadSdk).not.toHaveBeenCalled();
      expect(browserPreparation).not.toHaveBeenCalled();
      expect(fixture.requests).toEqual([]);

      // The same server serves a run that leaves native discovery alone.
      const external = new OpenCodeAdapter({
        mode: 'external',
        serverUrl: fixture.url,
      });
      const events = await collect(external.run('Native skills.', { cwd }));
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
    } finally {
      await fixture.close();
    }
  });
});
