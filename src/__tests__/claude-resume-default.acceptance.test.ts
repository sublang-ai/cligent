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
// Fresh omission follows current defaults; resumed omission delegates native
// session selection and ANTHROPIC_MODEL overrides without reading history.
// No credentials or paid requests occur.

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
  requestBetas: string[];
}

type DefaultSource =
  'environment' | 'settings env' | 'settings model' | 'settings context';

const cases: Array<{
  source: DefaultSource;
  apply: (configDir: string, value: string) => Promise<Record<string, string>>;
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
  {
    source: 'settings context',
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
  let betas: string[] = [];

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
      betas.push(String(request.headers['anthropic-beta'] ?? ''));
      streamReply(response, 'service-reported-different-model');
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
    it(`delegates omission to native selection across defaults and differing reply models (${source})`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'cligent-resume-'));
      const home = join(root, 'home');
      const configDir = join(home, '.claude');
      const cwd = join(root, 'project');
      await mkdir(configDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      let stderr = '';
      let runEnv: Record<string, string> = {};

      const originalEnv = { ...process.env };
      const isolatedEnv = Object.fromEntries(
        Object.entries(originalEnv).filter(
          ([key]) =>
            !key.startsWith('ANTHROPIC_') && !key.startsWith('CLAUDE_'),
        ),
      );

      const run = async (options: AgentOptions): Promise<RunResult> => {
        process.env = {
          ...isolatedEnv,
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
        };
        // Every turn starts a new SDK subprocess and a new adapter. The seam
        // only captures stderr; environment resolution sees the actual run env.
        let sdkModel: string | undefined;
        const adapter = new ClaudeCodeAdapter({
          loadSdk: async () => ({
            query(parameters) {
              sdkModel = parameters.options?.model;
              return query({
                ...parameters,
                options: {
                  ...parameters.options,
                  stderr: (data) => {
                    stderr = (stderr + data).slice(-8000);
                  },
                },
              });
            },
          }),
        });
        requests = [];
        betas = [];
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
        expect(sdkModel).toBe(options.model);
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
          requestBetas: [...betas],
        };
      };

      const setDefault = async (value: string) => {
        runEnv = await apply(configDir, value);
      };

      try {
        await setDefault(
          source === 'settings context' ? 'opus[1m]' : 'probe-default-a',
        );
        const fresh = await run({});

        expect(fresh.requestModels).toEqual([
          source === 'settings context' ? 'claude-opus-5-5' : 'probe-default-a',
        ]);
        if (source !== 'settings context')
          expect(fresh.initModel).toBe('probe-default-a');

        await setDefault('probe-default-b');
        const first = await run({ resume: fresh.token });
        expect(first.token).toBe(fresh.token);
        const firstExpected =
          source === 'settings context'
            ? 'claude-opus-5-5'
            : source === 'settings model'
              ? 'probe-default-a'
              : 'probe-default-b';
        expect(first.requestModels).toEqual([firstExpected]);
        if (source !== 'settings context')
          expect(first.initModel).toBe(firstExpected);
        else {
          expect(first.requestBetas).toEqual(fresh.requestBetas);
        }

        const switched = await run({
          resume: fresh.token,
          model: 'probe-explicit',
        });
        expect(switched.token).toBe(fresh.token);
        expect(switched.requestModels).toEqual(['probe-explicit']);
        expect(switched.initModel).toBe('probe-explicit');

        await setDefault('probe-default-c');
        const second = await run({ resume: fresh.token });
        expect(second.token).toBe(fresh.token);
        const secondExpected =
          source === 'settings model' || source === 'settings context'
            ? 'probe-explicit'
            : 'probe-default-c';
        expect(second.requestModels).toEqual([secondExpected]);
        expect(second.initModel).toBe(secondExpected);

        const independent = await run({});
        expect(independent.token).not.toBe(fresh.token);
        expect(independent.requestModels).toEqual(['probe-default-c']);
        expect(independent.initModel).toBe('probe-default-c');
      } finally {
        process.env = originalEnv;
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
