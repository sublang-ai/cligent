// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// claude-code-88: real-run verification that a run skill reaches Claude Code
// through the run-private plugin and runs headless. The recording-fixture
// tests (claude-code-87) prove what crosses the SDK boundary; only the real
// runtime shows that it loads the plugin, registers the skill under the
// `cligent` namespace, and lets the pre-approved skill run although its
// `allowed-tools` frontmatter would otherwise ask — which a run with no
// permission policy and no approval handler denies. The skill source lives
// outside the run's working directory, so only the plugin can reach it, and
// its body holds a token the prompt never shows, so the reply can carry it
// only through the skill. The test consumes the adapter's own stream, which
// ends only after the adapter removed the plugin root (claude-code-89).

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  DonePayload,
  ErrorPayload,
  ToolResultPayload,
  ToolUsePayload,
} from '../index.js';
import { ClaudeCodeAdapter, loadClaudeAgentSdk } from './claude-code.js';
import { probeClaudeExecutable } from './claude-executable.js';

const SKILL_NAME = 'token-reply';
const PROBE_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;

const missing = process.env.ANTHROPIC_API_KEY ? [] : ['ANTHROPIC_API_KEY'];
const MISSING = `Missing Claude skills acceptance dependencies: ${missing.join(', ')}`;

// claude-code-219's gate: self-skip locally with one stderr diagnostic when
// the credential is absent, and hard-fail instead under CI.
const acceptanceIt = (() => {
  if (missing.length === 0 || process.env.CI) return it;
  process.stderr.write(`${MISSING}; skipping locally\n`);
  return it.skip;
})();

// Retry only on explicit upstream-capacity failures, as claude-code-219 does,
// so a genuine regression still surfaces instead of being retried.
const TRANSIENT_UPSTREAM_MARKERS = [
  /\b(?:API Error:\s*Repeated|HTTP(?:[ _-]+status)?|status[ _-]+code)[ :=_-]*(?:429|503|529)\b/i,
  /\boverload(?:ed|ing)?\b/i,
  /\bover[ _-]?capacity\b/i,
  /\bservice[ _-]?unavailable\b/i,
  /\brate[ _-]?limit(?:ed|ing|[ _-]?exceeded)?\b/i,
  /\btoo[ _-]?many[ _-]?requests\b/i,
];

type QueryRequest = Parameters<
  Awaited<ReturnType<typeof loadClaudeAgentSdk>>['query']
>[0];

interface InitFrame {
  type: 'system';
  subtype: 'init';
  plugins?: Array<{ name?: unknown; path?: unknown }>;
  skills?: unknown[];
}

interface ProbeOutcome {
  readonly token: string;
  readonly events: readonly AgentEvent[];
  /** Every native frame the SDK yielded, unchanged. */
  readonly frames: readonly unknown[];
  readonly init: InitFrame | undefined;
  readonly pluginRoot: string | undefined;
  /** Whether the plugin root still existed when the adapter's stream ended. */
  readonly rootLeftAtEnd: boolean;
}

describe('Claude run skills real-run acceptance (claude-code-88)', () => {
  acceptanceIt(
    'loads the run skill as cligent:<name>, runs it headless, and removes the plugin',
    async () => {
      if (missing.length > 0) throw new Error(MISSING);
      const outcome = await runWithRetries();
      const { events, frames, init, pluginRoot, token } = outcome;

      const done = events.find((event) => event.type === 'done')?.payload as
        DonePayload | undefined;
      const errors = events
        .filter((event) => event.type === 'error')
        .map((event) => (event.payload as ErrorPayload).message);
      expect(done?.status, `errors: ${errors.join(' | ')}`).toBe('success');
      expect(errors).toEqual([]);

      // The initialization lists the plugin at its root and the skill under
      // the plugin's namespace (claude-code-86).
      expect(pluginRoot).toBeDefined();
      expect(init).toBeDefined();
      expect(
        (init?.plugins ?? []).some(
          (plugin) => plugin.name === 'cligent' && plugin.path === pluginRoot,
        ),
        JSON.stringify(init?.plugins),
      ).toBe(true);
      expect(init?.skills).toContain(`cligent:${SKILL_NAME}`);

      // The pre-approved skill ran through the Skill tool without a
      // permission ask or denial, and only it holds the token
      // (claude-code-85).
      expect(done?.result ?? '').toContain(token);
      expect(events.some((event) => event.type === 'permission_request')).toBe(
        false,
      );
      const skillCalls = events
        .filter((event) => event.type === 'tool_use')
        .map((event) => event.payload as ToolUsePayload)
        .filter(
          (call) =>
            call.toolName === 'Skill' &&
            Object.values(call.input).includes(`cligent:${SKILL_NAME}`),
        );
      const results = new Map(
        events
          .filter((event) => event.type === 'tool_result')
          .map((event) => event.payload as ToolResultPayload)
          .map((result) => [result.toolUseId, result.status]),
      );
      expect(
        skillCalls.some((call) => results.get(call.toolUseId) === 'success'),
        JSON.stringify({ skillCalls, results: [...results] }),
      ).toBe(true);
      // The native record of denials: the result's permission_denials is
      // authoritative, and a permission_denied notice is its advisory twin.
      const result = frames.find(
        (frame): frame is { permission_denials?: unknown } =>
          frameType(frame) === 'result',
      );
      expect(result?.permission_denials).toEqual([]);
      expect(
        frames.filter(
          (frame) =>
            frameType(frame) === 'system' &&
            (frame as { subtype?: unknown }).subtype === 'permission_denied',
        ),
      ).toEqual([]);

      // The plugin root is gone once the adapter's stream completes
      // (claude-code-89).
      expect(outcome.rootLeftAtEnd).toBe(false);
    },
    PROBE_TIMEOUT_MS * MAX_ATTEMPTS,
  );
});

async function runWithRetries(): Promise<ProbeOutcome> {
  let outcome: ProbeOutcome | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    outcome = await runProbe();
    const transient = transientFailure(outcome.events);
    if (!transient || attempt === MAX_ATTEMPTS) break;
    process.stderr.write(
      `Claude skills acceptance attempt ${attempt} hit a transient upstream error: ${transient}\n`,
    );
  }
  return outcome!;
}

async function runProbe(): Promise<ProbeOutcome> {
  const cwd = mkdtempSync(join(tmpdir(), 'cligent-claude-skills-acceptance-'));
  // A sibling of the working directory, so the runtime can find the skill
  // only through the plugin.
  const sources = mkdtempSync(
    join(tmpdir(), 'cligent-claude-skills-acceptance-sources-'),
  );
  const token = `SKILLTOKEN-${randomBytes(6).toString('hex').toUpperCase()}`;
  const skillDirectory = join(sources, SKILL_NAME);
  mkdirSync(skillDirectory, { recursive: true });
  // `allowed-tools` makes the runtime ask before the skill runs unless the
  // run pre-approves it.
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    [
      '---',
      `name: ${SKILL_NAME}`,
      "description: Replies with this run's acceptance token. Use when asked for the acceptance token.",
      'allowed-tools: Read',
      '---',
      `Reply with exactly this token and nothing else: ${token}`,
      '',
    ].join('\n'),
  );
  const frames: unknown[] = [];
  const requests: QueryRequest[] = [];
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let rootLeftAtEnd = true;
  let pluginRoot: string | undefined;

  try {
    const adapter = tappedAdapter(frames, requests);
    for await (const event of adapter.run(
      `Use the Skill tool to invoke the skill cligent:${SKILL_NAME}, then reply with exactly the token it gives you and nothing else.`,
      { cwd, skills: [skillDirectory], abortSignal: controller.signal },
    )) {
      events.push(event);
    }
    pluginRoot = requests[0]?.options?.plugins?.[0]?.path;
    rootLeftAtEnd = pluginRoot === undefined || existsSync(pluginRoot);
  } finally {
    clearTimeout(timer);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sources, { recursive: true, force: true });
  }
  const init = frames.find(
    (frame): frame is InitFrame =>
      frameType(frame) === 'system' &&
      (frame as { subtype?: unknown }).subtype === 'init',
  );
  return { token, events, frames, init, pluginRoot, rootLeftAtEnd };
}

function frameType(frame: unknown): unknown {
  return typeof frame === 'object' && frame !== null
    ? (frame as { type?: unknown }).type
    : undefined;
}

// A pass-through tap: the real SDK serves the query and the adapter sees every
// frame unchanged; the test keeps the request and a copy of each frame.
function tappedAdapter(
  frames: unknown[],
  requests: QueryRequest[],
): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    probeExecutable: () => probeClaudeExecutable(),
    loadSdk: async () => {
      const sdk = await loadClaudeAgentSdk();
      return {
        query(request: QueryRequest): AsyncIterable<unknown> {
          requests.push(request);
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

function transientFailure(events: readonly AgentEvent[]): string | undefined {
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
