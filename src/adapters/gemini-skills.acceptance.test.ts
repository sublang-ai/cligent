// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// gemini-54: real-run verification that a run's skill reaches Gemini CLI
// through the per-run settings home and that `activate_skill` is open for it.
// The fixture subprocess tests (gemini-53) prove what the adapter writes; only
// the real runtime shows that it discovers the user-tier skill, admits the
// activation under its headless policy, and follows the skill body. The
// skill's body carries a token the model cannot guess, so a reply carrying it
// is evidence that the body was loaded.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertAcceptanceDependencies,
  gateAcceptanceTest,
} from '../__tests__/helpers/acceptance-dependency-gate.js';
import type { AgentEvent, DonePayload, ErrorPayload } from '../types.js';
import { GeminiAdapter } from './gemini.js';

const SKILL_NAME = 'cligent-token-probe';
const PROBE_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;

// Keep competing auth and model routes inactive so workspace .env discovery
// cannot override the explicit API key or the harness-selected model, as the
// gemini-219 harness does.
const GEMINI_ISOLATED_ENV_KEYS = [
  'GEMINI_MODEL',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GEMINI_BASE_URL',
  'GEMINI_CLI_USE_COMPUTE_ADC',
  'CLOUD_SHELL',
] as const;

// Retry only explicit upstream-capacity failures so a genuine regression
// still surfaces.
const TRANSIENT_UPSTREAM_MARKERS = [
  /\b(?:API Error:\s*Repeated|HTTP(?:[ _-]+status)?|status[ _-]+code)[ :=_-]*(?:429|503|529)\b/i,
  /\boverload(?:ed|ing)?\b/i,
  /\bover[ _-]?capacity\b/i,
  /\bservice[ _-]?unavailable\b/i,
  /\brate[ _-]?limit(?:ed|ing|[ _-]?exceeded)?\b/i,
  /\btoo[ _-]?many[ _-]?requests\b/i,
];

const model = process.env.GEMINI_MODEL || undefined;

function missingDeps(): string[] {
  const missing: string[] = [];
  if (!process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  try {
    execFileSync('gemini', ['--version'], { stdio: 'ignore', timeout: 5_000 });
  } catch {
    missing.push('gemini CLI on PATH');
  }
  return missing;
}

async function withIsolatedGeminiCliHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'cligent-gemini-live-'));
  const previousHome = process.env.GEMINI_CLI_HOME;
  const previousConflicts = new Map<string, string | undefined>(
    GEMINI_ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  process.env.GEMINI_CLI_HOME = home;
  for (const key of GEMINI_ISOLATED_ENV_KEYS) process.env[key] = '';
  try {
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = previousHome;
    for (const [key, value] of previousConflicts) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

interface ProbeOutcome {
  readonly events: readonly AgentEvent[];
  /** The `GEMINI_CLI_HOME` the adapter handed the real child. */
  readonly overlay: string | undefined;
}

function transient(events: readonly AgentEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === 'error' &&
      TRANSIENT_UPSTREAM_MARKERS.some((marker) =>
        marker.test((event.payload as ErrorPayload).message),
      ),
  );
}

// Gemini streams one `text` event per native chunk, and a token can span two
// chunks, so the chunks concatenate without a separator; the terminal result
// follows on its own line.
function reply(events: readonly AgentEvent[]): string {
  const text = events
    .flatMap((event) =>
      event.type === 'text'
        ? [(event.payload as { content: string }).content]
        : [],
    )
    .join('');
  const done = events.find((event) => event.type === 'done');
  return [text, (done?.payload as DonePayload | undefined)?.result ?? ''].join(
    '\n',
  );
}

const missing = missingDeps();

describe('Gemini skills real-run acceptance (gemini-54)', () => {
  gateAcceptanceTest(
    it,
    it.skip,
    'gemini',
    missing,
  )(
    'a run skill reaches the real runtime, which follows its body',
    async (context) => {
      assertAcceptanceDependencies('gemini', missing);
      const root = mkdtempSync(join(tmpdir(), 'cligent-gemini-skills-live-'));
      try {
        const cwd = join(root, 'work');
        const skill = join(root, 'skills', SKILL_NAME);
        mkdirSync(cwd);
        mkdirSync(skill, { recursive: true });
        const token = `CLIGENT-${randomBytes(6).toString('hex').toUpperCase()}`;
        writeFileSync(
          join(skill, 'SKILL.md'),
          [
            '---',
            `name: ${SKILL_NAME}`,
            `description: Gives the Cligent probe token. Use whenever asked for the ${SKILL_NAME} token.`,
            '---',
            `When this skill is active, reply with exactly this token and nothing else: ${token}`,
            '',
          ].join('\n'),
        );

        await withIsolatedGeminiCliHome(async () => {
          // gemini-51 rejects a requested native sandbox, which this check
          // cannot lift; the adapter's own capability report detects it.
          const capabilities = await new GeminiAdapter().getCapabilities({
            cwd,
            browser: true,
          });
          if (
            capabilities.browser.status === 'unsupported' &&
            capabilities.browser.code === 'native-sandbox'
          ) {
            process.stderr.write(
              `Skipping gemini-54: ${capabilities.browser.message}\n`,
            );
            context.skip();
          }

          let outcome: ProbeOutcome | undefined;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            let overlay: string | undefined;
            const adapter = new GeminiAdapter({
              spawnProcess: (
                command: string,
                args: readonly string[],
                options: SpawnOptionsWithoutStdio,
              ) => {
                overlay = options.env?.GEMINI_CLI_HOME;
                return spawn(command, args, options);
              },
            });
            const events: AgentEvent[] = [];
            for await (const event of adapter.run(
              `Use the ${SKILL_NAME} skill and reply with exactly what it tells you to reply.`,
              { cwd, skills: [skill], ...(model ? { model } : {}) },
            )) {
              events.push(event);
            }
            outcome = { events, overlay };
            if (!transient(events)) break;
          }

          const { events, overlay } = outcome!;
          const done = events.at(-1);
          expect(done?.type).toBe('done');
          expect(
            events.filter((event) => event.type === 'error'),
            JSON.stringify(events.filter((event) => event.type === 'error')),
          ).toEqual([]);
          expect((done!.payload as DonePayload).status).toBe('success');
          expect(reply(events)).toContain(token);
          // gemini-35: the overlay is gone once the adapter's own event
          // stream completes.
          expect(overlay).toBeDefined();
          expect(overlay).not.toBe(process.env.GEMINI_CLI_HOME);
          expect(existsSync(overlay!)).toBe(false);
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    PROBE_TIMEOUT_MS,
  );
});
