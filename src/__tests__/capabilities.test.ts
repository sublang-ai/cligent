// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cligent } from '../cligent.js';
import { ATTACHMENT_SUPPORT } from '../attachments.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import { KimiAdapter } from '../adapters/kimi.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { createEvent } from '../events.js';
import type { AgentAdapter, AgentOptions } from '../types.js';

function fixtureAdapter(
  options: {
    known?: boolean;
    available?: () => Promise<boolean>;
    inspect?: (value?: AgentOptions) => void;
  } = {},
): AgentAdapter {
  return {
    // A custom name identical to a built-in must not inherit its facts.
    agent: 'codex',
    ...(options.known
      ? {
          getCapabilities(value?: AgentOptions) {
            options.inspect?.(value);
            return { browser: { status: 'supported' as const } };
          },
        }
      : {}),
    isAvailable: options.available ?? (async () => false),
    async *run() {
      yield createEvent(
        'init',
        'codex',
        { sessionId: 'kept-session' },
        'kept-session',
      );
      yield createEvent('done', 'codex', { status: 'success' }, 'kept-session');
    },
  };
}

describe('host capability and preparation contract', () => {
  it('returns unknown custom facts without inference, runtime calls, or continuity changes', async () => {
    let checked = false;
    const client = new Cligent(
      fixtureAdapter({
        available: async () => {
          checked = true;
          return true;
        },
      }),
    );
    for await (const event of client.run('establish continuity')) void event;
    const token = client.resumeToken;
    expect(await client.getCapabilities()).toEqual({
      browser: { status: 'unknown' },
    });
    expect(await client.prepareBrowser()).toMatchObject({
      status: 'not-ready',
      code: 'unknown-capability',
    });
    expect(checked).toBe(false);
    expect(client.resumeToken).toBe(token);
  });

  it('passes merged execution context to the optional hook without changing defaults', async () => {
    const seen: Array<AgentOptions | undefined> = [];
    const client = new Cligent(
      fixtureAdapter({ known: true, inspect: (value) => seen.push(value) }),
      {
        cwd: '/default',
        browser: true,
        mcpServers: { first: { type: 'stdio', command: 'first' } },
      },
    );
    await client.getCapabilities({
      cwd: '/override',
      browser: false,
      mcpServers: {},
    });
    await client.getCapabilities();
    expect(seen[0]).toMatchObject({
      cwd: '/override',
      browser: false,
      mcpServers: {},
    });
    expect(seen[1]).toMatchObject({
      cwd: '/default',
      browser: true,
      mcpServers: { first: { command: 'first' } },
    });
  });

  it('reports exact built-in attachment descriptors and shared MCP validation without runtime startup', async () => {
    const adapters = [
      new ClaudeCodeAdapter(),
      new CodexAdapter(),
      new GeminiAdapter(),
      new KimiAdapter(),
      new OpenCodeAdapter(),
    ];
    const cwd = await mkdtemp(join(tmpdir(), 'cligent-capabilities-'));
    try {
      for (const adapter of adapters) {
        const client = new Cligent(adapter);
        const facts = await client.getCapabilities({ cwd });
        expect(facts.attachments).toBe(
          ATTACHMENT_SUPPORT[adapter.agent as keyof typeof ATTACHMENT_SUPPORT],
        );
        expect(facts.browser).toEqual({ status: 'supported' });
        expect(facts.approvals).toMatchObject(
          adapter.agent === 'codex' || adapter.agent === 'gemini'
            ? { status: 'unsupported', code: 'unsupported-transport' }
            : { status: 'supported' },
        );
        expect(
          await client.getCapabilities({
            cwd,
            mcpServers: {
              cligent_browser: { type: 'stdio', command: 'collision' },
            },
          }),
        ).toMatchObject({
          browser: { status: 'unsupported', code: 'unsupported-option' },
        });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects context conflicts before runtime discovery or browser work', async () => {
    const claude = new Cligent(new ClaudeCodeAdapter(), { allowedTools: [] });
    expect(await claude.getCapabilities()).toMatchObject({
      browser: { status: 'unsupported', code: 'tool-restriction' },
    });
    expect(await claude.prepareBrowser()).toMatchObject({
      status: 'not-ready',
      code: 'tool-restriction',
    });
    expect(
      await new Cligent(
        new OpenCodeAdapter({ mode: 'external' }),
      ).prepareBrowser(),
    ).toMatchObject({ status: 'not-ready', code: 'unsupported-server-mode' });
    expect(
      await new Cligent(new CodexAdapter()).getCapabilities({
        allowedTools: [],
      }),
    ).toMatchObject({
      browser: { status: 'unsupported', code: 'tool-restriction' },
    });
  });

  it('refuses unavailable runtime and invalid deadline without preparing a browser', async () => {
    let inspections = 0;
    const client = new Cligent(
      fixtureAdapter({
        known: true,
        inspect: () => {
          inspections++;
        },
      }),
    );
    expect(await client.prepareBrowser()).toMatchObject({
      status: 'not-ready',
      code: 'runtime-unavailable',
    });
    expect(inspections).toBe(1);
    for (const timeoutMs of [0, -1, Number.NaN, Infinity, 2_147_483_648]) {
      await expect(client.prepareBrowser({ timeoutMs })).rejects.toThrow(
        'timeoutMs',
      );
    }
    expect(inspections).toBe(1);
    await expect(
      client.prepareBrowser({
        timeoutMs: 2_147_483_647,
        abortSignal: AbortSignal.abort(),
      }),
    ).resolves.toEqual({ status: 'cancelled' });
    await expect(
      client.prepareBrowser({ onProgress: 'invalid' } as never),
    ).rejects.toThrow('onProgress');
  });

  it('cancels or times out runtime discovery independently from ordinary runs', async () => {
    const client = new Cligent(
      fixtureAdapter({ known: true, available: () => new Promise(() => {}) }),
    );
    const controller = new AbortController();
    const pending = client.prepareBrowser({ abortSignal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(await client.prepareBrowser({ timeoutMs: 20 })).toMatchObject({
      status: 'not-ready',
      code: 'timeout',
    });
    const events = [];
    for await (const event of client.run('still works')) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      payload: { status: 'success' },
    });
  });
});
