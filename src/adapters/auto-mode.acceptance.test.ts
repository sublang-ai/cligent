// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// TADAPT-019: real-run verification that `permissions: { mode: 'auto' }`
// reaches each adapter's SDK and actually suppresses approval prompts for a
// file write + delete. The mapping-only tests (TADAPT-004/005) prove the knob
// values; they never spawn the SDK, so they cannot catch an auto-mode knob
// that the SDK silently rejects or that still gates the write/delete behind a
// prompt. Filesystem state is the ground-truth check: adapters normalize file
// edits differently (Codex -> `codex:file_change`, OpenCode -> `opencode:file_part`,
// others -> `tool_use`), so a `tool_use`-count assertion would be adapter-specific.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cligent } from '../index.js';
import type {
  AgentAdapter,
  CligentEvent,
  DonePayload,
  ErrorPayload,
  ToolResultPayload,
} from '../index.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import { OpenCodeAdapter } from './opencode.js';

const GEMINI_MODEL = process.env.GEMINI_MODEL;
const OPENCODE_MODEL = process.env.OPENCODE_MODEL ?? 'moonshotai-cn/kimi-k2.5';

const PROBE_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 2;

// Mirrors fanout.acceptance.test.ts: retry only on upstream-capacity failures
// so a genuine auto-mode regression still surfaces instead of being retried away.
const TRANSIENT_UPSTREAM_MARKERS = [
  /\bAPI Error: Repeated \d{3}/i,
  /529 Overloaded/i,
  /\b(?:overload(?:ed)?|over_capacity)\b/i,
  /\bservice unavailable\b/i,
  /\brate.?limit/i,
];

// Codex executes shell commands inside an OS sandbox (bubblewrap on Linux);
// some CI runners cannot start it. A sandbox that fails to initialize is an
// environment limitation, not an auto-mode regression — the codex leg skips.
// Markers are narrowed to the actual error-message shape so an unrelated
// mention of "bwrap" in model text cannot mask a real failure.
const SANDBOX_INIT_MARKERS = [/bwrap:\s*\S+:\s*Failed/i, /RTM_NEWADDR/];

// Codex resolves its native sandbox binary via @openai/codex's bin launcher,
// which selects the right platform package and prepends its codex-path dirs;
// invoking that launcher's credential-free `sandbox` subcommand preflights
// the exact same sandbox the SDK will use, rather than a different bwrap from
// the parent process's PATH. Only failures whose output matches
// SANDBOX_INIT_MARKERS classify as `sandbox-init` (skip per the TADAPT-019
// spec exception); any other preflight failure classifies as `unknown` and
// fails the codex test, so a broken codex install or drifted CLI surface
// cannot silently hide TADAPT-019.
const codexCliPath = resolveCodexCliPath();
const codexSandboxPreflight = preflightCodexSandbox();

describe('adapter auto-mode real-run acceptance (TADAPT-019)', () => {
  const claudeMissing = missingDeps(['ANTHROPIC_API_KEY']);
  gatedIt(claudeMissing)(
    'claude auto mode auto-approves a temp-file write + delete',
    async () => {
      assertReady('claude', claudeMissing);
      const outcome = await probeWithRetry(() => new ClaudeCodeAdapter(), undefined);
      expectAutoMode('claude', outcome);
    },
    PROBE_TIMEOUT_MS,
  );

  const codexMissing = missingDeps(['CODEX_API_KEY']);
  gatedIt(codexMissing)(
    'codex auto mode auto-approves a temp-file write + delete',
    async (ctx) => {
      assertReady('codex', codexMissing);
      if (codexSandboxPreflight.kind === 'sandbox-init') {
        process.stderr.write(
          `codex auto-mode acceptance: skipping — Codex's workspace sandbox ` +
            `cannot initialize on this host: ${codexSandboxPreflight.summary}\n`,
        );
        ctx.skip();
      }
      if (codexSandboxPreflight.kind === 'unknown') {
        throw new Error(
          `codex auto-mode acceptance: refusing to skip — Codex sandbox ` +
            `preflight failed for a non-sandbox-init reason: ` +
            codexSandboxPreflight.summary,
        );
      }
      const outcome = await probeWithRetry(() => new CodexAdapter(), undefined);
      // Backstop: catch sandbox-init failures the preflight didn't (e.g. when
      // codex's bundled helper is used because `bwrap` is not on PATH).
      const sandboxFailure = sandboxInitFailure(outcome);
      if (sandboxFailure) {
        process.stderr.write(
          `codex auto-mode acceptance: skipping — sandbox failure surfaced ` +
            `in probe events: ${sandboxFailure}\n`,
        );
        ctx.skip();
      }
      expectAutoMode('codex', outcome);
    },
    PROBE_TIMEOUT_MS,
  );

  const geminiMissing = missingDeps(['GEMINI_API_KEY'], ['gemini']);
  gatedIt(geminiMissing)(
    'gemini auto mode auto-approves a temp-file write + delete',
    async () => {
      assertReady('gemini', geminiMissing);
      const outcome = await probeWithRetry(() => new GeminiAdapter(), GEMINI_MODEL);
      expectAutoMode('gemini', outcome);
    },
    PROBE_TIMEOUT_MS,
  );

  const opencodeMissing = missingDeps(['MOONSHOT_API_KEY'], ['opencode']);
  gatedIt(opencodeMissing)(
    'opencode auto mode auto-approves a temp-file write + delete',
    async () => {
      assertReady('opencode', opencodeMissing);
      const outcome = await probeWithRetry(() => new OpenCodeAdapter(), OPENCODE_MODEL);
      expectAutoMode('opencode', outcome);
    },
    PROBE_TIMEOUT_MS,
  );
});

interface PhaseResult {
  readonly events: readonly CligentEvent[];
}

interface ProbeOutcome {
  readonly create: PhaseResult;
  readonly delete: PhaseResult;
  readonly fileCreated: boolean;
  readonly fileDeleted: boolean;
}

async function runAutoModeProbe(
  makeAdapter: () => AgentAdapter,
  model: string | undefined,
): Promise<ProbeOutcome> {
  // Use a repo-local workspace so Codex's `:workspace` profile, on Linux hosts
  // where its sandbox can initialize, is not subject to /tmp-related quirks
  // (`sandbox_workspace_write.exclude_slash_tmp` exists for a reason).
  const cwd = mkdtempSync(join(process.cwd(), 'cligent-automode-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  const fileName = `scratch_${randomUUID().slice(0, 8)}.txt`;
  const filePath = join(cwd, fileName);
  const cligent = new Cligent(makeAdapter(), {
    permissions: { mode: 'auto' },
    cwd,
    ...(model ? { model } : {}),
  });

  try {
    const create = await collect(cligent, createPrompt(fileName));
    const fileCreated = existsSync(filePath);

    const del = await collect(cligent, deletePrompt(fileName));
    const fileDeleted = !existsSync(filePath);

    return { create, delete: del, fileCreated, fileDeleted };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function createPrompt(fileName: string): string {
  const path = shellQuote(`./${fileName}`);
  return (
    `Run this exact shell command in the current working directory: ` +
    `printf '%s\\n' scratch > ${path} && test -f ${path}. ` +
    'Do not ask for permission or confirmation. After it succeeds, reply only "created".'
  );
}

function deletePrompt(fileName: string): string {
  const path = shellQuote(`./${fileName}`);
  return (
    `Run this exact shell command in the current working directory: ` +
    `rm -f ${path} && test ! -e ${path}. ` +
    'Do not ask for permission or confirmation. After it succeeds, reply only "deleted".'
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function collect(cligent: Cligent, prompt: string): Promise<PhaseResult> {
  const events: CligentEvent[] = [];
  for await (const event of cligent.run(prompt)) {
    events.push(event);
  }
  return { events };
}

async function probeWithRetry(
  makeAdapter: () => AgentAdapter,
  model: string | undefined,
): Promise<ProbeOutcome> {
  let outcome: ProbeOutcome | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    outcome = await runAutoModeProbe(makeAdapter, model);
    const transient =
      transientFailure(outcome.create.events) ??
      transientFailure(outcome.delete.events);
    if (!transient || attempt === MAX_ATTEMPTS) break;
    process.stderr.write(
      `auto-mode acceptance attempt ${attempt} hit transient upstream error: ${transient}\n`,
    );
  }
  return outcome!;
}

function transientFailure(events: readonly CligentEvent[]): string | undefined {
  for (const event of events) {
    let text = '';
    if (event.type === 'error') {
      text = (event.payload as ErrorPayload).message;
    } else if (
      event.type === 'done' &&
      (event.payload as DonePayload).status === 'error'
    ) {
      text = (event.payload as DonePayload).result ?? '';
    }
    if (text && TRANSIENT_UPSTREAM_MARKERS.some((pattern) => pattern.test(text))) {
      return text;
    }
  }
  return undefined;
}

function resolveCodexCliPath(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
  } catch {
    return undefined;
  }
}

type CodexSandboxPreflight =
  | { kind: 'ok' }
  | { kind: 'sandbox-init'; summary: string }
  | { kind: 'unknown'; summary: string };

// Credential-free preflight via Codex's own sandbox subcommand. Classifies
// the outcome so only OS-sandbox-init failures (matching SANDBOX_INIT_MARKERS)
// produce a skip; non-Linux hosts and an unresolvable codex CLI bin classify
// as `ok` (let the test run; the post-flight backstop catches anything the
// preflight missed). Any other preflight failure — CLI surface drift, missing
// platform helper, config parse error, launcher panic, timeout — classifies
// as `unknown`, so it surfaces as a test failure instead of a silent skip.
function preflightCodexSandbox(): CodexSandboxPreflight {
  if (process.platform !== 'linux') return { kind: 'ok' };
  if (!codexCliPath) return { kind: 'ok' };
  try {
    execFileSync(
      process.execPath,
      [
        codexCliPath,
        'sandbox',
        'linux',
        '--permissions-profile',
        ':workspace',
        '-C',
        process.cwd(),
        'true',
      ],
      { stdio: 'pipe', timeout: 10_000 },
    );
    return { kind: 'ok' };
  } catch (error) {
    const summary = summarizeExecFailure(error);
    if (SANDBOX_INIT_MARKERS.some((marker) => marker.test(summary))) {
      return { kind: 'sandbox-init', summary };
    }
    return { kind: 'unknown', summary };
  }
}

function summarizeExecFailure(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string } | null)?.stderr;
  const stderrText = Buffer.isBuffer(stderr)
    ? stderr.toString('utf8')
    : (stderr ?? '');
  const message = (error as { message?: string } | null)?.message ?? '';
  return (stderrText || message || String(error))
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

// A non-functional Codex OS sandbox (e.g. bubblewrap failing to set up its
// network namespace on a restricted CI runner) surfaces in the event stream
// rather than as an `error` event, so it is detected from the probe outcome.
function sandboxInitFailure(outcome: ProbeOutcome): string | undefined {
  for (const phase of [outcome.create, outcome.delete]) {
    for (const event of phase.events) {
      const text = JSON.stringify(event.payload);
      if (SANDBOX_INIT_MARKERS.some((marker) => marker.test(text))) {
        return text.replace(/\s+/g, ' ').slice(0, 300);
      }
    }
  }
  return undefined;
}

function expectAutoMode(label: string, outcome: ProbeOutcome): void {
  expectPhaseUnblocked(`${label} create`, outcome.create.events);
  expectPhaseUnblocked(`${label} delete`, outcome.delete.events);
  expect(
    outcome.fileCreated,
    `${label}: file was not on disk after the create run — auto mode did not let the write through\n${formatEvents(outcome.create.events)}`,
  ).toBe(true);
  expect(
    outcome.fileDeleted,
    `${label}: file survived the delete run — auto mode did not let the delete through\n${formatEvents(outcome.delete.events)}`,
  ).toBe(true);
}

function formatEvents(events: readonly CligentEvent[]): string {
  return JSON.stringify(
    events.map((event) => ({
      type: event.type,
      payload: event.payload,
    })),
    null,
    2,
  );
}

function expectPhaseUnblocked(
  label: string,
  events: readonly CligentEvent[],
): void {
  const permissionRequests = events.filter(
    (event) => event.type === 'permission_request',
  );
  const deniedTools = events
    .filter((event) => event.type === 'tool_result')
    .map((event) => event.payload as ToolResultPayload)
    .filter((payload) => payload.status === 'denied');
  const errorMessages = events
    .filter((event) => event.type === 'error')
    .map((event) => (event.payload as ErrorPayload).message);
  const done = events.find((event) => event.type === 'done');
  const doneStatus = done ? (done.payload as DonePayload).status : undefined;

  expect(
    permissionRequests,
    `${label}: emitted permission_request — auto mode did not auto-approve`,
  ).toEqual([]);
  expect(
    deniedTools.map((payload) => payload.toolName),
    `${label}: produced denied tool results`,
  ).toEqual([]);
  expect(errorMessages, `${label}: emitted error events`).toEqual([]);
  expect(doneStatus, `${label}: terminal done status`).toBe('success');
}

function missingDeps(
  envKeys: readonly string[],
  commands: readonly string[] = [],
): string[] {
  const missing: string[] = [];
  for (const key of envKeys) {
    if (!process.env[key]) missing.push(key);
  }
  for (const command of commands) {
    try {
      execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 5_000 });
    } catch {
      missing.push(`${command} CLI on PATH`);
    }
  }
  return missing;
}

// Acceptance files are excluded from the standard CI matrix; when the
// acceptance config does load this file, CI hard-fails on a missing dependency
// instead of silently skipping. Locally, a missing dependency skips only the
// affected adapter.
function gatedIt(missing: readonly string[]): typeof it | typeof it.skip {
  return missing.length === 0 || process.env.CI ? it : it.skip;
}

function assertReady(adapter: string, missing: readonly string[]): void {
  if (missing.length > 0) {
    throw new Error(
      `Missing ${adapter} auto-mode acceptance dependencies: ${missing.join(', ')}`,
    );
  }
}
