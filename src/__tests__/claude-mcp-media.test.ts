// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ClaudeCodeAdapter,
  mapAgentOptionsToClaudeQueryOptions,
} from '../adapters/claude-code.js';
import { Cligent } from '../cligent.js';
import * as mcp from '../mcp.js';
import type { AgentEvent, AgentOptions } from '../types.js';

const roots: string[] = [];
const SESSION_ID = '81b5a8e2-1fc9-462e-b548-f8b9c99d3f31';
const IMAGE_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8t8AAAAASUVORK5CYII=';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function collect(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function fixture(messages: unknown[], mcpStatuses?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'cligent-claude-mcp-'));
  roots.push(root);
  const script = join(root, 'fixture.mjs');
  const recording = join(root, 'arguments.json');
  await writeFile(
    script,
    `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));
const messages = ${JSON.stringify(messages)};
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id, response: {}
    } });
  } else if (message.type === 'user') {
    send({ type: 'system', subtype: 'init', session_id: '${SESSION_ID}', model: 'fixture', tools: ['mcp__browser__screenshot'], mcp_servers: ${JSON.stringify(mcpStatuses)} });
    for (const result of messages) send({ session_id: '${SESSION_ID}', ...result });
    send({ type: 'result', subtype: 'success', result: 'Checked screenshot', session_id: '${SESSION_ID}',
      is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, total_cost_usd: 0 });
  }
});
lines.on('close', () => process.exit(0));
`,
  );
  const adapter = new ClaudeCodeAdapter({
    probeExecutable: () => ({ state: 'present', path: script }),
    loadSdk: async () => ({
      query(parameters) {
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
  return { adapter, recording };
}

describe('Claude MCP and media through the installed SDK', () => {
  // claude-code-75: real SDK argument serialization and message decoding.
  it.each(['failed', 'needs-auth', 'disabled'])(
    'fails explicitly when a selected MCP server reports %s at initialization',
    async (status) => {
      const { adapter } = await fixture(
        [{ type: 'assistant', text: 'Must not claim browser work succeeded' }],
        [{ name: 'browser', status }],
      );
      const events = await collect(
        adapter.run('Inspect the browser', {
          mcpServers: { browser: { type: 'stdio', command: 'fixture' } },
        }),
      );
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      expect(events[1]?.payload).toMatchObject({
        code: 'SDK_STREAM_ERROR',
        message: expect.stringContaining(`"browser" is unavailable (${status})`),
        recoverable: false,
      });
      expect(events[2]?.payload).toMatchObject({
        status: 'error',
        usage: { toolUses: 0 },
      });
    },
  );

  it.each(['connected', 'pending', 'future-status', undefined])(
    'preserves inconclusive or connected selected MCP status %s and ignores unrelated failures',
    async (status) => {
      const { adapter } = await fixture(
        [],
        [
          { name: 'browser', status },
          { name: 'unrelated', status: 'failed' },
        ],
      );
      const events = await collect(
        adapter.run('Inspect the browser', {
          mcpServers: { browser: { type: 'stdio', command: 'fixture' } },
        }),
      );
      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
    },
  );

  it('preserves no-MCP behavior when the native init reports an unrelated failed server', async () => {
    const { adapter } = await fixture([], [{ name: 'ambient', status: 'failed' }]);
    const events = await collect(adapter.run('Explain this code'));
    expect(events.map((event) => event.type)).toEqual(['init', 'done']);
    expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
  });

  it('admits only explicit servers and forwards correlated screenshot results', async () => {
    const content = [
      { type: 'text', text: 'Screenshot captured' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA },
      },
    ];
    const toolResult = { type: 'tool_result', tool_use_id: 'shot-1', content };
    const { adapter, recording } = await fixture([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'shot-1',
              name: 'mcp__browser__screenshot',
              input: {},
            },
          ],
        },
      },
      {
        type: 'user',
        message: { role: 'user', content: [toolResult] },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        isReplay: true,
        message: { role: 'user', content: [toolResult] },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'The layout is aligned.' }],
        },
      },
    ]);
    const servers = {
      browser: {
        type: 'stdio' as const,
        command: 'node',
        args: ['browser.mjs'],
        env: { BROWSER_MODE: 'isolated' },
      },
      remote: {
        type: 'http' as const,
        url: 'https://example.test/mcp',
        headers: { 'X-Fixture': 'true' },
      },
    };
    const events = await collect(
      new Cligent(adapter).run('Check the page visually.', {
        mcpServers: servers,
        disallowedTools: ['mcp__browser__delete_profile'],
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'media',
      'text',
      'done',
    ]);
    expect(events[2]?.payload).toMatchObject({
      toolName: 'mcp__browser__screenshot',
      toolUseId: 'shot-1',
      status: 'success',
      output: content,
    });
    expect(events[3]?.payload).toEqual({
      mimeType: 'image/png',
      source: { type: 'base64', data: IMAGE_DATA },
      toolUseId: 'shot-1',
    });
    expect(events.at(-1)?.payload).toMatchObject({
      status: 'success',
      usage: { toolUses: 1 },
    });
    const args: string[] = JSON.parse(await readFile(recording, 'utf8'));
    expect(args).toContain('--strict-mcp-config');
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({
      mcpServers: servers,
    });
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(
      'mcp__browser__*,mcp__remote__*',
    );
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(
      'mcp__browser__delete_profile',
    );
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toMatchObject({
      disableClaudeAiConnectors: true,
    });
  });

  it('keeps tool-result errors, handles orphan results, and preserves content ordering', async () => {
    const { adapter } = await fixture([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'known', name: 'Read', input: {} }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'known',
              is_error: true,
              content: 'Read failed',
            },
            { type: 'text', text: 'Do not echo this' },
            {
              type: 'tool_result',
              tool_use_id: 'orphan',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: IMAGE_DATA,
                  },
                },
              ],
            },
          ],
        },
      },
    ]);
    const events = await collect(adapter.run('Read files.'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'tool_result',
      'media',
      'done',
    ]);
    expect(events[2]?.payload).toMatchObject({
      toolName: 'Read',
      toolUseId: 'known',
      status: 'error',
      output: 'Read failed',
    });
    expect(events[3]?.payload).toMatchObject({
      toolName: 'unknown_tool',
      toolUseId: 'orphan',
      status: 'success',
    });
  });

  it('rejects incompatible allowlists before SDK loading or browser preparation', async () => {
    const prepare = vi.spyOn(mcp, 'prepareMcpServers');
    const loadSdk = vi.fn(async () => {
      throw new Error('must not load');
    });
    const adapter = new ClaudeCodeAdapter({ loadSdk });
    for (const allowedTools of [[], ['Read']]) {
      for (const setup of [
        { browser: true },
        {
          mcpServers: { browser: { type: 'stdio' as const, command: 'node' } },
        },
      ]) {
        await expect(
          collect(adapter.run('Inspect', { ...setup, allowedTools })),
        ).rejects.toThrow('cannot combine allowedTools');
      }
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('preserves empty explicit maps and refuses malformed configurations before SDK loading', async () => {
    const { queryOptions, cleanupAbort } = mapAgentOptionsToClaudeQueryOptions({
      mcpServers: {},
      allowedTools: [],
    });
    expect(queryOptions.mcpServers).toEqual({});
    expect(queryOptions.tools).toEqual([]);
    expect(queryOptions.allowedTools).toEqual([]);
    expect(queryOptions.settings?.disableClaudeAiConnectors).toBe(true);
    cleanupAbort();
    const loadSdk = vi.fn(async () => {
      throw new Error('must not load');
    });
    const adapter = new ClaudeCodeAdapter({ loadSdk });
    await expect(
      collect(
        adapter.run('Inspect', {
          mcpServers: { browser: { type: 'stdio', command: '' } },
        } as unknown as AgentOptions),
      ),
    ).rejects.toThrow(/mcpServers|command/);
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('keeps interruption terminal when cancellation races MCP preparation completion', async () => {
    const controller = new AbortController();
    const original = mcp.prepareMcpServers;
    vi.spyOn(mcp, 'prepareMcpServers').mockImplementation(async (options) => {
      const result = await original(options);
      controller.abort();
      return result;
    });
    const loadSdk = vi.fn(async () => {
      throw new Error('must not load');
    });
    const events = await collect(
      new ClaudeCodeAdapter({ loadSdk }).run('Inspect', {
        mcpServers: {},
        abortSignal: controller.signal,
        resume: 'interrupted-resume',
      }),
    );
    expect(events.map((event) => event.type)).toEqual(['done']);
    expect(events[0]?.payload).toMatchObject({
      status: 'interrupted',
      resumeToken: 'interrupted-resume',
      usage: { toolUses: 0 },
    });
    expect(loadSdk).not.toHaveBeenCalled();
  });
});
