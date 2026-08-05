// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// TADAPT-032: real-run verification of the OpenCode tool lifecycle
// (OPENCODE-016). The canned-event lifecycle tests encode the ToolPart wire
// schema this release was written against; only a live run can catch a later
// OpenCode release changing that shape the way the pre-1.18 normalization
// drifted (issue #33: per-snapshot duplicate empty tool_use events and no
// terminal tool_result). Filesystem state is the ground truth that a tool
// actually ran; the stream assertions are invariants, not exact sequences,
// because model behavior varies between runs.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Cligent } from '../index.js';
import type {
  CligentEvent,
  DonePayload,
  ErrorPayload,
  ToolResultPayload,
  ToolUsePayload,
} from '../index.js';
import { OpenCodeAdapter } from './opencode.js';

const OPENCODE_MODEL = process.env.OPENCODE_MODEL ?? 'moonshotai-cn/kimi-k2.5';
const PROBE_TIMEOUT_MS = 300_000;
const MAX_PROBE_ATTEMPTS = 3;

// Same explicit provider capacity/status language as the TADAPT-019 harness;
// anything else is a real failure and must not retry.
const TRANSIENT_UPSTREAM_MARKERS = [
  /\b(?:API Error:\s*Repeated|HTTP(?:[ _-]+status)?|status[ _-]+code)[ :=_-]*(?:429|503|529)\b/i,
  /\boverload(?:ed|ing)?\b/i,
  /\bover[ _-]?capacity\b/i,
  /\bservice[ _-]?unavailable\b/i,
  /\brate[ _-]?limit(?:ed|ing|[ _-]?exceeded)?\b/i,
  /\btoo[ _-]?many[ _-]?requests\b/i,
];

const missing = missingDeps();
const acceptanceIt = missing.length === 0 || process.env.CI ? it : it.skip;

interface LifecycleProbe {
  readonly events: readonly CligentEvent[];
  readonly fileContentMatches: boolean;
}

describe('OpenCode tool lifecycle real-run acceptance (TADAPT-032)', () => {
  acceptanceIt(
    'correlates one tool_use/tool_result pair per real tool call',
    async () => {
      if (missing.length > 0) {
        throw new Error(
          `Missing OpenCode lifecycle acceptance dependencies: ${missing.join(', ')}`,
        );
      }

      const probe = await probeWithRetry();
      expect(probe.fileContentMatches).toBe(true);

      const toolUses = probe.events.filter((e) => e.type === 'tool_use');
      const toolUseIds = toolUses.map(
        (e) => (e.payload as ToolUsePayload).toolUseId,
      );
      expect(toolUses.length).toBeGreaterThan(0);

      // Issue #33 symptom one: repeated tool_use snapshots per invocation.
      expect(new Set(toolUseIds).size).toBe(toolUseIds.length);

      // Issue #33 symptom two: every input empty.
      expect(
        toolUses.some(
          (e) =>
            Object.keys((e.payload as ToolUsePayload).input).length > 0,
        ),
      ).toBe(true);

      // Issue #33 symptom three: calls without observations. Every announced
      // call terminates exactly once, and no result floats free of a call.
      const resultIds = probe.events
        .filter((e) => e.type === 'tool_result')
        .map((e) => (e.payload as ToolResultPayload).toolUseId);
      expect([...resultIds].sort()).toEqual([...toolUseIds].sort());

      // Auto mode: nothing should have asked, nothing should be denied.
      expect(
        probe.events.filter((e) => e.type === 'permission_request'),
      ).toEqual([]);
      expect(
        probe.events.filter(
          (e) =>
            e.type === 'tool_result' &&
            (e.payload as ToolResultPayload).status === 'denied',
        ),
      ).toEqual([]);

      const done = probe.events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      const donePayload = done!.payload as DonePayload;
      expect(donePayload.status).toBe('success');
      expect(donePayload.usage.toolUses).toBe(toolUses.length);
    },
    PROBE_TIMEOUT_MS,
  );
});

async function probeWithRetry(): Promise<LifecycleProbe> {
  for (let attempt = 1; attempt <= MAX_PROBE_ATTEMPTS; attempt++) {
    const probe = await runLifecycleProbe();
    const transient = transientFailure(probe.events);
    if (!transient) return probe;
    if (attempt === MAX_PROBE_ATTEMPTS) {
      throw new Error(
        `opencode lifecycle acceptance failed after ${MAX_PROBE_ATTEMPTS} ` +
          `consecutive transient upstream attempts: ${transient}`,
      );
    }
    process.stderr.write(
      `opencode lifecycle acceptance attempt ${attempt} hit transient ` +
        `upstream error: ${transient}\n`,
    );
  }
  throw new Error(
    'opencode lifecycle acceptance exhausted its retry loop unexpectedly',
  );
}

async function runLifecycleProbe(): Promise<LifecycleProbe> {
  const cwd = mkdtempSync(join(process.cwd(), 'cligent-oclifecycle-'));

  try {
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    const fileName = `lifecycle_${randomUUID().slice(0, 8)}.txt`;
    const filePath = join(cwd, fileName);
    const cligent = new Cligent(new OpenCodeAdapter(), {
      permissions: { mode: 'auto' },
      cwd,
      model: OPENCODE_MODEL,
    });

    const events: CligentEvent[] = [];
    for await (const event of cligent.run(lifecyclePrompt(fileName))) {
      events.push(event);
    }

    const fileContentMatches =
      existsSync(filePath) && readFileSync(filePath, 'utf8') === 'lifecycle\n';
    return { events, fileContentMatches };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function lifecyclePrompt(fileName: string): string {
  const path = `'./${fileName}'`;
  return [
    'Run this exact shell command in the current working directory:',
    '```sh',
    `printf '%s\\n' lifecycle > ${path} && test "$(cat ${path})" = lifecycle`,
    '```',
    'Do not ask for permission or confirmation. After it succeeds, reply only "created".',
  ].join('\n');
}

// Mirrors the TADAPT-019 classifier: only a failed attempt can be
// transient — a successful done's `result` is model-authored text, where
// capacity language would be a false positive that loops a passing run
// into the attempt bound — and every failure must match a marker, so a
// real defect accompanied by an incidental 429 fails instead of retrying.
// A failed attempt retries even when the tool already created the file:
// each attempt uses a fresh throwaway directory.
function transientFailure(
  events: readonly CligentEvent[],
): string | undefined {
  if (witnessedInvariantViolation(events)) return undefined;

  const doneEvents = events.filter((e) => e.type === 'done');
  if (doneEvents.length !== 1) return undefined;
  const done = doneEvents[0]!.payload as DonePayload;
  if (done.status !== 'error') return undefined;

  const failureTexts = events
    .filter((e) => e.type === 'error')
    .map((e) => (e.payload as ErrorPayload).message ?? '');
  const doneText = done.result?.trim();
  if (doneText) failureTexts.push(doneText);
  if (failureTexts.length === 0) return undefined;

  let summary: string | undefined;
  for (const text of failureTexts) {
    if (!TRANSIENT_UPSTREAM_MARKERS.some((marker) => marker.test(text))) {
      return undefined;
    }
    summary ??= text;
  }
  return summary;
}

// TADAPT-019-style fatal precheck: an attempt that witnessed a lifecycle
// invariant violation never classifies as transient, because a 429/503
// does not cause permission asks, denials, duplicate tool_use ids, or
// results for unannounced calls — retrying such an attempt would let a
// later nondeterministic clean run mask the very regressions this gate
// exists to catch. Errored tool_results stay retryable, unlike in
// TADAPT-019: the invariants deliberately tolerate model-level command
// failures, and a truncated transient attempt may legitimately strand a
// tool_use without its result, so neither condition may be fatal here.
function witnessedInvariantViolation(
  events: readonly CligentEvent[],
): boolean {
  if (events.some((e) => e.type === 'permission_request')) return true;

  const useIds = events
    .filter((e) => e.type === 'tool_use')
    .map((e) => (e.payload as ToolUsePayload).toolUseId);
  if (new Set(useIds).size !== useIds.length) return true;

  const announced = new Set(useIds);
  return events
    .filter((e) => e.type === 'tool_result')
    .some((e) => {
      const payload = e.payload as ToolResultPayload;
      return payload.status === 'denied' || !announced.has(payload.toolUseId);
    });
}

function missingDeps(): string[] {
  const result: string[] = [];
  if (!process.env.MOONSHOT_API_KEY) result.push('MOONSHOT_API_KEY');
  try {
    execFileSync('opencode', ['--version'], { stdio: 'ignore', timeout: 5_000 });
  } catch {
    result.push('opencode CLI on PATH');
  }
  return result;
}
