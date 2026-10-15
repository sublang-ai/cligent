// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// opencode-70: real-run verification that a managed OpenCode server receives
// a run's skill through the inline-configuration carrier. The integration
// checks (opencode-68) prove the merged environment and the listing gate
// against a recording fixture; only the real server can show that it loads
// the injected path, lists the skill at its carrier location, and lets the
// model invoke it. Preconditions follow opencode-219: the OpenCode CLI on
// PATH and MOONSHOT_API_KEY, a logged self-skip outside CI, a hard failure in
// CI, and at most two fresh retries after explicit upstream overload,
// rate-limit, or service-unavailable failures.

import { execFileSync, spawn } from 'node:child_process';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { describe, expect, it } from 'vitest';

import type {
  AgentEvent,
  DonePayload,
  ErrorPayload,
  TextDeltaPayload,
  TextPayload,
} from '../index.js';
import { OpenCodeAdapter, wrapOpencodeClient } from './opencode.js';

const OPENCODE_MODEL = process.env.OPENCODE_MODEL ?? 'moonshotai-cn/kimi-k3';
const SKILL_NAME = 'cligent-token-probe';
const PROBE_TIMEOUT_MS = 300_000;
const MAX_PROBE_ATTEMPTS = 3;

const TRANSIENT_UPSTREAM_MARKERS = [
  /\b(?:API Error:\s*Repeated|HTTP(?:[ _-]+status)?|status[ _-]+code)[ :=_-]*(?:429|503|529)\b/i,
  /\boverload(?:ed|ing)?\b/i,
  /\bover[ _-]?capacity\b/i,
  /\bservice[ _-]?unavailable\b/i,
  /\brate[ _-]?limit(?:ed|ing|[ _-]?exceeded)?\b/i,
  /\btoo[ _-]?many[ _-]?requests\b/i,
];

function missingDependencies(): string[] {
  const missing: string[] = [];
  if (!process.env.MOONSHOT_API_KEY) missing.push('MOONSHOT_API_KEY');
  try {
    execFileSync('opencode', ['--version'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
  } catch {
    missing.push('opencode CLI on PATH');
  }
  return missing;
}

const missing = missingDependencies();

// Acceptance files are excluded from the standard CI matrix; when the
// acceptance config does load this file, CI hard-fails on a missing
// dependency instead of silently skipping.
const acceptanceIt = (() => {
  if (missing.length === 0 || process.env.CI) return it;
  process.stderr.write(
    `Missing OpenCode skills acceptance dependencies: ${missing.join(', ')}; skipping locally\n`,
  );
  return it.skip;
})();

interface ListedSkill {
  readonly name?: unknown;
  readonly location?: unknown;
}

interface ProbeOutcome {
  readonly events: readonly AgentEvent[];
  readonly token: string;
  readonly listings: readonly unknown[];
  readonly configContent: string | undefined;
  readonly carrierGoneAfterStream: boolean | undefined;
}

function writeProbeSkill(root: string, token: string): string {
  const directory = join(root, SKILL_NAME);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${SKILL_NAME}`,
      'description: Supplies the reply token for the Cligent skill acceptance probe. Use it whenever a prompt names cligent-token-probe.',
      '---',
      '',
      `Reply with exactly this token and nothing else: ${token}`,
      '',
    ].join('\n'),
  );
  return directory;
}

async function runProbe(): Promise<ProbeOutcome> {
  const workspace = mkdtempSync(join(tmpdir(), 'cligent-opencode-skill-live-'));
  const token = `CLIGENT-SKILL-${randomBytes(6).toString('hex').toUpperCase()}`;
  const listings: unknown[] = [];
  let configContent: string | undefined;
  const events: AgentEvent[] = [];
  // The probe's server reads only the run's own inline configuration: a
  // caller value could add skills or replace the provider the probe needs.
  const callerConfig = process.env.OPENCODE_CONFIG_CONTENT;
  delete process.env.OPENCODE_CONFIG_CONTENT;
  try {
    const cwd = join(workspace, 'cwd');
    mkdirSync(cwd);
    const skill = writeProbeSkill(join(workspace, 'skills'), token);
    const adapter = new OpenCodeAdapter(
      { mode: 'managed', readyTimeoutMs: 20_000 },
      {
        spawnProcess(
          command: string,
          args: readonly string[],
          options: SpawnOptionsWithoutStdio,
        ) {
          configContent = options.env?.OPENCODE_CONFIG_CONTENT;
          return spawn(
            command,
            [...args],
            options,
          ) as ChildProcessWithoutNullStreams;
        },
        async loadSdk() {
          return {
            createClient({ baseUrl } = {}) {
              const real = createOpencodeClient({ baseUrl });
              // Tap the real server's listing the adapter checks.
              const app = real.app as unknown as Record<string, unknown>;
              const listSkills = real.app.skills.bind(real.app);
              app.skills = async (
                ...parameters: Parameters<typeof listSkills>
              ) => {
                const result = await listSkills(...parameters);
                listings.push(result.data);
                return result;
              };
              return wrapOpencodeClient(
                real as unknown as Record<string, unknown>,
                { apiVersion: 'v2' },
              );
            },
          };
        },
      },
    );
    // The adapter's own stream completes only after its teardown and carrier
    // removal, which the engine does not wait for after the terminal.
    for await (const event of adapter.run(
      `Load the skill named ${SKILL_NAME} and follow its instructions exactly.`,
      { cwd, model: OPENCODE_MODEL, skills: [skill] },
    )) {
      events.push(event);
    }
    const carrierPath = carrierSkillPath(configContent);
    return {
      events,
      token,
      listings,
      configContent,
      carrierGoneAfterStream:
        carrierPath === undefined
          ? undefined
          : !existsSync(dirname(carrierPath)),
    };
  } finally {
    if (callerConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = callerConfig;
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * The run's `<carrier root>/<name>` path from the inline configuration, the
 * last entry of its `skills` array or of `skills.paths`, whichever it holds.
 */
function carrierSkillPath(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const skills = (JSON.parse(content) as { skills?: unknown }).skills;
  const paths: unknown[] = Array.isArray(skills)
    ? skills
    : typeof skills === 'object' &&
        skills !== null &&
        Array.isArray((skills as { paths?: unknown }).paths)
      ? (skills as { paths: unknown[] }).paths
      : [];
  const path = paths.at(-1);
  return typeof path === 'string' ? path : undefined;
}

function transientFailure(events: readonly AgentEvent[]): string | undefined {
  const done = events.find((event) => event.type === 'done')?.payload as
    DonePayload | undefined;
  if (done?.status === 'success') return undefined;
  const messages = events
    .filter((event) => event.type === 'error')
    .map((event) => {
      const payload = event.payload as ErrorPayload;
      return `${payload.code ?? ''} ${payload.message}`;
    });
  return messages.find((message) =>
    TRANSIENT_UPSTREAM_MARKERS.some((marker) => marker.test(message)),
  );
}

async function runWithRetries(): Promise<ProbeOutcome> {
  for (let attempt = 1; attempt <= MAX_PROBE_ATTEMPTS; attempt++) {
    const outcome = await runProbe();
    const transient = transientFailure(outcome.events);
    if (!transient) return outcome;
    if (attempt === MAX_PROBE_ATTEMPTS) {
      throw new Error(
        `OpenCode skills acceptance failed after ${MAX_PROBE_ATTEMPTS} consecutive transient upstream attempts: ${transient}`,
      );
    }
    process.stderr.write(
      `OpenCode skills acceptance attempt ${attempt} hit transient upstream error: ${transient}\n`,
    );
  }
  throw new Error('OpenCode skills acceptance exhausted its retry loop');
}

describe('OpenCode managed skills real-run acceptance (opencode-70)', () => {
  acceptanceIt(
    'lists the skill at its carrier location, invokes it, and removes the carrier',
    async () => {
      if (missing.length > 0) {
        throw new Error(
          `Missing OpenCode skills acceptance dependencies: ${missing.join(', ')}`,
        );
      }
      const outcome = await runWithRetries();
      const errors = outcome.events
        .filter((event) => event.type === 'error')
        .map((event) => (event.payload as ErrorPayload).message);
      const done = outcome.events.find((event) => event.type === 'done')
        ?.payload as DonePayload | undefined;
      expect(done?.status, `errors: ${errors.join(' | ')}`).toBe('success');

      // The real server lists the skill at the carrier location.
      const carrierPath = carrierSkillPath(outcome.configContent);
      expect(carrierPath).toBeDefined();
      expect(outcome.listings).toHaveLength(1);
      const listed = (outcome.listings[0] as ListedSkill[]).filter(
        (skill) => skill.name === SKILL_NAME,
      );
      expect(listed).toEqual([
        expect.objectContaining({
          name: SKILL_NAME,
          location: join(carrierPath!, 'SKILL.md'),
        }),
      ]);

      // The model reached the skill body: only it holds the token.
      const reply = [
        ...outcome.events.map((event) =>
          event.type === 'text'
            ? (event.payload as TextPayload).content
            : event.type === 'text_delta'
              ? (event.payload as TextDeltaPayload).delta
              : '',
        ),
        done?.result ?? '',
      ].join('');
      expect(
        reply,
        `events: ${outcome.events.map((event) => event.type).join(', ')}`,
      ).toContain(outcome.token);

      // The carrier root is gone once the event stream completes.
      expect(outcome.carrierGoneAfterStream).toBe(true);
    },
    PROBE_TIMEOUT_MS * MAX_PROBE_ATTEMPTS,
  );
});
