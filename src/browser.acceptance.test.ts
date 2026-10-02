// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createServer } from 'node:http';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { prepareMcpServers } from './mcp.js';
import { releaseBrowserServer } from './browser.js';
import type { McpServerConfig } from './mcp.js';
import { Cligent } from './cligent.js';
import { CodexAdapter } from './adapters/codex.js';

it('prepares the packaged browser, navigates to a local app, and returns a real screenshot', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cligent-browser-output-'));
  const server = createServer((_req, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><html><head><title>Cligent UX preview</title></head><body><h1>Browser screenshot acceptance</h1><button>Continue</button></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server address');
  const client = new Client({
    name: 'cligent-browser-acceptance',
    version: '1.0.0',
  });
  let transport: StdioClientTransport | undefined;
  let browserConfig: McpServerConfig | undefined;
  let outputDir: string | undefined;
  try {
    const progress: string[] = [];
    const setup = await new Cligent(new CodexAdapter()).prepareBrowser({
      onProgress: ({ stage }) => progress.push(stage),
    });
    expect(setup).toMatchObject({
      status: 'ready',
      checkedAt: expect.any(Number),
    });
    expect(progress[0]).toBe('checking');
    expect(progress.at(-1)).toBe('launching');
    const config = (await prepareMcpServers({ browser: true }))!
      .cligent_browser!;
    browserConfig = config;
    if (config.type !== 'stdio')
      throw new Error('Expected packaged stdio browser');
    outputDir = config.args![config.args!.indexOf('--output-dir') + 1];
    expect(outputDir!.startsWith(cwd)).toBe(false);
    transport = new StdioClientTransport({
      command: config.command,
      args: [...(config.args ?? [])],
      cwd,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ...config.env,
      },
      stderr: 'pipe',
    });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(
      tools.tools.some((tool) => tool.name === 'browser_take_screenshot'),
    ).toBe(true);
    const navigation = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: `http://127.0.0.1:${address.port}` },
    });
    expect(navigation.isError).not.toBe(true);
    expect(JSON.stringify(navigation.content)).toContain('Cligent UX preview');
    const screenshot = await client.callTool({
      name: 'browser_take_screenshot',
      arguments: { type: 'png' },
    });
    expect(screenshot.isError).not.toBe(true);
    const images = (
      screenshot.content as Array<{
        type: string;
        mimeType?: string;
        data?: string;
      }>
    ).filter((block) => block.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe('image/png');
    const bytes = Buffer.from(images[0]!.data!, 'base64');
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.length).toBeGreaterThan(1000);
    expect(await readdir(cwd)).toEqual([]);
    expect(
      (await readdir(outputDir!)).some((name) => name.endsWith('.png')),
    ).toBe(true);
  } finally {
    await client.close();
    await transport?.close();
    if (browserConfig) await releaseBrowserServer(browserConfig);
    if (outputDir) await expect(access(outputDir)).rejects.toThrow();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(cwd, { recursive: true, force: true });
  }
}, 240_000);
