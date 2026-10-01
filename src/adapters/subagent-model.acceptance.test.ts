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
//
// claude-code-68 and claude-code-69 reuse this harness for the registered
// subagent definitions of DR-029: which subagent type the main agent's Agent
// call names, and — through a PreToolUse hook the harness adds to the tapped
// query — the effort each subagent runs at when a pinned effort replaces the
// built-in general-purpose by name and leaves Explore and Plan their own.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cligent } from '../index.js';
import type {
  ClaudeEffort,
  ClaudeSubagentEffort,
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

interface HookObservation {
  readonly agentType: string | undefined;
  readonly toolName: string | undefined;
  readonly effort: string | undefined;
}

interface ProbeOutcome {
  readonly events: readonly CligentEvent[];
  readonly frames: readonly unknown[];
  readonly hooks: readonly HookObservation[];
}

interface ProbeSettings {
  readonly subagentModel: string;
  readonly subagentEffort?: ClaudeSubagentEffort;
  readonly effort?: ClaudeEffort;
  readonly prompt: (wordFile: string) => string;
  readonly observeHooks?: boolean;
}

const DELEGATE_CHOICES = /^delegate-(?:low|medium|high|xhigh|max)$/;

const ONE_NEUTRAL_SUBAGENT = (wordFile: string): string =>
  [
    'Start exactly one subagent with the Agent tool.',
    `Its whole task: use the Read tool to read the file ${wordFile} and reply with only the single word it contains.`,
    'When the subagent returns, reply with exactly the word it returned and nothing else.',
  ].join(' ');

describe('Claude subagent-model real-run acceptance (claude-code-66)', () => {
  acceptanceIt(
    'runs every subagent on the chosen model',
    async () => {
      if (missing.length > 0) {
        throw new Error(
          `Missing Claude subagent-model acceptance dependencies: ${missing.join(', ')}`,
        );
      }

      const { events, frames } = await runWithRetries({
        subagentModel: SUBAGENT_MODEL,
        prompt: (wordFile) =>
          [
            'Start exactly one subagent with the Agent tool, passing subagent_type "general-purpose" and model "sonnet".',
            `Its whole task: use the Read tool to read the file ${wordFile} and reply with only the single word it contains.`,
            'When the subagent returns, reply with exactly the word it returned and nothing else.',
          ].join(' '),
      });

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

describe('Claude subagent definitions real-run acceptance (claude-code-68)', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly subagentModel: string;
    readonly subagentEffort?: ClaudeSubagentEffort;
    readonly type: RegExp;
    readonly frameModel: RegExp;
    readonly effortNamedByType?: boolean;
    readonly builtInsOnlyByName?: boolean;
  }> = [
    {
      // With a pinned effort `general-purpose` is replaced by name and
      // matches `delegate`, so a call naming either, or naming no type, which
      // runs general-purpose, runs pinned. Explore and Plan keep their own
      // definitions; the agent reaches them only by naming them.
      name: 'a pinned model and effort run through a pinned definition',
      subagentModel: SUBAGENT_MODEL,
      subagentEffort: 'low',
      type: /^(?:delegate|general-purpose|Explore|Plan)$/,
      frameModel: /haiku/i,
      builtInsOnlyByName: true,
    },
    {
      name: 'a pinned model leaves the effort to a delegate-<effort> choice',
      subagentModel: SUBAGENT_MODEL,
      type: DELEGATE_CHOICES,
      frameModel: /haiku/i,
    },
    {
      name: "inherit keeps subagents on the agent's own model",
      subagentModel: 'inherit',
      type: DELEGATE_CHOICES,
      frameModel: /sonnet/i,
      // Sonnet reports the effort it runs at; Haiku reports none.
      effortNamedByType: true,
    },
  ];

  for (const testCase of cases) {
    acceptanceIt(
      testCase.name,
      async () => {
        requireDependencies();
        const outcome = await runWithRetries({
          subagentModel: testCase.subagentModel,
          ...(testCase.subagentEffort !== undefined
            ? { subagentEffort: testCase.subagentEffort }
            : {}),
          prompt: ONE_NEUTRAL_SUBAGENT,
          observeHooks: true,
        });
        expectSuccessfulWord(outcome.events);

        // The Agent call's input may name a type or omit it; the hook reports
        // the type each subagent actually ran as.
        const named = agentCallInputs(outcome.events).map(
          (input) => input.subagent_type ?? null,
        );
        const ran = outcome.hooks.filter(
          (hook) => hook.agentType !== undefined,
        );
        const models = subagentFrameModels(outcome.frames);
        process.stderr.write(
          `Claude subagent definitions (${testCase.name}): named types ` +
            `${JSON.stringify(named)}, subagent tool calls ` +
            `${JSON.stringify(ran)}, subagent models ${JSON.stringify(models)}\n`,
        );
        expect(
          named.length,
          'the main agent started no subagent',
        ).toBeGreaterThan(0);
        expect(ran.length, 'no subagent tool call observed').toBeGreaterThan(0);
        for (const call of ran) {
          expect(call.agentType).toMatch(testCase.type);
          if (testCase.effortNamedByType) {
            expect(call.effort).toBe(call.agentType?.replace('delegate-', ''));
          }
          if (
            testCase.builtInsOnlyByName &&
            (call.agentType === 'Explore' || call.agentType === 'Plan')
          ) {
            expect(named, `${call.agentType} ran unnamed`).toContain(
              call.agentType,
            );
          }
        }
        if (testCase.builtInsOnlyByName && named.includes(null)) {
          // A call naming no type lands on the pinned general-purpose.
          expect(ran.map((call) => call.agentType)).toContain(
            'general-purpose',
          );
        }
        expect(
          models.length,
          'the SDK forwarded no subagent frame',
        ).toBeGreaterThan(0);
        for (const model of models) {
          expect(model).toMatch(testCase.frameModel);
        }
      },
      PROBE_TIMEOUT_MS * MAX_ATTEMPTS,
    );
  }
});

describe('Claude built-in replacement real-run acceptance (claude-code-69)', () => {
  acceptanceIt(
    'runs general-purpose pinned and Explore as its own read-only self',
    async () => {
      requireDependencies();
      // Named explicitly so both built-ins are reached whatever the agent's
      // habit; the hook shows the effort each one ran at, and each reply
      // lists the tools that subagent was given.
      const outcome = await runWithRetries({
        subagentModel: 'inherit',
        subagentEffort: 'low',
        effort: 'high',
        observeHooks: true,
        prompt: (wordFile) =>
          [
            'Start two subagents with the Agent tool, one after the other.',
            'The first with subagent_type "general-purpose", the second with subagent_type "Explore".',
            'Give each one this whole task, verbatim:',
            `"Use the Read tool to read the file ${wordFile}. Then reply with exactly two lines: first, TOOLS: followed by the exact names of all the tools available to you, separated by commas; second, only the single word the file contains."`,
            'When both have returned, reply with exactly the word they returned and nothing else.',
          ].join(' '),
      });
      expectSuccessfulWord(outcome.events);

      const types = agentCallInputs(outcome.events).map(
        (input) => input.subagent_type,
      );
      const builtIn = outcome.hooks.filter(
        (hook) =>
          hook.agentType === 'general-purpose' || hook.agentType === 'Explore',
      );
      const tools = listedTools(outcome.events, outcome.frames);
      const models = subagentFrameModels(outcome.frames);
      process.stderr.write(
        `Claude built-in replacement: types ${JSON.stringify(types)}, ` +
          `subagent tool calls ${JSON.stringify(builtIn)}, ` +
          `main-agent efforts ${JSON.stringify(
            outcome.hooks
              .filter((hook) => hook.agentType === undefined)
              .map((hook) => hook.effort),
          )}, listed tools ${JSON.stringify(tools)}, ` +
          `subagent models ${JSON.stringify(models)}\n`,
      );
      expect(types).toEqual(
        expect.arrayContaining(['general-purpose', 'Explore']),
      );
      // general-purpose runs the pinned definition that replaces it; Explore
      // is not replaced and runs at the main agent's effort.
      for (const [agentType, effort] of [
        ['general-purpose', 'low'],
        ['Explore', 'high'],
      ] as const) {
        const calls = builtIn.filter((hook) => hook.agentType === agentType);
        expect(
          calls.length,
          `no ${agentType} tool call observed`,
        ).toBeGreaterThan(0);
        for (const call of calls) {
          expect(call.effort, `${agentType} ${call.toolName}`).toBe(effort);
        }
      }
      // Explore keeps its built-in read-only tool restrictions; the
      // replacing general-purpose definition names no tools, so it has all.
      const explore = tools['Explore'];
      const general = tools['general-purpose'];
      expect(explore, 'Explore listed no TOOLS: line').toBeDefined();
      expect(general, 'general-purpose listed no TOOLS: line').toBeDefined();
      expect(explore).toContain('Read');
      expect(explore).not.toContain('Write');
      expect(explore).not.toContain('Edit');
      expect(general).toEqual(expect.arrayContaining(['Write', 'Edit']));
      expect(
        models.length,
        'the SDK forwarded no subagent frame',
      ).toBeGreaterThan(0);
      for (const model of models) {
        expect(model).toMatch(/sonnet/i);
      }
    },
    PROBE_TIMEOUT_MS * MAX_ATTEMPTS,
  );
});

function requireDependencies(): void {
  if (missing.length > 0) {
    throw new Error(
      `Missing Claude subagent-model acceptance dependencies: ${missing.join(', ')}`,
    );
  }
}

async function runWithRetries(settings: ProbeSettings): Promise<ProbeOutcome> {
  let outcome: ProbeOutcome | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    outcome = await runProbe(settings);
    const transient = transientFailure(outcome.events);
    if (!transient || attempt === MAX_ATTEMPTS) break;
    process.stderr.write(
      `Claude subagent-model acceptance attempt ${attempt} hit a ` +
        `transient upstream error: ${transient}\n`,
    );
  }
  return outcome!;
}

function expectSuccessfulWord(events: readonly CligentEvent[]): void {
  const done = events.find((event) => event.type === 'done')?.payload as
    DonePayload | undefined;
  const errors = events
    .filter((event) => event.type === 'error')
    .map((event) => (event.payload as ErrorPayload).message);
  expect(done?.status, `errors: ${errors.join(' | ')}`).toBe('success');
  expect(done?.result ?? '').toContain(WORD);
}

function agentCallInputs(
  events: readonly CligentEvent[],
): Array<{ subagent_type?: unknown; model?: unknown }> {
  return events
    .filter(
      (event) =>
        event.type === 'tool_use' &&
        ['Agent', 'Task'].includes((event.payload as ToolUsePayload).toolName),
    )
    .map(
      (event) =>
        ((event.payload as ToolUsePayload).input ?? {}) as {
          subagent_type?: unknown;
          model?: unknown;
        },
    );
}

// The tools each named subagent type listed on the TOOLS: line of the reply
// its Agent call returned to the main agent, read from the raw stream's
// main-thread tool results.
function listedTools(
  events: readonly CligentEvent[],
  frames: readonly unknown[],
): Record<string, string[]> {
  const typeById = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    const payload = event.payload as ToolUsePayload;
    const type = (payload.input as { subagent_type?: unknown }).subagent_type;
    if (
      ['Agent', 'Task'].includes(payload.toolName) &&
      typeof type === 'string'
    )
      typeById.set(payload.toolUseId, type);
  }
  const listed: Record<string, string[]> = {};
  for (const frame of frames) {
    const user = frame as {
      type?: unknown;
      parent_tool_use_id?: unknown;
      message?: { content?: unknown };
    };
    if (user.type !== 'user' || typeof user.parent_tool_use_id === 'string')
      continue;
    const blocks = Array.isArray(user.message?.content)
      ? (user.message.content as Array<Record<string, unknown>>)
      : [];
    for (const block of blocks) {
      const type = typeById.get(String(block.tool_use_id));
      if (block.type !== 'tool_result' || type === undefined) continue;
      const text =
        typeof block.content === 'string'
          ? block.content
          : (Array.isArray(block.content) ? block.content : [])
              .map((part: { text?: unknown }) =>
                typeof part.text === 'string' ? part.text : '',
              )
              .join('\n');
      const line = /^[\s*_`]*TOOLS:[\s*_`]*(.*)$/m.exec(text)?.[1];
      if (line === undefined) continue;
      listed[type] = line
        .split(',')
        .map((name) => name.replace(/[\s*_`.]+/g, ''))
        .filter((name) => name.length > 0);
    }
  }
  return listed;
}

function subagentFrameModels(frames: readonly unknown[]): string[] {
  return frames
    .filter(isSubagentAssistantFrame)
    .map((frame) => String(frame.message?.model));
}

async function runProbe(settings: ProbeSettings): Promise<ProbeOutcome> {
  const cwd = mkdtempSync(join(tmpdir(), 'cligent-subagent-model-'));
  const wordFile = join(cwd, 'word.txt');
  writeFileSync(wordFile, `${WORD}\n`);
  const frames: unknown[] = [];
  const hooks: HookObservation[] = [];
  const events: CligentEvent[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const cligent = new Cligent(
      tappedAdapter(frames, settings.observeHooks ? hooks : undefined),
      {
        cwd,
        model: MAIN_MODEL,
        ...(settings.effort !== undefined ? { effort: settings.effort } : {}),
        subagentModel: settings.subagentModel,
        ...(settings.subagentEffort !== undefined
          ? { subagentEffort: settings.subagentEffort }
          : {}),
        permissions: {
          fileWrite: 'deny',
          shellExecute: 'deny',
          networkAccess: 'deny',
        },
      },
    );
    const prompt = settings.prompt(wordFile);
    for await (const event of cligent.run(prompt, {
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }
  } finally {
    clearTimeout(timer);
    rmSync(cwd, { recursive: true, force: true });
  }
  return { events, frames, hooks };
}

// A pass-through tap: the real SDK serves the query and the adapter sees every
// frame unchanged; the test keeps a copy of each for the raw-stream evidence.
// With `hooks`, the tap adds one PreToolUse hook recording each tool call's
// agent type (absent on the main thread) and the effort the runtime applied.
function tappedAdapter(
  frames: unknown[],
  hooks?: HookObservation[],
): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    probeExecutable: () => probeClaudeExecutable(),
    loadSdk: async () => {
      const sdk = await loadClaudeAgentSdk();
      return {
        query(request: QueryRequest): AsyncIterable<unknown> {
          const stream = sdk.query(
            hooks === undefined ? request : withEffortHook(request, hooks),
          );
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

function withEffortHook(
  request: QueryRequest,
  hooks: HookObservation[],
): QueryRequest {
  const record = async (input: {
    agent_type?: string;
    tool_name?: string;
    effort?: { level?: string };
  }) => {
    hooks.push({
      agentType: input.agent_type,
      toolName: input.tool_name,
      effort: input.effort?.level,
    });
    return {};
  };
  return {
    ...request,
    options: {
      ...request.options,
      hooks: { PreToolUse: [{ hooks: [record] }] },
    },
  } as unknown as QueryRequest;
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
