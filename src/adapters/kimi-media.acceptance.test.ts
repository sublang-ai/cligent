// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Cligent } from '../cligent.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import type { AgentEvent } from '../types.js';
import { KimiAdapter } from './kimi.js';

const version = spawnSync('kimi', ['--version'], {
  encoding: 'utf8',
  timeout: 10_000,
});
const available =
  (version.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';
const acceptanceIt = available || process.env.CI ? it : it.skip;
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

interface ProviderRequest {
  stream?: boolean;
  messages: Array<{ role: string; content: unknown }>;
}

describe('Kimi native image input (kimi-42)', () => {
  acceptanceIt(
    'delivers exact image bytes through Cligent and the target CLI to a local provider',
    async () => {
      // An installed but wrong or broken runtime must fail, even outside CI.
      if (version.error) throw version.error;
      expect(version.status, version.stderr).toBe(0);
      expect(version.stdout.trim()).toBe(AGENT_RUNTIME_TARGETS.kimi[0]!.tested);

      const cwd = await mkdtemp(join(tmpdir(), 'cligent-kimi-media-'));
      const requests: Array<{
        path: string | undefined;
        body: ProviderRequest;
      }> = [];
      const serverErrors: unknown[] = [];
      const server = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('end', () => {
          try {
            const parsed = JSON.parse(body) as ProviderRequest;
            requests.push({ path: request.url, body: parsed });
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const [delta, finishReason] of [
              [{ role: 'assistant', content: 'Image accepted.' }, null],
              [{}, 'stop'],
            ]) {
              response.write(
                `data: ${JSON.stringify({
                  id: 'cligent-fixture',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: 'kimi-k3',
                  choices: [{ index: 0, delta, finish_reason: finishReason }],
                })}\n\n`,
              );
            }
            response.end('data: [DONE]\n\n');
          } catch (error) {
            serverErrors.push(error);
            response.writeHead(500).end();
          }
        });
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25_000);
      let child: ChildProcessWithoutNullStreams | undefined;
      let childClosed: Promise<void> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Local provider did not bind a TCP port');
        }
        await writeFile(join(cwd, 'pixel.png'), Buffer.from(png, 'base64'));
        // Keep only executable/platform plumbing; no user credentials, native
        // config overrides, proxy settings, or real provider URLs reach Kimi.
        const env: NodeJS.ProcessEnv = {
          ...Object.fromEntries(
            [
              'PATH',
              'SystemRoot',
              'WINDIR',
              'PATHEXT',
              'TMPDIR',
              'TEMP',
              'TMP',
            ].map((key) => [key, process.env[key]]),
          ),
          KIMI_CODE_HOME: join(cwd, 'kimi-home'),
          KIMI_MODEL_NAME: 'kimi-k3',
          KIMI_MODEL_API_KEY: 'cligent-local-fixture',
          KIMI_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          KIMI_MODEL_PROVIDER_TYPE: 'kimi',
          NO_COLOR: '1',
        };
        const adapter = new KimiAdapter({
          spawnProcess(command, args, options) {
            child = spawn(command, [...args], {
              ...options,
              env,
            }) as ChildProcessWithoutNullStreams;
            childClosed = new Promise((resolve) => {
              child!.once('close', () => resolve());
            });
            return child;
          },
        });
        const events: AgentEvent[] = [];
        for await (const event of new Cligent(adapter, { cwd }).run(
          'Describe the attached image.',
          {
            attachments: [{ path: 'pixel.png' }],
            abortSignal: controller.signal,
          },
        )) {
          events.push(event);
        }

        expect(serverErrors).toEqual([]);
        expect(events.filter((event) => event.type === 'error')).toEqual([]);
        expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
        expect(events.at(-1)?.payload).toMatchObject({
          status: 'success',
          result: 'Image accepted.',
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          path: '/v1/chat/completions',
          body: { stream: true },
        });
        const userParts = requests[0]!.body.messages
          .filter((message) => message.role === 'user')
          .flatMap((message) => message.content);
        expect(userParts).toContainEqual({
          type: 'text',
          text: 'Describe the attached image.',
        });
        expect(userParts).toContainEqual({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${png}` },
        });
        expect(child).toBeDefined();
        expect(child!.exitCode !== null || child!.signalCode !== null).toBe(
          true,
        );
      } finally {
        clearTimeout(timeout);
        controller.abort();
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await childClosed;
        }
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(cwd, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
