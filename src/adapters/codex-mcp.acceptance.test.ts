// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { expect, it } from 'vitest';

import { Cligent } from '../cligent.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import type { AgentEvent } from '../types.js';
import { CodexAdapter, resolveCodexBinPath } from './codex.js';

// A valid two-by-two RGB PNG; native Codex decodes it before model ingestion.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNQCt0NRAwQCgAfIgTJbJMJcQAAAABJRU5ErkJggg==';
const EXPLANATION = 'The screenshot shows a blue square.';

let launcher: string | undefined;
try {
  launcher = resolveCodexBinPath();
} catch {
  /* Optional native runtime. */
}
const acceptanceIt = launcher || process.env.CI ? it : it.skip;

interface ProviderRequest {
  tools?: Array<{
    type: string;
    name?: string;
    tools?: Array<{ name: string }>;
  }>;
  input?: Array<{ type: string; call_id?: string; output?: unknown }>;
}

acceptanceIt(
  'admits an MCP server through native Codex and returns its PNG to the model and host (codex-74)',
  async () => {
    expect(
      launcher,
      'The native Codex target must be installed in CI',
    ).toBeDefined();
    const version = spawnSync(process.execPath, [launcher!, '--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (version.error) throw version.error;
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(
      `codex-cli ${AGENT_RUNTIME_TARGETS.codex[0]!.tested}`,
    );

    const root = await mkdtemp(join(tmpdir(), 'cligent-codex-mcp-'));
    const home = join(root, 'codex-home');
    const events: AgentEvent[] = [];
    const requests: ProviderRequest[] = [];
    const serverErrors: unknown[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const provider = createServer(async (request, response) => {
      try {
        if (request.url !== '/v1/responses') {
          serverErrors.push(
            new Error(`Unexpected provider path: ${request.url}`),
          );
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest,
        );
        const index = requests.length;
        if (index > 2) throw new Error('Unexpected extra provider request');
        const item =
          index === 1
            ? {
                id: 'fc_capture',
                type: 'function_call',
                call_id: 'call_capture',
                namespace: 'mcp__review',
                name: 'capture',
                arguments: '{}',
                status: 'completed',
              }
            : {
                id: 'msg_explanation',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  { type: 'output_text', text: EXPLANATION, annotations: [] },
                ],
              };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        let sequence = 0;
        const send = (type: string, value: Record<string, unknown>) =>
          response.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`,
          );
        send('response.created', {
          response: {
            id: `resp_${index}`,
            object: 'response',
            status: 'in_progress',
            output: [],
          },
        });
        send('response.output_item.added', { output_index: 0, item });
        if (index === 2)
          send('response.output_text.delta', {
            item_id: 'msg_explanation',
            output_index: 0,
            content_index: 0,
            delta: EXPLANATION,
          });
        send('response.output_item.done', { output_index: 0, item });
        send('response.completed', {
          response: {
            id: `resp_${index}`,
            object: 'response',
            status: 'completed',
            output: [item],
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
          },
        });
        response.end();
      } catch (error) {
        serverErrors.push(error);
        response.writeHead(500).end();
      }
    });
    try {
      await mkdir(home);
      await new Promise<void>((resolve, reject) => {
        provider.once('error', reject);
        provider.listen(0, '127.0.0.1', resolve);
      });
      const address = provider.address();
      if (!address || typeof address === 'string')
        throw new Error('No local provider address');
      await writeFile(
        join(home, 'config.toml'),
        [
          'model_provider = "fixture"',
          'model = "gpt-5"',
          '[model_providers.fixture]',
          'name = "Local fixture provider"',
          `base_url = "http://127.0.0.1:${address.port}/v1"`,
          'wire_api = "responses"',
          'requires_openai_auth = false',
        ].join('\n'),
      );
      const mcpPath = join(root, 'mcp.cjs');
      const mcpLog = join(root, 'mcp.log');
      await writeFile(
        mcpPath,
        `
      const fs = require('node:fs');
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(mcpLog)}, request.method + '\\n');
        if (!('id' in request)) return;
        const result = request.method === 'initialize'
          ? {protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
          : request.method === 'tools/list'
            ? {tools:[{name:'capture',description:'Return the fixture screenshot.',inputSchema:{type:'object',properties:{}}}]}
            : request.method === 'tools/call'
              ? {content:[{type:'text',text:'Screenshot captured.'},{type:'image',mimeType:'image/png',data:${JSON.stringify(PNG)}}]}
              : {};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result}) + '\\n');
      });
    `,
      );
      // Only process/platform plumbing enters the native CLI; no real credentials,
      // user configuration, proxy settings, or production provider endpoints.
      const env = Object.fromEntries(
        Object.entries({
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATHEXT: process.env.PATHEXT,
          HOME: root,
          CODEX_HOME: home,
          TMPDIR: root,
          TEMP: root,
          TMP: root,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const adapter = new CodexAdapter({
        loadSdk: async () => ({
          Codex: class extends Codex {
            constructor(options: ConstructorParameters<typeof Codex>[0]) {
              super({
                ...options,
                env,
                config: { features: { tool_search: false } },
              });
            }
          },
        }),
      });
      for await (const event of new Cligent(adapter, {
        cwd: root,
        mcpServers: {
          review: { type: 'stdio', command: process.execPath, args: [mcpPath] },
        },
      }).run('Capture the fixture screenshot and explain its color.', {
        model: 'gpt-5',
        abortSignal: controller.signal,
      }))
        events.push(event);

      const diagnostics = JSON.stringify(
        { events, requests, serverErrors },
        null,
        2,
      );
      expect(serverErrors, diagnostics).toEqual([]);
      expect(
        events.filter((event) => event.type === 'error'),
        diagnostics,
      ).toEqual([]);
      expect(requests, diagnostics).toHaveLength(2);
      expect(requests[0]?.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'namespace',
            name: 'mcp__review',
            tools: expect.arrayContaining([
              expect.objectContaining({ name: 'capture' }),
            ]),
          }),
        ]),
      );
      expect(await readFile(mcpLog, 'utf8')).toContain('tools/call\n');
      expect(
        requests[1]?.input?.find(
          (item) =>
            item.type === 'function_call_output' &&
            item.call_id === 'call_capture',
        )?.output,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'input_image',
            image_url: `data:image/png;base64,${PNG}`,
          }),
        ]),
      );
      const media = events.filter((event) => event.type === 'media');
      expect(media).toHaveLength(1);
      expect(media[0]?.payload).toMatchObject({
        mimeType: 'image/png',
        source: { type: 'base64', data: PNG },
      });
      expect(
        events.find((event) => event.type === 'tool_result')?.payload,
      ).toMatchObject({
        status: 'success',
        toolName: 'review.capture',
        toolUseId: media[0]?.payload.toolUseId,
      });
      expect(events.find((event) => event.type === 'text')?.payload).toEqual({
        content: EXPLANATION,
      });
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(events.at(-1)?.payload).toMatchObject({
        status: 'success',
        usage: { toolUses: 1 },
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      // Native background handles can outlive the terminal SDK event.
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    }
  },
  60_000,
);
