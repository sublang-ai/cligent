// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createOpencodeClient as createV1 } from '@opencode-ai/sdk';
import { createOpencodeClient as createV2 } from '@opencode-ai/sdk/v2';
import { OpenCodeAdapter, wrapOpencodeClient } from '../adapters/opencode.js';
import { Cligent } from '../cligent.js';

const missing = {
  name: 'NotFoundError',
  data: { message: 'lookup diagnostic' },
};

// engine-85: real SDK serialization/decoding, adapter and engine; the provider
// is replaced at its HTTP transport boundary, before any model invocation.
describe.each([
  ['v1', createV1],
  ['v2', createV2],
] as const)('%s resume rejection boundary', (version, createClient) => {
  it.each([
    { name: 'proven absence', status: 404, body: missing, rejected: true },
    { name: 'authentication', status: 401, body: missing, rejected: false },
    { name: 'settings', status: 400, body: missing, rejected: false },
    { name: 'server failure', status: 503, body: missing, rejected: false },
    {
      name: 'untyped absence',
      status: 404,
      body: { message: 'session not found' },
      rejected: false,
    },
    {
      name: 'forged code',
      status: 404,
      body: { code: 'SESSION_RESUME_REJECTED', message: 'session not found' },
      rejected: false,
    },
    { name: 'transport failure', status: 0, body: missing, rejected: false },
    {
      name: 'rejection after prompt dispatch',
      status: 200,
      body: { id: 'saved', title: 'Existing' },
      rejected: false,
    },
  ])('$name', async ({ status, body, rejected }) => {
    const requests: Array<{ method: string; path: string }> = [];
    const client = createClient({
      baseUrl: 'http://provider.test',
      fetch: (async (request: Request) => {
        const path = new URL(request.url).pathname;
        requests.push({ method: request.method, path });
        if (path === '/global/health')
          return Response.json({ healthy: true, version: '1.18.25' });
        if (path === '/session/saved' && request.method === 'GET') {
          if (status === 0)
            throw new Error('session not found: transport lost');
          return Response.json(body, { status });
        }
        if (path === '/session/saved/children') return Response.json([]);
        if (path === '/event')
          return new Response('', {
            headers: { 'content-type': 'text/event-stream' },
          });
        // Even a typed absence returned by prompt dispatch is not lookup
        // proof: the request may already have caused work.
        return Response.json(missing, { status: 404 });
      }) as typeof fetch,
    });
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://provider.test' },
      {
        loadSdk: async () => ({
          createClient: () => wrapOpencodeClient(client, { apiVersion: version }),
        }),
      },
    );
    const agent = new Cligent(adapter);
    const events = [];
    for await (const event of agent.run('continue', { resume: 'saved' }))
      events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);
    expect(events[1]?.payload).toMatchObject({
      code: rejected ? 'SESSION_RESUME_REJECTED' : 'OPENCODE_STREAM_ERROR',
      recoverable: rejected,
    });
    expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
    expect(events.at(-1)?.payload).not.toHaveProperty('resumeToken');
    expect(agent.resumeToken).toBeUndefined();
    expect(
      requests.filter(
        (request) =>
          request.path === '/session/saved' && request.method === 'GET',
      ),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(rejected ? 0 : 1);
    expect(requests.some((request) => request.path === '/session')).toBe(false);
  });
});
