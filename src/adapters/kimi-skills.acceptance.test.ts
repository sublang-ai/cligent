// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// kimi-52: real-run verification that a run skill reaches Kimi Code through
// the project-root carrier. The scripted-peer checks (kimi-51) prove the
// carrier layout and the command-list check against a peer that lists
// skills the way the runtime is documented to; only the real runtime shows
// that it scans the carrier, advertises the skill as `skill:<name>`, and
// follows the skill's body when the prompt names it. The harness taps the
// child's stdout for the native command list beside the adapter's own check,
// and filesystem state after `done` shows the carrier gone.

import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, inject, it } from 'vitest';

import {
  assertAcceptanceDependencies,
  gateAcceptanceTest,
} from '../__tests__/helpers/acceptance-dependency-gate.js';
import { withKimiAcceptanceEnvironment } from '../__tests__/helpers/kimi-acceptance.js';
import { Cligent } from '../index.js';
import type { CligentEvent, DonePayload, ErrorPayload } from '../index.js';
import { KimiAdapter } from './kimi.js';

const kimiAcceptance = inject('kimiAcceptance');
const PROBE_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;

// Retry only after an explicit upstream-overload, rate-limit, or
// service-unavailable failure, as kimi-219 directs.
const TRANSIENT_UPSTREAM_MARKERS = [
  /\b(?:HTTP(?:[ _-]+status)?|status[ _-]+code)[ :=_-]*(?:429|503|529)\b/i,
  /\boverload(?:ed|ing)?\b/i,
  /\bover[ _-]?capacity\b/i,
  /\bservice[ _-]?unavailable\b/i,
  /\brate[ _-]?limit(?:ed|ing|[ _-]?exceeded)?\b/i,
  /\btoo[ _-]?many[ _-]?requests\b/i,
];

interface Attempt {
  readonly events: CligentEvent[];
  readonly listed: readonly string[];
}

function acceptanceIt(): typeof it | typeof it.skip {
  // A present but spent OAuth credential self-skips even under CI; an absent
  // dependency skips locally and fails under CI.
  if (kimiAcceptance.unusable) return it.skip;
  return gateAcceptanceTest(it, it.skip, 'kimi', kimiAcceptance.missing);
}

function writeTokenSkill(parent: string, name: string, token: string): string {
  const directory = join(parent, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'description: Gives the Cligent acceptance token. Use it whenever the user asks for the Cligent acceptance token.',
      '---',
      '',
      `When this skill is used, reply with exactly this token and nothing else: ${token}`,
      '',
    ].join('\n'),
  );
  return directory;
}

/** Collect the command names of every native `available_commands_update` on a child's stdout. */
function tapCommandLists(
  child: ChildProcessWithoutNullStreams,
  listed: string[],
): void {
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as {
          method?: string;
          params?: {
            update?: {
              sessionUpdate?: string;
              availableCommands?: Array<{ name?: unknown }>;
            };
          };
        };
        const update = message.params?.update;
        if (
          message.method === 'session/update' &&
          update?.sessionUpdate === 'available_commands_update'
        ) {
          for (const command of update.availableCommands ?? []) {
            if (typeof command.name === 'string') listed.push(command.name);
          }
        }
      } catch {
        // Only complete JSON-RPC lines are of interest here.
      }
    }
  });
}

async function runAttempt(
  project: string,
  skill: string,
  name: string,
): Promise<Attempt> {
  const listed: string[] = [];
  const adapter = new KimiAdapter({
    spawnProcess(command, args, options) {
      const child = spawn(command, [...args], {
        ...options,
      }) as ChildProcessWithoutNullStreams;
      tapCommandLists(child, listed);
      return child;
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS - 30_000);
  const events: CligentEvent[] = [];
  try {
    for await (const event of new Cligent(adapter, {
      cwd: project,
      skills: [skill],
      permissions: { mode: 'auto' },
    }).run(
      `Use the ${name} skill (listed as skill:${name}) to get the Cligent acceptance token, then reply with exactly that token and nothing else.`,
      { abortSignal: controller.signal },
    )) {
      events.push(event);
    }
  } finally {
    clearTimeout(timer);
  }
  return { events, listed };
}

function transientFailure(attempt: Attempt): string | undefined {
  const done = attempt.events.find((event) => event.type === 'done');
  if ((done?.payload as DonePayload | undefined)?.status === 'success') {
    return undefined;
  }
  const text = attempt.events
    .filter((event) => event.type === 'error')
    .map((event) => (event.payload as ErrorPayload).message)
    .join('\n');
  return TRANSIENT_UPSTREAM_MARKERS.some((pattern) => pattern.test(text))
    ? text
    : undefined;
}

describe('Kimi skills real-run acceptance (kimi-52)', () => {
  acceptanceIt()(
    'lists the run skill, follows its body, and removes the carrier after done',
    async () => {
      assertAcceptanceDependencies('kimi', kimiAcceptance.missing);
      const project = mkdtempSync(
        join(tmpdir(), 'cligent-kimi-skill-project-'),
      );
      const sources = mkdtempSync(join(tmpdir(), 'cligent-kimi-skill-source-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: project, stdio: 'ignore' });
        const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
        const name = `cligent-token-${suffix}`;
        const token = `CLIGENT-${suffix.toUpperCase()}-OK`;
        const skill = writeTokenSkill(sources, name, token);

        const attempt = await withKimiAcceptanceEnvironment(
          kimiAcceptance,
          async () => {
            let latest: Attempt | undefined;
            for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
              latest = await runAttempt(project, skill, name);
              const transient = transientFailure(latest);
              if (!transient) return latest;
              process.stderr.write(
                `kimi skills acceptance: retrying after a transient upstream failure: ${transient}\n`,
              );
            }
            return latest!;
          },
        );

        const errors = attempt.events.filter((event) => event.type === 'error');
        expect(errors, JSON.stringify(errors)).toEqual([]);
        // The runtime's own command list names the skill [kimi-50].
        expect(attempt.listed).toContain(`skill:${name}`);
        const done = attempt.events.find((event) => event.type === 'done');
        expect(done?.payload).toMatchObject({ status: 'success' });
        // The reply follows the skill body [kimi-49].
        expect((done?.payload as DonePayload).result ?? '').toContain(token);
        // The carrier, and the parents the run created, are gone [kimi-53].
        expect(existsSync(join(project, '.kimi-code'))).toBe(false);
      } finally {
        rmSync(project, { recursive: true, force: true });
        rmSync(sources, { recursive: true, force: true });
      }
    },
    PROBE_TIMEOUT_MS,
  );
});
