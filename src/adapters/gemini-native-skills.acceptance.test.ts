// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// gemini-60: real-runtime verification that a run selecting `nativeSkills:
// false` leaves the installed Gemini CLI discovering only the run's skill.
// The fixture subprocess tests (gemini-59) prove what the adapter writes into
// the per-run home; only the real runtime shows that its discovery, under
// that home, environment, and working directory, enables the run skill and
// no workspace or user skill (gemini-58). The CLI's own skill listing needs
// no credentials and calls no model, so it runs at the spawn the adapter
// requests, while the per-run home still exists; a stand-in child then ends
// the run.

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertAcceptanceDependencies,
  gateAcceptanceTest,
} from '../__tests__/helpers/acceptance-dependency-gate.js';
import type { AgentEvent } from '../types.js';
import { GeminiAdapter } from './gemini.js';

const RUN_SKILL = 'cligent-run-skill';
const WORKSPACE_SKILLS = ['ws-a', 'ws-b'];
const USER_SKILLS = ['user-a', 'user-b'];
const LISTING_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;

// The stand-in child: one init and one successful result, as Gemini's
// stream-json output ends a run.
const STAND_IN_CHILD = [
  "console.log(JSON.stringify({ type: 'init', session_id: 'gemini-native-skills-live' }));",
  "console.log(JSON.stringify({ type: 'result', status: 'success', result: 'done' }));",
].join(' ');

function missingDeps(): string[] {
  try {
    execFileSync('gemini', ['--version'], { stdio: 'ignore', timeout: 30_000 });
    return [];
  } catch {
    return ['gemini CLI on PATH'];
  }
}

function writeSkill(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n---\nBody of ${name}\n`,
  );
  return path;
}

/**
 * `gemini skills list --all` in `cwd` under `env`, the workspace trusted so
 * that its skills are considered, the system settings layers pointed at
 * files that do not exist, and no relaunch: each listed skill's status,
 * from its `name [Enabled|Disabled]` line.
 */
function listSkills(
  env: NodeJS.ProcessEnv,
  cwd: string,
  nowhere: string,
): Map<string, string> {
  const output = execFileSync('gemini', ['skills', 'list', '--all'], {
    cwd,
    env: {
      ...env,
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      GEMINI_CLI_NO_RELAUNCH: 'true',
      NO_COLOR: '1',
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(nowhere, 'settings.json'),
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(nowhere, 'system-defaults.json'),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: LISTING_TIMEOUT_MS,
  });
  const statuses = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+) \[(Enabled|Disabled)\]/.exec(line);
    if (match) statuses.set(match[1]!, match[2]!);
  }
  return statuses;
}

const missing = missingDeps();

describe('Gemini native skills off real-runtime acceptance (gemini-60)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  gateAcceptanceTest(
    it,
    it.skip,
    'gemini',
    missing,
  )(
    'the runtime enables only the run skill under the per-run home and every native skill under the real home',
    async () => {
      assertAcceptanceDependencies('gemini', missing);
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), 'cligent-gemini-native-skills-live-')),
      );
      try {
        const home = join(root, 'home');
        const workspace = join(root, 'work');
        // Never created: no system settings layer reaches either listing.
        const nowhere = join(root, 'system');
        writeSkill(join(workspace, '.gemini', 'skills'), 'ws-a');
        writeSkill(join(workspace, '.agents', 'skills'), 'ws-b');
        writeSkill(join(home, '.gemini', 'skills'), 'user-a');
        writeSkill(join(home, '.agents', 'skills'), 'user-b');
        // The per-run home copies these settings, keeping both listings
        // from reporting usage.
        writeFileSync(
          join(home, '.gemini', 'settings.json'),
          JSON.stringify({ privacy: { usageStatisticsEnabled: false } }),
        );
        const runSkill = writeSkill(join(root, 'sources'), RUN_SKILL);

        // A throwaway real home, named by HOME alone, and a trusted
        // workspace with no native sandbox.
        vi.stubEnv('HOME', home);
        vi.stubEnv('GEMINI_CLI_HOME', undefined);
        vi.stubEnv(
          'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
          join(nowhere, 'settings.json'),
        );
        vi.stubEnv(
          'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
          join(nowhere, 'system-defaults.json'),
        );
        vi.stubEnv('GEMINI_CLI_TRUST_WORKSPACE', 'true');
        vi.stubEnv('GEMINI_RESTRICTED_MODE', undefined);
        vi.stubEnv('GEMINI_SANDBOX', undefined);
        vi.stubEnv('SANDBOX', undefined);
        // The stand-in child replaces the runtime the floor guards; the
        // listing is what exercises the installed CLI.
        vi.stubEnv('CLIGENT_RUNTIME_GATE', 'off');

        let recorded:
          { env: NodeJS.ProcessEnv; listing: Map<string, string> } | undefined;
        let listingError: unknown;
        const adapter = new GeminiAdapter({
          spawnProcess: (
            _command: string,
            _args: readonly string[],
            options: SpawnOptionsWithoutStdio,
          ) => {
            const env = { ...options.env };
            try {
              recorded = {
                env,
                listing: listSkills(env, String(options.cwd), nowhere),
              };
            } catch (error) {
              listingError = error;
            }
            return spawn(process.execPath, ['-e', STAND_IN_CHILD], {
              ...options,
              stdio: 'pipe',
            });
          },
        });

        const events: AgentEvent[] = [];
        for await (const event of adapter.run('Use the skills', {
          cwd: workspace,
          skills: [runSkill],
          nativeSkills: false,
        })) {
          events.push(event);
        }

        if (listingError !== undefined) throw listingError;
        expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
        const { env, listing } = recorded!;
        const overlay = env.GEMINI_CLI_HOME;
        expect(overlay).toBeDefined();
        expect(overlay).not.toBe(home);
        // gemini-58: under the recorded home, environment, and working
        // directory, the run skill is enabled and no native skill is.
        expect(listing.get(RUN_SKILL), JSON.stringify([...listing])).toBe(
          'Enabled',
        );
        for (const name of [...WORKSPACE_SKILLS, ...USER_SKILLS]) {
          expect(
            [undefined, 'Disabled'],
            `${name} in ${JSON.stringify([...listing])}`,
          ).toContain(listing.get(name));
        }
        expect(existsSync(overlay!)).toBe(false);

        // Under the real home, the same workspace and user skills are all
        // enabled, so the per-run home alone turned them off.
        const real = listSkills({ ...process.env }, workspace, nowhere);
        for (const name of [...WORKSPACE_SKILLS, ...USER_SKILLS]) {
          expect(
            real.get(name),
            `${name} in ${JSON.stringify([...real])}`,
          ).toBe('Enabled');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
