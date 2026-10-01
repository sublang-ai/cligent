// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';

import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { Cligent } from '../cligent.js';
import type { AgentEvent } from '../types.js';

interface MessageRequest {
  stream?: boolean;
  messages?: Array<{ role: string; content: unknown }>;
}

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage);
  if (typeof value !== 'object' || value === null) return false;
  const object = value as Record<string, unknown>;
  if (object.type === 'image') return true;
  return Object.values(object).some(containsImage);
}

function reply(
  response: ServerResponse,
  index: number,
  content: Record<string, unknown>,
  stream: boolean,
) {
  const isTool = content.type === 'tool_use';
  const message = {
    id: `msg_fixture_${index}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [content],
    stop_reason: isTool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
  if (!stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const send = (type: string, data: Record<string, unknown>) =>
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
    );
  send('message_start', {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  send('content_block_start', {
    index: 0,
    content_block: isTool
      ? { ...content, input: {} }
      : { type: 'text', text: '' },
  });
  send('content_block_delta', {
    index: 0,
    delta: isTool
      ? {
          type: 'input_json_delta',
          partial_json: JSON.stringify(content.input),
        }
      : { type: 'text_delta', text: content.text },
  });
  send('content_block_stop', { index: 0 });
  send('message_delta', {
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send('message_stop', {});
  response.end();
}

// Real native SDK/CLI + real managed MCP/Chromium. Only the model API is a
// deterministic loopback fixture; no real credentials or paid requests occur.
it('returns a browser screenshot to both the Claude model loop and the Cligent host', async () => {
  // Chromium's local Unix sockets need a short path on macOS.
  const root = await mkdtemp(
    join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ccb-'),
  );
  const requests: MessageRequest[] = [];
  const events: AgentEvent[] = [];
  const rawUsers: unknown[] = [];
  let stderr = '';
  let endpoint = '';
  const server = createServer(async (request, response) => {
    if (request.url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<!doctype html><html><head><title>Cligent visual fixture</title></head><body style="background:#2b5175;color:white"><h1>Screenshot fixture</h1><button>Continue</button></body></html>',
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (!request.url?.startsWith('/v1/messages')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    const body = JSON.parse(
      Buffer.concat(chunks).toString('utf8'),
    ) as MessageRequest;
    requests.push(body);
    const index = requests.length;
    const content =
      index === 1
        ? {
            type: 'tool_use',
            id: 'toolu_fixture_navigate',
            name: 'mcp__cligent_browser__browser_navigate',
            input: { url: `${endpoint}/page` },
          }
        : index === 2
          ? {
              type: 'tool_use',
              id: 'toolu_fixture_screenshot',
              name: 'mcp__cligent_browser__browser_take_screenshot',
              input: { type: 'png' },
            }
          : {
              type: 'text',
              text: 'The screenshot shows a blue page with a Continue button.',
            };
    reply(response, index, content, body.stream === true);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No loopback address');
  endpoint = `http://127.0.0.1:${address.port}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 100_000);
  const adapter = new ClaudeCodeAdapter({
    loadSdk: async () => ({
      query(parameters) {
        const stream = query({
          ...parameters,
          options: {
            ...parameters.options,
            settingSources: [],
            persistSession: false,
            stderr: (data) => {
              stderr = (stderr + data).slice(-8000);
            },
            env: {
              PATH: process.env.PATH,
              HOME: root,
              TMPDIR: root,
              CLAUDE_CONFIG_DIR: root,
              ANTHROPIC_API_KEY: 'local-fixture-not-a-real-key',
              ANTHROPIC_BASE_URL: endpoint,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
              DISABLE_TELEMETRY: '1',
              DISABLE_ERROR_REPORTING: '1',
              ENABLE_TOOL_SEARCH: 'false',
            },
          },
        });
        return (async function* () {
          for await (const message of stream) {
            if (message.type === 'user') rawUsers.push(message);
            yield message;
          }
        })();
      },
    }),
  });
  try {
    for await (const event of new Cligent(adapter, {
      cwd: root,
      browser: true,
    }).run(
      'Open the supplied fixture page, take a screenshot, and describe its layout.',
      { model: 'claude-sonnet-4-6', maxTurns: 4, abortSignal: abort.signal },
    ))
      events.push(event);
    const diagnostics =
      JSON.stringify(
        {
          events: events.map((event) => ({
            type: event.type,
            payload: event.type === 'media' ? '[image]' : event.payload,
          })),
          requests: requests.length,
          rawUsers,
        },
        null,
        2,
      ).slice(-12000) + stderr;
    expect(requests.length, diagnostics).toBeGreaterThanOrEqual(3);
    expect(containsImage(requests.at(-1)?.messages), diagnostics).toBe(true);
    const media = events.find((event) => event.type === 'media');
    expect(media?.payload, diagnostics).toMatchObject({
      mimeType: 'image/png',
      source: { type: 'base64' },
      toolUseId: 'toolu_fixture_screenshot',
    });
    if (media?.type === 'media' && media.payload.source.type === 'base64') {
      expect(
        Buffer.from(media.payload.source.data, 'base64').subarray(0, 8),
      ).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    expect(
      events
        .filter((event) => event.type === 'tool_result')
        .map((event) => event.payload.status),
      diagnostics,
    ).toEqual(['success', 'success']);
    expect(events.at(-1)?.payload, diagnostics).toMatchObject({
      status: 'success',
      result: 'The screenshot shows a blue page with a Continue button.',
    });
  } finally {
    clearTimeout(timer);
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Chromium may still finish profile cleanup after the SDK iterator closes.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}, 120_000);
