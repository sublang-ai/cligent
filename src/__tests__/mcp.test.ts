// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { Cligent } from '../cligent.js';
import { createEvent } from '../events.js';
import { prepareMcpServers } from '../mcp.js';
import type { AgentAdapter, AgentEvent, AgentOptions } from '../types.js';

function adapter(calls: AgentOptions[]): AgentAdapter {
  return {
    agent: 'custom',
    isAvailable: async () => true,
    async *run(_prompt, options) {
      const servers = await prepareMcpServers(options);
      calls.push({ ...options, mcpServers: servers });
      yield createEvent('done', 'custom', {
        status: 'success',
        usage: { toolUses: 0 },
        durationMs: 0,
      });
    },
  };
}

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('caller MCP option pipeline', () => {
  it('replaces maps, preserves defaults across calls, clones configuration and disables a browser default', async () => {
    const calls: AgentOptions[] = [];
    const servers = {
      one: {
        type: 'stdio' as const,
        command: 'server',
        args: ['a'],
        env: { MODE: 'test' },
      },
    };
    const instance = new Cligent(adapter(calls), {
      mcpServers: servers,
      browser: true,
    });
    await collect(instance.run('first', { browser: false }));
    await collect(instance.run('second', { browser: false, mcpServers: {} }));
    await collect(instance.run('third', { browser: false }));
    expect(calls.map((call) => call.mcpServers)).toEqual([
      servers,
      {},
      servers,
    ]);
    expect(calls[0]!.mcpServers).not.toBe(servers);
    expect(calls[0]!.mcpServers!.one).not.toBe(servers.one);
    expect(calls.every((call) => call.browser === false)).toBe(true);
    expect(servers.one.args).toEqual(['a']);
  });

  it.each([
    { mcpServers: [] },
    { mcpServers: { bad: { type: 'stdio', command: '' } } },
    {
      mcpServers: { bad: { type: 'stdio', command: 'server', args: Array(1) } },
    },
    {
      mcpServers: {
        bad: { type: 'stdio', command: 'server', env: { 'A=B': 'secret' } },
      },
    },
    { mcpServers: { bad: { type: 'http', url: 'file:///private/file' } } },
    {
      mcpServers: {
        bad: { type: 'http', url: 'https://user:secret@example.com' },
      },
    },
    {
      mcpServers: {
        bad: {
          type: 'http',
          url: 'https://example.com',
          headers: { Authorization: 'secret\r\nx:y' },
        },
      },
    },
    { mcpServers: { constructor: { type: 'stdio', command: 'server' } } },
    { mcpServers: { 'bad.name': { type: 'stdio', command: 'server' } } },
    { mcpServers: { bad: { type: 'sse', url: 'https://example.com' } } },
    { browser: 'yes' },
    {
      browser: true,
      mcpServers: { cligent_browser: { type: 'stdio', command: 'server' } },
    },
  ])(
    'rejects malformed configuration before execution and preserves parallel siblings: %j',
    async (input) => {
      const calls: AgentOptions[] = [];
      const bad = new Cligent(adapter(calls));
      const good = new Cligent(adapter(calls));
      const [failed, passed] = await Promise.all([
        collect(bad.run('bad', input as unknown as AgentOptions)),
        collect(good.run('good', { browser: false })),
      ]);
      expect(failed.at(-1)).toMatchObject({
        type: 'done',
        payload: { status: 'error' },
      });
      expect(JSON.stringify(failed)).not.toContain('secret');
      expect(passed.at(-1)).toMatchObject({
        type: 'done',
        payload: { status: 'success' },
      });
      expect(calls).toHaveLength(1);
    },
  );

  it('transports HTTP headers without mutating the supplied map', async () => {
    const calls: AgentOptions[] = [];
    const config = {
      api: {
        type: 'http' as const,
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer secret' },
      },
    };
    await collect(
      new Cligent(adapter(calls)).run('go', { mcpServers: config }),
    );
    expect(calls[0]!.mcpServers).toEqual(config);
    expect(calls[0]!.mcpServers!.api).not.toBe(config.api);
  });
});
