// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { GeminiAdapter } from './gemini.js';
import { ATTACHMENT_SUPPORT } from '../attachments.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';

const nativeWindows = process.platform === 'win32';
const version = nativeWindows
  ? undefined
  : spawnSync('gemini', ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
const acceptanceIt =
  nativeWindows || version?.status === 0 || process.env.CI ? it : it.skip;

// Real Gemini CLI and adapter; only the provider is scripted. The binary payloads
// prove transport identity and MIME, not whether a model decodes every format.
acceptanceIt(
  nativeWindows
    ? 'reports unsupported native Windows attachment staging before runtime work (gemini-47)'
    : 'sends every staged media MIME and original byte in order through the pinned native CLI (gemini-50)',
  async () => {
    if (nativeWindows) {
      const capabilities = await new GeminiAdapter().getCapabilities();
      expect(capabilities.attachments?.mimeTypes).toEqual([]);
      expect(capabilities.attachments?.notes).toContain('native Windows');
      return;
    }
    expect(version?.stdout?.trim()).toBe(
      AGENT_RUNTIME_TARGETS.gemini[0]!.tested,
    );
    const root = await mkdtemp(join(tmpdir(), 'cligent-gemini-media-'));
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const temporary = join(root, 'temp space');
    await Promise.all([
      mkdir(workspace),
      mkdir(join(home, '.gemini'), { recursive: true }),
      mkdir(temporary),
    ]);
    await writeFile(
      join(home, '.gemini', 'settings.json'),
      JSON.stringify({
        advanced: { autoConfigureMemory: false },
        privacy: { usageStatisticsEnabled: false },
        security: { auth: { selectedType: 'gemini-api-key' } },
        telemetry: { enabled: false },
      }),
    );
    await writeFile(join(workspace, '.geminiignore'), '**/*.png\n');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNQCt0NRAwQCgAfIgTJbJMJcQAAAABJRU5ErkJggg==',
      'base64',
    );
    const fixtures = ATTACHMENT_SUPPORT.gemini.mimeTypes.map(
      (mimeType, index) => ({
        path: join(workspace, `${index} source [ab] ; \"quoted\".bin`),
        mimeType,
        bytes: Buffer.concat([png, Buffer.from([index])]),
      }),
    );
    fixtures.push({ ...fixtures[0]! });
    await Promise.all(fixtures.map((file) => writeFile(file.path, file.bytes)));
    const requests: Array<{
      url: string;
      body: {
        contents?: Array<{
          parts?: Array<{
            inlineData?: { mimeType: string; data: string };
            text?: string;
          }>;
        }>;
      };
    }> = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ url: request.url ?? '', body });
      if (request.url?.includes('countTokens')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ totalTokens: 10 }));
        return;
      }
      const result = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Native staged attachments received.' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
        modelVersion: 'gemini-3.1-pro-preview',
      };
      if (request.url?.includes('streamGenerateContent')) {
        response.setHeader('content-type', 'text/event-stream');
        response.end(`data: ${JSON.stringify(result)}\n\n`);
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result));
      }
    });
    let stage = '';
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing loopback provider');
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        TMPDIR: temporary,
        HOME: home,
        GEMINI_CLI_HOME: home,
        GEMINI_API_KEY: 'local-fixture-key',
        GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${address.port}`,
        GEMINI_CLI_NO_RELAUNCH: 'true',
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
        NO_COLOR: '1',
      };
      vi.stubEnv('TMPDIR', temporary);
      const adapter = new GeminiAdapter({
        createSettingsOverride: async () => ({
          env: {},
          cleanup: async () => {},
        }),
        createTelemetryCapture: async () => ({
          env: {},
          read: async () => '',
          cleanup: async () => {},
        }),
        spawnProcess: (command, args, options) => {
          expect(options.cwd).toBe(workspace);
          stage = args
            .find((arg) => arg.startsWith('--include-directories='))!
            .slice('--include-directories='.length);
          expect(existsSync(stage)).toBe(true);
          expect(args.at(-1)).not.toContain('source');
          expect(args.at(-1)).toContain('temp\\ space');
          return spawn(command, [...args], { ...options, env, stdio: 'pipe' });
        },
      });
      const events = [];
      for await (const event of adapter.run('Inspect the selected media.', {
        cwd: workspace,
        model: 'gemini-3.1-pro-preview',
        attachments: fixtures.map(({ path, mimeType }) => ({
          path,
          mimeType: mimeType.toUpperCase(),
        })),
        abortSignal: AbortSignal.timeout(45_000),
      })) {
        events.push(event);
        if (event.type === 'done') expect(existsSync(stage)).toBe(false);
      }
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      const prompts = requests.filter((request) =>
        request.url.includes('streamGenerateContent'),
      );
      expect(prompts).toHaveLength(1);
      const parts = prompts[0]!.body.contents!.flatMap(
        (content) => content.parts ?? [],
      );
      expect(
        parts.flatMap((part) => (part.inlineData ? [part.inlineData] : [])),
      ).toEqual(
        fixtures.map(({ mimeType, bytes }) => ({
          mimeType,
          data: bytes.toString('base64'),
        })),
      );
      expect(parts.map((part) => part.text ?? '').join('\n')).toContain(
        'Inspect the selected media.',
      );
      for (const file of fixtures)
        expect(await readFile(file.path)).toEqual(file.bytes);
      expect(await readdir(temporary)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
  60_000,
);
