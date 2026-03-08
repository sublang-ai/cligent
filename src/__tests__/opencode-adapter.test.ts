// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  OpenCodeAdapter,
  mapPermissionsToOpenCodeOptions,
  wrapOpencodeClient,
} from '../adapters/opencode.js';
import type { AgentEvent, PermissionLevel, PermissionPolicy } from '../types.js';

interface MockOpenCodeClient {
  run(options: Record<string, unknown>): Promise<unknown>;
  events(options?: Record<string, unknown>): AsyncIterable<unknown>;
  close(): Promise<void>;
  shutdown(): Promise<void>;
}

class MockServerProcess extends EventEmitter {
  readonly stdout = new PassThrough();

  readonly stderr = new PassThrough();

  killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    queueMicrotask(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('close', null, signal === 'SIGTERM' ? 'SIGTERM' : null);
    });
    return true;
  }
}

interface SpawnInvocation {
  command: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  process: MockServerProcess;
}

function makeSpawn(): {
  spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  invocations: SpawnInvocation[];
} {
  const invocations: SpawnInvocation[] = [];

  const spawnProcess = (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ): ChildProcessWithoutNullStreams => {
    const process = new MockServerProcess();
    invocations.push({ command, args, options, process });
    return process as unknown as ChildProcessWithoutNullStreams;
  };

  return { spawnProcess, invocations };
}

function makeLoader(config: {
  runResult?: unknown;
  events?: unknown[];
  eventStreamFactory?: (options?: Record<string, unknown>) => AsyncIterable<unknown>;
  onCreateClient?: (options: { baseUrl?: string }) => void;
  onRun?: (options: Record<string, unknown>) => void;
  onEvents?: (options?: Record<string, unknown>) => void;
  onClose?: () => void;
  onShutdown?: () => void;
}): () => Promise<{ createClient(options?: { baseUrl?: string }): MockOpenCodeClient }> {
  return async () => ({
    createClient(options?: { baseUrl?: string }): MockOpenCodeClient {
      config.onCreateClient?.(options ?? {});

      return {
        async run(options: Record<string, unknown>): Promise<unknown> {
          config.onRun?.(options);
          return config.runResult ?? { sessionId: 'session-1' };
        },
        events(options?: Record<string, unknown>): AsyncIterable<unknown> {
          config.onEvents?.(options);

          if (config.eventStreamFactory) {
            return config.eventStreamFactory(options);
          }

          const events = config.events ?? [];
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
              for (const event of events) {
                yield event;
              }
            },
          };
        },
        async close(): Promise<void> {
          config.onClose?.();
        },
        async shutdown(): Promise<void> {
          config.onShutdown?.();
        },
      };
    },
  });
}

async function collect(
  stream: AsyncGenerator<AgentEvent, void, void>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('OpenCodeAdapter', () => {
  it('maps OpenCode SSE events to unified events and filters by session', async () => {
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          runResult: {
            sessionId: 'session-1',
            model: 'opencode-model',
            cwd: '/repo',
            tools: ['edit', 'bash'],
          },
          events: [
            {
              type: 'message.part.updated',
              sessionId: 'session-2',
              part: { type: 'text', text: 'ignore me' },
            },
            {
              type: 'message.part.updated',
              sessionId: 'session-1',
              part: { type: 'text', text: 'hello' },
            },
            {
              type: 'message.part.updated',
              sessionId: 'session-1',
              part: { type: 'text', delta: ' world' },
            },
            {
              type: 'message.part.updated',
              sessionId: 'session-1',
              part: {
                type: 'tool_call',
                id: 'tool-1',
                name: 'bash',
                input: { command: 'ls' },
              },
            },
            {
              type: 'message.part.updated',
              sessionId: 'session-1',
              part: { type: 'thinking', summary: 'Plan next step' },
            },
            {
              type: 'message.part.updated',
              sessionId: 'session-1',
              part: { type: 'file_part', path: '/repo/a.ts', action: 'modified' },
            },
            {
              type: 'message.part.updated',
              sessionId: 'session-1',
              part: { type: 'image_part', mimeType: 'image/png', uri: 'file:///tmp/a.png' },
            },
            {
              type: 'permission.updated',
              sessionId: 'session-1',
              permission: {
                toolName: 'bash',
                toolUseId: 'tool-2',
                input: { command: 'rm -rf /tmp' },
                reason: 'needs approval',
              },
            },
            {
              type: 'permission.replied',
              sessionId: 'session-1',
              permission: {
                toolName: 'bash',
                toolUseId: 'tool-2',
                decision: 'denied',
                reason: 'rejected by user',
              },
            },
            {
              type: 'error',
              sessionId: 'session-1',
              code: 'TEMP',
              message: 'temporary issue',
              recoverable: true,
            },
            {
              type: 'session.idle',
              sessionId: 'session-1',
              status: 'max_turns',
              usage: {
                input_tokens: 11,
                output_tokens: 22,
                tool_uses: 2,
                total_cost_usd: 0.14,
              },
              duration_ms: 210,
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt', { model: 'override-model' }));

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'text_delta',
      'tool_use',
      'thinking',
      'opencode:file_part',
      'opencode:image_part',
      'permission_request',
      'tool_result',
      'error',
      'done',
    ]);

    const init = events[0] as AgentEvent & {
      payload: { model: string; cwd: string; tools: string[] };
    };
    expect(init.payload.model).toBe('override-model');
    expect(init.payload.cwd).toBe('/repo');
    expect(init.payload.tools).toEqual(['edit', 'bash']);

    const text = events[1] as AgentEvent & { payload: { content: string } };
    expect(text.payload.content).toBe('hello');

    const textDelta = events[2] as AgentEvent & { payload: { delta: string } };
    expect(textDelta.payload.delta).toBe(' world');

    const toolUse = events[3] as AgentEvent & {
      payload: { toolName: string; toolUseId: string; input: Record<string, unknown> };
    };
    expect(toolUse.payload.toolName).toBe('bash');
    expect(toolUse.payload.toolUseId).toBe('tool-1');
    expect(toolUse.payload.input).toEqual({ command: 'ls' });

    const thinking = events[4] as AgentEvent & { payload: { summary: string } };
    expect(thinking.payload.summary).toBe('Plan next step');

    const filePart = events[5] as AgentEvent & { payload: Record<string, unknown> };
    expect(filePart.type).toBe('opencode:file_part');
    expect(filePart.payload.path).toBe('/repo/a.ts');

    const imagePart = events[6] as AgentEvent & { payload: Record<string, unknown> };
    expect(imagePart.type).toBe('opencode:image_part');
    expect(imagePart.payload.mimeType).toBe('image/png');

    const permission = events[7] as AgentEvent & {
      payload: {
        toolName: string;
        toolUseId: string;
        input: Record<string, unknown>;
        reason?: string;
      };
    };
    expect(permission.payload.toolName).toBe('bash');
    expect(permission.payload.toolUseId).toBe('tool-2');
    expect(permission.payload.input).toEqual({ command: 'rm -rf /tmp' });
    expect(permission.payload.reason).toBe('needs approval');

    const denied = events[8] as AgentEvent & {
      payload: { toolName: string; toolUseId: string; status: string; output: unknown };
    };
    expect(denied.payload.toolName).toBe('bash');
    expect(denied.payload.toolUseId).toBe('tool-2');
    expect(denied.payload.status).toBe('denied');
    expect(denied.payload.output).toBe('rejected by user');

    const error = events[9] as AgentEvent & {
      payload: { code?: string; message: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('TEMP');
    expect(error.payload.message).toBe('temporary issue');
    expect(error.payload.recoverable).toBe(true);

    const done = events[10] as AgentEvent & {
      payload: {
        status: string;
        usage: {
          inputTokens: number;
          outputTokens: number;
          toolUses: number;
          totalCostUsd?: number;
        };
        durationMs: number;
      };
    };
    expect(done.payload.status).toBe('max_turns');
    expect(done.payload.usage).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      toolUses: 2,
      totalCostUsd: 0.14,
    });
    expect(done.payload.durationMs).toBe(210);
  });

  it('maps permission policies to OpenCode permission map for all combinations', () => {
    const levels: PermissionLevel[] = ['allow', 'ask', 'deny'];

    for (const fileWrite of levels) {
      for (const shellExecute of levels) {
        for (const networkAccess of levels) {
          const policy: PermissionPolicy = {
            fileWrite,
            shellExecute,
            networkAccess,
          };

          const mapped = mapPermissionsToOpenCodeOptions(policy, {
            allowedTools: ['custom-a'],
            disallowedTools: ['custom-b'],
          });

          expect(mapped.permission).toEqual({
            edit: fileWrite,
            bash: shellExecute,
            webfetch: networkAccess,
          });
          expect(mapped.tools?.core).toEqual(['custom-a']);
          expect(mapped.tools?.exclude).toEqual(['custom-b']);
        }
      }
    }
  });

  it('runs in managed mode with server spawn, ready wait, and graceful shutdown', async () => {
    const { spawnProcess, invocations } = makeSpawn();

    let readyCalled = false;
    let createClientBaseUrl: string | undefined;

    const adapter = new OpenCodeAdapter(
      {
        mode: 'managed',
        serverUrl: 'http://127.0.0.1:4788',
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'managed-1' },
          events: [
            {
              type: 'session.idle',
              sessionId: 'managed-1',
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          ],
          onCreateClient(options) {
            createClientBaseUrl = options.baseUrl;
          },
        }),
        spawnProcess,
        probeCliAvailability: async () => true,
        waitForServerReady: async (processRef) => {
          readyCalled = true;
          processRef.stdout.write('ready\n');
          return 'http://127.0.0.1:4788';
        },
      },
    );

    const events = await collect(adapter.run('prompt'));

    expect(events.map((event) => event.type)).toEqual(['init', 'done']);
    expect(readyCalled).toBe(true);
    expect(createClientBaseUrl).toBe('http://127.0.0.1:4788');

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.command).toBe('opencode');
    expect(invocations[0]?.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '4788']);
    expect(invocations[0]?.process.killSignals).toContain('SIGTERM');
  });

  it('uses external mode without spawning a server', async () => {
    let createClientBaseUrl: string | undefined;
    let spawnCalled = false;

    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://external-host:7000',
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'external-1' },
          events: [
            {
              type: 'session.idle',
              sessionId: 'external-1',
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          ],
          onCreateClient(options) {
            createClientBaseUrl = options.baseUrl;
          },
        }),
        spawnProcess: (command, args, options) => {
          void command;
          void args;
          void options;
          spawnCalled = true;
          return new MockServerProcess() as unknown as ChildProcessWithoutNullStreams;
        },
      },
    );

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual(['init', 'done']);
    expect(createClientBaseUrl).toBe('http://external-host:7000');
    expect(spawnCalled).toBe(false);
  });

  it('emits error + done when managed server crashes mid-stream', async () => {
    const { spawnProcess, invocations } = makeSpawn();

    const adapter = new OpenCodeAdapter(
      {
        mode: 'managed',
        serverUrl: 'http://127.0.0.1:4888',
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'crash-1' },
          eventStreamFactory: async function* (): AsyncGenerator<unknown, void, void> {
            await new Promise<void>(() => {});
          },
        }),
        spawnProcess,
        probeCliAvailability: async () => true,
        waitForServerReady: async () => 'http://127.0.0.1:4788',
      },
    );

    const stream = adapter.run('prompt');
    const first = await stream.next();
    expect(first.value?.type).toBe('init');

    invocations[0]?.process.emit('close', 1, null);

    const rest = await collect(
      (async function* (): AsyncGenerator<AgentEvent, void, void> {
        if (!first.done && first.value) {
          yield first.value;
        }
        for await (const event of stream) {
          yield event;
        }
      })(),
    );

    const types = rest.map((event) => event.type);
    expect(types).toContain('error');
    expect(types.at(-1)).toBe('done');

    const error = rest.find((event) => event.type === 'error') as AgentEvent & {
      payload: { code?: string; message: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('OPENCODE_SERVER_EXIT');

    const done = rest.at(-1) as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('error');
  });

  it('propagates abort signal and emits interrupted done in managed mode', async () => {
    const controller = new AbortController();
    const { spawnProcess, invocations } = makeSpawn();
    let capturedEventSignal: AbortSignal | undefined;

    const adapter = new OpenCodeAdapter(
      {
        mode: 'managed',
        serverUrl: 'http://127.0.0.1:4999',
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'abort-1' },
          eventStreamFactory: (options) => {
            capturedEventSignal = options?.signal as AbortSignal | undefined;
            return {
              async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
                await new Promise<void>((resolve) => {
                  if (capturedEventSignal?.aborted) {
                    resolve();
                    return;
                  }
                  capturedEventSignal?.addEventListener('abort', () => resolve(), {
                    once: true,
                  });
                });
              },
            };
          },
        }),
        spawnProcess,
        probeCliAvailability: async () => true,
        waitForServerReady: async () => 'http://127.0.0.1:4788',
      },
    );

    const stream = adapter.run('prompt', { abortSignal: controller.signal });

    const collected: AgentEvent[] = [];
    for await (const event of stream) {
      collected.push(event);
      if (event.type === 'init') {
        controller.abort();
      }
    }

    expect(collected.map((event) => event.type)).toEqual(['init', 'done']);

    const done = collected[1] as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('interrupted');

    expect(capturedEventSignal).toBeDefined();
    expect(invocations[0]?.process.killSignals).toContain('SIGTERM');
  });

  it('isAvailable checks SDK + CLI in managed mode and only SDK in external mode', async () => {
    const managedMissingCli = new OpenCodeAdapter(
      { mode: 'managed' },
      {
        loadSdk: makeLoader({ events: [] }),
        probeCliAvailability: async () => false,
      },
    );
    await expect(managedMissingCli.isAvailable()).resolves.toBe(false);

    const externalNoCli = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://external:7000' },
      {
        loadSdk: makeLoader({ events: [] }),
        probeCliAvailability: async () => false,
      },
    );
    await expect(externalNoCli.isAvailable()).resolves.toBe(true);

    const missingSdk = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://external:7000' },
      {
        loadSdk: async () => {
          throw new Error('sdk missing');
        },
      },
    );
    await expect(missingSdk.isAvailable()).resolves.toBe(false);
  });

  it('throws from run when SDK is not installed', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://external:7000' },
      {
        loadSdk: async () => {
          throw new Error('missing');
        },
      },
    );

    const stream = adapter.run('prompt');
    await expect(stream.next()).rejects.toThrow(
      'OpenCodeAdapter requires @opencode-ai/sdk. Install it to use this adapter.',
    );
  });

  it('sets resumeToken on done when backend provides a new session ID', async () => {
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'oc-session-new' },
          events: [
            {
              type: 'session.idle',
              sessionId: 'oc-session-new',
              status: 'success',
              usage: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
              durationMs: 100,
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as { resumeToken?: string };
    expect(payload.resumeToken).toBe('oc-session-new');
  });

  it('omits resumeToken when backend provides no session ID', async () => {
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          runResult: {},
          events: [
            {
              type: 'session.idle',
              status: 'success',
              usage: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
              durationMs: 100,
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as { resumeToken?: string };
    expect(payload.resumeToken).toBeUndefined();
  });

  it('filters and resumes correctly when stream events use threadId', async () => {
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          runResult: { threadId: 'thread-A' },
          events: [
            // Matching event via threadId
            {
              type: 'message.part.updated',
              threadId: 'thread-A',
              part: { type: 'text', text: 'hello' },
            },
            // Foreign event via thread_id — should be filtered
            {
              type: 'message.part.updated',
              thread_id: 'thread-B',
              part: { type: 'text', text: 'ignore me' },
            },
            // Terminal event via threadId
            {
              type: 'session.idle',
              threadId: 'thread-A',
              status: 'success',
              usage: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
              durationMs: 100,
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    const types = events.map((e) => e.type);

    // Foreign thread-B text must be filtered; matching thread-A text present
    expect(types).toEqual(['init', 'text', 'done']);

    // resumeToken emitted from backend-provided threadId
    const payload = events[2].payload as { resumeToken?: string };
    expect(payload.resumeToken).toBe('thread-A');
  });

  it('omits resumeToken when only foreign-session events carry IDs', async () => {
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          // runResult has no session ID
          runResult: {},
          events: [
            // Foreign event with a different session ID — should be filtered
            {
              type: 'message.part.updated',
              sessionId: 'foreign-session-999',
              part: { type: 'text', content: 'hello' },
            },
            // Terminal event with no session ID
            {
              type: 'session.idle',
              status: 'success',
              usage: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
              durationMs: 100,
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));

    // Exact event sequence: init + done — no leaked foreign events
    const types = events.map((e) => e.type);
    expect(types).toEqual(['init', 'done']);

    // Terminal done must have expected status and no fabricated resumeToken
    const payload = events[1].payload as { status: string; resumeToken?: string };
    expect(payload.status).toBe('success');
    expect(payload.resumeToken).toBeUndefined();
  });

  it('filters and resumes correctly when stream events use nested thread.id', async () => {
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          runResult: { thread: { id: 'thread-nested-1' } },
          events: [
            // Matching event via nested thread.id
            {
              type: 'message.part.updated',
              thread: { id: 'thread-nested-1' },
              part: { type: 'text', text: 'matched' },
            },
            // Foreign event via nested thread.id — should be filtered
            {
              type: 'message.part.updated',
              thread: { id: 'thread-nested-2' },
              part: { type: 'text', text: 'foreign' },
            },
            {
              type: 'session.idle',
              thread: { id: 'thread-nested-1' },
              status: 'success',
              usage: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
              durationMs: 100,
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    const types = events.map((e) => e.type);
    expect(types).toEqual(['init', 'text', 'done']);

    // Verify surviving text is from matching thread, not the foreign one
    const textPayload = events[1].payload as { content: string };
    expect(textPayload.content).toBe('matched');

    const payload = events[2].payload as { resumeToken?: string };
    expect(payload.resumeToken).toBe('thread-nested-1');
  });

  it('does not use generic message.id for session filtering', async () => {
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'real-session' },
          events: [
            // Event with matching sessionId but message carries unrelated id
            {
              type: 'message.part.updated',
              sessionId: 'real-session',
              message: { id: 'msg-777', role: 'assistant' },
              part: { type: 'text', text: 'valid' },
            },
            {
              type: 'session.idle',
              sessionId: 'real-session',
              status: 'success',
              usage: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
              durationMs: 100,
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    const types = events.map((e) => e.type);

    // message.id must not interfere with session matching
    expect(types).toEqual(['init', 'text', 'done']);

    const payload = events[2].payload as { resumeToken?: string };
    expect(payload.resumeToken).toBe('real-session');
  });

  // Design choice: events without any session/thread identifier pass through
  // unfiltered. In a multiplexed SSE stream, many event types lack explicit
  // session tags; dropping them would lose broadcast/system information.
  it('passes through events that carry no session identifier', async () => {
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'real-session' },
          events: [
            // Event with no session/thread fields at all
            {
              type: 'message.part.updated',
              message: { id: 'msg-888', role: 'assistant' },
              part: { type: 'text', text: 'untagged' },
            },
            {
              type: 'session.idle',
              sessionId: 'real-session',
              status: 'success',
              usage: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
              durationMs: 100,
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    const types = events.map((e) => e.type);

    // Id-less event passes through — not filtered
    expect(types).toEqual(['init', 'text', 'done']);
  });
});

/**
 * Tests for wrapOpencodeClient — the v1 SDK compatibility wrapper that adapts
 * createOpencodeClient's nested API (session.create/prompt, event.subscribe,
 * instance.dispose) to the flat OpenCodeClient interface.
 */
describe('wrapOpencodeClient (v1 SDK wrapper)', () => {
  function makeV1Sdk(config: {
    createResult?: Record<string, unknown>;
    promptResult?: unknown;
    subscribeResult?: { stream?: AsyncIterable<unknown>; events?: AsyncIterable<unknown> };
    onCreateSession?: () => void;
    onPrompt?: (args: unknown) => void;
    onSubscribe?: (args: unknown) => void;
    onDispose?: () => void;
  }): Record<string, unknown> {
    return {
      session: {
        async create(): Promise<Record<string, unknown>> {
          config.onCreateSession?.();
          return config.createResult ?? { id: 'v1-session-1' };
        },
        async prompt(args: unknown): Promise<unknown> {
          config.onPrompt?.(args);
          return config.promptResult ?? {};
        },
      },
      event: {
        async subscribe(args: unknown): Promise<unknown> {
          config.onSubscribe?.(args);
          return config.subscribeResult ?? { stream: (async function* () {})() };
        },
      },
      instance: {
        async dispose(): Promise<void> {
          config.onDispose?.();
        },
      },
    };
  }

  function makeV1Loader(config: Parameters<typeof makeV1Sdk>[0]): () => Promise<{
    createClient(options?: { baseUrl?: string }): MockOpenCodeClient;
  }> {
    return async () => ({
      createClient(options?: { baseUrl?: string }): MockOpenCodeClient {
        void options;
        const real = makeV1Sdk(config);
        return wrapOpencodeClient(real) as unknown as MockOpenCodeClient;
      },
    });
  }

  it('creates session and forwards prompt through session.prompt', async () => {
    let capturedPromptArgs: unknown;

    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://v1.local:7000' },
      {
        loadSdk: makeV1Loader({
          createResult: { id: 'new-session-42' },
          promptResult: { sessionId: 'new-session-42', model: 'kimi' },
          subscribeResult: {
            stream: (async function* () {
              yield {
                type: 'session.idle',
                sessionId: 'new-session-42',
                status: 'success',
                usage: { input_tokens: 1, output_tokens: 2, tool_uses: 0 },
              };
            })(),
          },
          onPrompt(args) {
            capturedPromptArgs = args;
          },
        }),
      },
    );

    const events = await collect(adapter.run('hello v1'));
    expect(events.map((e) => e.type)).toEqual(['init', 'done']);

    // Verify the prompt call received the correct structure
    const promptArgs = capturedPromptArgs as {
      path: { id: string };
      body: { parts: Array<{ type: string; text: string }> };
    };
    expect(promptArgs.path.id).toBe('new-session-42');
    expect(promptArgs.body.parts).toEqual([{ type: 'text', text: 'hello v1' }]);
  });

  it('resumes existing session instead of creating a new one', async () => {
    let createCalled = false;
    let capturedPromptArgs: unknown;

    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://v1.local:7000' },
      {
        loadSdk: makeV1Loader({
          promptResult: { sessionId: 'resumed-session', model: 'kimi' },
          subscribeResult: {
            stream: (async function* () {
              yield {
                type: 'session.idle',
                sessionId: 'resumed-session',
                status: 'success',
                usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
              };
            })(),
          },
          onCreateSession() {
            createCalled = true;
          },
          onPrompt(args) {
            capturedPromptArgs = args;
          },
        }),
      },
    );

    const events = await collect(
      adapter.run('continue', { resume: 'resumed-session' }),
    );
    expect(events.map((e) => e.type)).toEqual(['init', 'done']);

    // session.create must NOT be called when resuming
    expect(createCalled).toBe(false);

    // session.prompt must target the resumed session ID
    const promptArgs = capturedPromptArgs as { path: { id: string } };
    expect(promptArgs.path.id).toBe('resumed-session');
  });

  it('forwards steps, permission, and tools to session.prompt body', async () => {
    let capturedPromptArgs: unknown;

    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://v1.local:7000' },
      {
        loadSdk: makeV1Loader({
          createResult: { id: 'opts-session' },
          promptResult: { sessionId: 'opts-session' },
          subscribeResult: {
            stream: (async function* () {
              yield {
                type: 'session.idle',
                sessionId: 'opts-session',
                status: 'success',
                usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
              };
            })(),
          },
          onPrompt(args) {
            capturedPromptArgs = args;
          },
        }),
      },
    );

    await collect(
      adapter.run('test options', {
        model: 'kimi-k2',
        cwd: '/workspace',
        maxTurns: 5,
        permissions: {
          fileWrite: 'allow',
          shellExecute: 'ask',
          networkAccess: 'deny',
        },
        allowedTools: ['edit', 'bash'],
        disallowedTools: ['webfetch'],
      }),
    );

    const promptArgs = capturedPromptArgs as {
      body: {
        parts: unknown[];
        model?: string;
        cwd?: string;
        steps?: number;
        permission?: { edit: string; bash: string; webfetch: string };
        tools?: { core?: string[]; exclude?: string[] };
      };
    };

    expect(promptArgs.body.model).toBe('kimi-k2');
    expect(promptArgs.body.cwd).toBe('/workspace');
    expect(promptArgs.body.steps).toBe(5);
    expect(promptArgs.body.permission).toEqual({
      edit: 'allow',
      bash: 'ask',
      webfetch: 'deny',
    });
    expect(promptArgs.body.tools).toEqual({
      core: ['edit', 'bash'],
      exclude: ['webfetch'],
    });
  });

  it('streams events through event.subscribe and yields unified events', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://v1.local:7000' },
      {
        loadSdk: makeV1Loader({
          createResult: { id: 'stream-session' },
          promptResult: { sessionId: 'stream-session', model: 'kimi' },
          subscribeResult: {
            stream: (async function* () {
              yield {
                type: 'message.part.updated',
                sessionId: 'stream-session',
                part: { type: 'text', text: 'hello from v1' },
              };
              yield {
                type: 'message.part.updated',
                sessionId: 'stream-session',
                part: {
                  type: 'tool_call',
                  id: 'tc-1',
                  name: 'bash',
                  input: { command: 'echo hi' },
                },
              };
              yield {
                type: 'session.idle',
                sessionId: 'stream-session',
                status: 'success',
                result: 'all done',
                usage: { input_tokens: 10, output_tokens: 20, tool_uses: 1 },
                duration_ms: 150,
              };
            })(),
          },
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));

    expect(events.map((e) => e.type)).toEqual([
      'init',
      'text',
      'tool_use',
      'done',
    ]);

    const text = events[1] as AgentEvent & { payload: { content: string } };
    expect(text.payload.content).toBe('hello from v1');

    const toolUse = events[2] as AgentEvent & {
      payload: { toolName: string; toolUseId: string; input: Record<string, unknown> };
    };
    expect(toolUse.payload.toolName).toBe('bash');
    expect(toolUse.payload.toolUseId).toBe('tc-1');
    expect(toolUse.payload.input).toEqual({ command: 'echo hi' });
  });

  it('calls instance.dispose on close', async () => {
    let disposeCalled = false;

    const real = makeV1Sdk({
      onDispose() {
        disposeCalled = true;
      },
    });

    const client = wrapOpencodeClient(real);
    await client.close?.();

    expect(disposeCalled).toBe(true);
  });

  it('prefers promptAsync over prompt when both are available', async () => {
    let promptAsyncCalled = false;
    let promptSyncCalled = false;

    const real = {
      session: {
        async create() { return { id: 'pa-session' }; },
        async promptAsync(args: unknown) {
          void args;
          promptAsyncCalled = true;
          return {};
        },
        async prompt(args: unknown) {
          void args;
          promptSyncCalled = true;
          return {};
        },
      },
      event: {
        async subscribe() {
          return { stream: (async function* () {
            yield { type: 'session.idle', sessionId: 'pa-session' };
          })() };
        },
      },
    };

    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://v1.local:7000' },
      {
        loadSdk: async () => ({
          createClient() {
            return wrapOpencodeClient(real as Record<string, unknown>) as unknown as MockOpenCodeClient;
          },
        }),
      },
    );

    await collect(adapter.run('test'));
    expect(promptAsyncCalled).toBe(true);
    expect(promptSyncCalled).toBe(false);
  });

  it('parses "provider/model" strings into { providerID, modelID }', async () => {
    let capturedPromptArgs: unknown;

    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://v1.local:7000' },
      {
        loadSdk: makeV1Loader({
          createResult: { id: 'model-session' },
          subscribeResult: {
            stream: (async function* () {
              yield { type: 'session.idle', sessionId: 'model-session' };
            })(),
          },
          onPrompt(args) { capturedPromptArgs = args; },
        }),
      },
    );

    await collect(adapter.run('test', { model: 'moonshotai-cn/kimi-k2' }));

    const promptArgs = capturedPromptArgs as {
      body: { model?: { providerID: string; modelID: string } };
    };
    expect(promptArgs.body.model).toEqual({
      providerID: 'moonshotai-cn',
      modelID: 'kimi-k2',
    });
  });
});

describe('OpenCode SSE event structure', () => {
  it('unwraps properties envelope and handles message.part.delta', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'sse-session' },
          events: [
            {
              type: 'message.part.delta',
              properties: {
                sessionID: 'sse-session',
                delta: 'hello',
              },
            },
            {
              type: 'message.part.delta',
              properties: {
                sessionID: 'sse-session',
                delta: ' world',
              },
            },
            {
              type: 'session.idle',
              properties: {
                sessionID: 'sse-session',
              },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const types = events.map((e) => e.type);
    expect(types).toEqual(['init', 'text_delta', 'text_delta', 'done']);

    const d1 = events[1] as AgentEvent & { payload: { delta: string } };
    expect(d1.payload.delta).toBe('hello');

    const d2 = events[2] as AgentEvent & { payload: { delta: string } };
    expect(d2.payload.delta).toBe(' world');
  });

  it('handles session.error events', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'err-session' },
          events: [
            {
              type: 'session.error',
              properties: {
                sessionID: 'err-session',
                error: {
                  name: 'APIError',
                  data: { message: 'Invalid Authentication', statusCode: 401 },
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'err-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const types = events.map((e) => e.type);
    expect(types).toEqual(['init', 'error', 'done']);

    const err = events[1] as AgentEvent & { payload: { message: string } };
    expect(err.payload.message).toBe('Invalid Authentication');
  });

  it('treats session.status idle as terminal', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'status-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'status-session',
                  type: 'text',
                  text: 'done',
                },
              },
            },
            {
              type: 'session.status',
              properties: {
                sessionID: 'status-session',
                status: { type: 'idle' },
              },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const types = events.map((e) => e.type);
    expect(types).toEqual(['init', 'text', 'done']);
  });

  it('accumulates step-finish token usage for done event', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'usage-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'usage-session',
                  type: 'step-finish',
                  tokens: { input: 100, output: 50, reasoning: 20 },
                  cost: 0.003,
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'usage-session',
                  type: 'step-finish',
                  tokens: { input: 80, output: 30, reasoning: 10 },
                  cost: 0.002,
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'usage-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as {
      usage: { inputTokens: number; outputTokens: number; totalCostUsd?: number };
    };
    expect(payload.usage.inputTokens).toBe(180);
    expect(payload.usage.outputTokens).toBe(80);
    expect(payload.usage.totalCostUsd).toBe(0.005);
  });

  it('extracts sessionID from part inside properties envelope', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'part-session' },
          events: [
            // Part carries sessionID inside properties.part
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'part-session',
                  type: 'text',
                  text: 'matched',
                },
              },
            },
            // Foreign session via part.sessionID
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'other-session',
                  type: 'text',
                  text: 'foreign',
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'part-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const texts = events
      .filter((e) => e.type === 'text')
      .map((e) => (e.payload as { content: string }).content);
    expect(texts).toEqual(['matched']);
  });
});
