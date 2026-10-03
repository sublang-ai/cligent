// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { Cligent } from '../cligent.js';
import { runAgent, runParallel } from '../engine.js';
import { createEvent } from '../events.js';
import {
  normalizeMcpServers,
  prepareMcpServers,
  type McpServers,
} from '../mcp.js';
import { AdapterRegistry } from '../registry.js';
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

/** Records the options it receives, then admits the map without a browser. */
function recordingAdapter(agent: string) {
  const calls: AgentOptions[] = [];
  const adapter: AgentAdapter = {
    agent,
    isAvailable: async () => true,
    async *run(_prompt, options) {
      calls.push(options ?? {});
      normalizeMcpServers(options?.mcpServers);
      yield createEvent('done', agent, {
        status: 'success',
        usage: { toolUses: 0 },
        durationMs: 0,
      });
    },
  };
  return { adapter, calls };
}

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function doneStatuses(events: AgentEvent[]) {
  return events
    .filter((event) => event.type === 'done')
    .map((event) => [event.agent, event.payload.status]);
}

const first: McpServers = {
  one: { type: 'stdio', command: 'server', args: ['a'] },
};
const second: McpServers = {
  two: { type: 'http', url: 'https://example.com/mcp' },
};
const invalid = {
  bad: { type: 'stdio', command: '' },
} as unknown as McpServers;

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

  it('forwards per-task maps and browser selection unchanged through registered and both parallel paths', async () => {
    const a = recordingAdapter('custom-a');
    const b = recordingAdapter('custom-b');
    const empty: McpServers = {};
    const registry = new AdapterRegistry();
    registry.register(a.adapter);
    await collect(
      runAgent(
        'custom-a',
        'registered',
        { mcpServers: first, browser: true },
        registry,
      ),
    );
    await collect(
      runParallel([
        {
          adapter: a.adapter,
          prompt: 'a',
          options: { mcpServers: first, browser: true },
        },
        {
          adapter: b.adapter,
          prompt: 'b',
          options: { mcpServers: empty, browser: false },
        },
      ]),
    );
    await collect(
      Cligent.parallel([
        {
          agent: new Cligent(a.adapter),
          prompt: 'a',
          overrides: { mcpServers: first, browser: true },
        },
        {
          agent: new Cligent(b.adapter),
          prompt: 'b',
          overrides: { mcpServers: second, browser: false },
        },
      ]),
    );
    expect(a.calls).toHaveLength(3);
    for (const call of a.calls) {
      expect(call.mcpServers).toBe(first);
      expect(call.browser).toBe(true);
    }
    expect(b.calls).toHaveLength(2);
    expect(b.calls[0]!.mcpServers).toBe(empty);
    expect(b.calls[1]!.mcpServers).toBe(second);
    expect(b.calls.map((call) => call.browser)).toEqual([false, false]);
    expect(first.one).toEqual({
      type: 'stdio',
      command: 'server',
      args: ['a'],
    });
  });

  it('replaces instance maps and disables a browser default per parallel task', async () => {
    const a = recordingAdapter('custom-a');
    const b = recordingAdapter('custom-b');
    const empty: McpServers = {};
    await collect(
      Cligent.parallel([
        {
          agent: new Cligent(a.adapter, { mcpServers: first, browser: true }),
          prompt: 'a',
          overrides: { mcpServers: empty, browser: false },
        },
        {
          agent: new Cligent(b.adapter, { mcpServers: second, browser: true }),
          prompt: 'b',
        },
      ]),
    );
    expect(a.calls[0]!.mcpServers).toBe(empty);
    expect(a.calls[0]!.browser).toBe(false);
    expect(b.calls[0]!.mcpServers).toBe(second);
    expect(b.calls[0]!.browser).toBe(true);
  });

  it('isolates a rejected server map from its sibling on both parallel paths', async () => {
    const rejecting = recordingAdapter('custom-bad');
    const working = recordingAdapter('custom-good');
    const engineEvents = await collect(
      runParallel([
        {
          adapter: rejecting.adapter,
          prompt: 'bad',
          options: { mcpServers: invalid },
        },
        {
          adapter: working.adapter,
          prompt: 'good',
          options: { mcpServers: first },
        },
      ]),
    );
    const cligentEvents = await collect(
      Cligent.parallel([
        {
          agent: new Cligent(rejecting.adapter),
          prompt: 'bad',
          overrides: { mcpServers: invalid },
        },
        {
          agent: new Cligent(working.adapter),
          prompt: 'good',
          overrides: { mcpServers: first },
        },
      ]),
    );
    for (const events of [engineEvents, cligentEvents]) {
      expect(doneStatuses(events)).toEqual(
        expect.arrayContaining([
          ['custom-bad', 'error'],
          ['custom-good', 'success'],
        ]),
      );
      expect(events.filter((event) => event.type === 'done')).toHaveLength(2);
      expect(
        events.find(
          (event) => event.type === 'error' && event.agent === 'custom-bad',
        )?.payload,
      ).toMatchObject({ code: 'ADAPTER_ERROR' });
    }
    expect(working.calls.map((call) => call.mcpServers)).toEqual([
      first,
      first,
    ]);
  });

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
