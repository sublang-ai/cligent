// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// opencode-74: real-server verification of the per-run native skill switch
// (opencode-72). The integration check (opencode-73) proves the environment
// the adapter spawns with; only the installed CLI shows which skills that
// environment leaves its server listing. A managed run selecting
// `nativeSkills: false` with a run skill reaches its spawn, where this check
// records the environment and working directory, starts the real
// `opencode serve` with them while the run's carrier still exists, and reads
// `GET /skill`. No model is called. Everything the server reads lives under a
// throwaway home, XDG tree, and temporary directory. Preconditions: the
// OpenCode CLI on PATH, a logged self-skip outside CI, a hard failure in CI.

import { execFileSync, spawn } from 'node:child_process';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  assertAcceptanceDependencies,
  gateAcceptanceTest,
} from '../__tests__/helpers/acceptance-dependency-gate.js';
import type { AgentEvent } from '../types.js';
import { OpenCodeAdapter } from './opencode.js';

const RUN_SKILL = 'cligent-run-probe';
const AGENTS_SKILL = 'probe-a';
const CLAUDE_SKILL = 'probe-b';
const OPENCODE_SKILL = 'probe-c';
const CONFIGURED_SKILL = 'cfg-probe';
const BUILT_IN_LOCATION = '<built-in>';

const SERVER_READY_TIMEOUT_MS = 60_000;
const LISTING_TIMEOUT_MS = 15_000;
const SERVER_STOP_GRACE_MS = 5_000;
const TEST_TIMEOUT_MS = 180_000;

function missingDependencies(): string[] {
  try {
    execFileSync('opencode', ['--version'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return [];
  } catch {
    return ['opencode CLI on PATH'];
  }
}

const missing = missingDependencies();

interface ListedSkill {
  readonly name: string;
  readonly location: string;
}

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Stands in for the adapter's server while the check lists the real one: it
 * never reports readiness, and closes once the adapter's teardown signals it.
 */
class HeldServeProcess extends EventEmitter {
  readonly stdout = new PassThrough();

  readonly stderr = new PassThrough();

  private closed = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    setImmediate(() => {
      if (this.closed) return;
      this.closed = true;
      this.stdout.end();
      this.stderr.end();
      this.emit('close', null, typeof signal === 'string' ? signal : null);
    });
    return true;
  }
}

function writeSkill(parent: string, name: string): void {
  const directory = join(parent, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Native skill switch probe ${name}.\n---\n\nSay ${name}.\n`,
  );
}

async function stopServer(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), SERVER_STOP_GRACE_MS).unref();
    }),
  ]);
  if (!stopped) {
    child.kill('SIGKILL');
    await closed;
  }
}

/**
 * Start the real server with the given command, environment, and working
 * directory, read its skill list for that directory, and stop it.
 */
async function listRealServerSkills(
  record: SpawnRecord,
): Promise<ListedSkill[]> {
  const child = spawn(record.command, [...record.args], {
    cwd: record.cwd,
    env: record.env,
    stdio: 'pipe',
  });
  let output = '';
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `opencode serve reported no readiness within ${SERVER_READY_TIMEOUT_MS} ms: ${output}`,
          ),
        );
      }, SERVER_READY_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        output += chunk.toString('utf8');
        const match = /listening on (https?:\/\/\S+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        reject(
          new Error(
            `opencode serve exited before readiness (code=${code}, signal=${signal}): ${output}`,
          ),
        );
      });
    });
    const response = await fetch(
      `${url}/skill?directory=${encodeURIComponent(record.cwd)}`,
      { signal: AbortSignal.timeout(LISTING_TIMEOUT_MS) },
    );
    const body = (await response.json()) as unknown;
    if (!response.ok || !Array.isArray(body)) {
      throw new Error(
        `GET /skill answered ${response.status}: ${JSON.stringify(body)}`,
      );
    }
    return body as ListedSkill[];
  } finally {
    await stopServer(child);
  }
}

/** The run's `<carrier root>/<name>` path: the last inline `skills.paths` entry. */
function carrierSkillPath(env: NodeJS.ProcessEnv): string {
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as {
    skills?: { paths?: unknown[] };
  };
  const path = config.skills?.paths?.at(-1);
  if (typeof path !== 'string') {
    throw new Error(
      `no run skill path in OPENCODE_CONFIG_CONTENT: ${env.OPENCODE_CONFIG_CONTENT}`,
    );
  }
  return path;
}

function names(listing: readonly ListedSkill[]): string[] {
  return listing.map((skill) => skill.name);
}

describe('OpenCode native skill switch real-server acceptance (opencode-74)', () => {
  gateAcceptanceTest(
    it,
    it.skip,
    'opencode',
    missing,
  )(
    'leaves the real server listing the run skill, .opencode skills, and the built-in only',
    async () => {
      assertAcceptanceDependencies('opencode', missing);
      const root = mkdtempSync(
        join(realpathSync(tmpdir()), 'cligent-opencode-native-skills-'),
      );
      try {
        const home = join(root, 'home');
        const configHome = join(root, 'config');
        const cwd = join(root, 'work');
        const configuredSkills = join(root, 'cfg-skills');
        const runSkills = join(root, 'run-skills');
        for (const directory of [
          home,
          join(configHome, 'opencode'),
          join(root, 'data'),
          join(root, 'cache'),
          join(root, 'state'),
          join(root, 'tmp'),
          join(cwd, '.git'),
        ]) {
          mkdirSync(directory, { recursive: true });
        }
        writeSkill(join(cwd, '.agents', 'skills'), AGENTS_SKILL);
        writeSkill(join(cwd, '.claude', 'skills'), CLAUDE_SKILL);
        writeSkill(join(cwd, '.opencode', 'skills'), OPENCODE_SKILL);
        writeSkill(configuredSkills, CONFIGURED_SKILL);
        writeSkill(runSkills, RUN_SKILL);
        writeFileSync(
          join(configHome, 'opencode', 'opencode.json'),
          JSON.stringify({ skills: { paths: [configuredSkills] } }),
        );

        // Nothing the adapter or either server reads comes from the real
        // home, and no caller OpenCode variable steers discovery.
        for (const key of Object.keys(process.env)) {
          if (key.startsWith('OPENCODE_')) vi.stubEnv(key, undefined);
        }
        vi.stubEnv('HOME', home);
        vi.stubEnv('XDG_CONFIG_HOME', configHome);
        vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
        vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
        vi.stubEnv('XDG_STATE_HOME', join(root, 'state'));
        vi.stubEnv('TMPDIR', join(root, 'tmp'));

        // Control: without the switch, the same server finds every native
        // fixture, so their absence below is the switch's doing.
        const native = await listRealServerSkills({
          command: 'opencode',
          args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
          cwd,
          env: { ...process.env },
        });
        expect(names(native)).toEqual(
          expect.arrayContaining([
            AGENTS_SKILL,
            CLAUDE_SKILL,
            OPENCODE_SKILL,
            CONFIGURED_SKILL,
          ]),
        );

        // The run reaches its spawn; the real listing happens there, while
        // the carrier exists, and its settling ends the held run.
        const abort = new AbortController();
        let recorded: SpawnRecord | undefined;
        let listing: Promise<ListedSkill[]> | undefined;
        const adapter = new OpenCodeAdapter(
          {
            mode: 'managed',
            serverUrl: 'http://127.0.0.1:0',
            readyTimeoutMs: SERVER_READY_TIMEOUT_MS + LISTING_TIMEOUT_MS * 2,
          },
          {
            spawnProcess(
              command: string,
              args: readonly string[],
              options: SpawnOptionsWithoutStdio,
            ) {
              recorded = {
                command,
                args: [...args],
                cwd: String(options.cwd),
                env: options.env ?? process.env,
              };
              listing = listRealServerSkills(recorded).finally(() => {
                abort.abort();
              });
              // Observed after the run; marked handled until then.
              listing.catch(() => undefined);
              return new HeldServeProcess() as unknown as ChildProcessWithoutNullStreams;
            },
            managedServerTermGraceMs: 1_000,
            managedServerKillGraceMs: 1_000,
          },
        );
        const events: AgentEvent[] = [];
        for await (const event of adapter.run('List nothing.', {
          cwd,
          nativeSkills: false,
          skills: [join(runSkills, RUN_SKILL)],
          abortSignal: abort.signal,
        })) {
          events.push(event);
        }
        expect(events.at(-1)?.type).toBe('done');
        expect(recorded).toMatchObject({ command: 'opencode', cwd });
        expect(listing).toBeDefined();
        const listed = await listing!;

        // The run skill at its carrier location, the `.opencode/skills`
        // skill, and the built-in remain.
        const carrierPath = carrierSkillPath(recorded!.env);
        expect(listed).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: RUN_SKILL,
              location: join(carrierPath, 'SKILL.md'),
            }),
            expect.objectContaining({
              name: OPENCODE_SKILL,
              location: join(
                cwd,
                '.opencode',
                'skills',
                OPENCODE_SKILL,
                'SKILL.md',
              ),
            }),
            expect.objectContaining({ location: BUILT_IN_LOCATION }),
          ]),
        );
        // No `.agents/skills`, `.claude/skills`, or configured-path skill.
        expect(names(listed)).not.toContain(AGENTS_SKILL);
        expect(names(listed)).not.toContain(CLAUDE_SKILL);
        expect(names(listed)).not.toContain(CONFIGURED_SKILL);
      } finally {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
