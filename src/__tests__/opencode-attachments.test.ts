// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpencodeClient as createV1Client } from '@opencode-ai/sdk';
import { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2';
import { describe, expect, it, vi } from 'vitest';

import { OpenCodeAdapter, wrapOpencodeClient } from '../adapters/opencode.js';
import { Cligent } from '../cligent.js';
import type { AgentEvent } from '../types.js';

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('OpenCode attachments (opencode-58 / opencode-59)', () => {
  it.each([
    ['v1', 'promptAsync'],
    ['v1', 'prompt'],
    ['v2', 'promptAsync'],
    ['v2', 'prompt'],
  ] as const)(
    'sends local files through the installed %s SDK %s HTTP codec and preserves resume',
    async (apiVersion, promptRoute) => {
      const cwd = await mkdtemp(join(tmpdir(), 'cligent-opencode-media-'));
      const files = [
        { path: 'display #1.png', mime: 'image/png', data: 'image bytes' },
        { path: 'clip.mp4', mime: 'video/mp4', data: 'video bytes' },
        { path: 'voice.wav', mime: 'audio/wav', data: 'audio bytes' },
        { path: 'report.pdf', mime: 'application/pdf', data: 'pdf bytes' },
        { path: 'notes.txt', mime: 'text/plain', data: 'text content' },
        { path: 'custom.bin', mime: 'image/webp', data: 'custom bytes' },
      ];
      await Promise.all(
        files.map((file) => writeFile(join(cwd, file.path), file.data)),
      );
      const prompts: Array<{ body: Record<string, unknown>; url: URL }> = [];
      const subscribers = new Set<ServerResponse>();
      let sessionsCreated = 0;
      const server = createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url!, 'http://localhost');
          if (url.pathname === '/event') {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.write(
              'data: {"type":"server.connected","properties":{}}\n\n',
            );
            subscribers.add(response);
            response.on('close', () => subscribers.delete(response));
            return;
          }
          if (
            request.method === 'POST' &&
            (url.pathname.endsWith('/prompt_async') ||
              url.pathname.endsWith('/message'))
          ) {
            let body = '';
            for await (const chunk of request) body += String(chunk);
            prompts.push({ body: JSON.parse(body), url });
            response.writeHead(204).end();
            for (const subscriber of subscribers) {
              subscriber.write(
                'data: {"type":"session.idle","properties":{"sessionID":"media-session"}}\n\n',
              );
            }
            return;
          }
          let data: unknown = true;
          if (url.pathname === '/global/health') {
            data = { healthy: true, version: '1.18.33' };
          } else if (url.pathname === '/session' && request.method === 'POST') {
            sessionsCreated++;
            data = { id: 'media-session', title: 'Cligent run' };
          } else if (url.pathname.endsWith('/children')) {
            data = [];
          } else if (url.pathname === '/session/media-session') {
            data = { id: 'media-session', title: 'Cligent run' };
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(data));
        })().catch((error: unknown) => {
          response.writeHead(500).end(String(error));
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const serverUrl = `http://127.0.0.1:${address.port}`;
      const adapter = new OpenCodeAdapter(
        { mode: 'external', serverUrl },
        {
          loadSdk: async () => ({
            createClient: () => {
              const real =
                apiVersion === 'v1'
                  ? createV1Client({ baseUrl: serverUrl })
                  : createV2Client({ baseUrl: serverUrl });
              if (promptRoute === 'prompt') {
                Object.defineProperty(real.session, 'promptAsync', {
                  value: undefined,
                });
              }
              return wrapOpencodeClient(
                real as unknown as Record<string, unknown>,
                { apiVersion },
              );
            },
          }),
        },
      );
      const cligent = new Cligent(adapter, { cwd });
      try {
        const first = await collect(
          cligent.run('Inspect all attached files.\nPreserve this prompt.', {
            attachments: files.map((file) => ({
              path: file.path,
              ...(file.path.endsWith('.bin') ? { mimeType: file.mime } : {}),
            })),
          }),
        );
        expect(first.filter((event) => event.type === 'done')).toHaveLength(1);
        expect(first.at(-1)?.payload).toMatchObject({ status: 'success' });
        expect(prompts[0]?.body.parts).toEqual([
          {
            type: 'text',
            text: 'Inspect all attached files.\nPreserve this prompt.',
          },
          ...files.map((file) => ({
            type: 'file',
            filename: file.path,
            mime: file.mime,
            url: `data:${file.mime};base64,${Buffer.from(file.data).toString('base64')}`,
          })),
        ]);
        expect(prompts[0]?.url.searchParams.get('directory')).toBe(cwd);
        expect(prompts[0]?.body.messageID).toMatch(
          /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
        );

        const resumed = await collect(cligent.run('Continue without files.'));
        expect(resumed.at(-1)?.payload).toMatchObject({ status: 'success' });
        expect(sessionsCreated).toBe(1);
        expect(prompts[1]?.body.parts).toEqual([
          { type: 'text', text: 'Continue without files.' },
        ]);
        const empty = await collect(
          cligent.run('Explicit empty attachments.', { attachments: [] }),
        );
        expect(empty.at(-1)?.payload).toMatchObject({ status: 'success' });
        expect(prompts[2]?.body.parts).toEqual([
          { type: 'text', text: 'Explicit empty attachments.' },
        ]);
      } finally {
        for (const subscriber of subscribers) subscriber.end();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it('rejects invalid attachments before loading a backend and honors pre-abort', async () => {
    const loadSdk = vi.fn();
    const adapter = new OpenCodeAdapter({ mode: 'external' }, { loadSdk });
    await expect(
      collect(
        adapter.run('inspect', { attachments: [{ path: '/missing.png' }] }),
      ),
    ).rejects.toThrow();
    expect(loadSdk).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      adapter.run('inspect', {
        attachments: [{ path: '/missing.png' }],
        abortSignal: controller.signal,
      }),
    );
    expect(events.at(-1)?.payload).toMatchObject({ status: 'interrupted' });
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('rejects attachments on legacy run/query clients instead of dropping them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cligent-opencode-legacy-'));
    await writeFile(join(cwd, 'image.png'), 'image bytes');
    const run = vi.fn();
    const adapter = new OpenCodeAdapter(
      { mode: 'external' },
      { loadSdk: async () => ({ createClient: () => ({ run }) }) },
    );
    try {
      const events = await collect(
        adapter.run('inspect', { cwd, attachments: [{ path: 'image.png' }] }),
      );
      expect(run).not.toHaveBeenCalled();
      expect(
        events.find((event) => event.type === 'error')?.payload,
      ).toMatchObject({
        message: expect.stringContaining(
          'legacy run/query client cannot transport',
        ),
      });
      expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
