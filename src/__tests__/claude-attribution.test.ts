// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { Cligent } from '../cligent.js';
import type { AgentEvent, ClaudeEffort } from '../types.js';

const SESSION_ID = '3f0c2a57-8d4b-4e61-9a2f-5b7c1d9e0a84';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function collect(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

// A native-CLI stand-in that records the command line the installed SDK
// builds, so the test reads the settings the native agent would load.
async function claudeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cligent-claude-attribution-'));
  roots.push(root);
  const script = join(root, 'claude-fixture.mjs');
  const recording = join(root, 'claude-recording.jsonl');
  await writeFile(
    script,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id, response: {}
    } });
  } else if (message.type === 'user') {
    send({ type: 'system', subtype: 'init', session_id: '${SESSION_ID}', model: 'fixture', tools: [] });
    send({ type: 'result', subtype: 'success', result: 'committed', session_id: '${SESSION_ID}',
      is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, total_cost_usd: 0 });
  }
});
lines.on('close', () => process.exit(0));
`,
  );
  const adapter = new ClaudeCodeAdapter({
    probeExecutable: () => ({ state: 'present', path: script }),
    loadSdk: async () => ({
      query(parameters) {
        return query({
          ...parameters,
          options: {
            ...parameters.options,
            spawnClaudeCodeProcess: (options) =>
              spawn(process.execPath, [script, recording, ...options.args], {
                cwd: root,
                env: options.env,
                signal: options.signal,
                stdio: ['pipe', 'pipe', 'pipe'],
              }),
          },
        });
      },
    }),
  });
  return { adapter, recording, root };
}

describe('Claude Code attribution through the installed SDK', () => {
  // claude-code-84: whatever the run's tool list, effort, or fast mode, and
  // on fresh and resumed turns alike, the native CLI loads settings that turn
  // its own commit and pull-request attribution off (claude-code-83).
  it('launches every run with Claude Code attribution off', async () => {
    const allowlists: Array<string[] | undefined> = [undefined, [], ['Bash']];
    const tunings: Array<{ effort?: ClaudeEffort; fastMode?: boolean }> = [
      {},
      { effort: 'ultracode', fastMode: true },
    ];

    for (const allowedTools of allowlists) {
      for (const tuning of tunings) {
        const { adapter, recording, root } = await claudeFixture();
        const client = new Cligent(adapter, {
          cwd: root,
          ...(allowedTools !== undefined ? { allowedTools } : {}),
          ...tuning,
        });

        for (const prompt of ['Commit the change.', 'Amend the commit.']) {
          const events = await collect(client.run(prompt));
          expect(events.at(-1)).toMatchObject({
            type: 'done',
            payload: { status: 'success', resumeToken: SESSION_ID },
          });
        }

        const launches: string[][] = (await readFile(recording, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(launches).toHaveLength(2);
        // The second turn resumes the first turn's session.
        expect(launches[0]!.some((arg) => arg.startsWith('--resume'))).toBe(
          false,
        );
        expect(launches[1]).toContain(`--resume=${SESSION_ID}`);
        for (const args of launches) {
          const index = args.indexOf('--settings');
          expect(index).toBeGreaterThan(-1);
          expect(JSON.parse(args[index + 1]!)).toEqual({
            disableClaudeAiConnectors: true,
            attribution: { commit: '', pr: '', sessionUrl: false },
            ...(tuning.effort === 'ultracode' ? { ultracode: true } : {}),
            ...(tuning.fastMode !== undefined
              ? { fastMode: tuning.fastMode }
              : {}),
          });
        }
      }
    }
  });
});
