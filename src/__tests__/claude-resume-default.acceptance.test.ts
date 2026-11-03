// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import type { AgentEvent, AgentOptions } from '../types.js';

// claude-code-93: real native SDK/CLI against a loopback Messages fixture.
// A resume without a model must request the default current at that
// resume, never the session's earlier model. No credentials or paid
// requests occur.

function streamReply(response: ServerResponse, model: string): void {
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
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  });
  send('content_block_start', {
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  send('content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text: 'ok' },
  });
  send('content_block_stop', { index: 0 });
  send('message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  send('message_stop', {});
  response.end();
}

interface RunResult {
  token: string;
  initModel: string | undefined;
  requestModels: string[];
}

type DefaultSource = 'environment' | 'settings env' | 'settings model';

const cases: Array<{
  source: DefaultSource;
  apply: (
    configDir: string,
    value: string,
  ) => Promise<Record<string, string>>;
}> = [
  {
    source: 'environment',
    apply: async (_configDir, value) => ({ ANTHROPIC_MODEL: value }),
  },
  {
    source: 'settings env',
    apply: async (configDir, value) => {
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ env: { ANTHROPIC_MODEL: value } }),
      );
      return {};
    },
  },
  {
    source: 'settings model',
    apply: async (configDir, value) => {
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ model: value }),
      );
      return {};
    },
  },
];

describe('Claude resume without a model', () => {
  let server: Server;
  let endpoint = '';
  let requests: string[] = [];

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = request.url ?? '';
      if (!url.startsWith('/v1/messages') || url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 5 }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: string;
      };
      const model = body.model ?? '';
      requests.push(model);
      streamReply(response, model);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No loopback address');
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  for (const { source, apply } of cases) {
    it(`requests the default current at each resume (${source})`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'cligent-resume-'));
      const home = join(root, 'home');
      const configDir = join(home, '.claude');
      const cwd = join(root, 'project');
      await mkdir(configDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      let stderr = '';
      let runEnv: Record<string, string> = {};

      const adapter = new ClaudeCodeAdapter({
        loadSdk: async () => ({
          query(parameters) {
            const inherited = Object.fromEntries(
              Object.entries(parameters.options?.env ?? {}).filter(
                ([key]) =>
                  !key.startsWith('ANTHROPIC_') && !key.startsWith('CLAUDE_'),
              ),
            );
            return query({
              ...parameters,
              options: {
                ...parameters.options,
                stderr: (data) => {
                  stderr = (stderr + data).slice(-8000);
                },
                env: {
                  ...inherited,
                  HOME: home,
                  USERPROFILE: home,
                  TMPDIR: root,
                  CLAUDE_CONFIG_DIR: configDir,
                  ANTHROPIC_API_KEY: 'local-fixture-not-a-real-key',
                  ANTHROPIC_BASE_URL: endpoint,
                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
                  DISABLE_TELEMETRY: '1',
                  DISABLE_ERROR_REPORTING: '1',
                  ...runEnv,
                },
              },
            });
          },
        }),
      });

      const run = async (options: AgentOptions): Promise<RunResult> => {
        requests = [];
        const events: AgentEvent[] = [];
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 60_000);
        try {
          for await (const event of adapter.run('Reply with ok.', {
            ...options,
            cwd,
            maxTurns: 1,
            abortSignal: abort.signal,
          }))
            events.push(event);
        } finally {
          clearTimeout(timer);
        }
        const done = events.find((event) => event.type === 'done');
        const init = events.find((event) => event.type === 'init');
        const diagnostics = JSON.stringify(
          { source, options, events, requests, stderr },
          null,
          2,
        );
        expect(done?.payload, diagnostics).toMatchObject({
          status: 'success',
        });
        const token = (done?.payload as { resumeToken?: string }).resumeToken;
        expect(token, diagnostics).toBeTruthy();
        return {
          token: token!,
          initModel: (init?.payload as { reportedModel?: string } | undefined)
            ?.reportedModel,
          requestModels: [...requests],
        };
      };

      const setDefault = async (value: string) => {
        runEnv = await apply(configDir, value);
      };

      try {
        await setDefault('probe-default-a');
        const fresh = await run({ model: 'probe-explicit' });
        expect(fresh.requestModels).toEqual(['probe-explicit']);
        expect(fresh.initModel).toBe('probe-explicit');

        const first = await run({ resume: fresh.token });
        expect(first.token).toBe(fresh.token);
        expect(first.requestModels).toEqual(['probe-default-a']);
        expect(first.initModel).toBe('probe-default-a');

        await setDefault('probe-default-b');
        const second = await run({ resume: fresh.token });
        expect(second.token).toBe(fresh.token);
        expect(second.requestModels).toEqual(['probe-default-b']);
        expect(second.initModel).toBe('probe-default-b');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
