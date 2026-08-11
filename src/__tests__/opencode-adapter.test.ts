// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import type {
  EventMessagePartDelta,
  EventMessagePartRemoved,
  EventMessagePartUpdated,
  EventMessageRemoved,
  EventMessageUpdated,
  EventSessionError,
  EventSessionIdle,
  EventSessionNextReasoningDelta,
  EventSessionNextTextDelta,
  StepFinishPart,
} from '@opencode-ai/sdk/v2';
import type { EventMessagePartUpdated as V1EventMessagePartUpdated } from '@opencode-ai/sdk';

import {
  OpenCodeAdapter,
  mapEffortToOpenCodeVariant,
  mapPermissionsToOpenCodeOptions,
  wrapOpencodeClient,
} from '../adapters/opencode.js';
import type {
  AgentEvent,
  AgentOptions,
  DonePayload,
  OpenCodeEffort,
  PermissionLevel,
  PermissionPolicy,
} from '../types.js';

interface MockOpenCodeClient {
  run(options: Record<string, unknown>): Promise<unknown>;
  events(options?: Record<string, unknown>): AsyncIterable<unknown>;
  getSessionStatus?(options: {
    sessionId: string;
    cwd?: string;
  }): Promise<unknown>;
  abortSession?(options: {
    sessionId: string;
    cwd?: string;
  }): Promise<void>;
  replyPermission(options: {
    sessionId: string;
    requestId: string;
    permission: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;
  shutdown(): Promise<void>;
}

class MockServerProcess extends EventEmitter {
  constructor(
    private readonly ignoreSigterm = false,
    private readonly onKill?: (signal?: NodeJS.Signals | number) => void,
  ) {
    super();
  }

  readonly stdout = new PassThrough();

  readonly stderr = new PassThrough();

  killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.onKill?.(signal);
    if (signal === 'SIGTERM' && this.ignoreSigterm) return true;
    queueMicrotask(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit(
        'close',
        null,
        typeof signal === 'string' ? signal : null,
      );
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

function makeSpawn(processBehavior: {
  ignoreSigterm?: boolean;
  onKill?: (signal?: NodeJS.Signals | number) => void;
} = {}): {
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
    const process = new MockServerProcess(
      processBehavior.ignoreSigterm,
      processBehavior.onKill,
    );
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
  statusResult?: unknown;
  statusError?: unknown;
  onGetSessionStatus?: (options: { sessionId: string; cwd?: string }) => void;
  onAbortSession?: (
    options: { sessionId: string; cwd?: string },
  ) => Promise<void> | void;
  onReplyPermission?: (options: {
    sessionId: string;
    requestId: string;
    permission: string;
    cwd?: string;
    signal?: AbortSignal;
  }) => void;
  replyPermissionFactory?: (options: {
    sessionId: string;
    requestId: string;
    permission: string;
    cwd?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  replyPermissionError?: unknown;
  onClose?: () => Promise<void> | void;
  onShutdown?: () => Promise<void> | void;
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
        async getSessionStatus(options): Promise<unknown> {
          config.onGetSessionStatus?.(options);
          if (config.statusError !== undefined) {
            throw config.statusError;
          }
          return config.statusResult ?? { type: 'idle' };
        },
        async abortSession(options): Promise<void> {
          await config.onAbortSession?.(options);
        },
        async replyPermission(options): Promise<void> {
          config.onReplyPermission?.(options);
          if (config.replyPermissionFactory) {
            await config.replyPermissionFactory(options);
            return;
          }
          if (config.replyPermissionError !== undefined) {
            throw config.replyPermissionError;
          }
        },
        async close(): Promise<void> {
          await config.onClose?.();
        },
        async shutdown(): Promise<void> {
          await config.onShutdown?.();
        },
      };
    },
  });
}

function makeV2MessageUpdated(
  sessionID: string,
  messageID: string,
  role: 'user' | 'assistant',
): EventMessageUpdated {
  const info: EventMessageUpdated['properties']['info'] = role === 'assistant'
    ? {
        id: messageID,
        sessionID,
        role,
        time: { created: 1 },
        parentID: 'parent-message',
        modelID: 'test-model',
        providerID: 'test-provider',
        mode: 'test',
        agent: 'test-agent',
        path: { cwd: '/tmp', root: '/tmp' },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }
    : {
        id: messageID,
        sessionID,
        role,
        time: { created: 1 },
        agent: 'test-agent',
        model: { providerID: 'test-provider', modelID: 'test-model' },
      };

  return {
    id: `message-updated-${messageID}`,
    type: 'message.updated',
    properties: { sessionID, info },
  };
}

function makeV2PartUpdated(
  part: EventMessagePartUpdated['properties']['part'],
  time = 1,
): EventMessagePartUpdated {
  return {
    id: `part-updated-${part.id}-${time}`,
    type: 'message.part.updated',
    properties: { sessionID: part.sessionID, part, time },
  };
}

function makeV2PartRemoved(
  sessionID: string,
  messageID: string,
  partID: string,
): EventMessagePartRemoved {
  return {
    id: `part-removed-${partID}`,
    type: 'message.part.removed',
    properties: { sessionID, messageID, partID },
  };
}

function makeV2MessageRemoved(
  sessionID: string,
  messageID: string,
): EventMessageRemoved {
  return {
    id: `message-removed-${messageID}`,
    type: 'message.removed',
    properties: { sessionID, messageID },
  };
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
                id: 'permission-tool-2',
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
                requestID: 'permission-tool-2',
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
      tokenAvailability: 'reported',
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

  it('distinguishes an absent permission policy from an explicit empty policy', () => {
    expect(
      mapPermissionsToOpenCodeOptions(undefined, {
        allowedTools: ['edit', 'edit'],
        disallowedTools: ['webfetch', 'webfetch'],
      }),
    ).toEqual({
      tools: {
        core: ['edit'],
        exclude: ['webfetch'],
      },
    });
    expect(mapPermissionsToOpenCodeOptions(undefined)).toEqual({});
    expect(
      mapPermissionsToOpenCodeOptions(undefined, { allowedTools: [] }),
    ).toEqual({ tools: { core: [] } });
    expect(
      mapPermissionsToOpenCodeOptions(undefined, {
        allowedTools: ['edit', 'bash'],
        disallowedTools: ['bash'],
      }),
    ).toEqual({ tools: { core: ['edit'], exclude: ['bash'] } });
    expect(() =>
      mapPermissionsToOpenCodeOptions(undefined, { allowedTools: ['*'] }),
    ).toThrow(/exact tool identifiers, not wildcard patterns/);
    expect(() =>
      mapPermissionsToOpenCodeOptions(undefined, {
        disallowedTools: ['prefix-*'],
      }),
    ).toThrow(/exact tool identifiers, not wildcard patterns/);
    expect(mapPermissionsToOpenCodeOptions({}).permission).toEqual({
      edit: 'ask',
      bash: 'ask',
      webfetch: 'ask',
    });
  });

  it('reports an explicit empty allowlist as configured and known', async () => {
    let runOptions: Record<string, unknown> | undefined;
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          runResult: {
            sessionId: 'tool-free-session',
            tools: ['edit', 'bash'],
          },
          events: [
            {
              type: 'session.idle',
              sessionId: 'tool-free-session',
              status: 'success',
            },
          ],
          onRun(options) {
            runOptions = options;
          },
        }),
      },
    );

    const events = await collect(
      adapter.run('route only', { allowedTools: [] }),
    );
    expect(runOptions).toMatchObject({ tools: { core: [] } });
    const init = events[0] as AgentEvent & {
      payload: {
        tools: string[];
        capabilities: Record<string, unknown>;
      };
    };
    expect(init.payload.tools).toEqual([]);
    expect(init.payload.capabilities).toMatchObject({
      toolsKnown: true,
      toolsSource: 'configured',
    });
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

  it.each([
    ['anthropic/claude-sonnet-4-5', 'minimal', 'high'],
    ['anthropic/claude-sonnet-4-5', 'low', 'high'],
    ['anthropic/claude-sonnet-4-5', 'medium', 'high'],
    ['anthropic/claude-sonnet-4-5', 'high', 'high'],
    ['anthropic/claude-sonnet-4-5', 'xhigh', 'max'],
    ['anthropic/claude-sonnet-4-5', 'max', 'max'],
    ['openai/gpt-5', 'minimal', 'minimal'],
    ['openai/gpt-5', 'low', 'low'],
    ['openai/gpt-5', 'medium', 'medium'],
    ['openai/gpt-5', 'high', 'high'],
    ['openai/gpt-5', 'xhigh', 'xhigh'],
    ['openai/gpt-5', 'max', 'xhigh'],
    ['google/gemini-3-pro', 'minimal', 'low'],
    ['google/gemini-3-pro', 'low', 'low'],
    ['google/gemini-3-pro', 'medium', 'low'],
    ['google/gemini-3-pro', 'high', 'high'],
    ['google/gemini-3-pro', 'xhigh', 'high'],
    ['google/gemini-3-pro', 'max', 'high'],
  ] satisfies Array<[string, OpenCodeEffort, string]>)(
    'maps OpenCode %s effort %s to variant %s per OPENCODE-012',
    (model, effort, variant) => {
      expect(mapEffortToOpenCodeVariant(model, effort)).toBe(
        variant,
      );
    },
  );

  it('leaves OpenCode variant unset for omitted effort and unrecognised providers', () => {
    expect(
      mapEffortToOpenCodeVariant('openai/gpt-5', undefined),
    ).toBeUndefined();
    expect(
      mapEffortToOpenCodeVariant(undefined, 'high'),
    ).toBeUndefined();
    expect(
      mapEffortToOpenCodeVariant('gpt-5', 'high'),
    ).toBeUndefined();
    expect(
      mapEffortToOpenCodeVariant('someprovider/somemodel', 'max'),
    ).toBeUndefined();
  });

  it('rejects provider-native and unknown effort before prompting', async () => {
    let runCalls = 0;
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          onRun: () => {
            runCalls += 1;
          },
        }),
      },
    );

    for (const effort of ['ultra', 'future-effort']) {
      const invalid = { effort } as unknown as AgentOptions<OpenCodeEffort>;
      await expect(collect(adapter.run('prompt', invalid))).rejects.toThrow(
        'effort for adapter "opencode" must be one of: minimal, low, medium, high, xhigh, max',
      );
    }
    expect(runCalls).toBe(0);
  });

  it('surfaces provider rejection of a valid variant without substitution', async () => {
    let capturedRunOptions: Record<string, unknown> | undefined;
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'effort-error-session' },
          events: [
            ({
              id: 'event-effort-error',
              type: 'session.error',
              properties: {
                sessionID: 'effort-error-session',
                error: {
                  name: 'APIError',
                  data: {
                    message: 'xhigh is unavailable for this model',
                    statusCode: 400,
                    isRetryable: false,
                  },
                },
              },
            } satisfies EventSessionError),
            ({
              id: 'event-effort-idle',
              type: 'session.idle',
              properties: { sessionID: 'effort-error-session' },
            } satisfies EventSessionIdle),
          ],
          onRun: (options) => {
            capturedRunOptions = options;
          },
        }),
      },
    );

    const events = await collect(
      adapter.run('prompt', {
        model: 'openai/gpt-5',
        effort: 'max',
      }),
    );

    expect(capturedRunOptions?.variant).toBe('xhigh');
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);
    expect(events[1]?.payload).toMatchObject({
      message: 'xhigh is unavailable for this model',
    });
    expect(events[2]?.payload).toMatchObject({ status: 'error' });
  });

  it('forwards effort to the OpenCode prompt variant per OPENCODE-012', async () => {
    let capturedRunOptions: Record<string, unknown> | undefined;

    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'effort-session' },
          events: [
            {
              type: 'session.idle',
              sessionId: 'effort-session',
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          ],
          onRun(options) {
            capturedRunOptions = options;
          },
        }),
      },
    );

    await collect(
      adapter.run('prompt', {
        model: 'openai/gpt-5',
        effort: 'medium',
      }),
    );

    expect(capturedRunOptions).toBeDefined();
    expect(capturedRunOptions).toMatchObject({
      model: 'openai/gpt-5',
      variant: 'medium',
    });
    expect(capturedRunOptions).not.toHaveProperty('reasoningEffort');
    expect(capturedRunOptions).not.toHaveProperty('reasoning_effort');
    expect(capturedRunOptions).not.toHaveProperty('thinking');
  });

  it('does not forward OpenCode variant for unrecognised provider prefixes', async () => {
    let capturedRunOptions: Record<string, unknown> | undefined;

    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'unknown-provider-session' },
          events: [
            {
              type: 'session.idle',
              sessionId: 'unknown-provider-session',
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          ],
          onRun(options) {
            capturedRunOptions = options;
          },
        }),
      },
    );

    await collect(
      adapter.run('prompt', {
        model: 'someprovider/somemodel',
        effort: 'max',
      }),
    );

    expect(capturedRunOptions).toBeDefined();
    expect(capturedRunOptions).not.toHaveProperty('variant');
  });

  it('normalizes OpenCode v2 permission.asked events', async () => {
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'v2-permission-session' },
          events: [
            {
              type: 'permission.asked',
              properties: {
                id: 'permission-1',
                sessionID: 'v2-permission-session',
                permission: 'bash',
                patterns: ['*'],
                metadata: { command: 'npm test' },
                always: [],
                tool: { messageID: 'message-1', callID: 'tool-call-1' },
              },
            },
            {
              type: 'session.idle',
              properties: {
                sessionID: 'v2-permission-session',
              },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    const permission = events.find((event) => event.type === 'permission_request') as
      | (AgentEvent & {
          payload: {
            toolName: string;
            toolUseId: string;
            input: Record<string, unknown>;
          };
        })
      | undefined;

    expect(permission?.payload).toEqual({
      toolName: 'bash',
      toolUseId: 'tool-call-1',
      input: { command: 'npm test' },
    });
  });

  it('rejects canonical v1 and v2 permission requests with exact correlation', async () => {
    const replies: Array<{
      sessionId: string;
      requestId: string;
      permission: string;
      signal?: AbortSignal;
    }> = [];

    for (const fixture of [
      {
        sessionId: 'permission-v1-session',
        requestId: 'permission-v1-request',
        permission: 'external_directory',
        event: {
          type: 'permission.updated',
          properties: {
            id: 'permission-v1-request',
            sessionID: 'permission-v1-session',
            type: 'external_directory',
            pattern: ['/tmp/*'],
            messageID: 'message-v1',
            callID: 'call-v1',
            title: 'Access outside the working directory',
            metadata: { path: '/tmp/probe' },
            time: { created: 1 },
          },
        },
      },
      {
        sessionId: 'permission-v2-session',
        requestId: 'permission-v2-request',
        permission: 'future_permission',
        event: {
          type: 'permission.asked',
          properties: {
            id: 'permission-v2-request',
            sessionID: 'permission-v2-session',
            permission: 'future_permission',
            patterns: ['*'],
            metadata: { future: true },
            always: [],
            tool: { messageID: 'message-v2', callID: 'call-v2' },
          },
        },
      },
    ]) {
      const adapter = new OpenCodeAdapter(
        { mode: 'external', serverUrl: 'http://opencode.local:7777' },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: fixture.sessionId },
            events: [
              fixture.event,
              {
                type: 'session.idle',
                properties: { sessionID: fixture.sessionId },
              },
            ],
            onReplyPermission(options) {
              replies.push(options);
            },
          }),
        },
      );

      const events = await collect(adapter.run('permission probe'));
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'permission_request',
        'done',
      ]);
    }

    expect(
      replies.map(({ signal: _signal, ...reply }) => reply),
    ).toEqual([
      {
        sessionId: 'permission-v1-session',
        requestId: 'permission-v1-request',
        permission: 'external_directory',
      },
      {
        sessionId: 'permission-v2-session',
        requestId: 'permission-v2-request',
        permission: 'future_permission',
      },
    ]);
    expect(replies[0]?.signal).toBeDefined();
    expect(replies[0]?.signal?.aborted).toBe(true);
    expect(replies[1]?.signal).toBeDefined();
    expect(replies[1]?.signal?.aborted).toBe(true);
    expect(replies[0]?.signal).not.toBe(replies[1]?.signal);
  });

  it('ignores foreign-session asks and replies once to a repeated local request', async () => {
    const replies: Array<{
      sessionId: string;
      requestId: string;
      permission: string;
    }> = [];
    const localAsk = {
      type: 'permission.asked',
      properties: {
        id: 'request-local-a',
        sessionID: 'session-local',
        permission: 'external_directory',
        patterns: ['/tmp/*'],
        metadata: {},
        always: [],
      },
    };
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'session-local' },
          events: [
            {
              type: 'permission.asked',
              properties: {
                ...localAsk.properties,
                id: 'request-foreign',
                sessionID: 'session-foreign',
              },
            },
            localAsk,
            {
              type: 'permission.asked',
              properties: {
                ...localAsk.properties,
                id: 'request-local-b',
                permission: 'future_permission',
              },
            },
            localAsk,
            {
              type: 'session.idle',
              properties: { sessionID: 'session-local' },
            },
          ],
          onReplyPermission(options) {
            replies.push({
              sessionId: options.sessionId,
              requestId: options.requestId,
              permission: options.permission,
            });
          },
        }),
      },
    );

    await collect(adapter.run('concurrency probe'));
    expect(replies).toEqual([
      {
        sessionId: 'session-local',
        requestId: 'request-local-a',
        permission: 'external_directory',
      },
      {
        sessionId: 'session-local',
        requestId: 'request-local-b',
        permission: 'future_permission',
      },
    ]);
  });

  it('terminates with request identifiers when a permission reply fails', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'reply-failure-session' },
          events: [
            {
              type: 'permission.asked',
              properties: {
                id: 'reply-failure-request',
                sessionID: 'reply-failure-session',
                permission: 'unknown_future_permission',
                patterns: ['*'],
                metadata: {},
                always: [],
              },
            },
          ],
          replyPermissionError: new Error('reply route unavailable'),
        }),
      },
    );

    const events = await collect(adapter.run('failure probe'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'permission_request',
      'error',
      'done',
    ]);
    const error = events[2] as AgentEvent & {
      payload: { code?: string; message: string };
    };
    expect(error.payload.code).toBe('OPENCODE_PERMISSION_REPLY_FAILED');
    expect(error.payload.message).toContain('reply-failure-session');
    expect(error.payload.message).toContain('reply-failure-request');
    expect(error.payload.message).toContain('unknown_future_permission');
    expect((events[3]!.payload as { status: string }).status).toBe('error');
  });

  it('bounds a permission reply that never settles', async () => {
    vi.useFakeTimers();
    try {
      let eventSignal: AbortSignal | undefined;
      let replySignal: AbortSignal | undefined;
      let replyCancelled = false;
      const adapter = new OpenCodeAdapter(
        { mode: 'external', serverUrl: 'http://opencode.local:7777' },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'reply-timeout-session' },
            events: [
              {
                type: 'permission.asked',
                properties: {
                  id: 'reply-timeout-request',
                  sessionID: 'reply-timeout-session',
                  permission: 'future_permission',
                  patterns: ['*'],
                  metadata: {},
                  always: [],
                },
              },
            ],
            onEvents(options) {
              eventSignal = options?.signal as AbortSignal | undefined;
            },
            replyPermissionFactory: async (options) =>
              new Promise<void>((_resolve, reject) => {
                replySignal = options.signal;
                const cancel = () => {
                  replyCancelled = true;
                  reject(new Error('reply request cancelled'));
                };
                if (replySignal?.aborted) {
                  cancel();
                } else {
                  replySignal?.addEventListener('abort', cancel, { once: true });
                }
              }),
          }),
        },
      );

      const stream = adapter.run('timeout probe');
      expect((await stream.next()).value?.type).toBe('init');
      expect((await stream.next()).value?.type).toBe('permission_request');

      const pendingError = stream.next();
      await vi.advanceTimersByTimeAsync(5_000);
      const error = (await pendingError).value as AgentEvent & {
        payload: { code?: string; message: string };
      };
      expect(error.type).toBe('error');
      expect(error.payload.code).toBe('OPENCODE_PERMISSION_REPLY_FAILED');
      expect(error.payload.message).toContain('reply-timeout-session');
      expect(error.payload.message).toContain('reply-timeout-request');
      expect(error.payload.message).toContain('timed out after 5000ms');
      expect(eventSignal).toBe(replySignal);
      expect(eventSignal?.aborted).toBe(true);
      expect(replySignal?.aborted).toBe(true);
      expect(replyCancelled).toBe(true);

      const done = (await stream.next()).value;
      expect(done?.type).toBe('done');
      expect((done?.payload as { status: string }).status).toBe('error');
      await stream.next();
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates when a permission event has no request identifier', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'invalid-request-session' },
          events: [
            {
              type: 'permission.asked',
              properties: {
                sessionID: 'invalid-request-session',
                permission: 'future_permission',
                patterns: ['*'],
                metadata: {},
                always: [],
              },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('invalid request probe'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'permission_request',
      'error',
      'done',
    ]);
    const error = events[2] as AgentEvent & {
      payload: { code?: string; message: string };
    };
    expect(error.payload.code).toBe('OPENCODE_PERMISSION_REQUEST_INVALID');
    expect(error.payload.message).toContain('requestID="<missing>"');
    expect(error.payload.message).toContain('future_permission');
  });

  it('aborts a pending permission reply and cleans up the managed server', async () => {
    const controller = new AbortController();
    const { spawnProcess, invocations } = makeSpawn();
    let closeCalls = 0;
    let shutdownCalls = 0;
    let eventSignal: AbortSignal | undefined;
    let replySignal: AbortSignal | undefined;
    let replyCancelled = false;
    const adapter = new OpenCodeAdapter(
      { mode: 'managed', serverUrl: 'http://127.0.0.1:4998' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'pending-permission-session' },
          events: [
            {
              type: 'permission.asked',
              properties: {
                id: 'pending-permission-request',
                sessionID: 'pending-permission-session',
                permission: 'external_directory',
                patterns: ['/tmp/*'],
                metadata: {},
                always: [],
              },
            },
          ],
          onEvents(options) {
            eventSignal = options?.signal as AbortSignal | undefined;
          },
          replyPermissionFactory: async (options) =>
            new Promise<void>((_resolve, reject) => {
              replySignal = options.signal;
              const cancel = () => {
                replyCancelled = true;
                reject(new Error('reply request cancelled'));
              };
              if (replySignal?.aborted) {
                cancel();
              } else {
                replySignal?.addEventListener('abort', cancel, { once: true });
              }
            }),
          onClose() {
            closeCalls++;
          },
          onShutdown() {
            shutdownCalls++;
          },
        }),
        spawnProcess,
        probeCliAvailability: async () => true,
        waitForServerReady: async () => 'http://127.0.0.1:4998',
      },
    );

    const stream = adapter.run('abort permission probe', {
      abortSignal: controller.signal,
    });
    expect((await stream.next()).value?.type).toBe('init');
    expect((await stream.next()).value?.type).toBe('permission_request');

    const terminal = stream.next();
    controller.abort();
    const done = await terminal;
    expect(done.value?.type).toBe('done');
    expect((done.value?.payload as { status: string }).status).toBe(
      'interrupted',
    );
    expect(invocations[0]?.process.killSignals).not.toContain('SIGTERM');
    await stream.next();

    expect(invocations[0]?.process.killSignals).toContain('SIGTERM');
    expect(eventSignal).toBe(replySignal);
    expect(eventSignal?.aborted).toBe(true);
    expect(replySignal).not.toBe(controller.signal);
    expect(replySignal?.aborted).toBe(true);
    expect(replyCancelled).toBe(true);
    expect(closeCalls).toBe(1);
    expect(shutdownCalls).toBe(1);
  });

  it('bounds stuck iterator and SDK cleanup after terminating the managed server', async () => {
    vi.useFakeTimers();
    try {
      const { spawnProcess, invocations } = makeSpawn();
      const cleanupOrder: string[] = [];
      let nextCalls = 0;
      const iterator: AsyncIterator<unknown> = {
        async next() {
          nextCalls++;
          return {
            done: false,
            value: {
              type: 'session.idle',
              properties: { sessionID: 'stuck-cleanup-session' },
            },
          };
        },
        async return() {
          cleanupOrder.push('iterator.return');
          return new Promise<IteratorResult<unknown>>(() => {});
        },
      };
      const adapter = new OpenCodeAdapter(
        { mode: 'managed', serverUrl: 'http://127.0.0.1:4997' },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'stuck-cleanup-session' },
            eventStreamFactory: () => ({
              [Symbol.asyncIterator]() {
                return iterator;
              },
            }),
            onClose() {
              cleanupOrder.push('client.close');
              return new Promise<void>(() => {});
            },
            onShutdown() {
              cleanupOrder.push('client.shutdown');
              return new Promise<void>(() => {});
            },
          }),
          spawnProcess,
          probeCliAvailability: async () => true,
          waitForServerReady: async () => 'http://127.0.0.1:4997',
        },
      );

      const stream = adapter.run('finish before stuck cleanup');
      expect((await stream.next()).value?.type).toBe('init');
      expect((await stream.next()).value?.type).toBe('done');
      expect(nextCalls).toBe(1);

      const processRef = invocations[0]!.process;
      const originalKill = processRef.kill.bind(processRef);
      processRef.kill = (signal) => {
        cleanupOrder.push(`server.kill:${String(signal)}`);
        return originalKill(signal);
      };

      const teardown = stream.next();
      await vi.advanceTimersByTimeAsync(0);

      expect(cleanupOrder).toEqual([
        'server.kill:SIGTERM',
        'iterator.return',
        'client.close',
        'client.shutdown',
      ]);

      await vi.advanceTimersByTimeAsync(2_000);
      expect((await teardown).done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending v1 canonical SSE request and closes its iterator', async () => {
    const controller = new AbortController();
    let subscriptionSignal: AbortSignal | undefined;
    let nextCancelled = false;
    let returnCalls = 0;

    const rawIterator: AsyncIterator<unknown> = {
      next: async () =>
        new Promise<IteratorResult<unknown>>((_resolve, reject) => {
          const cancel = () => {
            nextCancelled = true;
            reject(new Error('v1 SSE request cancelled'));
          };
          if (subscriptionSignal?.aborted) {
            cancel();
          } else {
            subscriptionSignal?.addEventListener('abort', cancel, {
              once: true,
            });
          }
        }),
      return: async () => {
        returnCalls++;
        return { done: true, value: undefined };
      },
    };
    const real = {
      session: {
        async create() {
          return { id: 'v1-pending-sse-session' };
        },
        async prompt() {
          return {};
        },
      },
      event: {
        async subscribe(requestOptions?: unknown) {
          subscriptionSignal = (requestOptions as { signal?: AbortSignal })
            ?.signal;
          return {
            stream: {
              [Symbol.asyncIterator]() {
                return rawIterator;
              },
            },
          };
        },
      },
    };
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: async () => ({
          createClient: () => wrapOpencodeClient(real),
        }),
      },
    );

    const stream = adapter.run('abort pending v1 SSE', {
      abortSignal: controller.signal,
    });
    expect((await stream.next()).value?.type).toBe('init');
    expect(subscriptionSignal).toBeDefined();
    expect(subscriptionSignal).not.toBe(controller.signal);
    expect(subscriptionSignal?.aborted).toBe(false);

    const terminal = stream.next();
    controller.abort();
    const done = await terminal;
    expect(done.value?.type).toBe('done');
    expect((done.value?.payload as { status: string }).status).toBe(
      'interrupted',
    );
    await stream.next();

    expect(subscriptionSignal?.aborted).toBe(true);
    expect(nextCancelled).toBe(true);
    expect(returnCalls).toBe(1);
  });

  it('cancels a pending v2 canonical SSE request and closes its iterator', async () => {
    const controller = new AbortController();
    let subscriptionSignal: AbortSignal | undefined;
    let nextCancelled = false;
    let returnCalls = 0;

    const rawIterator: AsyncIterator<unknown> = {
      next: async () =>
        new Promise<IteratorResult<unknown>>((_resolve, reject) => {
          const cancel = () => {
            nextCancelled = true;
            reject(new Error('SSE request cancelled'));
          };
          if (subscriptionSignal?.aborted) {
            cancel();
          } else {
            subscriptionSignal?.addEventListener('abort', cancel, {
              once: true,
            });
          }
        }),
      return: async () => {
        returnCalls++;
        return { done: true, value: undefined };
      },
    };
    const real = {
      session: {
        async create() {
          return { data: { id: 'eager-sse-session' } };
        },
        async promptAsync() {
          return {};
        },
      },
      event: {
        async subscribe(_parameters: unknown, requestOptions?: unknown) {
          subscriptionSignal = (requestOptions as { signal?: AbortSignal })
            ?.signal;
          return {
            stream: {
              [Symbol.asyncIterator]() {
                return rawIterator;
              },
            },
          };
        },
      },
    };
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: async () => ({
          createClient: () =>
            wrapOpencodeClient(real, { apiVersion: 'v2' }),
        }),
      },
    );

    const stream = adapter.run('abort eager SSE', {
      abortSignal: controller.signal,
    });
    expect((await stream.next()).value?.type).toBe('init');
    expect(subscriptionSignal).toBeDefined();
    expect(subscriptionSignal).not.toBe(controller.signal);
    expect(subscriptionSignal?.aborted).toBe(false);

    const terminal = stream.next();
    controller.abort();
    const done = await terminal;
    expect(done.value?.type).toBe('done');
    expect((done.value?.payload as { status: string }).status).toBe(
      'interrupted',
    );
    await stream.next();

    expect(subscriptionSignal?.aborted).toBe(true);
    expect(nextCancelled).toBe(true);
    expect(returnCalls).toBe(1);
  });

  it.each(['v1', 'v2'] as const)(
    'cancels a pending %s canonical permission reply HTTP request',
    async (apiVersion) => {
      const controller = new AbortController();
      const sessionId = `canonical-${apiVersion}-reply-session`;
      const requestId = `canonical-${apiVersion}-reply-request`;
      let subscriptionSignal: AbortSignal | undefined;
      let replySignal: AbortSignal | undefined;
      let replyCancelled = false;
      let legacyReplyParameters: Record<string, unknown> | undefined;
      let v2ReplyParameters: Record<string, unknown> | undefined;
      let rawEventDelivered = false;
      let resolveReplyStarted: () => void = () => {};
      const replyStarted = new Promise<void>((resolve) => {
        resolveReplyStarted = resolve;
      });

      const permissionEvent =
        apiVersion === 'v1'
          ? {
              type: 'permission.updated',
              properties: {
                id: requestId,
                sessionID: sessionId,
                type: 'external_directory',
                pattern: ['/tmp/*'],
              },
            }
          : {
              type: 'permission.asked',
              properties: {
                id: requestId,
                sessionID: sessionId,
                permission: 'external_directory',
                patterns: ['/tmp/*'],
              },
            };
      const rawIterator: AsyncIterator<unknown> = {
        async next() {
          if (!rawEventDelivered) {
            rawEventDelivered = true;
            return { done: false, value: permissionEvent };
          }
          return new Promise<IteratorResult<unknown>>(() => {});
        },
        async return() {
          return { done: true, value: undefined };
        },
      };
      const event = {
        async subscribe(parameters?: unknown, requestOptions?: unknown) {
          const options = apiVersion === 'v2' ? requestOptions : parameters;
          subscriptionSignal = (options as { signal?: AbortSignal })?.signal;
          return {
            stream: {
              [Symbol.asyncIterator]() {
                return rawIterator;
              },
            },
          };
        },
      };
      const rejectOnAbort = (signal: AbortSignal | undefined) =>
        new Promise<unknown>((_resolve, reject) => {
          replySignal = signal;
          resolveReplyStarted();
          const cancel = () => {
            replyCancelled = true;
            reject(new Error(`${apiVersion} reply HTTP request cancelled`));
          };
          if (signal?.aborted) {
            cancel();
          } else {
            signal?.addEventListener('abort', cancel, { once: true });
          }
        });
      const real: Record<string, unknown> =
        apiVersion === 'v1'
          ? {
              session: {
                async create() {
                  return { id: sessionId };
                },
                async prompt() {
                  return {};
                },
              },
              event,
              async postSessionIdPermissionsPermissionId(parameters: unknown) {
                legacyReplyParameters = parameters as Record<string, unknown>;
                return rejectOnAbort(
                  legacyReplyParameters.signal as AbortSignal | undefined,
                );
              },
            }
          : {
              session: {
                async create() {
                  return { data: { id: sessionId } };
                },
                async promptAsync() {
                  return {};
                },
              },
              event,
              permission: {
                async reply(parameters: unknown, requestOptions?: unknown) {
                  v2ReplyParameters = parameters as Record<string, unknown>;
                  return rejectOnAbort(
                    (requestOptions as { signal?: AbortSignal })?.signal,
                  );
                },
              },
            };
      const adapter = new OpenCodeAdapter(
        { mode: 'external', serverUrl: 'http://opencode.local:7777' },
        {
          loadSdk: async () => ({
            createClient: () =>
              wrapOpencodeClient(real, { apiVersion }),
          }),
        },
      );

      const stream = adapter.run(`abort ${apiVersion} reply HTTP`, {
        abortSignal: controller.signal,
        cwd: '/workspace',
      });
      expect((await stream.next()).value?.type).toBe('init');
      expect((await stream.next()).value?.type).toBe('permission_request');

      const terminal = stream.next();
      await replyStarted;
      expect(replySignal).toBeDefined();
      expect(replySignal).toBe(subscriptionSignal);
      expect(replySignal).not.toBe(controller.signal);
      expect(replySignal?.aborted).toBe(false);

      controller.abort();
      const done = await terminal;
      expect(done.value?.type).toBe('done');
      expect((done.value?.payload as { status: string }).status).toBe(
        'interrupted',
      );
      await stream.next();

      expect(replySignal?.aborted).toBe(true);
      expect(replyCancelled).toBe(true);
      if (apiVersion === 'v1') {
        expect(legacyReplyParameters).toMatchObject({
          path: { id: sessionId, permissionID: requestId },
          body: { response: 'reject' },
          signal: replySignal,
        });
      } else {
        expect(v2ReplyParameters).toMatchObject({
          requestID: requestId,
          directory: '/workspace',
          reply: 'reject',
        });
      }
    },
  );

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
    const shutdownOrder: string[] = [];
    const { spawnProcess, invocations } = makeSpawn({
      onKill(signal) {
        if (signal === 'SIGTERM') shutdownOrder.push('SIGTERM');
      },
    });
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
          onAbortSession() {
            shutdownOrder.push('session.abort');
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
      } else if (
        event.type === 'done' &&
        event.payload.status === 'interrupted'
      ) {
        shutdownOrder.push('done.interrupted');
      }
    }

    expect(collected.map((event) => event.type)).toEqual(['init', 'done']);

    const done = collected[1] as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('interrupted');

    expect(capturedEventSignal).toBeDefined();
    expect(invocations[0]?.process.killSignals).toContain('SIGTERM');
    expect(shutdownOrder).toEqual([
      'session.abort',
      'done.interrupted',
      'SIGTERM',
    ]);
  });

  it('sets interrupted resumeToken from backend id, inbound resume, or omission', async () => {
    async function interruptedResumeToken(options: {
      backendSessionId?: string;
      resume?: string;
    }): Promise<string | undefined> {
      const controller = new AbortController();
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
        },
        {
          loadSdk: makeLoader({
            runResult: options.backendSessionId
              ? { sessionId: options.backendSessionId }
              : {},
            eventStreamFactory: (streamOptions) => ({
              async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
                const signal = streamOptions?.signal as AbortSignal | undefined;
                await new Promise<void>((resolve) => {
                  if (signal?.aborted) {
                    resolve();
                    return;
                  }
                  signal?.addEventListener('abort', () => resolve(), { once: true });
                });
              },
            }),
          }),
        },
      );

      const events: AgentEvent[] = [];
      for await (const event of adapter.run('prompt', {
        abortSignal: controller.signal,
        ...(options.resume ? { resume: options.resume } : {}),
      })) {
        events.push(event);
        if (event.type === 'init') {
          controller.abort();
        }
      }

      const done = events.find((event) => event.type === 'done') as AgentEvent & {
        payload: { status: string; resumeToken?: string };
      };
      expect(done.payload.status).toBe('interrupted');
      return done.payload.resumeToken;
    }

    await expect(
      interruptedResumeToken({ backendSessionId: 'opencode-abort-new' }),
    ).resolves.toBe('opencode-abort-new');
    await expect(
      interruptedResumeToken({ resume: 'opencode-abort-resume' }),
    ).resolves.toBe('opencode-abort-resume');
    await expect(interruptedResumeToken({})).resolves.toBeUndefined();
  });

  describe('event inactivity liveness (TADAPT-035)', () => {
    it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])(
      'rejects non-finite or non-positive inactivity deadline %s',
      (eventInactivityTimeoutMs) => {
        expect(
          () => new OpenCodeAdapter({ eventInactivityTimeoutMs }),
        ).toThrow(/eventInactivityTimeoutMs must be a finite number greater than 0/);
      },
    );

    it('recovers a missed idle event through status with full diagnostics and cleanup', async () => {
      let iteratorReturns = 0;
      let statusOptions: { sessionId: string; cwd?: string } | undefined;
      let abortCalls = 0;
      let closeCalls = 0;
      let shutdownCalls = 0;

      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 20,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'silent-idle' },
            statusResult: { type: 'idle' },
            eventStreamFactory: (streamOptions) => ({
              [Symbol.asyncIterator](): AsyncIterator<unknown> {
                const signal = streamOptions?.signal as AbortSignal;
                let resolveNext: ((result: IteratorResult<unknown>) => void) | undefined;
                signal.addEventListener(
                  'abort',
                  () => resolveNext?.({ done: true, value: undefined }),
                  { once: true },
                );
                return {
                  next: () =>
                    new Promise<IteratorResult<unknown>>((resolve) => {
                      resolveNext = resolve;
                    }),
                  async return(value?: unknown) {
                    iteratorReturns++;
                    resolveNext?.({ done: true, value });
                    return { done: true, value };
                  },
                };
              },
            }),
            onGetSessionStatus(options) {
              statusOptions = options;
            },
            onAbortSession() {
              abortCalls++;
            },
            onClose() {
              closeCalls++;
            },
            onShutdown() {
              shutdownCalls++;
            },
          }),
        },
      );

      const events = await collect(adapter.run('prompt', { cwd: '/repo' }));
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      expect(statusOptions).toEqual({ sessionId: 'silent-idle', cwd: '/repo' });
      expect(abortCalls).toBe(0);
      expect(iteratorReturns).toBe(1);
      expect(closeCalls).toBe(1);
      expect(shutdownCalls).toBe(1);

      const diagnostic = events[1] as AgentEvent & {
        payload: { code?: string; message: string; recoverable: boolean };
      };
      expect(diagnostic.payload.code).toBe(
        'OPENCODE_INACTIVITY_IDLE_RECOVERED',
      );
      expect(diagnostic.payload.recoverable).toBe(true);
      expect(diagnostic.payload.message).toContain('session=silent-idle');
      expect(diagnostic.payload.message).toContain(
        'lastRelevantEvent=prompt.dispatched',
      );
      expect(diagnostic.payload.message).toMatch(/inactiveMs=\d+/);
      expect(diagnostic.payload.message).toContain('deadlineMs=20');
      expect(diagnostic.payload.message).toContain('serverMode=external');
      expect(diagnostic.payload.message).toContain('serverState=external');
      expect(diagnostic.payload.message).toContain(
        'queriedSessionState={"type":"idle"}',
      );
      expect(events[2]?.payload).toMatchObject({
        status: 'success',
        resumeToken: 'silent-idle',
      });
    });

    it.each([
      { type: 'busy' },
      { type: 'retry', attempt: 2, message: 'capacity', next: 123 },
    ])('aborts a silent non-idle session in state $type', async (statusResult) => {
      const aborts: Array<{ sessionId: string; cwd?: string }> = [];
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 15,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: `silent-${statusResult.type}` },
            statusResult,
            eventStreamFactory: () => ({
              [Symbol.asyncIterator](): AsyncIterator<unknown> {
                return {
                  next: () => new Promise<IteratorResult<unknown>>(() => {}),
                  async return(value?: unknown) {
                    return { done: true, value };
                  },
                };
              },
            }),
            onAbortSession(options) {
              aborts.push(options);
            },
          }),
        },
      );

      const events = await collect(adapter.run('prompt', { cwd: '/repo' }));
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      expect(aborts).toEqual([
        { sessionId: `silent-${statusResult.type}`, cwd: '/repo' },
      ]);
      expect(events[1]?.payload).toMatchObject({
        code: 'OPENCODE_INACTIVITY_TIMEOUT',
        recoverable: false,
      });
      expect((events[1]?.payload as { message: string }).message).toContain(
        `queriedSessionState=${JSON.stringify(statusResult)}`,
      );
      expect(events[2]?.payload).toMatchObject({ status: 'error' });
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    });

    it('aborts the session and terminates its managed server after silence', async () => {
      const { spawnProcess, invocations } = makeSpawn();
      let abortCalls = 0;
      const adapter = new OpenCodeAdapter(
        {
          mode: 'managed',
          serverUrl: 'http://127.0.0.1:4779',
          eventInactivityTimeoutMs: 15,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'managed-silent-busy' },
            statusResult: { type: 'busy' },
            eventStreamFactory: async function* () {
              await new Promise<void>(() => {});
            },
            onAbortSession() {
              abortCalls++;
            },
          }),
          spawnProcess,
          probeCliAvailability: async () => true,
          waitForServerReady: async () => 'http://127.0.0.1:4779',
        },
      );

      const events = await collect(adapter.run('prompt'));
      expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
      expect(abortCalls).toBe(1);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.process.killSignals).toContain('SIGTERM');
    });

    it('escalates an owned managed server that ignores SIGTERM', async () => {
      const { spawnProcess, invocations } = makeSpawn({
        ignoreSigterm: true,
      });
      const adapter = new OpenCodeAdapter(
        {
          mode: 'managed',
          serverUrl: 'http://127.0.0.1:4781',
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'managed-term-resistant' },
            events: [
              {
                type: 'session.idle',
                sessionId: 'managed-term-resistant',
              },
            ],
          }),
          spawnProcess,
          probeCliAvailability: async () => true,
          waitForServerReady: async () => 'http://127.0.0.1:4781',
          managedServerTermGraceMs: 5,
          managedServerKillGraceMs: 25,
        },
      );

      const events = await collect(adapter.run('prompt'));
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      expect(invocations[0]?.process.killSignals).toEqual([
        'SIGTERM',
        'SIGKILL',
      ]);
    });

    it('bounds a non-settling session abort and reports its outcome', async () => {
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 15,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'silent-abort-hang' },
            statusResult: { type: 'busy' },
            eventStreamFactory: async function* () {
              await new Promise<void>(() => {});
            },
            onAbortSession: () => new Promise<void>(() => {}),
          }),
        },
      );

      const startedAt = Date.now();
      const events = await collect(adapter.run('prompt'));
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
      expect((events[1]?.payload as { message: string }).message).toContain(
        'sessionAbort=timed out after 15ms',
      );
    });

    it('reports a status-query failure and still attempts session cleanup', async () => {
      let abortCalls = 0;
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 15,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'silent-query-failure' },
            statusError: new Error('status endpoint unavailable'),
            eventStreamFactory: async function* () {
              await new Promise<void>(() => {});
            },
            onAbortSession() {
              abortCalls++;
            },
          }),
        },
      );

      const events = await collect(adapter.run('prompt'));
      expect(abortCalls).toBe(1);
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      expect(events[1]?.payload).toMatchObject({
        code: 'OPENCODE_INACTIVITY_STATUS_QUERY_FAILED',
        recoverable: false,
      });
      expect((events[1]?.payload as { message: string }).message).toContain(
        'statusQuery=failed: status endpoint unavailable',
      );
      expect(events[2]?.payload).toMatchObject({ status: 'error' });
    });

    it('bounds a status query that itself becomes silent', async () => {
      let abortCalls = 0;
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 15,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'silent-query-hang' },
            statusResult: new Promise<never>(() => {}),
            eventStreamFactory: async function* () {
              await new Promise<void>(() => {});
            },
            onAbortSession() {
              abortCalls++;
            },
          }),
        },
      );

      const startedAt = Date.now();
      const events = await collect(adapter.run('prompt'));
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(abortCalls).toBe(1);
      expect(events[1]?.payload).toMatchObject({
        code: 'OPENCODE_INACTIVITY_STATUS_QUERY_FAILED',
      });
      expect((events[1]?.payload as { message: string }).message).toContain(
        'statusQuery=timed out after 15ms',
      );
    });

    it('resets only for relevant activity while progress continues', async () => {
      let statusCalls = 0;
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 40,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'active-session' },
            eventStreamFactory: async function* () {
              for (let index = 0; index < 4; index++) {
                await new Promise((resolve) => setTimeout(resolve, 15));
                yield {
                  type: 'session.status',
                  sessionId: 'active-session',
                  status: { type: 'busy' },
                };
              }
              yield {
                type: 'session.idle',
                sessionId: 'active-session',
              };
            },
            onGetSessionStatus() {
              statusCalls++;
            },
          }),
        },
      );

      const events = await collect(adapter.run('prompt'));
      expect(statusCalls).toBe(0);
      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
    });

    it('chunks deadlines beyond the Node timer limit without expiring early', async () => {
      let statusCalls = 0;
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 2_147_483_648,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'large-deadline' },
            eventStreamFactory: async function* () {
              await new Promise((resolve) => setTimeout(resolve, 25));
              yield {
                type: 'session.idle',
                sessionId: 'large-deadline',
              };
            },
            onGetSessionStatus() {
              statusCalls++;
            },
          }),
        },
      );

      const events = await collect(adapter.run('prompt'));
      expect(statusCalls).toBe(0);
      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
    });

    it('does not let foreign multiplexed traffic reset the deadline', async () => {
      let statusCalls = 0;
      let abortCalls = 0;
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 35,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'current-session' },
            statusResult: { type: 'busy' },
            eventStreamFactory: (streamOptions) => ({
              async *[Symbol.asyncIterator]() {
                const signal = streamOptions?.signal as AbortSignal;
                let eventIndex = 0;
                while (!signal.aborted) {
                  await new Promise((resolve) => setTimeout(resolve, 8));
                  yield eventIndex++ % 2 === 0
                    ? {
                        type: 'message.updated',
                        properties: {
                          info: {
                            id: 'foreign-message',
                            sessionID: 'foreign-session',
                            role: 'assistant',
                          },
                        },
                      }
                    : {
                        type: 'session.updated',
                        properties: {
                          info: { id: 'foreign-session' },
                        },
                      };
                }
              },
            }),
            onGetSessionStatus() {
              statusCalls++;
            },
            onAbortSession() {
              abortCalls++;
            },
          }),
        },
      );

      const events = await collect(adapter.run('prompt'));
      expect(statusCalls).toBe(1);
      expect(abortCalls).toBe(1);
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      expect((events[1]?.payload as { message: string }).message).toContain(
        'lastRelevantEvent=prompt.dispatched',
      );
    });

    it('interrupts external mode even when its iterator ignores AbortSignal', async () => {
      const controller = new AbortController();
      let iteratorReturns = 0;
      let abortCalls = 0;
      let closeCalls = 0;
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 1_000,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'external-abort' },
            eventStreamFactory: () => ({
              [Symbol.asyncIterator](): AsyncIterator<unknown> {
                return {
                  next: () => new Promise<IteratorResult<unknown>>(() => {}),
                  async return(value?: unknown) {
                    iteratorReturns++;
                    return { done: true, value };
                  },
                };
              },
            }),
            onAbortSession() {
              abortCalls++;
            },
            onClose() {
              closeCalls++;
            },
          }),
        },
      );

      const events: AgentEvent[] = [];
      for await (const event of adapter.run('prompt', {
        abortSignal: controller.signal,
      })) {
        events.push(event);
        if (event.type === 'init') controller.abort();
      }

      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(events[1]?.payload).toMatchObject({
        status: 'interrupted',
        resumeToken: 'external-abort',
      });
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(abortCalls).toBe(1);
      expect(iteratorReturns).toBe(1);
      expect(closeCalls).toBe(1);
    });

    it('aborts a created external session when caller aborts during prompt dispatch', async () => {
      const controller = new AbortController();
      let resolvePromptStarted!: () => void;
      const promptStarted = new Promise<void>((resolve) => {
        resolvePromptStarted = resolve;
      });
      let createSignal: AbortSignal | undefined;
      let promptSignal: AbortSignal | undefined;
      let runAbortListenerRemoved = false;
      let rawIteratorReturns = 0;
      let wrappedRunSettled = false;
      const abortCalls: unknown[] = [];

      const real = {
        session: {
          async create(_args: unknown, requestOptions?: unknown) {
            const sdkSignal = (
              requestOptions as { signal?: AbortSignal } | undefined
            )
              ?.signal;
            createSignal = sdkSignal;
            if (sdkSignal) {
              const originalRemove = sdkSignal.removeEventListener.bind(sdkSignal);
              sdkSignal.removeEventListener = ((
                ...args: Parameters<AbortSignal['removeEventListener']>
              ) => {
                if (args[0] === 'abort') runAbortListenerRemoved = true;
                originalRemove(...args);
              }) as AbortSignal['removeEventListener'];
            }
            return { data: { id: 'dispatch-abort-session' } };
          },
          async promptAsync(_args: unknown, requestOptions?: unknown) {
            promptSignal = (requestOptions as { signal?: AbortSignal } | undefined)
              ?.signal;
            resolvePromptStarted();
            return new Promise<never>(() => {});
          },
          async abort(args: unknown) {
            abortCalls.push(args);
            return { data: true };
          },
        },
        event: {
          async subscribe(_args: unknown, requestOptions?: unknown) {
            const signal = (
              requestOptions as { signal?: AbortSignal } | undefined
            )?.signal;
            return {
              stream: {
                [Symbol.asyncIterator](): AsyncIterator<unknown> {
                  return {
                    next: () =>
                      new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                        if (signal?.aborted) {
                          reject(new Error('event stream aborted'));
                          return;
                        }
                        signal?.addEventListener(
                          'abort',
                          () => reject(new Error('event stream aborted')),
                          { once: true },
                        );
                      }),
                    async return(value?: unknown) {
                      rawIteratorReturns++;
                      return { done: true, value };
                    },
                  };
                },
              },
            };
          },
        },
      };

      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 1_000,
        },
        {
          loadSdk: async () => ({
            createClient() {
              const wrapped = wrapOpencodeClient(real, {
                apiVersion: 'v2',
              });
              return {
                ...wrapped,
                async run(options: Record<string, unknown>) {
                  try {
                    return await wrapped.run!(options);
                  } finally {
                    wrappedRunSettled = true;
                  }
                },
              } as unknown as MockOpenCodeClient;
            },
          }),
        },
      );

      const eventsPromise = collect(
        adapter.run('prompt', {
          abortSignal: controller.signal,
          cwd: '/repo',
        }),
      );
      await promptStarted;
      controller.abort();
      const events = await eventsPromise;

      expect(createSignal).toBeInstanceOf(AbortSignal);
      expect(promptSignal).toBe(createSignal);
      expect(createSignal?.aborted).toBe(true);
      expect(wrappedRunSettled).toBe(true);
      expect(runAbortListenerRemoved).toBe(true);
      expect(rawIteratorReturns).toBe(1);
      expect(abortCalls).toEqual([
        { sessionID: 'dispatch-abort-session', directory: '/repo' },
      ]);
      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(events.at(-1)?.payload).toMatchObject({
        status: 'interrupted',
        resumeToken: 'dispatch-abort-session',
      });
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    });

    it('captures a raced run result before emitting interrupted done', async () => {
      const controller = new AbortController();
      const cleanupOrder: string[] = [];
      const abortCalls: Array<{ sessionId: string; cwd?: string }> = [];
      const racedEvents: AsyncIterable<unknown> = {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          return {
            next: () => new Promise<IteratorResult<unknown>>(() => {}),
            async return(value?: unknown) {
              cleanupOrder.push('iterator.return');
              return { done: true, value };
            },
          };
        },
      };
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 1_000,
        },
        {
          loadSdk: async () => ({
            createClient() {
              return {
                run() {
                  const result = new Promise<unknown>((resolve) => {
                    queueMicrotask(() => {
                      resolve({
                        sessionId: 'raced-dispatch-session',
                        events: racedEvents,
                      });
                    });
                  });
                  controller.abort();
                  return result;
                },
                async abortSession(options: {
                  sessionId: string;
                  cwd?: string;
                }) {
                  abortCalls.push(options);
                  cleanupOrder.push('session.abort');
                },
                async close() {},
                async shutdown() {},
              } as unknown as MockOpenCodeClient;
            },
          }),
        },
      );

      const events: AgentEvent[] = [];
      for await (const event of adapter.run('prompt', {
        abortSignal: controller.signal,
        cwd: '/repo',
      })) {
        events.push(event);
        if (event.type === 'done') cleanupOrder.push('done.interrupted');
      }

      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(events.at(-1)?.payload).toMatchObject({
        status: 'interrupted',
        resumeToken: 'raced-dispatch-session',
      });
      expect(abortCalls).toEqual([
        { sessionId: 'raced-dispatch-session', cwd: '/repo' },
      ]);
      expect(cleanupOrder).toEqual([
        'session.abort',
        'iterator.return',
        'done.interrupted',
      ]);
    });

    it('bounds client disposal and still attempts the shutdown fallback', async () => {
      let shutdownCalls = 0;
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 1_000,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'hanging-close' },
            events: [
              {
                type: 'session.idle',
                sessionId: 'hanging-close',
              },
            ],
            onClose: () => new Promise<void>(() => {}),
            onShutdown() {
              shutdownCalls++;
            },
          }),
        },
      );

      const startedAt = Date.now();
      const events = await collect(adapter.run('prompt'));
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      expect(shutdownCalls).toBe(1);
    });

    it('isolates rejected cleanup phases and still terminates the managed server', async () => {
      const cleanupOrder: string[] = [];
      const { spawnProcess, invocations } = makeSpawn({
        onKill(signal) {
          if (signal === 'SIGTERM') cleanupOrder.push('SIGTERM');
        },
      });
      const adapter = new OpenCodeAdapter(
        {
          mode: 'managed',
          serverUrl: 'http://127.0.0.1:4782',
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'rejected-cleanup' },
            events: [
              {
                type: 'session.idle',
                sessionId: 'rejected-cleanup',
              },
            ],
            async onClose() {
              cleanupOrder.push('close');
              throw new Error('close failed');
            },
            async onShutdown() {
              cleanupOrder.push('shutdown');
              throw new Error('shutdown failed');
            },
          }),
          spawnProcess,
          probeCliAvailability: async () => true,
          waitForServerReady: async () => 'http://127.0.0.1:4782',
        },
      );

      const events = await collect(adapter.run('prompt'));
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      expect(cleanupOrder).toEqual(['SIGTERM', 'close', 'shutdown']);
      expect(invocations[0]?.process.killSignals).toEqual(['SIGTERM']);
    });

    it('emits one interrupted terminal when caller abort races timeout status', async () => {
      const controller = new AbortController();
      let abortCalls = 0;
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 15,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'abort-timeout-race' },
            statusResult: { type: 'busy' },
            eventStreamFactory: async function* () {
              await new Promise<void>(() => {});
            },
            onGetSessionStatus() {
              controller.abort();
            },
            onAbortSession() {
              abortCalls++;
            },
          }),
        },
      );

      const events = await collect(
        adapter.run('prompt', { abortSignal: controller.signal }),
      );
      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(events[1]?.payload).toMatchObject({ status: 'interrupted' });
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
      expect(abortCalls).toBe(1);
    });

    it('gives caller abort precedence over a simultaneously ready idle event', async () => {
      const controller = new AbortController();
      let abortCalls = 0;
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 1_000,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'abort-terminal-race' },
            eventStreamFactory: () => ({
              [Symbol.asyncIterator](): AsyncIterator<unknown> {
                return {
                  next() {
                    controller.abort();
                    return Promise.resolve({
                      done: false,
                      value: {
                        type: 'session.idle',
                        sessionId: 'abort-terminal-race',
                      },
                    });
                  },
                };
              },
            }),
            onAbortSession() {
              abortCalls++;
            },
          }),
        },
      );

      const events = await collect(
        adapter.run('prompt', { abortSignal: controller.signal }),
      );
      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(events.at(-1)?.payload).toMatchObject({
        status: 'interrupted',
        resumeToken: 'abort-terminal-race',
      });
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(abortCalls).toBe(1);
    });

    it('gives caller abort terminal precedence after a timeout diagnostic is yielded', async () => {
      const controller = new AbortController();
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 15,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'abort-after-diagnostic' },
            statusResult: { type: 'busy' },
            eventStreamFactory: async function* () {
              await new Promise<void>(() => {});
            },
          }),
        },
      );

      const events: AgentEvent[] = [];
      for await (const event of adapter.run('prompt', {
        abortSignal: controller.signal,
      })) {
        events.push(event);
        if (event.type === 'error') controller.abort();
      }

      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      expect(events.at(-1)?.payload).toMatchObject({
        status: 'interrupted',
        resumeToken: 'abort-after-diagnostic',
      });
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    });
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

  it('maps PermissionPolicy.mode = "auto" to SDK permission: allow per ENG-021', () => {
    const auto = mapPermissionsToOpenCodeOptions({ mode: 'auto' });
    expect(auto.permission).toEqual({ '*': 'allow' });

    // User-passed allowedTools / disallowedTools (independent from
    // `permissions`) still flow through to `tools`.
    const withUserTools = mapPermissionsToOpenCodeOptions(
      { mode: 'auto' },
      { allowedTools: ['custom-a'], disallowedTools: ['custom-b'] },
    );
    expect(withUserTools.permission).toEqual({ '*': 'allow' });
    expect(withUserTools.tools?.core).toEqual(['custom-a']);
    expect(withUserTools.tools?.exclude).toEqual(['custom-b']);
  });

  it('rejects PermissionPolicy.mode = "bypass" with an SDK/server architecture error per IR-014', () => {
    expect(() => mapPermissionsToOpenCodeOptions({ mode: 'bypass' })).toThrow(
      /opencode adapter does not support PermissionPolicy.mode: 'bypass'/,
    );
    expect(() => mapPermissionsToOpenCodeOptions({ mode: 'bypass' })).toThrow(
      /SDK\/server session/,
    );
  });

  it('mode overrides per-capability levels in opencode per ENG-021', () => {
    // mode: 'auto' set together with explicit per-capability denies: the
    // per-capability path is short-circuited so the deny levels do not
    // appear in the emitted SDK permission body. Only the session-wide
    // `permission: allow` shape applies.
    const config = mapPermissionsToOpenCodeOptions({
      mode: 'auto',
      fileWrite: 'deny',
      shellExecute: 'deny',
      networkAccess: 'deny',
    });
    expect(config.permission).toEqual({ '*': 'allow' });
  });

  it('accepts writablePaths and reports ambient enforcement', () => {
    const mapped = mapPermissionsToOpenCodeOptions({
      mode: 'auto',
      writablePaths: ['./.git/', 'generated/./cache//'],
    });

    expect(mapped.permission).toEqual({ '*': 'allow' });
    expect(mapped.writablePaths).toEqual({
      paths: ['.git', 'generated/cache'],
      enforcement: 'ambient',
    });

    expect(() =>
      mapPermissionsToOpenCodeOptions({ writablePaths: ['../cache'] }),
    ).toThrow("permissions.writablePaths[0] must not contain '..'");
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
    onCreateSession?: (args: unknown) => void;
    onPrompt?: (args: unknown) => void;
    onSubscribe?: (args: unknown) => void;
    onDispose?: (args: unknown) => void;
  }): Record<string, unknown> {
    return {
      session: {
        async create(args?: unknown): Promise<Record<string, unknown>> {
          config.onCreateSession?.(args);
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
        async dispose(args?: unknown): Promise<void> {
          config.onDispose?.(args);
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

  it('passes the run-owned signal to v1 SSE and delegates iterator cleanup', async () => {
    const controller = new AbortController();
    let subscribeOptions: unknown;
    let returnCalls = 0;
    const rawIterator: AsyncIterator<unknown> = {
      async next() {
        return { done: false, value: { type: 'session.idle' } };
      },
      async return() {
        returnCalls++;
        return { done: true, value: undefined };
      },
    };
    const client = wrapOpencodeClient(
      makeV1Sdk({
        onSubscribe(options) {
          subscribeOptions = options;
        },
        subscribeResult: {
          stream: {
            [Symbol.asyncIterator]() {
              return rawIterator;
            },
          },
        },
      }),
    );

    const result = (await client.run?.({
      prompt: 'signal-aware v1 subscription',
      signal: controller.signal,
    })) as { events: AsyncIterable<unknown> };
    expect(subscribeOptions).toEqual({ signal: controller.signal });

    const iterator = result.events[Symbol.asyncIterator]();
    await iterator.return?.();
    expect(returnCalls).toBe(1);
  });

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

  it('preserves native permissions on v1 fresh and resumed runs', async () => {
    const createCalls: unknown[] = [];
    const promptCalls: unknown[] = [];
    let createdSessions = 0;
    const real = makeV1Sdk({
      onCreateSession(args) {
        createCalls.push(args);
      },
      onPrompt(args) {
        promptCalls.push(args);
      },
    });
    real.session = {
      ...(real.session as Record<string, unknown>),
      async create(args?: unknown) {
        createCalls.push(args);
        createdSessions++;
        return { id: `v1-native-${createdSessions}` };
      },
    };
    const client = wrapOpencodeClient(real);
    const toolRestrictions = {
      allowedTools: ['edit'],
      disallowedTools: ['webfetch'],
    };
    const unmanaged = mapPermissionsToOpenCodeOptions(
      undefined,
      toolRestrictions,
    );

    await client.run?.({ prompt: 'fresh native', ...unmanaged });
    await client.run?.({
      prompt: 'resumed native',
      sessionId: 'v1-existing',
      ...unmanaged,
    });

    expect(createCalls).toEqual([undefined]);
    expect(promptCalls).toHaveLength(2);
    for (const call of promptCalls) {
      const body = (call as { body: Record<string, unknown> }).body;
      expect(body).not.toHaveProperty('permission');
      expect(body.tools).toEqual({
        '*': false,
        edit: true,
        webfetch: false,
      });
    }

    const explicitlyManaged = mapPermissionsToOpenCodeOptions({});
    await client.run?.({ prompt: 'fresh managed', ...explicitlyManaged });
    await client.run?.({
      prompt: 'resumed managed',
      sessionId: 'v1-existing',
      ...explicitlyManaged,
    });

    expect(createCalls).toEqual([undefined, undefined]);
    for (const call of promptCalls.slice(2)) {
      expect((call as { body: Record<string, unknown> }).body.permission).toEqual({
        edit: 'ask',
        bash: 'ask',
        webfetch: 'ask',
      });
    }
  });

  it('uses the v2 prompt surface so variant reaches fresh and resumed sessions', async () => {
    let createCalls = 0;
    const promptCalls: unknown[] = [];
    const real = {
      session: {
        async create() {
          createCalls++;
          return { id: `v2-session-${createCalls}` };
        },
        async promptAsync(args: unknown) {
          promptCalls.push(args);
          return {};
        },
      },
      event: {
        async subscribe() {
          return { stream: (async function* () {})() };
        },
      },
    };

    const client = wrapOpencodeClient(real, { apiVersion: 'v2' });

    await client.run?.({
      prompt: 'fresh',
      model: 'anthropic/claude-sonnet-4-5',
      variant: 'max',
    });
    await client.run?.({
      prompt: 'resumed',
      sessionId: 'existing-session',
      model: 'openai/gpt-5',
      variant: 'medium',
    });

    expect(createCalls).toBe(1);
    expect(promptCalls).toEqual([
      expect.objectContaining({
        sessionID: 'v2-session-1',
        variant: 'max',
        model: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
        },
        parts: [{ type: 'text', text: 'fresh' }],
      }),
      expect.objectContaining({
        sessionID: 'existing-session',
        variant: 'medium',
        model: {
          providerID: 'openai',
          modelID: 'gpt-5',
        },
        parts: [{ type: 'text', text: 'resumed' }],
      }),
    ]);
    expect(promptCalls[0]).not.toHaveProperty('path');
    expect(promptCalls[0]).not.toHaveProperty('body');
    expect(promptCalls[1]).not.toHaveProperty('path');
    expect(promptCalls[1]).not.toHaveProperty('body');
  });

  it('preserves native permissions on v2 fresh and resumed runs', async () => {
    const createCalls: unknown[] = [];
    const updateCalls: unknown[] = [];
    const promptCalls: unknown[] = [];
    const real = {
      session: {
        async create(args?: unknown) {
          createCalls.push(args);
          return { data: { id: `v2-native-${createCalls.length}` } };
        },
        async update(args: unknown) {
          updateCalls.push(args);
          return {};
        },
        async promptAsync(args: unknown) {
          promptCalls.push(args);
          return {};
        },
      },
      event: {
        async subscribe() {
          return { stream: (async function* () {})() };
        },
      },
    };
    const client = wrapOpencodeClient(real, { apiVersion: 'v2' });
    const toolRestrictions = {
      allowedTools: ['edit'],
      disallowedTools: ['webfetch'],
    };
    const unmanaged = mapPermissionsToOpenCodeOptions(
      undefined,
      toolRestrictions,
    );

    await client.run?.({ prompt: 'fresh native', ...unmanaged });
    await client.run?.({
      prompt: 'resumed native',
      sessionId: 'v2-existing',
      ...unmanaged,
    });

    expect(createCalls).toEqual([{}]);
    expect(updateCalls).toEqual([]);
    expect(promptCalls).toHaveLength(2);
    for (const call of promptCalls) {
      expect(call).not.toHaveProperty('permission');
      expect(call).toEqual(
        expect.objectContaining({
          tools: {
            '*': false,
            edit: true,
            webfetch: false,
          },
        }),
      );
    }

    const explicitlyManaged = mapPermissionsToOpenCodeOptions({});
    await client.run?.({ prompt: 'fresh managed', ...explicitlyManaged });
    await client.run?.({
      prompt: 'resumed managed',
      sessionId: 'v2-existing',
      ...explicitlyManaged,
    });

    const askRules = [
      { permission: 'edit', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'webfetch', pattern: '*', action: 'ask' },
    ];
    expect(createCalls).toEqual([
      {},
      { permission: askRules },
    ]);
    expect(updateCalls).toEqual([
      {
        sessionID: 'v2-existing',
        permission: askRules,
      },
    ]);
  });

  it('maps auto mode to wildcard allow on v1 and v2 permission paths', async () => {
    const mapped = mapPermissionsToOpenCodeOptions({ mode: 'auto' });
    const v1Prompts: unknown[] = [];
    const v1 = wrapOpencodeClient(
      makeV1Sdk({
        onPrompt(args) {
          v1Prompts.push(args);
        },
      }),
    );
    await v1.run?.({ prompt: 'v1 auto', ...mapped });
    expect(v1Prompts[0]).toMatchObject({
      body: { permission: { '*': 'allow' } },
    });
    await v1.run?.({
      prompt: 'v1 resumed auto',
      sessionId: 'v1-existing',
      ...mapped,
    });
    expect(v1Prompts[1]).toMatchObject({
      path: { id: 'v1-existing' },
      body: { permission: { '*': 'allow' } },
    });

    let v2Create: unknown;
    let v2Update: unknown;
    const v2 = wrapOpencodeClient(
      {
        session: {
          async create(args: unknown) {
            v2Create = args;
            return { data: { id: 'v2-auto' } };
          },
          async update(args: unknown) {
            v2Update = args;
            return {};
          },
          async promptAsync() {
            return {};
          },
        },
        event: {
          async subscribe() {
            return { stream: (async function* () {})() };
          },
        },
      },
      { apiVersion: 'v2' },
    );
    await v2.run?.({ prompt: 'v2 auto', ...mapped });
    expect(v2Create).toEqual({
      permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    });

    await v2.run?.({
      prompt: 'v2 resumed auto',
      sessionId: 'v2-existing',
      cwd: '/workspace',
      ...mapped,
    });
    expect(v2Update).toEqual({
      sessionID: 'v2-existing',
      directory: '/workspace',
      permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    });
  });

  it('uses the legacy v1 permission response endpoint with session correlation', async () => {
    let replyArgs: unknown;
    const controller = new AbortController();
    const real = makeV1Sdk({});
    real.postSessionIdPermissionsPermissionId = async (args: unknown) => {
      replyArgs = args;
      return {};
    };
    const client = wrapOpencodeClient(real);

    await client.replyPermission?.({
      sessionId: 'legacy-session',
      requestId: 'legacy-request',
      permission: 'external_directory',
      cwd: '/workspace',
      signal: controller.signal,
    });

    expect(replyArgs).toEqual({
      path: { id: 'legacy-session', permissionID: 'legacy-request' },
      body: { response: 'reject' },
      query: { directory: '/workspace' },
      signal: controller.signal,
    });
  });

  it('uses the v2 permission reply endpoint and surfaces SDK result errors', async () => {
    const replyCalls: Array<{
      parameters: unknown;
      requestOptions: unknown;
    }> = [];
    const controller = new AbortController();
    const real = {
      session: {
        async create() {
          return { data: { id: 'v2-reply-session' } };
        },
        async promptAsync() {
          return {};
        },
      },
      event: {
        async subscribe() {
          return { stream: (async function* () {})() };
        },
      },
      permission: {
        async reply(parameters: unknown, requestOptions?: unknown) {
          replyCalls.push({ parameters, requestOptions });
          if (replyCalls.length === 1) return {};
          if (replyCalls.length === 2) {
            return { error: { data: { message: 'request disappeared' } } };
          }
          return { data: false };
        },
      },
    };
    const client = wrapOpencodeClient(real, { apiVersion: 'v2' });

    await client.replyPermission?.({
      sessionId: 'v2-reply-session',
      requestId: 'v2-reply-request',
      permission: 'future_permission',
      cwd: '/workspace',
      signal: controller.signal,
    });
    expect(replyCalls[0]).toEqual({
      parameters: {
        requestID: 'v2-reply-request',
        directory: '/workspace',
        reply: 'reject',
        message:
          'Cligent headless runs reject unresolved permission requests',
      },
      requestOptions: { signal: controller.signal },
    });

    await expect(
      client.replyPermission?.({
        sessionId: 'v2-reply-session',
        requestId: 'v2-missing-request',
        permission: 'future_permission',
      }),
    ).rejects.toThrow(
      /sessionID="v2-reply-session".*requestID="v2-missing-request".*permission="future_permission".*request disappeared/,
    );

    await expect(
      client.replyPermission?.({
        sessionId: 'v2-reply-session',
        requestId: 'v2-declined-request',
        permission: 'future_permission',
      }),
    ).rejects.toThrow(
      /sessionID="v2-reply-session".*requestID="v2-declined-request".*permission="future_permission".*declined/,
    );
  });

  it('fails with correlation details when the SDK has no permission response route', async () => {
    const client = wrapOpencodeClient(
      {
        session: {
          async create() {
            return { data: { id: 'no-reply-route-session' } };
          },
          async promptAsync() {
            return {};
          },
        },
        event: {
          async subscribe() {
            return { stream: (async function* () {})() };
          },
        },
      },
      { apiVersion: 'v2' },
    );

    await expect(
      client.replyPermission?.({
        sessionId: 'no-reply-route-session',
        requestId: 'no-reply-route-request',
        permission: 'future_permission',
      }),
    ).rejects.toThrow(
      /sessionID="no-reply-route-session".*requestID="no-reply-route-request".*permission="future_permission".*permission\.reply\(\) not available/,
    );
  });

  it('maps an explicit empty allowlist to wildcard deny prompts', async () => {
    let v1Prompt: unknown;
    const v1 = wrapOpencodeClient(
      makeV1Sdk({
        onPrompt(args) {
          v1Prompt = args;
        },
      }),
    );
    await v1.run?.({ prompt: 'v1 tool-free', tools: { core: [] } });
    expect(v1Prompt).toMatchObject({ body: { tools: { '*': false } } });

    let v2Prompt: unknown;
    const v2 = wrapOpencodeClient(
      {
        session: {
          async create() {
            return { data: { id: 'v2-tool-free' } };
          },
          async promptAsync(args: unknown) {
            v2Prompt = args;
            return {};
          },
        },
        event: {
          async subscribe() {
            return { stream: (async function* () {})() };
          },
        },
      },
      { apiVersion: 'v2' },
    );
    await v2.run?.({ prompt: 'v2 tool-free', tools: { core: [] } });
    expect(v2Prompt).toMatchObject({ tools: { '*': false } });
  });

  it('rejects wildcard allow entries on v1 and v2 prompt paths', async () => {
    const v1 = wrapOpencodeClient(makeV1Sdk());
    await expect(
      v1.run?.({ prompt: 'v1 wildcard', tools: { core: ['*'] } }),
    ).rejects.toThrow(/exact tool identifiers, not wildcard patterns/);

    const v2 = wrapOpencodeClient(
      {
        session: {
          async create() {
            return { data: { id: 'v2-wildcard' } };
          },
          async promptAsync() {
            throw new Error('prompt must not run');
          },
        },
        event: {
          async subscribe() {
            return { stream: (async function* () {})() };
          },
        },
      },
      { apiVersion: 'v2' },
    );
    await expect(
      v2.run?.({ prompt: 'v2 wildcard', tools: { core: ['*'] } }),
    ).rejects.toThrow(/exact tool identifiers, not wildcard patterns/);
  });

  it('maps v1 permission and tools options onto the v2 session and prompt surfaces', async () => {
    let capturedCreateArgs: unknown;
    let capturedPromptArgs: unknown;
    const real = {
      session: {
        async create(args?: unknown) {
          capturedCreateArgs = args;
          return { data: { id: 'v2-session-permissions' } };
        },
        async promptAsync(args: unknown) {
          capturedPromptArgs = args;
          return {};
        },
      },
      event: {
        async subscribe() {
          return { stream: (async function* () {})() };
        },
      },
    };

    const client = wrapOpencodeClient(real, { apiVersion: 'v2' });

    await client.run?.({
      prompt: 'test options',
      cwd: '/workspace',
      permission: {
        edit: 'allow',
        bash: 'ask',
        webfetch: 'deny',
      },
      tools: {
        core: ['edit', 'bash'],
        exclude: ['webfetch'],
      },
    });

    expect(capturedCreateArgs).toEqual({
      directory: '/workspace',
      permission: [
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'bash', pattern: '*', action: 'ask' },
        { permission: 'webfetch', pattern: '*', action: 'deny' },
      ],
    });
    expect(capturedPromptArgs).toEqual(
      expect.objectContaining({
        sessionID: 'v2-session-permissions',
        directory: '/workspace',
        tools: {
          '*': false,
          edit: true,
          bash: true,
          webfetch: false,
        },
        parts: [{ type: 'text', text: 'test options' }],
      }),
    );
    expect(capturedPromptArgs).not.toHaveProperty('permission');
  });

  it('updates v2 resumed sessions with the mapped permission ruleset before prompting', async () => {
    let createCalled = false;
    const updateCalls: unknown[] = [];
    const promptCalls: unknown[] = [];
    const real = {
      session: {
        async create() {
          createCalled = true;
          return { data: { id: 'new-session' } };
        },
        async update(args: unknown) {
          updateCalls.push(args);
          return {};
        },
        async promptAsync(args: unknown) {
          promptCalls.push(args);
          return {};
        },
      },
      event: {
        async subscribe() {
          return { stream: (async function* () {})() };
        },
      },
    };

    const client = wrapOpencodeClient(real, { apiVersion: 'v2' });

    await client.run?.({
      prompt: 'continue',
      sessionId: 'existing-session',
      cwd: '/workspace',
      permission: {
        edit: 'allow',
        bash: 'allow',
        webfetch: 'allow',
      },
    });

    expect(createCalled).toBe(false);
    expect(updateCalls).toEqual([
      {
        sessionID: 'existing-session',
        directory: '/workspace',
        permission: [
          { permission: 'edit', pattern: '*', action: 'allow' },
          { permission: 'bash', pattern: '*', action: 'allow' },
          { permission: 'webfetch', pattern: '*', action: 'allow' },
        ],
      },
    ]);
    expect(promptCalls).toEqual([
      expect.objectContaining({
        sessionID: 'existing-session',
        directory: '/workspace',
        parts: [{ type: 'text', text: 'continue' }],
      }),
    ]);
  });

  it('surfaces v2 SDK result errors instead of waiting on an unreachable stream', async () => {
    const real = {
      session: {
        async create() {
          return {
            error: {
              data: { message: 'bad permission ruleset' },
            },
          };
        },
        async promptAsync() {
          throw new Error('prompt should not be called');
        },
      },
      event: {
        async subscribe() {
          throw new Error('subscribe should not be called');
        },
      },
    };

    const client = wrapOpencodeClient(real, { apiVersion: 'v2' });

    await expect(client.run?.({ prompt: 'test' })).rejects.toThrow(
      'OpenCode session.create failed: bad permission ruleset',
    );
  });

  it('cleans up the eager SSE iterator and abort listener when prompting fails', async () => {
    const controller = new AbortController();
    let abortListenerRemovals = 0;
    let iteratorNextCalls = 0;
    let iteratorReturns = 0;
    let resolveNext: ((result: IteratorResult<unknown>) => void) | undefined;
    const originalRemove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    controller.signal.removeEventListener = ((
      ...args: Parameters<AbortSignal['removeEventListener']>
    ) => {
      if (args[0] === 'abort') abortListenerRemovals++;
      originalRemove(...args);
    }) as AbortSignal['removeEventListener'];

    const client = wrapOpencodeClient(
      {
        session: {
          async create() {
            return { data: { id: 'prompt-failure-cleanup' } };
          },
          async promptAsync() {
            throw new Error('prompt dispatch failed');
          },
        },
        event: {
          async subscribe() {
            return {
              stream: {
                [Symbol.asyncIterator](): AsyncIterator<unknown> {
                  return {
                    next: () => {
                      iteratorNextCalls++;
                      return new Promise<IteratorResult<unknown>>((resolve) => {
                        resolveNext = resolve;
                      });
                    },
                    async return(value?: unknown) {
                      iteratorReturns++;
                      const result = { done: true as const, value };
                      resolveNext?.(result);
                      return result;
                    },
                  };
                },
              },
            };
          },
        },
      },
      { apiVersion: 'v2' },
    );

    await expect(
      client.run?.({ prompt: 'fail', signal: controller.signal }),
    ).rejects.toThrow('prompt dispatch failed');
    expect(iteratorNextCalls).toBe(1);
    expect(iteratorReturns).toBe(1);
    expect(abortListenerRemovals).toBe(1);
  });

  it('scopes v1 create and prompt requests through query.directory', async () => {
    let capturedCreateArgs: unknown;
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
          onCreateSession(args) {
            capturedCreateArgs = args;
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

    const createArgs = capturedCreateArgs as {
      query: { directory?: string };
      signal?: AbortSignal;
    };
    const promptArgs = capturedPromptArgs as {
      query: { directory?: string };
      signal?: AbortSignal;
      body: {
        parts: unknown[];
        model?: string;
        steps?: number;
        permission?: { edit: string; bash: string; webfetch: string };
        tools?: Record<string, boolean>;
      };
    };

    expect(createArgs.query).toEqual({ directory: '/workspace' });
    expect(createArgs.signal).toBeInstanceOf(AbortSignal);
    expect(promptArgs.query).toEqual({ directory: '/workspace' });
    expect(promptArgs.signal).toBe(createArgs.signal);
    expect(promptArgs.body.model).toBe('kimi-k2');
    expect(promptArgs.body).not.toHaveProperty('cwd');
    expect(promptArgs.body.steps).toBe(5);
    expect(promptArgs.body.permission).toEqual({
      edit: 'allow',
      bash: 'ask',
      webfetch: 'deny',
    });
    expect(promptArgs.body.tools).toEqual({
      '*': false,
      edit: true,
      bash: true,
      webfetch: false,
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

  it('scopes instance.dispose to the run directory on v1 and v2', async () => {
    const v1DisposeCalls: unknown[] = [];
    const v1 = wrapOpencodeClient(
      makeV1Sdk({
        onDispose(args) {
          v1DisposeCalls.push(args);
        },
      }),
    );
    await v1.run?.({ prompt: 'v1 dispose', cwd: '/v1-workspace' });
    await v1.close?.();

    const v2DisposeCalls: unknown[] = [];
    const v2 = wrapOpencodeClient(
      {
        session: {
          async create() {
            return { data: { id: 'v2-dispose' } };
          },
          async promptAsync() {
            return {};
          },
        },
        event: {
          async subscribe() {
            return { stream: (async function* () {})() };
          },
        },
        instance: {
          async dispose(args?: unknown) {
            v2DisposeCalls.push(args);
            return { data: true };
          },
        },
      },
      { apiVersion: 'v2' },
    );
    await v2.run?.({ prompt: 'v2 dispose', cwd: '/v2-workspace' });
    await v2.close?.();

    expect(v1DisposeCalls).toEqual([
      { query: { directory: '/v1-workspace' } },
    ]);
    expect(v2DisposeCalls).toEqual([{ directory: '/v2-workspace' }]);
  });

  it('maps v2 session status and abort through the real SDK service seam', async () => {
    const statusCalls: unknown[] = [];
    const abortCalls: unknown[] = [];
    const client = wrapOpencodeClient(
      {
        session: {
          async create() {
            return { data: { id: 'status-v2' } };
          },
          async promptAsync() {
            return {};
          },
          async status(args?: unknown) {
            statusCalls.push(args);
            return { data: { 'status-v2': { type: 'busy' } } };
          },
          async abort(args: unknown) {
            abortCalls.push(args);
            return { data: true };
          },
        },
        event: {
          async subscribe() {
            return { stream: (async function* () {})() };
          },
        },
      },
      { apiVersion: 'v2' },
    );

    await expect(
      client.getSessionStatus?.({ sessionId: 'status-v2', cwd: '/repo' }),
    ).resolves.toEqual({ type: 'busy' });
    await expect(
      client.abortSession?.({ sessionId: 'status-v2', cwd: '/repo' }),
    ).resolves.toBeUndefined();
    expect(statusCalls).toEqual([{ directory: '/repo' }]);
    expect(abortCalls).toEqual([
      { sessionID: 'status-v2', directory: '/repo' },
    ]);
  });

  it('maps an omitted OpenCode status-map entry to idle', async () => {
    const client = wrapOpencodeClient(
      {
        session: {
          async create() {
            return { data: { id: 'idle-v2' } };
          },
          async promptAsync() {
            return {};
          },
          async status() {
            return { data: {} };
          },
          async abort() {
            return { data: true };
          },
        },
        event: {
          async subscribe() {
            return { stream: (async function* () {})() };
          },
        },
      },
      { apiVersion: 'v2' },
    );

    await expect(
      client.getSessionStatus?.({ sessionId: 'idle-v2', cwd: '/repo' }),
    ).resolves.toEqual({ type: 'idle' });
  });

  it('maps legacy session status and abort path/query envelopes', async () => {
    const statusCalls: unknown[] = [];
    const abortCalls: unknown[] = [];
    const client = wrapOpencodeClient({
      session: {
        async create() {
          return { id: 'status-v1' };
        },
        async prompt() {
          return {};
        },
        async status(args?: unknown) {
          statusCalls.push(args);
          return { data: { 'status-v1': { type: 'retry', attempt: 1 } } };
        },
        async abort(args: unknown) {
          abortCalls.push(args);
          return { data: true };
        },
      },
      event: {
        async subscribe() {
          return { stream: (async function* () {})() };
        },
      },
    });

    await expect(
      client.getSessionStatus?.({ sessionId: 'status-v1', cwd: '/repo' }),
    ).resolves.toEqual({ type: 'retry', attempt: 1 });
    await expect(
      client.abortSession?.({ sessionId: 'status-v1', cwd: '/repo' }),
    ).resolves.toBeUndefined();
    expect(statusCalls).toEqual([{ query: { directory: '/repo' } }]);
    expect(abortCalls).toEqual([
      { path: { id: 'status-v1' }, query: { directory: '/repo' } },
    ]);
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
  it('suppresses user content whether role metadata arrives before or after parts', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'role-session' },
          events: [
            {
              type: 'message.updated',
              properties: {
                info: {
                  id: 'user-before',
                  sessionID: 'role-session',
                  role: 'user',
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'role-session',
                  messageID: 'user-before',
                  type: 'text',
                  text: 'the submitted prompt',
                },
              },
            },
            {
              type: 'message.part.delta',
              properties: {
                sessionID: 'role-session',
                messageID: 'user-before',
                delta: 'prompt delta',
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'role-session',
                  messageID: 'user-after',
                  type: 'reasoning',
                  text: 'prompt reasoning',
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'role-session',
                  messageID: 'user-after',
                  type: 'text',
                  text: 'another submitted prompt',
                },
              },
            },
            {
              type: 'message.updated',
              properties: {
                info: {
                  id: 'user-after',
                  sessionID: 'role-session',
                  role: 'user',
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'role-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('the submitted prompt'));
    expect(events.map((event) => event.type)).toEqual(['init', 'done']);
  });

  it('emits assistant content in stream order without comparing it to the prompt', async () => {
    const prompt = 'the same bytes can be a legitimate answer';
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'role-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'assistant-after-part',
                  sessionID: 'role-session',
                  messageID: 'assistant-after',
                  type: 'text',
                  text: 'buffered answer',
                },
              },
            },
            {
              type: 'message.part.delta',
              properties: {
                sessionID: 'role-session',
                messageID: 'assistant-after',
                partID: 'assistant-after-part',
                delta: ' buffered delta',
              },
            },
            {
              type: 'message.updated',
              properties: {
                info: {
                  id: 'assistant-after',
                  sessionID: 'role-session',
                  role: 'assistant',
                },
              },
            },
            {
              type: 'message.updated',
              properties: {
                info: {
                  id: 'assistant-before',
                  sessionID: 'role-session',
                  role: 'assistant',
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'role-session',
                  messageID: 'assistant-before',
                  type: 'thinking',
                  summary: 'known-role reasoning',
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'role-session',
                  messageID: 'assistant-before',
                  type: 'text',
                  text: prompt,
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'role-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run(prompt));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'text_delta',
      'thinking',
      'text',
      'done',
    ]);
    expect(events[1]?.payload).toEqual({ content: 'buffered answer' });
    expect(events[2]?.payload).toEqual({ delta: ' buffered delta' });
    expect(events[3]?.payload).toEqual({ summary: 'known-role reasoning' });
    expect(events[4]?.payload).toEqual({ content: prompt });
  });

  it('preserves content order across interleaved unresolved message roles', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'role-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'role-session',
                part: {
                  messageID: 'assistant-a',
                  type: 'text',
                  text: 'first',
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'role-session',
                part: {
                  messageID: 'assistant-b',
                  type: 'text',
                  text: 'second',
                },
              },
            },
            {
              type: 'message.updated',
              properties: {
                sessionID: 'role-session',
                info: {
                  id: 'assistant-b',
                  role: 'assistant',
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'role-session',
                part: { type: 'text', text: 'legacy third' },
              },
            },
            {
              type: 'message.updated',
              properties: {
                sessionID: 'role-session',
                info: {
                  id: 'assistant-a',
                  role: 'assistant',
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'role-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    expect(
      events
        .filter((event) => event.type === 'text')
        .map((event) => (event.payload as { content: string }).content),
    ).toEqual(['first', 'second', 'legacy third']);
  });

  it('removes unresolved message content without blocking later output', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'role-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'role-session',
                part: {
                  messageID: 'removed-message',
                  type: 'text',
                  text: 'drop me',
                },
              },
            },
            {
              type: 'message.removed',
              properties: {
                sessionID: 'role-session',
                messageID: 'removed-message',
              },
            },
            {
              type: 'message.updated',
              properties: {
                sessionID: 'role-session',
                info: {
                  id: 'assistant-known',
                  role: 'assistant',
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'role-session',
                part: {
                  messageID: 'assistant-known',
                  type: 'text',
                  text: 'keep me',
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'role-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'done',
    ]);
    expect(events[1]?.payload).toEqual({ content: 'keep me' });
  });

  it('drops an unresolved head item without losing later known output', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'role-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'role-session',
                part: {
                  messageID: 'never-resolved',
                  type: 'text',
                  text: 'drop me',
                },
              },
            },
            {
              type: 'message.updated',
              properties: {
                sessionID: 'role-session',
                info: {
                  id: 'assistant-known',
                  role: 'assistant',
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'role-session',
                part: {
                  messageID: 'assistant-known',
                  type: 'text',
                  text: 'keep me',
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'role-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'done',
    ]);
    expect(events[1]?.payload).toEqual({ content: 'keep me' });
  });

  it('flushes known assistant output before inactivity recovery terminates', async () => {
    let streamSignal: AbortSignal | undefined;
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
        eventInactivityTimeoutMs: 15,
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'role-session' },
          statusResult: { type: 'idle' },
          eventStreamFactory: (streamOptions) => ({
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'role-session',
                  part: {
                    messageID: 'never-resolved',
                    type: 'text',
                    text: 'drop me',
                  },
                },
              };
              yield {
                type: 'message.updated',
                properties: {
                  sessionID: 'role-session',
                  info: { id: 'assistant-known', role: 'assistant' },
                },
              };
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'role-session',
                  part: {
                    messageID: 'assistant-known',
                    type: 'text',
                    text: 'keep me',
                  },
                },
              };
              const signal = streamOptions?.signal as AbortSignal;
              streamSignal = signal;
              await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
              });
            },
          }),
        }),
      },
    );

    const run = adapter.run('prompt');
    const init = await run.next();
    const flushed = await run.next();
    expect(init.value).toMatchObject({ type: 'init' });
    expect(flushed.value).toMatchObject({
      type: 'text',
      payload: { content: 'keep me' },
    });
    expect(streamSignal?.aborted).toBe(true);

    const terminal = await collect(run);
    expect(terminal.map((event) => event.type)).toEqual(['error', 'done']);
    expect(terminal[0]?.payload).toMatchObject({
      code: 'OPENCODE_INACTIVITY_IDLE_RECOVERED',
    });
    expect(terminal[1]?.payload).toMatchObject({ status: 'success' });
  });

  it('flushes known assistant output before a permission failure terminates', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'role-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'role-session',
                part: {
                  messageID: 'never-resolved',
                  type: 'text',
                  text: 'drop me',
                },
              },
            },
            {
              type: 'message.updated',
              properties: {
                sessionID: 'role-session',
                info: { id: 'assistant-known', role: 'assistant' },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'role-session',
                part: {
                  messageID: 'assistant-known',
                  type: 'text',
                  text: 'keep me',
                },
              },
            },
            {
              type: 'permission.asked',
              properties: {
                sessionID: 'role-session',
                permission: 'future_permission',
              },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'permission_request',
      'text',
      'error',
      'done',
    ]);
    expect(events[2]?.payload).toEqual({ content: 'keep me' });
    expect(events[3]?.payload).toMatchObject({
      code: 'OPENCODE_PERMISSION_REQUEST_INVALID',
    });
    expect(events[4]?.payload).toMatchObject({ status: 'error' });
  });

  it.each([
    {
      label: 'a missing permission request id',
      permission: {
        sessionID: 'role-session',
        permission: 'future_permission',
      },
      replyPermissionError: undefined,
    },
    {
      label: 'a failed permission reply',
      permission: {
        sessionID: 'role-session',
        requestID: 'permission-request-1',
        permission: 'future_permission',
      },
      replyPermissionError: new Error('reply route unavailable'),
    },
  ])(
    'awaits session cancellation before interrupted done after $label queue flush',
    async ({ permission, replyPermissionError }) => {
      const controller = new AbortController();
      let abortCalls = 0;
      let releaseAbort: (() => void) | undefined;
      const abortGate = new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      const adapter = new OpenCodeAdapter(
        { mode: 'external', serverUrl: 'http://opencode.local:7777' },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'role-session' },
            events: [
              {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'role-session',
                  part: {
                    messageID: 'never-resolved',
                    type: 'text',
                    text: 'drop me',
                  },
                },
              },
              {
                type: 'message.updated',
                properties: {
                  sessionID: 'role-session',
                  info: { id: 'assistant-known', role: 'assistant' },
                },
              },
              {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'role-session',
                  part: {
                    messageID: 'assistant-known',
                    type: 'text',
                    text: 'keep me',
                  },
                },
              },
              {
                type: 'permission.asked',
                properties: permission,
              },
            ],
            ...(replyPermissionError !== undefined
              ? { replyPermissionError }
              : {}),
            async onAbortSession() {
              abortCalls++;
              await abortGate;
            },
          }),
        },
      );

      const run = adapter.run('prompt', { abortSignal: controller.signal });
      expect((await run.next()).value).toMatchObject({ type: 'init' });
      expect((await run.next()).value).toMatchObject({
        type: 'permission_request',
      });
      expect((await run.next()).value).toMatchObject({
        type: 'text',
        payload: { content: 'keep me' },
      });

      controller.abort();
      let terminalSettled = false;
      const terminalPromise = run.next().then((terminal) => {
        terminalSettled = true;
        return terminal;
      });
      await vi.waitFor(() => expect(abortCalls).toBe(1));
      expect(terminalSettled).toBe(false);

      releaseAbort?.();
      const terminal = await terminalPromise;
      expect(terminal.value).toMatchObject({
        type: 'done',
        payload: { status: 'interrupted' },
      });
      expect((await run.next()).done).toBe(true);
    },
  );

  it('gives caller abort precedence after terminal role-queue flushing', async () => {
    const controller = new AbortController();
    let abortCalls = 0;
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'role-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'role-session',
                part: {
                  messageID: 'never-resolved',
                  type: 'text',
                  text: 'drop me',
                },
              },
            },
            {
              type: 'message.updated',
              properties: {
                sessionID: 'role-session',
                info: { id: 'assistant-known', role: 'assistant' },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'role-session',
                part: {
                  messageID: 'assistant-known',
                  type: 'text',
                  text: 'keep me',
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'role-session' },
            },
          ],
          onAbortSession() {
            abortCalls++;
          },
        }),
      },
    );

    const events: AgentEvent[] = [];
    for await (const event of adapter.run('prompt', {
      abortSignal: controller.signal,
    })) {
      events.push(event);
      if (event.type === 'text') controller.abort();
    }

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'done',
    ]);
    expect(events[2]?.payload).toMatchObject({ status: 'interrupted' });
    expect(abortCalls).toBe(1);
  });

  it('does not use foreign-session role metadata to release pending content', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'role-session' },
          events: [
            {
              type: 'message.updated',
              properties: {
                info: {
                  id: 'shared-message',
                  sessionID: 'foreign-session',
                  role: 'assistant',
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'role-session',
                  messageID: 'shared-message',
                  type: 'text',
                  text: 'must stay pending',
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'role-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual(['init', 'done']);
  });

  it('unwraps properties and classifies generic deltas by part id', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'sse-session' },
          events: [
            {
              type: 'message.updated',
              properties: {
                sessionID: 'sse-session',
                info: {
                  id: 'assistant-message',
                  sessionID: 'sse-session',
                  role: 'assistant',
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'sse-session',
                part: {
                  id: 'text-part',
                  sessionID: 'sse-session',
                  messageID: 'assistant-message',
                  type: 'text',
                  text: '',
                },
              },
            },
            {
              type: 'message.part.delta',
              properties: {
                sessionID: 'sse-session',
                messageID: 'assistant-message',
                partID: 'text-part',
                field: 'text',
                delta: 'hello',
              },
            },
            {
              type: 'message.part.delta',
              properties: {
                sessionID: 'sse-session',
                messageID: 'assistant-message',
                partID: 'text-part',
                field: 'text',
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

  it('keeps interleaved reasoning out of typed and generic output deltas', async () => {
    const assistantMessageUpdated = makeV2MessageUpdated(
      'typed-session',
      'assistant-message',
      'assistant',
    );
    const genericTextBeforeMetadata = {
      id: 'generic-text-late',
      type: 'message.part.delta',
      properties: {
        sessionID: 'typed-session',
        messageID: 'assistant-message',
        partID: 'text-late',
        field: 'text',
        delta: 'late',
      },
    } satisfies EventMessagePartDelta;
    const genericReasoningBeforeMetadata = {
      id: 'generic-reasoning-late',
      type: 'message.part.delta',
      properties: {
        sessionID: 'typed-session',
        messageID: 'assistant-message',
        partID: 'reasoning-late',
        field: 'text',
        delta: 'secret late',
      },
    } satisfies EventMessagePartDelta;
    const genericTextAfterMetadata = {
      id: 'generic-text-early',
      type: 'message.part.delta',
      properties: {
        sessionID: 'typed-session',
        messageID: 'assistant-message',
        partID: 'text-early',
        field: 'text',
        delta: ' output',
      },
    } satisfies EventMessagePartDelta;
    const genericReasoningAfterMetadata = {
      id: 'generic-reasoning-early',
      type: 'message.part.delta',
      properties: {
        sessionID: 'typed-session',
        messageID: 'assistant-message',
        partID: 'reasoning-early',
        field: 'text',
        delta: 'secret early',
      },
    } satisfies EventMessagePartDelta;
    const lateTextMetadata = makeV2PartUpdated({
      id: 'text-late',
      sessionID: 'typed-session',
      messageID: 'assistant-message',
      type: 'text',
      text: '',
    });
    const lateReasoningMetadata = makeV2PartUpdated({
      id: 'reasoning-late',
      sessionID: 'typed-session',
      messageID: 'assistant-message',
      type: 'reasoning',
      text: 'settled late thought',
      time: { start: 1, end: 2 },
    });
    const earlyTextMetadata = makeV2PartUpdated({
      id: 'text-early',
      sessionID: 'typed-session',
      messageID: 'assistant-message',
      type: 'text',
      text: '',
    });
    const earlyReasoningMetadata = makeV2PartUpdated({
      id: 'reasoning-early',
      sessionID: 'typed-session',
      messageID: 'assistant-message',
      type: 'reasoning',
      text: 'settled early thought',
      time: { start: 2, end: 3 },
    });
    const explicitTextDelta = {
      id: 'explicit-text',
      type: 'session.next.text.delta',
      properties: {
        timestamp: 1,
        sessionID: 'typed-session',
        assistantMessageID: 'assistant-message',
        textID: 'explicit-text-part',
        delta: ' explicit',
      },
    } satisfies EventSessionNextTextDelta;
    const explicitReasoningDelta = {
      id: 'explicit-reasoning',
      type: 'session.next.reasoning.delta',
      properties: {
        timestamp: 2,
        sessionID: 'typed-session',
        assistantMessageID: 'assistant-message',
        reasoningID: 'explicit-reasoning-part',
        delta: 'secret explicit',
      },
    } satisfies EventSessionNextReasoningDelta;
    const v1TextDelta = {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'v1-text',
          sessionID: 'typed-session',
          messageID: 'assistant-message',
          type: 'text',
          text: 'late output explicit v1',
        },
        delta: ' v1',
      },
    } satisfies V1EventMessagePartUpdated;
    const v1ReasoningDelta = {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'v1-reasoning',
          sessionID: 'typed-session',
          messageID: 'assistant-message',
          type: 'reasoning',
          text: 'partial thought',
          time: { start: 1 },
        },
        delta: 'secret v1',
      },
    } satisfies V1EventMessagePartUpdated;
    const v1ReasoningFinal = {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'v1-reasoning',
          sessionID: 'typed-session',
          messageID: 'assistant-message',
          type: 'reasoning',
          text: 'settled v1 thought',
          time: { start: 1, end: 4 },
        },
      },
    } satisfies V1EventMessagePartUpdated;
    const v1TextFinal = {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'v1-text',
          sessionID: 'typed-session',
          messageID: 'assistant-message',
          type: 'text',
          text: ' v1',
        },
      },
    } satisfies V1EventMessagePartUpdated;
    const explicitTextFinal = makeV2PartUpdated({
      id: 'explicit-text-part',
      sessionID: 'typed-session',
      messageID: 'assistant-message',
      type: 'text',
      text: ' explicit',
    });
    const unresolvedDelta = {
      id: 'generic-unresolved',
      type: 'message.part.delta',
      properties: {
        sessionID: 'typed-session',
        messageID: 'assistant-message',
        partID: 'never-described',
        field: 'text',
        delta: 'must not default to output',
      },
    } satisfies EventMessagePartDelta;

    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'typed-session' },
          events: [
            assistantMessageUpdated,
            genericTextBeforeMetadata,
            genericReasoningBeforeMetadata,
            lateTextMetadata,
            lateReasoningMetadata,
            earlyTextMetadata,
            earlyReasoningMetadata,
            genericTextAfterMetadata,
            genericReasoningAfterMetadata,
            explicitTextDelta,
            explicitReasoningDelta,
            v1TextDelta,
            v1ReasoningDelta,
            v1ReasoningFinal,
            v1ReasoningFinal,
            v1TextFinal,
            v1TextFinal,
            unresolvedDelta,
            makeV2MessageUpdated('typed-session', 'user-message', 'user'),
            makeV2PartUpdated({
              id: 'user-text',
              sessionID: 'typed-session',
              messageID: 'user-message',
              type: 'text',
              text: '',
            }),
            {
              id: 'generic-user',
              type: 'message.part.delta',
              properties: {
                sessionID: 'typed-session',
                messageID: 'user-message',
                partID: 'user-text',
                field: 'text',
                delta: 'user prompt delta',
              },
            } satisfies EventMessagePartDelta,
            explicitTextFinal,
            explicitTextFinal,
            {
              type: 'session.idle',
              properties: { sessionID: 'typed-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('user prompt delta'));
    const deltas = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => (event.payload as { delta: string }).delta);
    const thoughts = events
      .filter((event) => event.type === 'thinking')
      .map((event) => (event.payload as { summary: string }).summary);
    const semanticOutput = events
      .filter((event) => event.type === 'text' || event.type === 'text_delta')
      .map((event) =>
        event.type === 'text'
          ? (event.payload as { content: string }).content
          : (event.payload as { delta: string }).delta,
      )
      .join('');

    expect(deltas.join('')).toBe('late output explicit v1');
    expect(deltas).toEqual(['late', ' output', ' explicit', ' v1']);
    expect(thoughts).toEqual([
      'settled late thought',
      'settled early thought',
      'settled v1 thought',
    ]);
    expect(semanticOutput).toBe('late output explicit v1');
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text_delta',
      'thinking',
      'thinking',
      'text_delta',
      'text_delta',
      'text_delta',
      'thinking',
      'done',
    ]);
  });

  it('preserves generic delta order when later part metadata resolves first', async () => {
    const firstDelta = {
      id: 'delta-first',
      type: 'message.part.delta',
      properties: {
        sessionID: 'ordered-session',
        messageID: 'assistant-message',
        partID: 'part-first',
        field: 'text',
        delta: 'first',
      },
    } satisfies EventMessagePartDelta;
    const secondDelta = {
      id: 'delta-second',
      type: 'message.part.delta',
      properties: {
        sessionID: 'ordered-session',
        messageID: 'assistant-message',
        partID: 'part-second',
        field: 'text',
        delta: ' second',
      },
    } satisfies EventMessagePartDelta;
    const secondMetadata = makeV2PartUpdated({
      id: 'part-second',
      sessionID: 'ordered-session',
      messageID: 'assistant-message',
      type: 'text',
      text: '',
    });
    const firstMetadata = makeV2PartUpdated({
      id: 'part-first',
      sessionID: 'ordered-session',
      messageID: 'assistant-message',
      type: 'text',
      text: '',
    });
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'ordered-session' },
          events: [
            makeV2MessageUpdated(
              'ordered-session',
              'assistant-message',
              'assistant',
            ),
            firstDelta,
            secondDelta,
            secondMetadata,
            firstMetadata,
            {
              id: 'ordered-session-idle',
              type: 'session.idle',
              properties: { sessionID: 'ordered-session' },
            } satisfies EventSessionIdle,
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    expect(
      events
        .filter((event) => event.type === 'text_delta')
        .map((event) => (event.payload as { delta: string }).delta),
    ).toEqual(['first', ' second']);
  });

  it('discards role-pending content when its part is removed', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'removed-part-session' },
          events: [
            makeV2PartUpdated({
              id: 'removed-part',
              sessionID: 'removed-part-session',
              messageID: 'assistant-message',
              type: 'text',
              text: 'removed snapshot',
            }),
            {
              id: 'removed-part-delta',
              type: 'message.part.delta',
              properties: {
                sessionID: 'removed-part-session',
                messageID: 'assistant-message',
                partID: 'removed-part',
                field: 'text',
                delta: ' removed delta',
              },
            } satisfies EventMessagePartDelta,
            makeV2PartRemoved(
              'removed-part-session',
              'assistant-message',
              'removed-part',
            ),
            makeV2MessageUpdated(
              'removed-part-session',
              'assistant-message',
              'assistant',
            ),
            {
              id: 'removed-part-session-idle',
              type: 'session.idle',
              properties: { sessionID: 'removed-part-session' },
            } satisfies EventSessionIdle,
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual(['init', 'done']);
  });

  it('clears correlated part history when a message is removed', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'removed-message-session' },
          events: [
            makeV2MessageUpdated(
              'removed-message-session',
              'old-message',
              'assistant',
            ),
            {
              id: 'old-text-delta',
              type: 'session.next.text.delta',
              properties: {
                timestamp: 1,
                sessionID: 'removed-message-session',
                assistantMessageID: 'old-message',
                textID: 'reused-part',
                delta: 'same output',
              },
            } satisfies EventSessionNextTextDelta,
            makeV2MessageRemoved('removed-message-session', 'old-message'),
            makeV2MessageUpdated(
              'removed-message-session',
              'new-message',
              'assistant',
            ),
            makeV2PartUpdated({
              id: 'reused-part',
              sessionID: 'removed-message-session',
              messageID: 'new-message',
              type: 'text',
              text: 'same output',
            }),
            {
              id: 'removed-message-session-idle',
              type: 'session.idle',
              properties: { sessionID: 'removed-message-session' },
            } satisfies EventSessionIdle,
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    expect(
      events
        .filter((event) => event.type === 'text_delta' || event.type === 'text')
        .map((event) =>
          event.type === 'text_delta'
            ? (event.payload as { delta: string }).delta
            : (event.payload as { content: string }).content,
        ),
    ).toEqual(['same output', 'same output']);
  });

  it('emits nonconsecutive settled snapshots only once per content', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'snapshot-session' },
          events: [
            makeV2MessageUpdated(
              'snapshot-session',
              'assistant-message',
              'assistant',
            ),
            makeV2PartUpdated({
              id: 'text-part',
              sessionID: 'snapshot-session',
              messageID: 'assistant-message',
              type: 'text',
              text: 'A',
            }, 1),
            makeV2PartUpdated({
              id: 'text-part',
              sessionID: 'snapshot-session',
              messageID: 'assistant-message',
              type: 'text',
              text: 'B',
            }, 2),
            makeV2PartUpdated({
              id: 'text-part',
              sessionID: 'snapshot-session',
              messageID: 'assistant-message',
              type: 'text',
              text: 'A',
            }, 3),
            {
              id: 'snapshot-session-idle',
              type: 'session.idle',
              properties: { sessionID: 'snapshot-session' },
            } satisfies EventSessionIdle,
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    expect(
      events
        .filter((event) => event.type === 'text')
        .map((event) => (event.payload as { content: string }).content),
    ).toEqual(['A', 'B']);
  });

  it('fails closed on an uncorrelatable generic delta without blocking output', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'malformed-session' },
          events: [
            makeV2MessageUpdated(
              'malformed-session',
              'assistant-message',
              'assistant',
            ),
            {
              type: 'message.part.delta',
              properties: {
                sessionID: 'malformed-session',
                messageID: 'assistant-message',
                delta: 'must be dropped',
              },
            },
            makeV2PartUpdated({
              id: 'valid-part',
              sessionID: 'malformed-session',
              messageID: 'assistant-message',
              type: 'text',
              text: 'valid output',
            }),
            {
              id: 'malformed-session-idle',
              type: 'session.idle',
              properties: { sessionID: 'malformed-session' },
            } satisfies EventSessionIdle,
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'done',
    ]);
    expect(events[1]?.payload).toEqual({ content: 'valid output' });
  });

  it('drains incident-scale pending deltas without losing order', async () => {
    const deltaCount = 2_050;
    const pendingDeltas = Array.from({ length: deltaCount }, (_, index) => ({
      id: `bulk-delta-${index}`,
      type: 'message.part.delta' as const,
      properties: {
        sessionID: 'bulk-session',
        messageID: 'assistant-message',
        partID: 'bulk-part',
        field: 'text',
        delta: `${index},`,
      },
    } satisfies EventMessagePartDelta));
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'bulk-session' },
          events: [
            makeV2MessageUpdated(
              'bulk-session',
              'assistant-message',
              'assistant',
            ),
            ...pendingDeltas,
            makeV2PartUpdated({
              id: 'bulk-part',
              sessionID: 'bulk-session',
              messageID: 'assistant-message',
              type: 'text',
              text: '',
            }),
            {
              id: 'bulk-session-idle',
              type: 'session.idle',
              properties: { sessionID: 'bulk-session' },
            } satisfies EventSessionIdle,
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    const deltas = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => (event.payload as { delta: string }).delta);
    expect(deltas).toHaveLength(deltaCount);
    expect(deltas.join('')).toBe(pendingDeltas
      .map((event) => event.properties.delta)
      .join(''));
  });

  it('handles session.error events', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'err-session' },
          events: [
            ({
              id: 'event-auth-error',
              type: 'session.error',
              properties: {
                sessionID: 'err-session',
                error: {
                  name: 'APIError',
                  data: {
                    message: 'Invalid Authentication',
                    statusCode: 401,
                    isRetryable: false,
                  },
                },
              },
            } satisfies EventSessionError),
            ({
              id: 'event-auth-idle',
              type: 'session.idle',
              properties: { sessionID: 'err-session' },
            } satisfies EventSessionIdle),
          ],
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const types = events.map((e) => e.type);
    expect(types).toEqual(['init', 'error', 'done']);

    const err = events[1] as AgentEvent & { payload: { message: string } };
    expect(err.payload.message).toBe('Invalid Authentication');
    expect(events[2]?.payload).toMatchObject({ status: 'error' });
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

  it('accumulates cache and reasoning step usage exactly once', async () => {
    const firstStep = {
      id: 'step-1',
      sessionID: 'usage-session',
      messageID: 'message-1',
      type: 'step-finish',
      reason: 'stop',
      cost: 0.003,
      tokens: {
        input: 100,
        output: 50,
        reasoning: 20,
        cache: { read: 10, write: 5 },
      },
    } satisfies StepFinishPart;
    const secondStep = {
      id: 'step-2',
      sessionID: 'usage-session',
      messageID: 'message-2',
      type: 'step-finish',
      reason: 'stop',
      cost: 0.002,
      tokens: {
        input: 80,
        output: 30,
        reasoning: 10,
        cache: { read: 4, write: 1 },
      },
    } satisfies StepFinishPart;
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'usage-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                part: firstStep,
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                part: secondStep,
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
    const payload = done.payload as DonePayload;
    expect(payload.usage.tokenAvailability).toBe('reported');
    expect(payload.usage.inputTokens).toBe(200);
    expect(payload.usage.outputTokens).toBe(110);
    expect(payload.usage.totalCostUsd).toBe(0.005);
  });

  it('treats an explicitly reported zero-valued step as available usage', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'zero-usage-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'zero-usage-session',
                  type: 'step-finish',
                  tokens: {
                    input: 0,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                  cost: 0,
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'zero-usage-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage).toEqual({
      tokenAvailability: 'reported',
      inputTokens: 0,
      outputTokens: 0,
      toolUses: 0,
    });
  });

  it.each([
    [
      'negative input',
      {
        input: -1,
        output: 2,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    ],
    [
      'fractional output',
      {
        input: 1,
        output: 2.5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    ],
    [
      'invalid cache read',
      {
        input: 1,
        output: 2,
        reasoning: 0,
        cache: { read: '3', write: 0 },
      },
    ],
    [
      'invalid reasoning',
      {
        input: 1,
        output: 2,
        reasoning: -1,
        cache: { read: 0, write: 0 },
      },
    ],
    [
      'missing required cache counters',
      { input: 1, output: 2, reasoning: 0 },
    ],
  ])('marks step-finish %s accounting unavailable', async (_case, tokens) => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'malformed-usage-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'malformed-usage-session',
                  type: 'step-finish',
                  tokens,
                  cost: 0,
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'malformed-usage-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage.tokenAvailability).toBe(
      'unavailable',
    );
  });

  it.each([
    {
      label: 'malformed terminal counters over valid step accounting',
      stepTokens: {
        input: 3,
        output: 2,
        reasoning: 0,
        cache: { read: 1, write: 0 },
      },
      terminalUsage: {
        inputTokens: 4,
        outputTokens: 2,
        cacheReadInputTokens: 'invalid',
        toolUses: 4,
      },
    },
    {
      label: 'valid terminal counters over malformed step accounting',
      stepTokens: {
        input: 3,
        output: 2,
        reasoning: 0,
        cache: { read: -1, write: 0 },
      },
      terminalUsage: {
        inputTokens: 4,
        outputTokens: 2,
        toolUses: 4,
      },
    },
  ])('does not hide $label', async ({ stepTokens, terminalUsage }) => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'combined-usage-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'combined-usage-session',
                  type: 'step-finish',
                  tokens: stepTokens,
                  cost: 0,
                },
              },
            },
            {
              type: 'session.idle',
              properties: {
                sessionID: 'combined-usage-session',
                usage: terminalUsage,
              },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage).toMatchObject({
      tokenAvailability: 'unavailable',
      toolUses: 4,
    });
  });

  it('preserves observed tools on a synthesized OpenCode terminal', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'synthetic-usage-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'synthetic-usage-session',
                part: {
                  id: 'tool-part-1',
                  messageID: 'assistant-message',
                  type: 'tool',
                  callID: 'tool-call-1',
                  tool: 'bash',
                  state: { status: 'running', input: { command: 'pwd' } },
                },
              },
            },
            {
              type: 'permission.asked',
              properties: {
                sessionID: 'synthetic-usage-session',
                permission: 'future_permission',
              },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage).toMatchObject({
      tokenAvailability: 'unavailable',
      toolUses: 1,
    });
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

  it('sums cache tokens into inputTokens', async () => {
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
      },
      {
        loadSdk: makeLoader({
          events: [
            {
              type: 'session.idle',
              status: 'success',
              usage: {
                inputTokens: 6,
                outputTokens: 18,
                cacheReadInputTokens: 90,
                cacheCreationInputTokens: 40,
                toolUses: 0,
              },
              durationMs: 50,
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const usage = (done.payload as DonePayload).usage;
    expect(usage.tokenAvailability).toBe('reported');
    expect(usage.inputTokens).toBe(136);
  });

  it('marks a present-invalid optional event cache counter unavailable', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          events: [
            {
              type: 'session.idle',
              usage: {
                inputTokens: 6,
                outputTokens: 18,
                cacheReadInputTokens: '90',
              },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage.tokenAvailability).toBe(
      'unavailable',
    );
  });

  it('preserves provider tool uses when event token accounting is unavailable', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          events: [
            {
              type: 'session.idle',
              usage: { toolUses: 5 },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('prompt'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage).toMatchObject({
      tokenAvailability: 'unavailable',
      inputTokens: 0,
      outputTokens: 0,
      toolUses: 5,
    });
  });
});

describe('OpenCode tool lifecycle (TADAPT-031)', () => {
  interface ToolUseLike {
    payload: {
      toolName: string;
      toolUseId: string;
      input: Record<string, unknown>;
      description?: string;
    };
  }

  interface ToolResultLike {
    payload: {
      toolName: string;
      toolUseId: string;
      status: string;
      output: unknown;
      durationMs?: number;
    };
  }

  interface DoneLike {
    payload: {
      usage: {
        tokenAvailability: 'reported' | 'unavailable';
        toolUses: number;
      };
    };
  }

  function toolPartEvent(
    callID: string,
    partId: string,
    state: Record<string, unknown>,
    tool = 'bash',
  ): Record<string, unknown> {
    return {
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: partId,
          sessionID: 'session-1',
          messageID: 'message-1',
          type: 'tool',
          callID,
          tool,
          state,
        },
        time: 1,
      },
    };
  }

  const idleEvent = {
    type: 'session.idle',
    properties: { sessionID: 'session-1' },
  };

  async function runLifecycle(events: unknown[]): Promise<AgentEvent[]> {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'session-1' },
          events: [...events, idleEvent],
        }),
      },
    );
    return collect(adapter.run('prompt'));
  }

  it('collapses pending → repeated running → completed into one correlated pair', async () => {
    const events = await runLifecycle([
      toolPartEvent('call-a', 'part-a', {
        status: 'pending',
        input: {},
        raw: '{"comm',
      }),
      toolPartEvent('call-a', 'part-a', {
        status: 'running',
        input: { command: 'ls -la' },
        time: { start: 100 },
      }),
      toolPartEvent('call-a', 'part-a', {
        status: 'running',
        input: { command: 'ls -la' },
        title: 'ls -la',
        time: { start: 100 },
      }),
      toolPartEvent('call-a', 'part-a', {
        status: 'completed',
        input: { command: 'ls -la' },
        output: 'file.txt',
        title: 'ls -la',
        metadata: {},
        time: { start: 100, end: 250 },
      }),
    ]);

    expect(events.map((e) => e.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'done',
    ]);

    const toolUse = events[1] as AgentEvent & ToolUseLike;
    expect(toolUse.payload.toolUseId).toBe('call-a');
    expect(toolUse.payload.toolName).toBe('bash');
    expect(toolUse.payload.input).toEqual({ command: 'ls -la' });
    expect(toolUse.payload.description).toBeUndefined();

    const toolResult = events[2] as AgentEvent & ToolResultLike;
    expect(toolResult.payload.toolUseId).toBe('call-a');
    expect(toolResult.payload.toolName).toBe('bash');
    expect(toolResult.payload.status).toBe('success');
    expect(toolResult.payload.output).toBe('file.txt');
    expect(toolResult.payload.durationMs).toBe(150);

    const done = events[3] as AgentEvent & DoneLike;
    expect(done.payload.usage.tokenAvailability).toBe('unavailable');
    expect(done.payload.usage.toolUses).toBe(1);
  });

  it('collapses pending → running → error into one correlated error pair', async () => {
    const events = await runLifecycle([
      toolPartEvent('call-b', 'part-b', {
        status: 'pending',
        input: {},
        raw: '',
      }),
      toolPartEvent('call-b', 'part-b', {
        status: 'running',
        input: { url: 'https://example.com' },
        time: { start: 10 },
      }),
      toolPartEvent(
        'call-b',
        'part-b',
        {
          status: 'error',
          input: { url: 'https://example.com' },
          error: 'connection refused',
          time: { start: 10, end: 35 },
        },
        'webfetch',
      ),
    ]);

    expect(events.map((e) => e.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'done',
    ]);

    const toolUse = events[1] as AgentEvent & ToolUseLike;
    expect(toolUse.payload.toolUseId).toBe('call-b');
    expect(toolUse.payload.input).toEqual({ url: 'https://example.com' });

    const toolResult = events[2] as AgentEvent & ToolResultLike;
    expect(toolResult.payload.toolUseId).toBe('call-b');
    expect(toolResult.payload.status).toBe('error');
    expect(toolResult.payload.output).toBe('connection refused');
    expect(toolResult.payload.durationMs).toBe(25);

    const done = events[3] as AgentEvent & DoneLike;
    expect(done.payload.usage.toolUses).toBe(1);
  });

  it('produces a correlated pair from a terminal snapshot with no earlier snapshots', async () => {
    const events = await runLifecycle([
      toolPartEvent('call-c', 'part-c', {
        status: 'completed',
        input: { command: 'pwd' },
        output: '/repo',
        title: 'pwd',
        metadata: {},
        time: { start: 5, end: 9 },
      }),
    ]);

    expect(events.map((e) => e.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'done',
    ]);

    const toolUse = events[1] as AgentEvent & ToolUseLike;
    expect(toolUse.payload.toolUseId).toBe('call-c');
    expect(toolUse.payload.input).toEqual({ command: 'pwd' });
    expect(toolUse.payload.description).toBe('pwd');

    const toolResult = events[2] as AgentEvent & ToolResultLike;
    expect(toolResult.payload.toolUseId).toBe('call-c');
    expect(toolResult.payload.status).toBe('success');
  });

  it('does not duplicate events or usage on repeated terminal snapshots', async () => {
    const completed = {
      status: 'completed',
      input: { command: 'pwd' },
      output: '/repo',
      title: 'pwd',
      metadata: {},
      time: { start: 5, end: 9 },
    };
    const events = await runLifecycle([
      toolPartEvent('call-d', 'part-d', completed),
      toolPartEvent('call-d', 'part-d', completed),
      toolPartEvent('call-d', 'part-d', completed),
    ]);

    expect(events.filter((e) => e.type === 'tool_use')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(1);

    const done = events.find((e) => e.type === 'done') as AgentEvent & DoneLike;
    expect(done.payload.usage.toolUses).toBe(1);
  });

  it('keeps interleaved parallel calls isolated per callID', async () => {
    const events = await runLifecycle([
      toolPartEvent('call-x', 'part-x', {
        status: 'running',
        input: { command: 'sleep 1' },
        time: { start: 1 },
      }),
      toolPartEvent(
        'call-y',
        'part-y',
        {
          status: 'running',
          input: { url: 'https://example.com' },
          time: { start: 2 },
        },
        'webfetch',
      ),
      toolPartEvent('call-x', 'part-x', {
        status: 'completed',
        input: { command: 'sleep 1' },
        output: 'done-x',
        title: 'sleep',
        metadata: {},
        time: { start: 1, end: 11 },
      }),
      toolPartEvent(
        'call-y',
        'part-y',
        {
          status: 'error',
          input: { url: 'https://example.com' },
          error: 'timeout',
          time: { start: 2, end: 22 },
        },
        'webfetch',
      ),
    ]);

    const toolUses = events.filter(
      (e) => e.type === 'tool_use',
    ) as Array<AgentEvent & ToolUseLike>;
    expect(toolUses.map((e) => e.payload.toolUseId)).toEqual([
      'call-x',
      'call-y',
    ]);
    expect(toolUses[1]!.payload.toolName).toBe('webfetch');

    const toolResults = events.filter(
      (e) => e.type === 'tool_result',
    ) as Array<AgentEvent & ToolResultLike>;
    expect(
      toolResults.map((e) => [e.payload.toolUseId, e.payload.status]),
    ).toEqual([
      ['call-x', 'success'],
      ['call-y', 'error'],
    ]);

    const done = events.find((e) => e.type === 'done') as AgentEvent & DoneLike;
    expect(done.payload.usage.toolUses).toBe(2);
  });

  it('emits a single denied terminal result across denial and tool-state error', async () => {
    const events = await runLifecycle([
      toolPartEvent(
        'call-e',
        'part-e',
        { status: 'pending', input: {}, raw: '' },
        'write',
      ),
      toolPartEvent(
        'call-e',
        'part-e',
        {
          status: 'running',
          input: { filePath: '/tmp/x', content: 'data' },
          time: { start: 1 },
        },
        'write',
      ),
      {
        type: 'permission.asked',
        properties: {
          id: 'perm-1',
          sessionID: 'session-1',
          permission: 'edit',
          patterns: ['/tmp/*'],
          metadata: {},
          always: [],
          tool: { messageID: 'message-1', callID: 'call-e' },
        },
      },
      {
        type: 'permission.replied',
        properties: {
          sessionID: 'session-1',
          requestID: 'perm-1',
          reply: 'reject',
        },
      },
      toolPartEvent(
        'call-e',
        'part-e',
        {
          status: 'error',
          input: { filePath: '/tmp/x', content: 'data' },
          error: 'rejected',
          time: { start: 1, end: 2 },
        },
        'write',
      ),
    ]);

    expect(events.map((e) => e.type)).toEqual([
      'init',
      'tool_use',
      'permission_request',
      'tool_result',
      'done',
    ]);

    const toolUse = events[1] as AgentEvent & ToolUseLike;
    expect(toolUse.payload.toolUseId).toBe('call-e');
    expect(toolUse.payload.toolName).toBe('write');

    const permission = events[2] as AgentEvent & {
      payload: { toolName: string };
    };
    expect(permission.payload.toolName).toBe('edit');

    // The denial resolves to the tracked call: it carries the tool's
    // name, not the permission name the ask carried.
    const toolResult = events[3] as AgentEvent & ToolResultLike;
    expect(toolResult.payload.toolUseId).toBe('call-e');
    expect(toolResult.payload.toolName).toBe('write');
    expect(toolResult.payload.status).toBe('denied');

    const done = events[4] as AgentEvent & DoneLike;
    expect(done.payload.usage.toolUses).toBe(1);
  });

  it('emits no denied result for a call whose terminal result already arrived', async () => {
    const events = await runLifecycle([
      toolPartEvent('call-g', 'part-g', {
        status: 'completed',
        input: { command: 'pwd' },
        output: '/repo',
        title: 'pwd',
        metadata: {},
        time: { start: 5, end: 9 },
      }),
      {
        type: 'permission.asked',
        properties: {
          id: 'perm-3',
          sessionID: 'session-1',
          permission: 'bash',
          patterns: [],
          metadata: {},
          always: [],
          tool: { messageID: 'message-1', callID: 'call-g' },
        },
      },
      {
        type: 'permission.replied',
        properties: {
          sessionID: 'session-1',
          requestID: 'perm-3',
          reply: 'reject',
        },
      },
    ]);

    expect(events.map((e) => e.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'permission_request',
      'done',
    ]);

    const toolResult = events[2] as AgentEvent & ToolResultLike;
    expect(toolResult.payload.toolUseId).toBe('call-g');
    expect(toolResult.payload.status).toBe('success');

    const done = events[4] as AgentEvent & DoneLike;
    expect(done.payload.usage.toolUses).toBe(1);
  });

  it('suppresses a late tool_use behind a denial delivered while pending', async () => {
    const events = await runLifecycle([
      toolPartEvent('call-f', 'part-f', {
        status: 'pending',
        input: {},
        raw: '',
      }),
      {
        type: 'permission.asked',
        properties: {
          id: 'perm-2',
          sessionID: 'session-1',
          permission: 'bash',
          patterns: [],
          metadata: {},
          always: [],
          tool: { messageID: 'message-1', callID: 'call-f' },
        },
      },
      {
        type: 'permission.replied',
        properties: {
          sessionID: 'session-1',
          requestID: 'perm-2',
          reply: 'reject',
        },
      },
      toolPartEvent('call-f', 'part-f', {
        status: 'error',
        input: {},
        error: 'rejected',
        time: { start: 1, end: 2 },
      }),
    ]);

    expect(events.map((e) => e.type)).toEqual([
      'init',
      'permission_request',
      'tool_result',
      'done',
    ]);

    const toolResult = events[2] as AgentEvent & ToolResultLike;
    expect(toolResult.payload.toolUseId).toBe('call-f');
    expect(toolResult.payload.status).toBe('denied');

    const done = events[3] as AgentEvent & DoneLike;
    expect(done.payload.usage.toolUses).toBe(0);
  });

  it('deduplicates repeated legacy stateless tool parts by identifier', async () => {
    const legacyPart = {
      type: 'message.part.updated',
      sessionId: 'session-1',
      part: {
        type: 'tool_call',
        id: 'legacy-1',
        name: 'bash',
        input: { command: 'ls' },
      },
    };
    const events = await runLifecycle([legacyPart, legacyPart]);

    const toolUses = events.filter(
      (e) => e.type === 'tool_use',
    ) as Array<AgentEvent & ToolUseLike>;
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]!.payload.toolUseId).toBe('legacy-1');
    expect(toolUses[0]!.payload.input).toEqual({ command: 'ls' });

    const done = events.find((e) => e.type === 'done') as AgentEvent & DoneLike;
    expect(done.payload.usage.toolUses).toBe(1);
  });
});
