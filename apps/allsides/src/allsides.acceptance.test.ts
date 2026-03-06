// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Allow nested Claude Code sessions (the SDK checks process.env.CLAUDECODE
// before spawning, so the adapter's per-child env cleanup isn't enough).
delete process.env.CLAUDECODE;

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveAgents, type ResolvedAgent } from './agents.js';
import { formatEvent } from './session.js';
import type {
  CligentEvent,
  DonePayload,
  ToolUsePayload,
} from '@sublang/cligent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENTS = ['claude', 'codex', 'gemini', 'opencode'] as const;

/**
 * Agents the CI workflow provisions (SDKs + binaries). If any of these are
 * missing in a CI run, beforeAll fails the entire suite loudly rather than
 * letting tests pass vacuously.
 */
const CI_EXPECTED_AGENTS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'gemini',
]);

/** Strip ANSI escape sequences (ESC[ or CSI) and collapse newlines. */
function normalizeLog(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x1b\x9b]\[[0-9;]*[a-zA-Z]/g, '')  // strip ESC[…x / CSI…x
          .replace(/\r?\n/g, ' ');                         // newlines → spaces
}

/** Assert text contains needle, ignoring ANSI codes and whitespace.
 *  Adapters may line-wrap output with spaces/ANSI codes that split UUIDs.
 *  Strips ANSI sequences first (so param bytes like '7m' don't leak into
 *  content), then removes remaining non-content characters. */
function assertContainsText(text: string, needle: string, msg?: string) {
  // eslint-disable-next-line no-control-regex
  const strip = (s: string) => s.replace(/[\x1b\x9b]\[[0-9;]*[a-zA-Z]/g, '')
                                 .replace(/[^a-zA-Z0-9._-]/g, '');
  expect(strip(text), msg).toContain(needle);
}

interface RunResult {
  events: CligentEvent[];
  log: string;
  /** Combined output: formatted log + done.payload.result (some adapters
   *  only surface text content in the done payload, not via text events). */
  output: string;
}

/** Run a prompt against an agent, collecting all events and the formatted log. */
async function collectEvents(
  agent: ResolvedAgent,
  prompt: string,
  options: { cwd: string; abortSignal: AbortSignal },
): Promise<RunResult> {
  const events: CligentEvent[] = [];
  let log = `boss> ${prompt}\n\n`;

  const permissions = permissionsFor(agent.name);

  for await (const event of agent.cligent.run(prompt, {
    cwd: options.cwd,
    permissions,
    abortSignal: options.abortSignal,
  })) {
    events.push(event);
    const formatted = formatEvent(event);
    if (formatted !== null) {
      log += formatted;
    }
  }

  // Build combined output: log text + done result (for adapters that only
  // surface response content in the done payload, like Claude Code).
  let output = log;
  const doneEvent = events.find((e) => e.type === 'done');
  if (doneEvent) {
    const result = (doneEvent.payload as DonePayload).result;
    if (result) {
      output += `\n${result}`;
    }
  }

  return { events, log: normalizeLog(log), output };
}

function permissionsFor(agentName: string) {
  return agentName === 'codex'
    ? { shellExecute: 'allow' as const, fileWrite: 'allow' as const, networkAccess: 'allow' as const }
    : { shellExecute: 'allow' as const, fileWrite: 'deny' as const, networkAccess: 'deny' as const };
}

function findDoneEvent(events: CligentEvent[]): CligentEvent & { type: 'done'; payload: DonePayload } {
  const done = events.find((e) => e.type === 'done');
  if (!done) throw new Error('No done event found');
  return done as CligentEvent & { type: 'done'; payload: DonePayload };
}

function findToolUseEvents(events: CligentEvent[]): (CligentEvent & { type: 'tool_use'; payload: ToolUsePayload })[] {
  return events.filter((e) => e.type === 'tool_use') as (CligentEvent & { type: 'tool_use'; payload: ToolUsePayload })[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AllSides acceptance', () => {
  let workDir: string;
  let sentinelName: string;
  let sentinelContent: string;
  /** All four agents (forced) — used for abort tests that don't need API. */
  let agents: ResolvedAgent[];
  /** Names of agents whose isAvailable() returned true. */
  let availableAgentNames: Set<string>;

  beforeAll(async () => {
    // Create work dir inside the project tree so that agents with project-
    // scoped security policies (e.g. Claude Code) can access the files.
    const testRoot = join(process.cwd(), '.test-accept');
    mkdirSync(testRoot, { recursive: true });
    workDir = mkdtempSync(join(testRoot, 'run-'));

    // Create log files, session marker, and sentinel with known content
    for (const name of AGENTS) {
      writeFileSync(join(workDir, `${name}.log`), '');
    }
    writeFileSync(join(workDir, '.allsides-session'), '');

    sentinelName = `SENTINEL_${randomUUID()}.txt`;
    sentinelContent = `CANARY_${randomUUID()}`;
    writeFileSync(join(workDir, sentinelName), sentinelContent);

    // Detect which agents are actually available (SDK + binary installed)
    const detected = await resolveAgents(undefined, workDir);
    availableAgentNames = new Set(detected.map((a) => a.name));
    console.log(`[setup] Available agents: ${[...availableAgentNames].join(', ')}`);

    // In CI, assert the provisioned agent set is present. If a provisioned
    // agent disappears (e.g. SDK removed, binary missing), fail loudly.
    if (process.env.CI) {
      for (const expected of CI_EXPECTED_AGENTS) {
        if (!availableAgentNames.has(expected)) {
          throw new Error(
            `CI requires agent "${expected}" but it was not detected. ` +
              `Available: ${[...availableAgentNames].join(', ')}`,
          );
        }
      }
    }

    // Resolve all four agents (needed for abort tests which don't hit APIs)
    agents = await resolveAgents(
      AGENTS.map((name) => ({ name })),
      workDir,
    );
  });

  afterAll(() => {
    try {
      rmSync(join(process.cwd(), '.test-accept'), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // -----------------------------------------------------------------------
  // Group 1: sentinel file listing (existing)
  // -----------------------------------------------------------------------

  describe('sentinel file listing', () => {
    for (const agentName of AGENTS) {
      it(`${agentName} lists sentinel file`, async () => {
        if (!availableAgentNames.has(agentName)) {
          console.warn(`[skip] ${agentName} not available in this environment`);
          return;
        }
        const agent = agents.find((a) => a.name === agentName)!;
        const logPath = join(workDir, `${agentName}.log`);

        const ac = new AbortController();
        const timeout = setTimeout(() => ac.abort(), 110_000);

        try {
          const { log, output } = await collectEvents(
            agent,
            `List the files in the directory ${workDir}`,
            { cwd: workDir, abortSignal: ac.signal },
          );

          // Write log for debugging
          writeFileSync(logPath, log);

          // Assert boss echo present
          expect(log).toContain('boss>');

          // Assert sentinel filename appears in output (log or done result)
          assertContainsText(output, sentinelName);

          // Assert done line
          expect(log).toMatch(/\[success \|/);
        } finally {
          clearTimeout(timeout);
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  // Group 2: tool use and event lifecycle
  // -----------------------------------------------------------------------

  describe('tool use and event lifecycle', () => {
    const results = new Map<string, RunResult>();

    beforeAll(async () => {
      // Run available agents sequentially, caching results
      for (const agentName of AGENTS) {
        if (!availableAgentNames.has(agentName)) {
          console.warn(`[skip] ${agentName} not available — skipping tool-use collection`);
          continue;
        }
        const agent = agents.find((a) => a.name === agentName)!;
        const ac = new AbortController();
        const timeout = setTimeout(() => ac.abort(), 110_000);

        try {
          const result = await collectEvents(
            agent,
            `Read the file ${join(workDir, sentinelName)} and state its contents`,
            { cwd: workDir, abortSignal: ac.signal },
          );
          results.set(agentName, result);

          // Write log for debugging
          writeFileSync(join(workDir, `${agentName}-tooluse.log`), result.log);
        } finally {
          clearTimeout(timeout);
        }
      }
    });

    for (const agentName of AGENTS) {
      describe(agentName, () => {
        it('produces valid event lifecycle', () => {
          if (!availableAgentNames.has(agentName)) {
          console.warn(`[skip] ${agentName} not available in this environment`);
          return;
        }
          const { events } = results.get(agentName)!;

          // Has activity events before done (text, text_delta, tool_use, init, or error)
          const activityEvents = events.filter((e) =>
            e.type === 'text' || e.type === 'text_delta' || e.type === 'tool_use' || e.type === 'init' || e.type === 'error',
          );
          expect(activityEvents.length).toBeGreaterThan(0);

          // Exactly 1 done event, and it's the last event
          const doneEvents = events.filter((e) => e.type === 'done');
          expect(doneEvents).toHaveLength(1);
          expect(events[events.length - 1]!.type).toBe('done');

          // Status is success
          const done = findDoneEvent(events);
          expect(done.payload.status).toBe('success');

          // Non-negative token counts
          expect(done.payload.usage.inputTokens).toBeGreaterThanOrEqual(0);
          expect(done.payload.usage.outputTokens).toBeGreaterThanOrEqual(0);
        });

        it('emits no unknown_tool names in tool_use events', () => {
          if (!availableAgentNames.has(agentName)) {
          console.warn(`[skip] ${agentName} not available in this environment`);
          return;
        }
          const { events } = results.get(agentName)!;
          const toolEvents = findToolUseEvents(events);

          // Some adapters (e.g. Claude Code SDK) bundle tool invocations
          // inside the result message and do not emit discrete tool_use
          // events. When tool_use events ARE present, none may be
          // 'unknown_tool' — which indicates an adapter parsing failure.
          for (const te of toolEvents) {
            expect(
              te.payload.toolName,
              `${agentName} emitted unknown_tool — raw event: ${JSON.stringify(te)}`,
            ).not.toBe('unknown_tool');
          }
        });

        it('reads file and returns sentinel content', () => {
          if (!availableAgentNames.has(agentName)) {
          console.warn(`[skip] ${agentName} not available in this environment`);
          return;
        }
          const { output } = results.get(agentName)!;
          assertContainsText(output, sentinelContent);
        });

        it('captures resumeToken after successful run', () => {
          if (!availableAgentNames.has(agentName)) {
          console.warn(`[skip] ${agentName} not available in this environment`);
          return;
        }
          const { events } = results.get(agentName)!;
          const done = findDoneEvent(events);
          const agent = agents.find((a) => a.name === agentName)!;

          if (done.payload.resumeToken !== undefined) {
            expect(done.payload.resumeToken).toBeTruthy();
            expect(typeof done.payload.resumeToken).toBe('string');
            expect(agent.cligent.resumeToken).toBe(done.payload.resumeToken);
          }
        });
      });
    }
  });

  // -----------------------------------------------------------------------
  // Group 3: auto-detection (zero API cost)
  // -----------------------------------------------------------------------

  describe('auto-detection', () => {
    it('detects at least one available agent', async () => {
      const detected = await resolveAgents(undefined, workDir);

      expect(detected.length).toBeGreaterThan(0);

      const knownNames = new Set(AGENTS);
      for (const agent of detected) {
        expect(knownNames.has(agent.name as typeof AGENTS[number])).toBe(true);
      }

      // Log which agents were detected for CI visibility
      const names = detected.map((a) => a.name).join(', ');
      console.log(`[auto-detection] Available agents: ${names}`);
    });
  });

  // -----------------------------------------------------------------------
  // Group 4: abort handling (near-zero API cost)
  // -----------------------------------------------------------------------

  describe('abort handling', { timeout: 30_000 }, () => {
    for (const agentName of AGENTS) {
      it(`${agentName} yields interrupted done on pre-abort`, async () => {
        const agent = agents.find((a) => a.name === agentName)!;

        // Pre-abort: signal is already aborted before run()
        const ac = new AbortController();
        ac.abort();

        const { events } = await collectEvents(
          agent,
          'This prompt should never reach the API',
          { cwd: workDir, abortSignal: ac.signal },
        );

        // Should get a done event with interrupted status
        const done = findDoneEvent(events);
        expect(done.payload.status).toBe('interrupted');
      });
    }
  });
});
