// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { Cligent } from '../cligent.js';
import * as attachmentFiles from '../attachments.js';
import type { AgentEvent } from '../types.js';

const SESSION_ID = '7debe36f-1f2c-4ab8-8912-89e887ccd145';
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureFiles() {
  const root = await mkdtemp(join(tmpdir(), 'cligent-native-attachments-'));
  roots.push(root);
  const png = Buffer.from('image bytes\u0000with binary data');
  const pdf = Buffer.from('%PDF-1.7\nfixture');
  await writeFile(join(root, 'first image.PNG'), png);
  await writeFile(join(root, 'second.webp'), 'second-image');
  await writeFile(join(root, 'reference.pdf'), pdf);
  return { root, png, pdf };
}

async function collect(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function recordedLines(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function claudeFixture(root: string) {
  const script = join(root, 'claude-fixture.mjs');
  const recording = join(root, 'claude-recording.jsonl');
  await writeFile(
    script,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const recording = process.argv[2];
appendFileSync(recording, JSON.stringify({ args: process.argv.slice(3) }) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id, response: {}
    } });
  } else if (message.type === 'user') {
    appendFileSync(recording, JSON.stringify(message) + '\\n');
    send({ type: 'system', subtype: 'init', session_id: '${SESSION_ID}', model: 'fixture', tools: [] });
    send({ type: 'result', subtype: 'success', result: 'received', session_id: '${SESSION_ID}',
      is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, total_cost_usd: 0 });
  }
});
lines.on('close', () => process.exit(0));
`,
  );
  const calls: Array<{ prompt: unknown }> = [];
  const adapter = new ClaudeCodeAdapter({
    probeExecutable: () => ({ state: 'present', path: script }),
    loadSdk: async () => ({
      query(parameters) {
        calls.push({ prompt: parameters.prompt });
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
  return { adapter, recording, calls };
}

async function codexFixture(root: string) {
  const script = join(root, 'codex-fixture.mjs');
  const recording = join(root, 'codex-recording.jsonl');
  await writeFile(
    script,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  appendFileSync(process.env.CLIGENT_ATTACHMENT_RECORDING, JSON.stringify({ args: process.argv.slice(2), prompt }) + '\\n');
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  send({ type: 'thread.started', thread_id: '${SESSION_ID}' });
  send({ type: 'item.completed', item: { id: 'text', type: 'agent_message', text: 'received' } });
  send({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
});
`,
  );
  await chmod(script, 0o755);
  const calls: unknown[] = [];
  const adapter = new CodexAdapter({
    probeExecutable: () => ({ state: 'present', path: script }),
    loadSdk: async () => ({
      Codex: class extends Codex {
        constructor(options) {
          calls.push(options);
          super({
            ...options,
            codexPathOverride: script,
            env: { ...process.env, CLIGENT_ATTACHMENT_RECORDING: recording },
          });
        }
      },
    }),
  });
  return { adapter, recording, calls };
}

describe('native attachment SDK transports', () => {
  it('sends Claude images and PDF bytes through the installed SDK and resumes without resending attachments (claude-code-70)', async () => {
    const { root, png, pdf } = await fixtureFiles();
    const { adapter, recording, calls } = await claudeFixture(root);
    const client = new Cligent(adapter, { cwd: root });
    const prompt = 'Inspect the two attachments.\nKeep this text unchanged.';
    const events = await collect(
      client.run(prompt, {
        attachments: [{ path: 'first image.PNG' }, { path: 'reference.pdf' }],
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      payload: { status: 'success' },
    });
    await collect(client.run('Continue with text only.'));
    await collect(client.run('An explicit empty list.', { attachments: [] }));
    const lines = await recordedLines(recording);
    const userMessages = lines.filter((line) => line.type === 'user');
    expect(userMessages[0]).toMatchObject({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: png.toString('base64'),
            },
          },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdf.toString('base64'),
            },
          },
        ],
      },
    });
    expect(calls[0]?.prompt).not.toBeTypeOf('string');
    expect(calls[1]?.prompt).toBe('Continue with text only.');
    expect(calls[2]?.prompt).toBe('An explicit empty list.');
    expect(lines.filter((line) => Array.isArray(line.args))[1]?.args).toEqual(
      expect.arrayContaining([`--resume=${SESSION_ID}`]),
    );
    const resumed = await collect(
      client.run('New visual evidence.', {
        attachments: [{ path: 'second.webp' }],
      }),
    );
    expect(resumed.at(-1)).toMatchObject({
      type: 'done',
      payload: { status: 'success' },
    });
    const latest = (await recordedLines(recording))
      .filter((line) => line.type === 'user')
      .at(-1);
    expect(latest).toMatchObject({
      message: {
        content: [
          { type: 'text', text: 'New visual evidence.' },
          {
            type: 'image',
            source: {
              media_type: 'image/webp',
              data: Buffer.from('second-image').toString('base64'),
            },
          },
        ],
      },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'sends ordered Codex --image arguments and unchanged stdin through the installed SDK on fresh and resumed turns (codex-68)',
    async () => {
      const { root } = await fixtureFiles();
      const { adapter, recording } = await codexFixture(root);
      const client = new Cligent(adapter, { cwd: root });
      const prompt = 'Compare both pictures.\nLiteral @file stays text.';
      const events = await collect(
        client.run(prompt, {
          attachments: [{ path: 'first image.PNG' }, { path: 'second.webp' }],
        }),
      );
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        payload: { status: 'success' },
      });
      await collect(
        client.run('Continue.', { attachments: [{ path: 'second.webp' }] }),
      );
      await collect(client.run('No pictures.', { attachments: [] }));
      const lines = await recordedLines(recording);
      const imagePaths = (args: string[]) =>
        args.flatMap((argument, index) =>
          argument === '--image' ? [args[index + 1]] : [],
        );
      expect(lines[0]?.prompt).toBe(prompt);
      expect(imagePaths(lines[0]?.args as string[])).toEqual([
        join(root, 'first image.PNG'),
        join(root, 'second.webp'),
      ]);
      expect(lines[1]?.args).toEqual(
        expect.arrayContaining(['resume', SESSION_ID]),
      );
      expect(imagePaths(lines[1]?.args as string[])).toEqual([
        join(root, 'second.webp'),
      ]);
      expect(lines[2]?.prompt).toBe('No pictures.');
      expect(imagePaths(lines[2]?.args as string[])).toEqual([]);
    },
  );

  for (const agent of ['claude-code', 'codex'] as const) {
    it(`${agent} rejects malformed, missing, unsupported, and cancelled attachments before loading its SDK`, async () => {
      const { root } = await fixtureFiles();
      let loads = 0;
      const deps = {
        loadSdk: async () => {
          loads += 1;
          throw new Error('SDK must not load');
        },
      };
      const adapter =
        agent === 'claude-code'
          ? new ClaudeCodeAdapter(deps)
          : new CodexAdapter(deps);
      for (const attachments of [
        null,
        [{ path: '' }],
        [{ path: 'missing.png' }],
        [{ path: 'first image.PNG', mimeType: 'video/mp4' }],
        [{ path: 'first image.PNG' }, { path: 'missing.png' }],
      ]) {
        await expect(
          collect(adapter.run('test', { cwd: root, attachments })),
        ).rejects.toThrow(/attachments/);
      }
      const controller = new AbortController();
      controller.abort();
      const interrupted = await collect(
        adapter.run('test', {
          cwd: root,
          attachments: [{ path: 'first image.PNG' }],
          abortSignal: controller.signal,
          resume: SESSION_ID,
        }),
      );
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toMatchObject({
        type: 'done',
        payload: {
          status: 'interrupted',
          resumeToken: SESSION_ID,
          usage: { toolUses: 0 },
        },
      });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(loads).toBe(0);
    });

    it(`${agent} preserves interruption during asynchronous file preparation without loading its SDK`, async () => {
      const { root } = await fixtureFiles();
      const controller = new AbortController();
      let loads = 0;
      const deps = {
        loadSdk: async () => {
          loads += 1;
          throw new Error('SDK must not load');
        },
      };
      const adapter =
        agent === 'claude-code'
          ? new ClaudeCodeAdapter(deps)
          : new CodexAdapter(deps);
      const stream = collect(
        adapter.run('test', {
          cwd: root,
          attachments: [{ path: 'first image.PNG' }],
          abortSignal: controller.signal,
        }),
      );
      controller.abort();
      const events = await stream;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'done',
        payload: { status: 'interrupted', usage: { toolUses: 0 } },
      });
      expect(events[0]?.payload).not.toHaveProperty('resumeToken');
      expect(loads).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });
  }

  it('preserves cancellation from the Claude attachment read without an SDK generator abort', async () => {
    const { root } = await fixtureFiles();
    const controller = new AbortController();
    const read = attachmentFiles.readAttachment;
    const reading = vi
      .spyOn(attachmentFiles, 'readAttachment')
      .mockImplementationOnce((attachment, signal) => {
        controller.abort();
        return read(attachment, signal);
      });
    let loads = 0;
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => {
        loads += 1;
        throw new Error('SDK must not load');
      },
    });
    const events = await collect(
      adapter.run('test', {
        cwd: root,
        attachments: [{ path: 'first image.PNG' }],
        abortSignal: controller.signal,
      }),
    );
    expect(reading).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'done',
      payload: { status: 'interrupted', usage: { toolUses: 0 } },
    });
    expect(loads).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
