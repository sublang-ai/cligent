// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { Part, SessionPromptAsyncData } from '@opencode-ai/sdk/v2';
import { describe, expect, it } from 'vitest';

import { Cligent } from '../cligent.js';
import type { AgentEvent } from '../types.js';
import { OpenCodeAdapter, wrapOpencodeClient } from './opencode.js';

const available =
  (
    spawnSync('opencode', ['--version'], { timeout: 10_000 }).error as
      NodeJS.ErrnoException | undefined
  )?.code !== 'ENOENT';
const acceptanceIt = available || process.env.CI ? it : it.skip;

function bounded(promise: Promise<unknown>, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe('OpenCode native attachment parsing (opencode-60)', () => {
  acceptanceIt(
    'persists adapter-produced media parts on a real isolated server without model execution',
    async () => {
      if (!available) {
        throw new Error('Missing OpenCode CLI required by acceptance CI');
      }
      const cwd = await mkdtemp(join(tmpdir(), 'cligent-opencode-media-'));
      const files = [
        {
          path: 'pixel.png',
          mime: 'image/png',
          // Valid 2x2 PNG: OpenCode validates image bytes even with noReply.
          data: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',
            'base64',
          ),
        },
        {
          path: 'sound.wav',
          mime: 'audio/wav',
          data: Buffer.from('audio fixture'),
        },
        {
          path: 'clip.mp4',
          mime: 'video/mp4',
          data: Buffer.from('video fixture'),
        },
        {
          path: 'report.pdf',
          mime: 'application/pdf',
          data: Buffer.from('%PDF-1.4 fixture'),
        },
        {
          path: 'notes.txt',
          mime: 'text/plain',
          data: Buffer.from('native text fixture'),
        },
      ];
      let serverProcess: ChildProcessWithoutNullStreams | undefined;
      let serverClosed: Promise<void> | undefined;
      let persistedParts: Part[] = [];
      let persistedRoles: string[] = [];
      const configuration = {
        model: 'cligent-fixture/media',
        enabled_providers: ['cligent-fixture'],
        provider: {
          'cligent-fixture': {
            npm: '@ai-sdk/openai-compatible',
            name: 'Cligent local parsing fixture',
            options: { apiKey: 'unused', baseURL: 'http://127.0.0.1:1/v1' },
            models: {
              media: {
                name: 'Local media fixture',
                modalities: {
                  input: ['text', 'image', 'audio', 'video', 'pdf'],
                  output: ['text'],
                },
              },
            },
          },
        },
      };
      try {
        await Promise.all(
          files.map((file) => writeFile(join(cwd, file.path), file.data)),
        );
        const adapter = new OpenCodeAdapter(
          { mode: 'managed', readyTimeoutMs: 10_000 },
          {
            spawnProcess(command, args, options) {
              serverProcess = spawn(command, [...args], {
                ...options,
                env: {
                  ...process.env,
                  XDG_CACHE_HOME: join(cwd, 'cache'),
                  XDG_CONFIG_HOME: join(cwd, 'config'),
                  XDG_DATA_HOME: join(cwd, 'data'),
                  OPENCODE_CONFIG: undefined,
                  OPENCODE_CONFIG_DIR: join(cwd, 'config'),
                  OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration),
                  OPENCODE_DISABLE_MODELS_FETCH: 'true',
                  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
                  OPENCODE_DISABLE_CLAUDE_CODE: 'true',
                },
              }) as ChildProcessWithoutNullStreams;
              serverClosed = new Promise((resolve) => {
                serverProcess!.once('close', () => resolve());
              });
              return serverProcess;
            },
            async loadSdk() {
              return {
                createClient({ baseUrl } = {}) {
                  const real = createOpencodeClient({ baseUrl });
                  const nativePrompt = real.session.prompt.bind(real.session);
                  let finishPrompt: () => void = () => {};
                  const promptFinished = new Promise<void>((resolve) => {
                    finishPrompt = resolve;
                  });
                  let sessionID: string | undefined;
                  // This probe exercises the production adapter's files and
                  // real server parser, using native noReply to avoid an LLM.
                  // Supply idle control because noReply starts no agent loop.
                  const session = real.session as unknown as Record<
                    string,
                    unknown
                  >;
                  session.promptAsync = async (
                    parameters: NonNullable<SessionPromptAsyncData['body']> & {
                      sessionID: string;
                      directory?: string;
                    },
                    requestOptions?: { signal?: AbortSignal },
                  ) => {
                    sessionID = parameters.sessionID;
                    const result = await nativePrompt(
                      { ...parameters, noReply: true },
                      requestOptions,
                    );
                    if (result.error) return result;
                    const messages = await real.session.messages(
                      { sessionID, directory: cwd },
                      requestOptions,
                    );
                    if (messages.error) return messages;
                    persistedParts = messages.data.flatMap(
                      (message) => message.parts,
                    );
                    persistedRoles = messages.data.map(
                      (message) => message.info.role,
                    );
                    finishPrompt();
                    return {};
                  };
                  (real.event as unknown as Record<string, unknown>).subscribe =
                    async () => ({
                      stream: (async function* () {
                        await promptFinished;
                        yield {
                          type: 'session.idle',
                          properties: { sessionID },
                        };
                      })(),
                    });
                  return wrapOpencodeClient(real, { apiVersion: 'v2' });
                },
              };
            },
          },
        );
        const events: AgentEvent[] = [];
        const cligent = new Cligent(adapter, { cwd });
        for await (const event of cligent.run('Inspect the attached media.', {
          attachments: files.map((file) => ({ path: file.path })),
        })) {
          events.push(event);
        }
        expect(events.filter((event) => event.type === 'error')).toEqual([]);
        expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
        expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
        expect(persistedRoles).toEqual(['user']);
        for (const file of files) {
          expect(persistedParts).toContainEqual(
            expect.objectContaining({
              type: 'file',
              mime: file.mime,
              filename: file.path,
              url: `data:${file.mime};base64,${file.data.toString('base64')}`,
            }),
          );
        }
        expect(persistedParts).toContainEqual(
          expect.objectContaining({
            type: 'text',
            text: 'native text fixture',
            synthetic: true,
          }),
        );
        expect(serverClosed).toBeDefined();
        expect(await bounded(serverClosed!, 2_000)).toBe(true);
      } finally {
        if (
          serverProcess &&
          serverProcess.exitCode === null &&
          serverProcess.signalCode === null
        ) {
          serverProcess.kill('SIGTERM');
          if (serverClosed && !(await bounded(serverClosed, 2_000))) {
            serverProcess.kill('SIGKILL');
            await bounded(serverClosed, 1_000);
          }
        }
        await rm(cwd, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
