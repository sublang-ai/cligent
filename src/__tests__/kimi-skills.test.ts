// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// kimi-51: run skills reach Kimi through the process carrier under the
// project root's `.kimi-code/skills`, are confirmed against the session's
// command list, and leave with the last holding run. A scripted ACP peer
// stands in for the runtime over real stdio framing, and every project is a
// real git checkout on the real filesystem.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  chmodSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KimiAdapter } from '../adapters/kimi.js';
import { Cligent } from '../cligent.js';
import {
  carrierHostToken,
  carrierName,
  isProcessRunning,
  parseCarrierName,
  processCarrierSuffix,
  SKILL_CARRIER_CLEANUP_FAILED,
} from '../skills.js';
import type { AgentEvent } from '../types.js';

import {
  FakeKimi,
  listKimiSkillCommands,
  type FakeScenario,
  type FakeSessionSetup,
} from './fixtures/kimi-peer.js';

const temps: string[] = [];
const runsAsRoot = process.getuid?.() === 0;

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) {
    // A test may leave read-only directories behind on purpose.
    try {
      execFileSync('chmod', ['-R', 'u+rwx', dir]);
    } catch {
      // Removal below still reports what it cannot delete.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cligent-kimi-skills-${prefix}-`));
  temps.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=cligent',
      '-c',
      'user.email=cligent@example.com',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  );
}

function gitProject(): string {
  const dir = tempDir('project');
  git(dir, 'init', '-q');
  return dir;
}

/** A linked worktree, whose `.git` is a file rather than a directory. */
function gitWorktree(): string {
  const main = gitProject();
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = join(tempDir('worktree'), 'checkout');
  git(main, 'worktree', 'add', '-q', worktree);
  return worktree;
}

function writeSkill(
  parent: string,
  name: string,
  description: string = JSON.stringify(`Run skill ${name}`),
): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nReply with the token for ${name}.\n`,
  );
  writeFileSync(join(dir, 'notes.txt'), `notes for ${name}\n`);
  return dir;
}

/** A skill whose copy takes long enough to act while it is in flight. */
function writeLargeSkill(parent: string, name: string): string {
  const dir = writeSkill(parent, name);
  for (let group = 0; group < 40; group += 1) {
    const data = join(dir, 'data', `d${group}`);
    mkdirSync(data, { recursive: true });
    for (let file = 0; file < 100; file += 1) {
      writeFileSync(join(data, `f${file}.txt`), `${group}:${file}\n`);
    }
  }
  return dir;
}

/**
 * A skill holding a deep directory chain, which a recursive removal takes
 * one level at a time without flooding the threadpool other runs share.
 */
function writeDeepSkill(parent: string, name: string): string {
  const dir = writeSkill(parent, name);
  mkdirSync(join(dir, ...Array<string>(250).fill('a')), { recursive: true });
  return dir;
}

/** The staging directories present in a directory. */
function stagingIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) =>
      name.startsWith('.cligent-staging-'),
    );
  } catch {
    return [];
  }
}

function deadPid(): number {
  for (let pid = 4_000_000; pid > 3_000_000; pid -= 1) {
    if (!isProcessRunning(pid)) return pid;
  }
  throw new Error('No unused process identifier found');
}

const OTHER_SUFFIX = 'ab'.repeat(10);

function carrierDirectory(project: string): string {
  return join(
    project,
    '.kimi-code',
    'skills',
    carrierName(processCarrierSuffix()),
  );
}

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function eventOf<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }> {
  const event = events.find((candidate) => candidate.type === type);
  if (!event) throw new Error(`Missing ${type} event`);
  return event as Extract<AgentEvent, { type: T }>;
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; !condition(); attempt += 1) {
    if (attempt > 2_000) throw new Error('Condition not reached');
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
}

type ListingTiming = 'before-response' | 'after-response' | 'never';

interface PeerOptions extends FakeScenario {
  /** When the scripted peer sends its one command list relative to the setup response. */
  listing?: ListingTiming;
  /** The working directory the command list is built from. */
  listFrom?: (setup: FakeSessionSetup) => string;
  rewrite?: (
    commands: Array<{ name: string; description: string }>,
  ) => unknown[];
  listingSessionId?: string;
}

/** A scripted Kimi peer that lists project skills the way Kimi Code advertises them. */
function kimiPeer(options: PeerOptions = {}): FakeKimi {
  const {
    listing = 'after-response',
    listFrom,
    rewrite,
    listingSessionId,
    ...scenario
  } = options;
  return new FakeKimi({
    async prompt(connection, request) {
      await connection.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok' },
        },
      });
      return { stopReason: 'end_turn' };
    },
    ...scenario,
    async sessionSetup(connection, setup, fake) {
      await scenario.sessionSetup?.(connection, setup, fake);
      if (listing === 'never') return;
      const send = async (): Promise<void> => {
        const commands = [
          { name: 'init', description: 'Analyze the codebase' },
          ...(await listKimiSkillCommands(listFrom?.(setup) ?? setup.cwd)),
        ];
        await sendCommands(
          connection,
          listingSessionId ?? setup.sessionId,
          rewrite ? rewrite(commands) : commands,
        );
      };
      if (listing === 'before-response') await send();
      // A run that never waits for the list may close the session first.
      else setTimeout(() => void send().catch(() => undefined), 30);
    },
  });
}

async function sendCommands(
  connection: AgentSideConnection,
  sessionId: string,
  availableCommands: unknown[],
): Promise<void> {
  await connection.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands,
    } as never,
  });
}

describe('Kimi skills carrier (kimi-51)', () => {
  it('places run skills under the git root of a nested cwd and removes the carrier with its created parents', async () => {
    const worktree = gitWorktree();
    expect(statSync(join(worktree, '.git')).isFile()).toBe(true);
    const cwd = join(worktree, 'packages', 'app');
    mkdirSync(cwd, { recursive: true });
    const alpha = writeSkill(tempDir('sources'), 'alpha');
    let observed:
      | {
          carriers: string[];
          entries: string[];
          kimiDir: string[];
          skill: string;
          notes: string;
        }
      | undefined;
    const fake = kimiPeer({
      async prompt(connection, request) {
        const skillsDir = join(worktree, '.kimi-code', 'skills');
        const carriers = readdirSync(skillsDir);
        const root = join(skillsDir, carriers[0]!);
        observed = {
          carriers,
          entries: readdirSync(root),
          kimiDir: readdirSync(join(worktree, '.kimi-code')),
          skill: readFileSync(join(root, 'alpha', 'SKILL.md'), 'utf8'),
          notes: readFileSync(join(root, 'alpha', 'notes.txt'), 'utf8'),
        };
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'used alpha' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });

    const events = await collect(
      new Cligent(new KimiAdapter({ spawnProcess: fake.spawn }), {
        skills: [alpha],
      }).run('Use alpha', { cwd }),
    );

    // Project root, carrier layout, and name [kimi-49].
    expect(observed?.carriers).toEqual([carrierName(processCarrierSuffix())]);
    expect(parseCarrierName(observed!.carriers[0]!)).toEqual({
      host: carrierHostToken(),
      pid: process.pid,
      suffix: processCarrierSuffix(),
    });
    expect(observed?.entries).toEqual(['alpha']);
    expect(observed?.kimiDir).toEqual(['skills']);
    expect(observed?.skill).toBe(readFileSync(join(alpha, 'SKILL.md'), 'utf8'));
    expect(observed?.notes).toBe('notes for alpha\n');
    expect(existsSync(join(cwd, '.kimi-code'))).toBe(false);
    // Session operations are unchanged and the check precedes the run sequence.
    expect(fake.spawns[0]?.options.cwd).toBe(cwd);
    expect(fake.newRequests[0]?.cwd).toBe(cwd);
    expect(fake.calls).toEqual(['initialize', 'session/new', 'session/prompt']);
    const done = eventOf(events, 'done');
    expect(done.payload.status).toBe('success');
    expect(done.payload.result).toBe('used alpha');
    // Removal after the last holder, created parents included [kimi-53].
    expect(existsSync(join(worktree, '.kimi-code'))).toBe(false);
  });

  it('uses the cwd as the project root outside any repository', async () => {
    const cwd = tempDir('plain');
    const alpha = writeSkill(tempDir('sources'), 'alpha');
    let carrierEntries: string[] | undefined;
    const fake = kimiPeer({
      async prompt() {
        carrierEntries = readdirSync(carrierDirectory(cwd));
        return { stopReason: 'end_turn' };
      },
    });

    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Use alpha', {
        cwd,
        skills: [alpha],
      }),
    );

    expect(carrierEntries).toEqual(['alpha']);
    expect(eventOf(events, 'done').payload.status).toBe('success');
    expect(existsSync(join(cwd, '.kimi-code'))).toBe(false);
  });

  it('rejects a project root that is the operating-system home before any sweep or write', async () => {
    const home = tempDir('home');
    vi.stubEnv('HOME', home);
    const stale = join(
      home,
      '.kimi-code',
      'skills',
      `cligent-${carrierHostToken()}-${deadPid()}-${OTHER_SUFFIX}`,
    );
    mkdirSync(stale, { recursive: true });
    const alpha = writeSkill(tempDir('sources'), 'alpha');
    const fake = kimiPeer();

    await expect(
      collect(
        new KimiAdapter({ spawnProcess: fake.spawn }).run('Use alpha', {
          cwd: home,
          skills: [alpha],
        }),
      ),
    ).rejects.toThrow(
      `skills for adapter "kimi" cannot use the project root ${home}`,
    );
    expect(fake.spawns).toHaveLength(0);
    expect(readdirSync(join(home, '.kimi-code', 'skills'))).toEqual([
      `cligent-${carrierHostToken()}-${deadPid()}-${OTHER_SUFFIX}`,
    ]);
  });

  it.each([
    ['the Kimi user skill root', 'kimi'],
    ['~/.agents/skills', 'agents'],
  ] as const)(
    'rejects a .kimi-code/skills linked to %s before any sweep or write',
    async (_label, target) => {
      const home = tempDir('home');
      vi.stubEnv('HOME', home);
      let userRoot: string;
      if (target === 'kimi') {
        const kimiHome = join(tempDir('kimi-home'), 'state');
        vi.stubEnv('KIMI_CODE_HOME', kimiHome);
        userRoot = join(kimiHome, 'skills');
      } else {
        vi.stubEnv('KIMI_CODE_HOME', undefined);
        userRoot = join(home, '.agents', 'skills');
      }
      const staleName = `cligent-${carrierHostToken()}-${deadPid()}-${OTHER_SUFFIX}`;
      mkdirSync(join(userRoot, staleName), { recursive: true });
      const project = gitProject();
      mkdirSync(join(project, '.kimi-code'));
      symlinkSync(userRoot, join(project, '.kimi-code', 'skills'));
      const alpha = writeSkill(tempDir('sources'), 'alpha');
      const fake = kimiPeer();

      const run = collect(
        new KimiAdapter({ spawnProcess: fake.spawn }).run('Use alpha', {
          cwd: project,
          skills: [alpha],
        }),
      );

      await expect(run).rejects.toThrow(
        `cannot use the carrier destination ${join(project, '.kimi-code', 'skills')}`,
      );
      await expect(run).rejects.toThrow(userRoot);
      expect(fake.spawns).toHaveLength(0);
      expect(readdirSync(userRoot)).toEqual([staleName]);
    },
  );

  it('rejects a run skill containing the project root before any sweep or write', async () => {
    const outer = writeSkill(tempDir('outer'), 'outer-skill');
    const project = join(outer, 'project');
    mkdirSync(project);
    git(project, 'init', '-q');
    // A stale carrier inside the skill is an owned carrier root, which
    // validation leaves out of the skill (skills-2) and no sweep may reach.
    const staleName = `cligent-${carrierHostToken()}-${deadPid()}-${OTHER_SUFFIX}`;
    mkdirSync(join(project, '.kimi-code', 'skills', staleName), {
      recursive: true,
    });
    const fake = kimiPeer();

    const run = collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Use it', {
        cwd: project,
        skills: [outer],
      }),
    );

    await expect(run).rejects.toThrow(
      `skills[0] for adapter "kimi" names ${outer}, which equals or contains the carrier destination ${join(project, '.kimi-code', 'skills')}`,
    );
    expect(fake.spawns).toHaveLength(0);
    expect(readdirSync(join(project, '.kimi-code', 'skills'))).toEqual([
      staleName,
    ]);
  });

  it('shares the carrier between concurrent runs, rejects a disputed name, and removes it after the last holder only', async () => {
    const project = gitProject();
    const sources = tempDir('sources');
    const alpha = writeSkill(sources, 'alpha');
    const beta = writeSkill(sources, 'beta');
    const otherAlpha = writeSkill(tempDir('other'), 'alpha', 'Another alpha');
    const entered = new Set<string>();
    const gates = new Map<string, () => void>();
    const fake = kimiPeer({
      async prompt(_connection, request) {
        const text = (request.prompt[0] as { text: string }).text;
        await new Promise<void>((release) => {
          gates.set(text, release);
          entered.add(text);
        });
        return { stopReason: 'end_turn' };
      },
    });
    const adapter = new KimiAdapter({ spawnProcess: fake.spawn });
    const root = carrierDirectory(project);

    const first = collect(adapter.run('A', { cwd: project, skills: [alpha] }));
    await until(() => entered.has('A'));
    const alphaInode = statSync(join(root, 'alpha')).ino;

    const second = collect(
      adapter.run('B', { cwd: project, skills: [alpha, beta] }),
    );
    await until(() => entered.has('B'));
    expect(readdirSync(root).sort()).toEqual(['alpha', 'beta']);
    // The second run reused the first run's entry rather than rewriting it.
    expect(statSync(join(root, 'alpha')).ino).toBe(alphaInode);

    const skillFree = collect(adapter.run('D', { cwd: project }));
    await until(() => entered.has('D'));

    // A disputing run is rejected before any sweep or write.
    const staleName = `cligent-${carrierHostToken()}-${deadPid()}-${OTHER_SUFFIX}`;
    mkdirSync(join(project, '.kimi-code', 'skills', staleName));
    const disputed = collect(
      adapter.run('C', { cwd: project, skills: [otherAlpha] }),
    );
    await expect(disputed).rejects.toThrow(
      `supplies ${realpathSync(otherAlpha)} under the name "alpha", while the carrier entry ${join(root, 'alpha')} holds ${realpathSync(alpha)}`,
    );
    expect(fake.spawns).toHaveLength(3);
    expect(readdirSync(join(project, '.kimi-code', 'skills')).sort()).toEqual(
      [carrierName(processCarrierSuffix()), staleName].sort(),
    );
    rmSync(join(project, '.kimi-code', 'skills', staleName), {
      recursive: true,
    });

    gates.get('A')!();
    expect(eventOf(await first, 'done').payload.status).toBe('success');
    expect(readdirSync(root).sort()).toEqual(['alpha', 'beta']);

    // A later run disputing an entry that is still present.
    await expect(
      collect(adapter.run('E', { cwd: project, skills: [otherAlpha] })),
    ).rejects.toThrow(`while the carrier entry ${join(root, 'alpha')} holds`);
    expect(fake.spawns).toHaveLength(3);

    gates.get('D')!();
    expect(eventOf(await skillFree, 'done').payload.status).toBe('success');
    // A skill-free run holds nothing, so the carrier stays for its holder.
    expect(readdirSync(root).sort()).toEqual(['alpha', 'beta']);

    gates.get('B')!();
    expect(eventOf(await second, 'done').payload.status).toBe('success');
    expect(existsSync(join(project, '.kimi-code'))).toBe(false);
  });

  it.skipIf(runsAsRoot)(
    'sweeps stale carriers of this host, keeps live and foreign ones, and tolerates a failed removal',
    async () => {
      const project = gitProject();
      const skillsDir = join(project, '.kimi-code', 'skills');
      const host = carrierHostToken();
      const pid = deadPid();
      const names = {
        dead: `cligent-${host}-${pid}-${OTHER_SUFFIX}`,
        ownOther: `cligent-${host}-${process.pid}-${OTHER_SUFFIX}`,
        live: `cligent-${host}-${process.ppid}-${OTHER_SUFFIX}`,
        foreign: `cligent-elsewhere-${host}-x-${pid}-${OTHER_SUFFIX}`,
        locked: `cligent-${host}-${pid}-${'cd'.repeat(10)}`,
        project: 'alpha',
      };
      for (const name of Object.values(names)) {
        mkdirSync(join(skillsDir, name, 'nested'), { recursive: true });
        writeFileSync(join(skillsDir, name, 'nested', 'file.txt'), name);
      }
      writeFileSync(
        join(skillsDir, 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: "Project alpha"\n---\n',
      );
      chmodSync(join(skillsDir, names.locked, 'nested'), 0o500);
      const beta = writeSkill(tempDir('sources'), 'beta');
      let during: string[] | undefined;
      const fake = kimiPeer({
        async prompt() {
          during = readdirSync(skillsDir).sort();
          return { stopReason: 'end_turn' };
        },
      });

      const events = await collect(
        new KimiAdapter({ spawnProcess: fake.spawn }).run('Use beta', {
          cwd: project,
          skills: [beta],
        }),
      );

      expect(eventOf(events, 'done').payload.status).toBe('success');
      expect(during).toEqual(
        [
          carrierName(processCarrierSuffix()),
          names.live,
          names.foreign,
          names.locked,
          names.project,
        ].sort(),
      );
      // The pre-existing parent and its entries outlive the carrier.
      expect(readdirSync(skillsDir).sort()).toEqual(
        [names.live, names.foreign, names.locked, names.project].sort(),
      );
      expect(
        readFileSync(join(skillsDir, 'alpha', 'nested', 'file.txt'), 'utf8'),
      ).toBe('alpha');
    },
  );

  it('fails setup when a pre-existing same-named project skill shadows a run skill and preserves it', async () => {
    const project = gitProject();
    const projectSkill = writeSkill(
      join(project, '.kimi-code', 'skills'),
      'alpha',
      'Project alpha',
    );
    const alpha = writeSkill(tempDir('sources'), 'alpha', 'Run alpha');
    const fake = kimiPeer();

    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Use alpha', {
        cwd: project,
        skills: [alpha],
      }),
    );

    const error = eventOf(events, 'error').payload;
    expect(error.code).toBe('KIMI_ACP_ERROR');
    expect(error.message).toContain(
      `Kimi did not list every run skill from the carrier ${carrierDirectory(project)}`,
    );
    expect(error.message).toContain(
      'shadowed by a same-named skill with another description skill:alpha',
    );
    expect(fake.calls).not.toContain('session/prompt');
    expect(eventOf(events, 'done').payload).toMatchObject({
      status: 'error',
      resumeToken: 'kimi-session',
    });
    expect(readdirSync(join(project, '.kimi-code', 'skills'))).toEqual([
      'alpha',
    ]);
    expect(readFileSync(join(projectSkill, 'SKILL.md'), 'utf8')).toContain(
      'Project alpha',
    );
  });

  it.each([
    ['a fresh project', false],
    ['a project holding a stale carrier', true],
  ] as const)(
    'interrupts a run cancelled while materializing in %s without spawning and removes its hold before done',
    async (_label, withStale) => {
      const project = gitProject();
      const skillsDir = join(project, '.kimi-code', 'skills');
      const staleName = `cligent-${carrierHostToken()}-${deadPid()}-${OTHER_SUFFIX}`;
      if (withStale) mkdirSync(join(skillsDir, staleName), { recursive: true });
      const big = writeLargeSkill(tempDir('sources'), 'big');
      const fake = kimiPeer();
      const reporter = vi.fn();
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const listing = (dir: string): string[] | undefined =>
        existsSync(dir) ? readdirSync(dir) : undefined;
      let atDone: Record<string, string[] | undefined> | undefined;

      const pending = (async () => {
        for await (const event of new KimiAdapter({
          spawnProcess: fake.spawn,
          reportCleanupFailure: reporter,
        }).run('Use big', {
          cwd: project,
          resume: 'prior-session',
          skills: [big],
          abortSignal: controller.signal,
        })) {
          if (event.type === 'done') {
            atDone = {
              kimiDir: listing(join(project, '.kimi-code')),
              skillsDir: listing(skillsDir),
            };
          }
          events.push(event);
        }
      })();
      // The hold is taken once the copy is staged: the root exists and the
      // sweep that follows the hold has removed the stale carrier.
      await until(() => stagingIn(join(project, '.kimi-code')).length > 0);
      expect(existsSync(carrierDirectory(project))).toBe(true);
      expect(existsSync(join(skillsDir, staleName))).toBe(false);
      controller.abort();
      await pending;

      expect(events.map((event) => event.type)).toEqual(['done']);
      expect(eventOf(events, 'done').payload).toMatchObject({
        status: 'interrupted',
        resumeToken: 'prior-session',
      });
      expect(fake.spawns).toHaveLength(0);
      expect(reporter).not.toHaveBeenCalled();
      // Removed before done reached the consumer [kimi-53]: the root and its
      // staging always, and the parents only where this process created them.
      expect(atDone).toEqual(
        withStale
          ? { kimiDir: ['skills'], skillsDir: [] }
          : { kimiDir: undefined, skillsDir: undefined },
      );
    },
  );

  it('shares one carrier between project roots whose .kimi-code aliases one directory', async () => {
    const first = gitProject();
    mkdirSync(join(first, '.kimi-code'));
    const second = gitProject();
    symlinkSync(join(first, '.kimi-code'), join(second, '.kimi-code'));
    const sources = tempDir('sources');
    const alpha = writeSkill(sources, 'alpha');
    const beta = writeSkill(sources, 'beta');
    const entered = new Set<string>();
    const gates = new Map<string, () => void>();
    const seen = new Map<string, string[]>();
    const root = carrierDirectory(first);
    const fake = kimiPeer({
      async prompt(_connection, request) {
        const text = (request.prompt[0] as { text: string }).text;
        await new Promise<void>((release) => {
          gates.set(text, release);
          entered.add(text);
        });
        seen.set(text, readdirSync(root).sort());
        return { stopReason: 'end_turn' };
      },
    });
    const adapter = new KimiAdapter({ spawnProcess: fake.spawn });

    const runA = collect(adapter.run('A', { cwd: first, skills: [alpha] }));
    await until(() => entered.has('A'));
    const runB = collect(adapter.run('B', { cwd: second, skills: [beta] }));
    await until(() => entered.has('B'));
    // One root, one hold count, both entries [kimi-49].
    expect(readdirSync(join(first, '.kimi-code', 'skills'))).toEqual([
      carrierName(processCarrierSuffix()),
    ]);
    expect(readdirSync(root).sort()).toEqual(['alpha', 'beta']);

    gates.get('A')!();
    expect(eventOf(await runA, 'done').payload.status).toBe('success');
    // A's end leaves B's live root [kimi-53].
    expect(readdirSync(root).sort()).toEqual(['alpha', 'beta']);

    gates.get('B')!();
    expect(eventOf(await runB, 'done').payload.status).toBe('success');
    expect(seen.get('B')).toEqual(['alpha', 'beta']);
    // The created skills directory goes; the pre-existing .kimi-code and the
    // second project's link to it stay.
    expect(readdirSync(join(first, '.kimi-code'))).toEqual([]);
    expect(lstatSync(join(second, '.kimi-code')).isSymbolicLink()).toBe(true);
  });

  it('stages each entry beside the resolved destination when .kimi-code/skills is a link', async () => {
    const project = gitProject();
    mkdirSync(join(project, '.kimi-code'));
    const elsewhere = tempDir('elsewhere');
    const target = join(elsewhere, 'shared-skills');
    mkdirSync(target);
    symlinkSync(target, join(project, '.kimi-code', 'skills'));
    const big = writeLargeSkill(tempDir('sources'), 'big');
    const fake = kimiPeer();

    const pending = collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Use big', {
        cwd: project,
        skills: [big],
      }),
    );
    await until(() => stagingIn(elsewhere).length > 0);
    expect(readdirSync(join(project, '.kimi-code'))).toEqual(['skills']);
    const events = await pending;

    expect(eventOf(events, 'done').payload.status).toBe('success');
    expect(readdirSync(elsewhere)).toEqual(['shared-skills']);
    expect(readdirSync(target)).toEqual([]);
  });

  it('reuses an entry whose materialization is in flight once it is renamed into place', async () => {
    const project = gitProject();
    const skillsDir = join(project, '.kimi-code', 'skills');
    const big = writeLargeSkill(tempDir('sources'), 'big');
    const root = carrierDirectory(project);
    const entered = new Set<string>();
    const gates = new Map<string, () => void>();
    const seen = new Map<string, { entries: string[]; inode: number }>();
    const fake = kimiPeer({
      async prompt(_connection, request) {
        const text = (request.prompt[0] as { text: string }).text;
        seen.set(text, {
          entries: readdirSync(root),
          inode: statSync(join(root, 'big')).ino,
        });
        await new Promise<void>((release) => {
          gates.set(text, release);
          entered.add(text);
        });
        return { stopReason: 'end_turn' };
      },
    });
    const adapter = new KimiAdapter({ spawnProcess: fake.spawn });

    const runA = collect(adapter.run('A', { cwd: project, skills: [big] }));
    await until(() => stagingIn(join(project, '.kimi-code')).length > 0);
    // The second run sweeps this marker only after taking its hold, so its
    // disappearance shows the reuse registered while the copy was staged.
    const marker = join(
      skillsDir,
      `cligent-${carrierHostToken()}-${deadPid()}-${OTHER_SUFFIX}`,
    );
    mkdirSync(marker);
    const runB = collect(adapter.run('B', { cwd: project, skills: [big] }));
    await until(() => !existsSync(marker));
    expect(stagingIn(join(project, '.kimi-code')).length).toBeGreaterThan(0);
    await until(() => entered.has('A') && entered.has('B'));

    expect(seen.get('A')).toEqual(seen.get('B'));
    expect(seen.get('B')?.entries).toEqual(['big']);
    gates.get('A')!();
    gates.get('B')!();
    for (const events of [await runA, await runB]) {
      expect(eventOf(events, 'done').payload.status).toBe('success');
    }
    expect(existsSync(join(project, '.kimi-code'))).toBe(false);
  });

  it("interrupts a run cancelled while it waits on another run's in-flight entry", async () => {
    const project = gitProject();
    const kimiDir = join(project, '.kimi-code');
    const big = writeLargeSkill(tempDir('sources'), 'big');
    const fake = kimiPeer();
    const adapter = new KimiAdapter({ spawnProcess: fake.spawn });
    const controller = new AbortController();

    const runA = collect(adapter.run('A', { cwd: project, skills: [big] }));
    await until(() => stagingIn(kimiDir).length > 0);
    const marker = join(
      kimiDir,
      'skills',
      `cligent-${carrierHostToken()}-${deadPid()}-${OTHER_SUFFIX}`,
    );
    mkdirSync(marker);
    const runB = collect(
      adapter.run('B', {
        cwd: project,
        resume: 'prior-session',
        skills: [big],
        abortSignal: controller.signal,
      }),
    );
    await until(() => !existsSync(marker));
    controller.abort();
    const eventsB = await runB;

    expect(eventsB.map((event) => event.type)).toEqual(['done']);
    expect(eventOf(eventsB, 'done').payload).toMatchObject({
      status: 'interrupted',
      resumeToken: 'prior-session',
    });
    // The first run's copy is still staged: the cancelled run did not wait.
    expect(stagingIn(kimiDir).length).toBeGreaterThan(0);
    expect(eventOf(await runA, 'done').payload.status).toBe('success');
    expect(fake.spawns).toHaveLength(1);
    expect(existsSync(kimiDir)).toBe(false);
  });

  it("makes a run starting during the last holder's removal wait for it", async () => {
    const project = gitProject();
    const big = writeDeepSkill(tempDir('sources'), 'big');
    // Another directory under the same name: joining the state whose removal
    // is in flight would find its entry and reject the name as disputed.
    const otherBig = writeSkill(tempDir('other'), 'big', 'Another big');
    const root = carrierDirectory(project);
    const entered = new Set<string>();
    const seen = new Map<string, string>();
    const fake = kimiPeer({
      async prompt(_connection, request) {
        const text = (request.prompt[0] as { text: string }).text;
        seen.set(text, readFileSync(join(root, 'big', 'SKILL.md'), 'utf8'));
        entered.add(text);
        return { stopReason: 'end_turn' };
      },
    });
    const adapter = new KimiAdapter({ spawnProcess: fake.spawn });

    const runA = collect(adapter.run('A', { cwd: project, skills: [big] }));
    await until(() => entered.has('A'));
    // The removal is in flight once the entry loses its SKILL.md while the
    // root remains.
    await until(
      () => existsSync(root) && !existsSync(join(root, 'big', 'SKILL.md')),
    );
    const runB = collect(
      adapter.run('B', { cwd: project, skills: [otherBig] }),
    );

    const [eventsA, eventsB] = await Promise.all([runA, runB]);
    expect(eventOf(eventsA, 'done').payload.status).toBe('success');
    expect(eventOf(eventsB, 'done').payload.status).toBe('success');
    // The second run materialized its own entry into a fresh root.
    expect(seen.get('A')).toBe(readFileSync(join(big, 'SKILL.md'), 'utf8'));
    expect(seen.get('B')).toBe(
      readFileSync(join(otherBig, 'SKILL.md'), 'utf8'),
    );
    expect(existsSync(join(project, '.kimi-code'))).toBe(false);
  });
});

describe('Kimi skill command listing (kimi-51)', () => {
  it.each(['before-response', 'after-response'] as const)(
    'continues when every skill is listed %s, block-scalar descriptions included',
    async (listing) => {
      const project = gitProject();
      const sources = tempDir('sources');
      const skills = [
        writeSkill(sources, 'padded', JSON.stringify('  Padded alpha  ')),
        writeSkill(sources, 'literal', '|\n  First line\n  second line\n'),
        writeSkill(sources, 'folded', '>\n  Folded first\n  folded second\n'),
      ];
      const fake = kimiPeer({ listing });

      const events = await collect(
        new KimiAdapter({ spawnProcess: fake.spawn }).run('Use them', {
          cwd: project,
          skills,
        }),
      );

      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(eventOf(events, 'done').payload.status).toBe('success');
      expect(fake.calls).toContain('session/prompt');
      expect(existsSync(join(project, '.kimi-code'))).toBe(false);
    },
  );

  it.each([
    [
      'lists a run skill with another description',
      {
        rewrite: (commands: Array<{ name: string; description: string }>) =>
          commands.map((command) =>
            command.name === 'skill:alpha'
              ? { ...command, description: 'Something else' }
              : command,
          ),
      },
      'shadowed by a same-named skill with another description skill:alpha',
    ],
    [
      'omits a run skill',
      {
        rewrite: (commands: Array<{ name: string; description: string }>) =>
          commands.filter((command) => command.name !== 'skill:beta'),
      },
      'missing skill:beta',
    ],
    [
      'sends no list within the bound',
      { listing: 'never' as const },
      'Kimi listed no commands within 150 ms of session setup, so the run skills skill:alpha, skill:beta',
    ],
  ])(
    'fails setup without a prompt when the session %s',
    async (_label, options, expected) => {
      const project = gitProject();
      const sources = tempDir('sources');
      const skills = [
        writeSkill(sources, 'alpha'),
        writeSkill(sources, 'beta'),
      ];
      const fake = kimiPeer(options);

      const events = await collect(
        new KimiAdapter({
          spawnProcess: fake.spawn,
          skillListingTimeoutMs: 150,
        }).run('Use them', { cwd: project, skills }),
      );

      const error = eventOf(events, 'error').payload;
      expect(error).toMatchObject({
        code: 'KIMI_ACP_ERROR',
        recoverable: false,
      });
      expect(error.message).toContain(expected);
      expect(error.message).toContain(carrierDirectory(project));
      expect(fake.calls).toEqual(['initialize', 'session/new']);
      expect(eventOf(events, 'done').payload).toMatchObject({
        status: 'error',
        resumeToken: 'kimi-session',
      });
      expect(existsSync(join(project, '.kimi-code'))).toBe(false);
    },
  );

  it.each([
    ['before-response', 'complete'],
    ['before-response', 'missing'],
    ['after-response', 'complete'],
    ['after-response', 'missing'],
  ] as const)(
    'follows the first of two same-session lists sent %s when the first is %s',
    async (timing, first) => {
      const project = gitProject();
      const sources = tempDir('sources');
      const skills = [
        writeSkill(sources, 'alpha'),
        writeSkill(sources, 'beta'),
      ];
      const fake = kimiPeer({
        listing: 'never',
        async sessionSetup(connection, setup) {
          const complete = [
            { name: 'init', description: 'Analyze the codebase' },
            ...(await listKimiSkillCommands(setup.cwd)),
          ];
          const missing = complete.filter(
            (command) => command.name !== 'skill:beta',
          );
          const lists =
            first === 'complete' ? [complete, missing] : [missing, complete];
          const send = async (): Promise<void> => {
            for (const list of lists) {
              await sendCommands(connection, setup.sessionId, list);
            }
          };
          // Held before the setup response, a list reaching the SDK would
          // name a session not yet known: a protocol failure.
          if (timing === 'before-response') await send();
          else setTimeout(() => void send().catch(() => undefined), 30);
        },
      });

      const events = await collect(
        new KimiAdapter({ spawnProcess: fake.spawn }).run('Use them', {
          cwd: project,
          skills,
        }),
      );

      const errors = events.filter((event) => event.type === 'error');
      if (first === 'complete') {
        expect(errors).toEqual([]);
        expect(eventOf(events, 'done').payload.status).toBe('success');
        expect(fake.calls).toContain('session/prompt');
      } else {
        expect(errors).toHaveLength(1);
        expect(errors[0]?.payload).toMatchObject({ code: 'KIMI_ACP_ERROR' });
        const { message } = errors[0]!.payload as { message: string };
        expect(message).toContain('missing skill:beta');
        expect(message).not.toContain('Malformed Kimi ACP traffic');
        expect(fake.calls).toEqual(['initialize', 'session/new']);
        expect(eventOf(events, 'done').payload.status).toBe('error');
      }
    },
  );

  it('fails a resumed session whose rebuilt list omits the run skill', async () => {
    const project = gitProject();
    const creationCwd = tempDir('created-elsewhere');
    const alpha = writeSkill(tempDir('sources'), 'alpha');
    const fake = kimiPeer({ listFrom: () => creationCwd });

    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Use alpha', {
        cwd: project,
        resume: 'prior-session',
        skills: [alpha],
      }),
    );

    expect(fake.calls).toEqual(['initialize', 'session/resume']);
    expect(eventOf(events, 'error').payload.message).toContain(
      'missing skill:alpha',
    );
    expect(eventOf(events, 'done').payload).toMatchObject({
      status: 'error',
      resumeToken: 'prior-session',
    });
  });

  it.each(['before-response', 'after-response'] as const)(
    'treats a malformed list %s as a protocol failure while retained',
    async (timing) => {
      const project = gitProject();
      const alpha = writeSkill(tempDir('sources'), 'alpha');
      const malformed = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'kimi-session',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'skill:alpha', description: 7 }],
          },
        },
      };
      const fake = kimiPeer({
        listing: 'never',
        async sessionSetup(_connection, _setup, peer) {
          if (timing === 'before-response') peer.writeRaw(malformed);
          else setTimeout(() => peer.writeRaw(malformed), 30);
        },
      });

      const events = await collect(
        new KimiAdapter({ spawnProcess: fake.spawn }).run('Use alpha', {
          cwd: project,
          skills: [alpha],
        }),
      );

      expect(eventOf(events, 'error').payload).toMatchObject({
        code: 'KIMI_ACP_ERROR',
        message: expect.stringContaining(
          'Malformed Kimi ACP traffic: invalid available_commands_update parameters',
        ),
      });
      expect(fake.calls).not.toContain('session/prompt');
      expect(eventOf(events, 'done').payload.status).toBe('error');
      expect(existsSync(join(project, '.kimi-code'))).toBe(false);
    },
  );

  it.each(['before-response', 'after-response'] as const)(
    'treats a list for another session %s as a protocol failure',
    async (listing) => {
      const project = gitProject();
      const alpha = writeSkill(tempDir('sources'), 'alpha');
      const fake = kimiPeer({ listing, listingSessionId: 'other-session' });

      const events = await collect(
        new KimiAdapter({ spawnProcess: fake.spawn }).run('Use alpha', {
          cwd: project,
          skills: [alpha],
        }),
      );

      expect(eventOf(events, 'error').payload.message).toContain(
        'available_commands_update referenced a non-active session',
      );
      expect(fake.calls).not.toContain('session/prompt');
    },
  );

  it('drops a list outside the window: in a skill-free run and after the check settles', async () => {
    const project = gitProject();
    const alpha = writeSkill(tempDir('sources'), 'alpha');
    const malformed = (sessionId: string) => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: 'not a list',
        },
      },
    });
    const respond = async (
      connection: AgentSideConnection,
      sessionId: string,
    ): Promise<{ stopReason: 'end_turn' }> => {
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok' },
        },
      });
      return { stopReason: 'end_turn' };
    };
    // Before the backend session is known, a forwarded update would be a
    // protocol failure; dropped, it is invisible.
    const skillFreePeer = kimiPeer({
      listing: 'before-response',
      listingSessionId: 'another-session',
      async sessionSetup(_connection, _setup, peer) {
        peer.writeRaw(malformed('another-session'));
      },
    });
    const skillsPeer = kimiPeer({
      async prompt(connection, request, peer) {
        peer.writeRaw(malformed(request.sessionId));
        await sendCommands(connection, 'another-session', []);
        return respond(connection, request.sessionId);
      },
    });

    const skillFree = await collect(
      new KimiAdapter({ spawnProcess: skillFreePeer.spawn }).run('Plain', {
        cwd: project,
      }),
    );
    const withSkills = await collect(
      new KimiAdapter({ spawnProcess: skillsPeer.spawn }).run('Use alpha', {
        cwd: project,
        skills: [alpha],
      }),
    );

    for (const events of [skillFree, withSkills]) {
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(eventOf(events, 'done').payload).toMatchObject({
        status: 'success',
        result: 'ok',
      });
    }
  });

  it('interrupts a caller abort while awaiting the list and removes the carrier after the child exits', async () => {
    const project = gitProject();
    const alpha = writeSkill(tempDir('sources'), 'alpha');
    let setupDone = false;
    const fake = kimiPeer({
      listing: 'never',
      async sessionSetup() {
        setTimeout(() => {
          setupDone = true;
        }, 10);
      },
    });
    const controller = new AbortController();

    const pending = collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Use alpha', {
        cwd: project,
        skills: [alpha],
        abortSignal: controller.signal,
      }),
    );
    await until(() => setupDone);
    expect(existsSync(carrierDirectory(project))).toBe(true);
    controller.abort();
    const events = await pending;

    expect(events.map((event) => event.type)).toEqual(['done']);
    expect(eventOf(events, 'done').payload).toMatchObject({
      status: 'interrupted',
      resumeToken: 'kimi-session',
    });
    expect(fake.calls).toEqual(['initialize', 'session/new', 'session/cancel']);
    expect(
      fake.children[0]?.exitCode !== null || fake.children[0]?.killed,
    ).toBe(true);
    expect(existsSync(join(project, '.kimi-code'))).toBe(false);
  });
});

describe.skipIf(runsAsRoot)(
  'Kimi skills carrier removal failure (kimi-51)',
  () => {
    function lockSkillsDir(project: string): void {
      chmodSync(join(project, '.kimi-code', 'skills'), 0o555);
    }

    it('selects the cleanup-failure terminal for a succeeding run after child close', async () => {
      const project = gitProject();
      const alpha = writeSkill(tempDir('sources'), 'alpha');
      const reporter = vi.fn();
      const fake = kimiPeer({
        lifecycle: [],
        async prompt(connection, request) {
          lockSkillsDir(project);
          await connection.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'kept' },
            },
          });
          return { stopReason: 'end_turn' };
        },
      });

      const events = await collect(
        new KimiAdapter({
          spawnProcess: fake.spawn,
          reportCleanupFailure: reporter,
        }).run('Use alpha', { cwd: project, skills: [alpha] }),
      );

      expect(events.map((event) => event.type)).toEqual([
        'init',
        'text_delta',
        'error',
        'done',
      ]);
      const error = eventOf(events, 'error').payload;
      expect(error).toMatchObject({
        code: SKILL_CARRIER_CLEANUP_FAILED,
        recoverable: false,
      });
      expect(error.message).toContain(carrierDirectory(project));
      expect(eventOf(events, 'done').payload).toMatchObject({
        status: 'error',
        result: 'kept',
        resumeToken: 'kimi-session',
        usage: { toolUses: 0 },
      });
      expect(fake.children[0]?.exitCode).toBe(0);
      expect(reporter).not.toHaveBeenCalled();
      expect(existsSync(carrierDirectory(project))).toBe(true);
    });

    it('appends the unremoved path to a run that already carries an error', async () => {
      const project = gitProject();
      const alpha = writeSkill(tempDir('sources'), 'alpha');
      const fake = kimiPeer({
        async prompt() {
          lockSkillsDir(project);
          return { stopReason: 'refusal' };
        },
      });

      const events = await collect(
        new KimiAdapter({ spawnProcess: fake.spawn }).run('Use alpha', {
          cwd: project,
          skills: [alpha],
        }),
      );

      const errors = events.filter((event) => event.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload).toMatchObject({ code: 'KIMI_REFUSAL' });
      expect((errors[0]?.payload as { message: string }).message).toMatch(
        new RegExp(
          `^Kimi refused the prompt; skill carrier cleanup failed: ${carrierDirectory(project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
      );
      expect(eventOf(events, 'done').payload.status).toBe('error');
    });

    it('reports a removal failure after a cancellation during materialization once, without an error event', async () => {
      const project = gitProject();
      const big = writeLargeSkill(tempDir('sources'), 'big');
      const fake = kimiPeer();
      const reporter = vi.fn();
      const controller = new AbortController();

      const pending = collect(
        new KimiAdapter({
          spawnProcess: fake.spawn,
          reportCleanupFailure: reporter,
        }).run('Use big', {
          cwd: project,
          skills: [big],
          abortSignal: controller.signal,
        }),
      );
      await until(() => stagingIn(join(project, '.kimi-code')).length > 0);
      lockSkillsDir(project);
      controller.abort();
      const events = await pending;

      expect(events.map((event) => event.type)).toEqual(['done']);
      expect(eventOf(events, 'done').payload.status).toBe('interrupted');
      expect(fake.spawns).toHaveLength(0);
      expect(reporter).toHaveBeenCalledTimes(1);
      expect((reporter.mock.calls[0]?.[0] as Error).message).toContain(
        `Kimi skill carrier cleanup failed: ${carrierDirectory(project)}`,
      );
    });

    /** A run whose removal fails, leaving the root with its `alpha` entry. */
    async function leaveRootBehind(
      adapter: KimiAdapter,
      project: string,
      alpha: string,
    ): Promise<void> {
      const events = await collect(
        adapter.run('A', { cwd: project, skills: [alpha] }),
      );
      expect(eventOf(events, 'error').payload.code).toBe(
        SKILL_CARRIER_CLEANUP_FAILED,
      );
      expect(readdirSync(carrierDirectory(project))).toEqual(['alpha']);
    }

    function lockEntryOnPrompt(project: string) {
      return async (
        _connection: AgentSideConnection,
        request: { prompt: unknown[] },
      ) => {
        const text = (request.prompt[0] as { text: string }).text;
        if (text === 'A') {
          chmodSync(join(carrierDirectory(project), 'alpha'), 0o555);
        }
        return { stopReason: 'end_turn' as const };
      };
    }

    it('rejects a run supplying a name present in a root a failed removal left, naming both paths', async () => {
      const project = gitProject();
      const alpha = writeSkill(tempDir('sources'), 'alpha');
      const fake = kimiPeer({ prompt: lockEntryOnPrompt(project) });
      const adapter = new KimiAdapter({ spawnProcess: fake.spawn });
      await leaveRootBehind(adapter, project, alpha);

      // The root's second removal fails too, so the entry stays present
      // with no recorded source.
      await expect(
        collect(adapter.run('B', { cwd: project, skills: [alpha] })),
      ).rejects.toThrow(
        `skills[0] for adapter "kimi" supplies ${realpathSync(alpha)} under the name "alpha", while the carrier entry ${join(carrierDirectory(project), 'alpha')} is present with no recorded source`,
      );
      expect(fake.spawns).toHaveLength(1);
    });

    it('removes a root a failed removal left, and the parents the process created, on the next run', async () => {
      const project = gitProject();
      const sources = tempDir('sources');
      const alpha = writeSkill(sources, 'alpha');
      const beta = writeSkill(sources, 'beta');
      const root = carrierDirectory(project);
      const listed: string[][] = [];
      let seen: string[] | undefined;
      const lockEntry = lockEntryOnPrompt(project);
      const fake = kimiPeer({
        rewrite: (commands) => {
          listed.push(commands.map((command) => command.name));
          return commands;
        },
        async prompt(connection, request) {
          seen = readdirSync(root);
          return lockEntry(connection, request);
        },
      });
      const adapter = new KimiAdapter({ spawnProcess: fake.spawn });
      await leaveRootBehind(adapter, project, alpha);
      chmodSync(join(root, 'alpha'), 0o755);

      const events = await collect(
        adapter.run('B', { cwd: project, skills: [beta] }),
      );

      expect(eventOf(events, 'done').payload.status).toBe('success');
      expect(seen).toEqual(['beta']);
      expect(listed.at(-1)).toEqual(['init', 'skill:beta']);
      // The parents the failed run created go with the later run's root.
      expect(existsSync(join(project, '.kimi-code'))).toBe(false);
    });

    it('rejects a run reusing an entry whose in-flight materialization fails, naming both paths', async () => {
      const project = gitProject();
      const skillsDir = join(project, '.kimi-code', 'skills');
      const big = writeLargeSkill(tempDir('sources'), 'big');
      const root = carrierDirectory(project);
      const fake = kimiPeer();
      const adapter = new KimiAdapter({ spawnProcess: fake.spawn });

      const runA = collect(adapter.run('A', { cwd: project, skills: [big] }));
      await until(() => stagingIn(join(project, '.kimi-code')).length > 0);
      // The second run sweeps this marker only after taking its hold.
      const marker = join(
        skillsDir,
        `cligent-${carrierHostToken()}-${deadPid()}-${OTHER_SUFFIX}`,
      );
      mkdirSync(marker);
      const runB = collect(adapter.run('B', { cwd: project, skills: [big] }));
      const rejectedA = expect(runA).rejects.toThrow(/EACCES/);
      const rejectedB = expect(runB).rejects.toThrow(
        `skills[0] for adapter "kimi" supplies ${realpathSync(big)} under the name "big", while the materialization of the carrier entry ${join(root, 'big')} from ${realpathSync(big)} failed`,
      );
      await until(() => !existsSync(marker));
      // The copy still in flight now fails on its next source entry.
      chmodSync(join(big, 'data'), 0o000);

      await rejectedA;
      await rejectedB;
      expect(fake.spawns).toHaveLength(0);
      expect(existsSync(join(project, '.kimi-code'))).toBe(false);
    });

    it('reports a removal failure after a caller abort through the cleanup reporter', async () => {
      const project = gitProject();
      const alpha = writeSkill(tempDir('sources'), 'alpha');
      let setupDone = false;
      const fake = kimiPeer({
        listing: 'never',
        async sessionSetup() {
          lockSkillsDir(project);
          setTimeout(() => {
            setupDone = true;
          }, 10);
        },
      });
      const reporter = vi.fn();
      const controller = new AbortController();

      const pending = collect(
        new KimiAdapter({
          spawnProcess: fake.spawn,
          reportCleanupFailure: reporter,
        }).run('Use alpha', {
          cwd: project,
          skills: [alpha],
          abortSignal: controller.signal,
        }),
      );
      await until(() => setupDone);
      controller.abort();
      const events = await pending;

      expect(events.map((event) => event.type)).toEqual(['done']);
      expect(eventOf(events, 'done').payload.status).toBe('interrupted');
      expect(reporter).toHaveBeenCalledTimes(1);
      expect((reporter.mock.calls[0]?.[0] as Error).message).toContain(
        `Kimi skill carrier cleanup failed: ${carrierDirectory(project)}`,
      );
    });
  },
);
