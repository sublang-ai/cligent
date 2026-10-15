// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// codex-77: real-run verification that a run skill reaches Codex through the
// run-private plugin. The fixture-subprocess check (codex-76) shows the plugin
// root, the override, and the offline catalog; only a real model turn shows
// that a `$cligent:<name>` mention injects the skill's body. The body directs
// a reply carrying a token generated for the attempt, which no other source
// can supply. The run uses a throwaway CODEX_HOME, so the user's home, its
// plugin cache, and its configuration stay untouched, and the plugin cache
// entry is observed while the run holds it and checked gone once the stream
// completes. No tool runs, so the native sandbox never starts.

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { carrierHostToken } from '../skills.js';
import type { AgentEvent, DonePayload, ErrorPayload } from '../types.js';
import { CodexAdapter } from './codex.js';

const PROBE_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;
const SKILL = 'token-reply';

const missing = process.env.CODEX_API_KEY ? [] : ['CODEX_API_KEY'];

// Acceptance files are excluded from the standard CI matrix; when the
// acceptance config does load this file, CI hard-fails on a missing key
// instead of silently skipping.
const acceptanceIt = (() => {
  if (missing.length === 0 || process.env.CI) return it;
  process.stderr.write(
    `Missing Codex skills acceptance dependencies: ${missing.join(', ')}; skipping locally\n`,
  );
  return it.skip;
})();

// Retry only after an explicit upstream-overload, rate-limit, or
// service-unavailable failure, so a genuine regression still surfaces.
const TRANSIENT_UPSTREAM_CODES = new Set([
  '429',
  '503',
  '529',
  'HTTP_429',
  'HTTP_503',
  'HTTP_529',
  'OVERLOADED',
  'OVER_CAPACITY',
  'RATE_LIMITED',
  'RATE_LIMIT_EXCEEDED',
  'SERVICE_UNAVAILABLE',
  'TOO_MANY_REQUESTS',
]);
const TRANSIENT_UPSTREAM_MARKERS = [
  /\b(?:API Error:\s*Repeated|HTTP(?:[ _-]+status)?|status[ _-]+code)[ :=_-]*(?:429|503|529)\b/i,
  /\boverload(?:ed|ing)?\b/i,
  /\bover[ _-]?capacity\b/i,
  /\bservice[ _-]?unavailable\b/i,
  /\brate[ _-]?limit(?:ed|ing|[ _-]?exceeded)?\b/i,
  /\btoo[ _-]?many[ _-]?requests\b/i,
];

const OWN_MARKETPLACE = new RegExp(
  `^cligent-${carrierHostToken().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-${process.pid}-[0-9a-f]{20}$`,
);

interface ProbeOutcome {
  readonly token: string;
  readonly events: readonly AgentEvent[];
  readonly cache: string;
  readonly heldDuringRun: readonly string[];
}

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    // Native background handles can outlive the terminal SDK event.
    rmSync(root, { recursive: true, force: true, maxRetries: 20 });
  }
});

async function probe(): Promise<ProbeOutcome> {
  const root = mkdtempSync(join(tmpdir(), 'cligent-codex-skills-live-'));
  roots.push(root);
  const home = join(root, 'codex-home');
  const workspace = join(root, 'workspace');
  const skill = join(root, 'skills', SKILL);
  mkdirSync(home);
  mkdirSync(workspace);
  mkdirSync(skill, { recursive: true });
  const token = `CLIGENT-SKILL-${randomBytes(6).toString('hex').toUpperCase()}`;
  writeFileSync(
    join(skill, 'SKILL.md'),
    [
      '---',
      `name: ${SKILL}`,
      'description: Reply with the verification token this skill holds.',
      '---',
      '',
      `When this skill is used, reply with exactly ${token} and nothing else.`,
      '',
    ].join('\n'),
  );
  vi.stubEnv('CODEX_HOME', home);
  const cache = join(home, 'plugins', 'cache');

  const events: AgentEvent[] = [];
  let heldDuringRun: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS - 30_000);
  try {
    for await (const event of new CodexAdapter().run(
      `$cligent:${SKILL} Follow the skill.`,
      { cwd: workspace, skills: [skill], abortSignal: controller.signal },
    )) {
      if (events.length === 0 && existsSync(cache)) {
        heldDuringRun = readdirSync(cache);
      }
      events.push(event);
    }
  } finally {
    clearTimeout(timer);
  }
  return { token, events, cache, heldDuringRun };
}

function transientFailure(events: readonly AgentEvent[]): string | undefined {
  const done = events.find((event) => event.type === 'done')?.payload as
    DonePayload | undefined;
  if (done?.status === 'success') return undefined;
  for (const event of events) {
    if (event.type !== 'error') continue;
    const { code, message } = event.payload as ErrorPayload;
    if (
      (code && TRANSIENT_UPSTREAM_CODES.has(code.toUpperCase())) ||
      TRANSIENT_UPSTREAM_MARKERS.some((marker) => marker.test(message))
    ) {
      return `${code ?? 'error'}: ${message}`;
    }
  }
  return undefined;
}

async function probeWithRetries(): Promise<ProbeOutcome> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const outcome = await probe();
    const transient = transientFailure(outcome.events);
    if (!transient) return outcome;
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(
        `Codex skills acceptance failed after ${MAX_ATTEMPTS} consecutive transient upstream attempts: ${transient}`,
      );
    }
    process.stderr.write(
      `Codex skills acceptance attempt ${attempt} hit transient upstream error: ${transient}\n`,
    );
  }
  throw new Error('Codex skills acceptance exhausted its retry loop');
}

describe('Codex skills real-run acceptance (codex-77)', () => {
  acceptanceIt(
    'injects a run skill on a $cligent mention and removes its plugin cache entry',
    async () => {
      if (missing.length > 0) {
        throw new Error(
          `Missing Codex skills acceptance dependencies: ${missing.join(', ')}`,
        );
      }
      const { token, events, cache, heldDuringRun } = await probeWithRetries();
      const diagnostics = JSON.stringify(events, null, 2);
      expect(
        events.filter((event) => event.type === 'error'),
        diagnostics,
      ).toEqual([]);
      const done = events.at(-1);
      expect(done?.type, diagnostics).toBe('done');
      expect((done?.payload as DonePayload).status, diagnostics).toBe(
        'success',
      );
      const reply = [
        ...events
          .filter((event) => event.type === 'text')
          .map((event) => (event.payload as { content: string }).content),
        (done?.payload as DonePayload).result ?? '',
      ].join('\n');
      expect(reply, diagnostics).toContain(token);

      // The run held exactly one marketplace of its own, now gone.
      const held = heldDuringRun.filter((name) => OWN_MARKETPLACE.test(name));
      expect(
        held,
        `cache during the run: ${heldDuringRun.join(', ')}`,
      ).toHaveLength(1);
      expect(existsSync(join(cache, held[0]!))).toBe(false);
    },
    PROBE_TIMEOUT_MS,
  );
});
