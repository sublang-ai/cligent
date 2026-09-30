// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// claude-code-66: real-run verification that `subagentModel` binds the model
// a Claude subagent actually runs on. The mapping tests (claude-code-64) prove
// the environment pair and system prompt reach the SDK query; only a real run
// can show that Claude Code honours them. Two independent pieces of evidence:
//
// - every Agent call's own input carries the competing per-call `sonnet` the
//   prompt asks for, or no model, never a Haiku one — so Haiku frames cannot
//   be the main agent's own choice;
// - the raw SDK stream, tapped between the real SDK and the adapter, carries
//   each subagent frame (`parent_tool_use_id` set) with the model that served
//   it — decisive, because it cannot come from any main-loop or auxiliary call;
// - the unified terminal usage records, built from the SDK's `modelUsage`,
//   name a Haiku model — what a Cligent caller can observe on its own.
//
// The subagent's task uses the Read tool so that the SDK forwards at least one
// of its frames by default (without `forwardSubagentText` only tool_use and
// tool_result blocks from subagents are emitted). The permission policy denies
// writes, shell, and network, so the probe cannot change anything outside its
// throwaway directory while Read and Agent stay free.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cligent } from '../index.js';
import type {
  CligentEvent,
  DonePayload,
  ErrorPayload,
  ToolUsePayload,
} from '../index.js';
import { ClaudeCodeAdapter, loadClaudeAgentSdk } from './claude-code.js';
import { probeClaudeExecutable } from './claude-executable.js';

const SUBAGENT_MODEL = 'claude-haiku-4-5';
const MAIN_MODEL = 'claude-sonnet-5-5';
const WORD = 'PONG';
const PROBE_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;

const missing = process.env.ANTHROPIC_API_KEY ? [] : ['ANTHROPIC_API_KEY'];

// Acceptance files are excluded from the standard CI matrix; when the
// acceptance config does load this file, CI hard-fails on a missing key
// instead of silently skipping.
const acceptanceIt = (() => {
  if (missing.length === 0 || process.env.CI) return it;
  process.stderr.write(
    `Missing Claude subagent-model acceptance dependencies: ${missing.join(', ')}; skipping locally\n`,
  );
  return it.skip;
})();

// Retry only on explicit upstream-capacity failures so a genuine regression
// still surfaces instead of being retried.
const TRANSIENT_UPSTREAM_MARKERS = [
  /\bAPI Error: Repeated \d{3}/i,
  /\b529\b.*overloaded/i,
  /\b(?:overload(?:ed)?|over_capacity)\b/i,
  /\bservice[ _-]?unavailable\b/i,
  /\brate[ _-]?limit/i,
  /\btoo[ _-]?many[ _-]?requests\b/i,
];

type QueryRequest = Parameters<
  Awaited<ReturnType<typeof loadClaudeAgentSdk>>['query']
>[0];

interface RawAssistantFrame {
  type: 'assistant';
  parent_tool_use_id?: string | null;
  message?: { model?: unknown };
}

interface ProbeOutcome {
  readonly events: readonly CligentEvent[];
  readonly frames: readonly unknown[];
}

describe('Claude subagent-model real-run acceptance (claude-code-66)', () => {
  acceptanceIt(
    'runs every subagent on the chosen model',
    async () => {
      if (missing.length > 0) {
        throw new Error(
          `Missing Claude subagent-model acceptance dependencies: ${missing.join(', ')}`,
        );
      }

      let outcome: ProbeOutcome | undefined;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        outcome = await runProbe();
        const transient = transientFailure(outcome.events);
        if (!transient || attempt === MAX_ATTEMPTS) break;
        process.stderr.write(
          `Claude subagent-model acceptance attempt ${attempt} hit a ` +
            `transient upstream error: ${transient}\n`,
        );
      }
      const { events, frames } = outcome!;

      const done = events.find((event) => event.type === 'done')?.payload as
        DonePayload | undefined;
      const errors = events
        .filter((event) => event.type === 'error')
        .map((event) => (event.payload as ErrorPayload).message);
      expect(done?.status, `errors: ${errors.join(' | ')}`).toBe('success');
      expect(done?.result ?? '').toContain(WORD);

      const agentCalls = events.filter(
        (event) =>
          event.type === 'tool_use' &&
          ['Agent', 'Task'].includes(
            (event.payload as ToolUsePayload).toolName,
          ),
      );
      expect(
        agentCalls.length,
        'the main agent started no subagent',
      ).toBeGreaterThan(0);

      // The main agent was asked for a competing per-call `sonnet`. Each call
      // may carry it (then `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrode it) or
      // no model at all (the runtime withheld the choice) — never a Haiku one,
      // so a Haiku frame below can come only from the environment pair, not
      // from the main agent's own choice.
      const perCallModels = agentCalls.map((event) => {
        const input = (event.payload as ToolUsePayload).input as
          { model?: unknown } | undefined;
        return input?.model;
      });
      for (const model of perCallModels) {
        expect(
          model === undefined || model === 'sonnet',
          `per-call subagent model: ${String(model)}`,
        ).toBe(true);
      }
      process.stderr.write(
        `Claude subagent-model acceptance: per-call models ${JSON.stringify(perCallModels)}\n`,
      );

      // Decisive: frames produced inside a subagent name the model that served
      // them, and every one of them must be Haiku.
      const subagentModels = frames
        .filter(isSubagentAssistantFrame)
        .map((frame) => String(frame.message?.model));
      expect(
        subagentModels.length,
        'the SDK forwarded no subagent frame',
      ).toBeGreaterThan(0);
      for (const model of subagentModels) {
        expect(model).toMatch(/haiku/i);
      }

      // Caller-observable: the unified usage records carry the same model.
      const recordModels = (done?.usage.tokens?.records ?? []).map(
        (record) => record.model ?? '',
      );
      expect(
        recordModels.some((model) => /haiku/i.test(model)),
        `usage records: ${recordModels.join(', ')}`,
      ).toBe(true);
    },
    PROBE_TIMEOUT_MS * MAX_ATTEMPTS,
  );
});

async function runProbe(): Promise<ProbeOutcome> {
  const cwd = mkdtempSync(join(tmpdir(), 'cligent-subagent-model-'));
  const wordFile = join(cwd, 'word.txt');
  writeFileSync(wordFile, `${WORD}\n`);
  const frames: unknown[] = [];
  const events: CligentEvent[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const cligent = new Cligent(tappedAdapter(frames), {
      cwd,
      model: MAIN_MODEL,
      subagentModel: SUBAGENT_MODEL,
      permissions: {
        fileWrite: 'deny',
        shellExecute: 'deny',
        networkAccess: 'deny',
      },
    });
    const prompt = [
      'Start exactly one subagent with the Agent tool, passing subagent_type "general-purpose" and model "sonnet".',
      `Its whole task: use the Read tool to read the file ${wordFile} and reply with only the single word it contains.`,
      'When the subagent returns, reply with exactly the word it returned and nothing else.',
    ].join(' ');
    for await (const event of cligent.run(prompt, {
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }
  } finally {
    clearTimeout(timer);
    rmSync(cwd, { recursive: true, force: true });
  }
  return { events, frames };
}

// A pass-through tap: the real SDK serves the query and the adapter sees every
// frame unchanged; the test keeps a copy of each for the raw-stream evidence.
function tappedAdapter(frames: unknown[]): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    probeExecutable: () => probeClaudeExecutable(),
    loadSdk: async () => {
      const sdk = await loadClaudeAgentSdk();
      return {
        query(request: QueryRequest): AsyncIterable<unknown> {
          const stream = sdk.query(request);
          return {
            async *[Symbol.asyncIterator]() {
              for await (const frame of stream) {
                frames.push(frame);
                yield frame;
              }
            },
          };
        },
      };
    },
  });
}

function isSubagentAssistantFrame(frame: unknown): frame is RawAssistantFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const candidate = frame as RawAssistantFrame;
  return (
    candidate.type === 'assistant' &&
    typeof candidate.parent_tool_use_id === 'string' &&
    candidate.parent_tool_use_id.length > 0
  );
}

function transientFailure(events: readonly CligentEvent[]): string | undefined {
  const done = events.find((event) => event.type === 'done')?.payload as
    DonePayload | undefined;
  if (done?.status === 'success') return undefined;
  const texts = [
    ...events
      .filter((event) => event.type === 'error')
      .map((event) => (event.payload as ErrorPayload).message),
    done?.result ?? '',
  ];
  return texts.find((text) =>
    TRANSIENT_UPSTREAM_MARKERS.some((marker) => marker.test(text)),
  );
}
