// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { performance } from 'node:perf_hooks';
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
import { Cligent } from '../cligent.js';
import { createPermissionPolicyReset } from '../internal/permission-reset.js';
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
  abortSession?(options: { sessionId: string; cwd?: string }): Promise<void>;
  replyPermission(options: {
    sessionId: string;
    requestId: string;
    permission: string;
    decision: 'once' | 'reject';
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
      this.emit('close', null, typeof signal === 'string' ? signal : null);
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

function makeSpawn(
  processBehavior: {
    ignoreSigterm?: boolean;
    onKill?: (signal?: NodeJS.Signals | number) => void;
  } = {},
): {
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
  eventStreamFactory?: (
    options?: Record<string, unknown>,
  ) => AsyncIterable<unknown>;
  onCreateClient?: (options: { baseUrl?: string }) => void;
  onRun?: (options: Record<string, unknown>) => void;
  onEvents?: (options?: Record<string, unknown>) => void;
  statusResult?: unknown;
  statusError?: unknown;
  onGetSessionStatus?: (options: { sessionId: string; cwd?: string }) => void;
  onAbortSession?: (options: {
    sessionId: string;
    cwd?: string;
  }) => Promise<void> | void;
  onReplyPermission?: (options: {
    sessionId: string;
    requestId: string;
    permission: string;
    decision: 'once' | 'reject';
    cwd?: string;
    signal?: AbortSignal;
  }) => void;
  replyPermissionFactory?: (options: {
    sessionId: string;
    requestId: string;
    permission: string;
    decision: 'once' | 'reject';
    cwd?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  replyPermissionError?: unknown;
  onClose?: () => Promise<void> | void;
  onShutdown?: () => Promise<void> | void;
}): () => Promise<{
  createClient(options?: { baseUrl?: string }): MockOpenCodeClient;
}> {
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
            async *[Symbol.asyncIterator](): AsyncGenerator<
              unknown,
              void,
              void
            > {
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
  parentID = 'parent-message',
): EventMessageUpdated {
  const info: EventMessageUpdated['properties']['info'] =
    role === 'assistant'
      ? {
          id: messageID,
          sessionID,
          role,
          time: { created: 1 },
          parentID,
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
              part: {
                type: 'file_part',
                path: '/repo/a.ts',
                action: 'modified',
              },
            },
            {
              type: 'message.part.updated',
              sessionId: 'session-1',
              part: {
                type: 'image_part',
                mimeType: 'image/png',
                uri: 'file:///tmp/a.png',
              },
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

    const events = await collect(
      adapter.run('prompt', { model: 'override-model' }),
    );

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
      payload: {
        toolName: string;
        toolUseId: string;
        input: Record<string, unknown>;
      };
    };
    expect(toolUse.payload.toolName).toBe('bash');
    expect(toolUse.payload.toolUseId).toBe('tool-1');
    expect(toolUse.payload.input).toEqual({ command: 'ls' });

    const thinking = events[4] as AgentEvent & { payload: { summary: string } };
    expect(thinking.payload.summary).toBe('Plan next step');

    const filePart = events[5] as AgentEvent & {
      payload: Record<string, unknown>;
    };
    expect(filePart.type).toBe('opencode:file_part');
    expect(filePart.payload.path).toBe('/repo/a.ts');

    const imagePart = events[6] as AgentEvent & {
      payload: Record<string, unknown>;
    };
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
      payload: {
        toolName: string;
        toolUseId: string;
        status: string;
        output: unknown;
      };
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
        usage: { toolUses: number };
        durationMs: number;
      };
    };
    expect(done.payload.status).toBe('max_turns');
    // Generic idle aliases are not an authenticated OpenCode accounting
    // source. The independently observed root tool call remains reportable.
    expect(done.payload.usage).toEqual({ toolUses: 1 });
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

          const mapped = mapPermissionsToOpenCodeOptions(policy);

          expect(mapped.permission).toEqual({
            edit: fileWrite,
            bash: shellExecute,
            webfetch: networkAccess,
          });
        }
      }
    }
  });

  it('distinguishes an absent permission policy from an explicit empty policy', () => {
    expect(mapPermissionsToOpenCodeOptions(undefined)).toEqual({});
    expect(mapPermissionsToOpenCodeOptions({}).permission).toEqual({
      edit: 'ask',
      bash: 'ask',
      webfetch: 'ask',
    });
  });

  it('rejects every explicit tool-list form before loading the SDK', async () => {
    const rejection =
      /does not support explicit allowedTools or disallowedTools.*override native or explicit denies.*independent exact per-call tool registry/;
    const cases: AgentOptions<OpenCodeEffort>[] = [
      { allowedTools: [] },
      { allowedTools: ['bash'] },
      { disallowedTools: [] },
      { disallowedTools: ['write'] },
      { allowedTools: ['bash'], disallowedTools: ['bash'] },
      { permissions: { shellExecute: 'deny' }, allowedTools: ['bash'] },
      { permissions: { shellExecute: 'ask' }, allowedTools: ['bash'] },
      { resume: 'existing-session', allowedTools: ['bash'] },
    ];

    for (const options of cases) {
      expect(() =>
        mapPermissionsToOpenCodeOptions(options.permissions, options),
      ).toThrow(rejection);

      let loadCalls = 0;
      const adapter = new OpenCodeAdapter(
        { mode: 'external', serverUrl: 'http://opencode.local:7777' },
        {
          loadSdk: async () => {
            loadCalls++;
            throw new Error('SDK loader must not run');
          },
        },
      );

      await expect(
        collect(adapter.run('tool restriction', options)),
      ).rejects.toThrow(rejection);
      expect(loadCalls).toBe(0);
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
    expect(invocations[0]?.args).toEqual([
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4788',
    ]);
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
      expect(mapEffortToOpenCodeVariant(model, effort)).toBe(variant);
    },
  );

  it('leaves OpenCode variant unset for omitted effort and unrecognised providers', () => {
    expect(
      mapEffortToOpenCodeVariant('openai/gpt-5', undefined),
    ).toBeUndefined();
    expect(mapEffortToOpenCodeVariant(undefined, 'high')).toBeUndefined();
    expect(mapEffortToOpenCodeVariant('gpt-5', 'high')).toBeUndefined();
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
            {
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
            } satisfies EventSessionError,
            {
              id: 'event-effort-idle',
              type: 'session.idle',
              properties: { sessionID: 'effort-error-session' },
            } satisfies EventSessionIdle,
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
    const permission = events.find(
      (event) => event.type === 'permission_request',
    ) as
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
      decision: 'once' | 'reject';
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

    expect(replies.map(({ signal: _signal, ...reply }) => reply)).toEqual([
      {
        sessionId: 'permission-v1-session',
        requestId: 'permission-v1-request',
        permission: 'external_directory',
        decision: 'reject',
      },
      {
        sessionId: 'permission-v2-session',
        requestId: 'permission-v2-request',
        permission: 'future_permission',
        decision: 'reject',
      },
    ]);
    expect(replies[0]?.signal).toBeDefined();
    expect(replies[0]?.signal?.aborted).toBe(true);
    expect(replies[1]?.signal).toBeDefined();
    expect(replies[1]?.signal?.aborted).toBe(true);
    expect(replies[0]?.signal).not.toBe(replies[1]?.signal);
  });

  it('audits successful v1 and v2 auto approvals without an interactive request', async () => {
    const replies: Array<{
      requestId: string;
      decision: 'once' | 'reject';
    }> = [];
    const fixtures = [
      {
        sessionId: 'auto-v1-session',
        requestId: 'auto-v1-request',
        event: {
          type: 'permission.updated',
          properties: {
            id: 'auto-v1-request',
            sessionID: 'auto-v1-session',
            type: 'external_directory',
            pattern: '/tmp/*',
            callID: 'auto-v1-call',
            metadata: { path: '/tmp/audit-v1' },
            reason: 'outside workspace',
          },
        },
        expectedPayload: {
          requestId: 'auto-v1-request',
          nativeSessionId: 'auto-v1-session',
          permission: 'external_directory',
          patterns: ['/tmp/*'],
          toolUseId: 'auto-v1-call',
          decision: 'once',
          automated: true,
          input: { path: '/tmp/audit-v1' },
          reason: 'outside workspace',
        },
      },
      {
        sessionId: 'auto-v2-session',
        requestId: 'auto-v2-request',
        event: {
          type: 'permission.asked',
          properties: {
            id: 'auto-v2-request',
            sessionID: 'auto-v2-session',
            permission: 'future_permission',
            patterns: ['scope:a', 'scope:b'],
            metadata: { future: true },
            always: [],
            tool: { callID: 'auto-v2-call' },
          },
        },
        expectedPayload: {
          requestId: 'auto-v2-request',
          nativeSessionId: 'auto-v2-session',
          permission: 'future_permission',
          patterns: ['scope:a', 'scope:b'],
          toolUseId: 'auto-v2-call',
          decision: 'once',
          automated: true,
          input: { future: true },
        },
      },
    ];

    for (const fixture of fixtures) {
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
              replies.push({
                requestId: options.requestId,
                decision: options.decision,
              });
            },
          }),
        },
      );

      const events = await collect(
        adapter.run('native auto probe', { permissions: { mode: 'auto' } }),
      );
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'opencode:permission_decision',
        'done',
      ]);
      expect(events[1]!.payload).toEqual(fixture.expectedPayload);
    }

    expect(replies).toEqual([
      { requestId: 'auto-v1-request', decision: 'once' },
      { requestId: 'auto-v2-request', decision: 'once' },
    ]);
  });

  it('releases permission correlation after every replied decision', async () => {
    const replies: string[] = [];
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'correlation-cleanup-session' },
          events: [
            {
              type: 'permission.asked',
              properties: {
                id: 'reused-request',
                sessionID: 'correlation-cleanup-session',
                permission: 'edit',
                tool: { callID: 'stale-call' },
              },
            },
            {
              type: 'permission.replied',
              properties: {
                sessionID: 'correlation-cleanup-session',
                requestID: 'reused-request',
                reply: 'once',
              },
            },
            {
              type: 'permission.asked',
              properties: {
                id: 'reused-request',
                sessionID: 'correlation-cleanup-session',
                permission: 'edit',
                tool: { callID: 'duplicate-call' },
              },
            },
            {
              type: 'permission.replied',
              properties: {
                sessionID: 'correlation-cleanup-session',
                requestID: 'reused-request',
                reply: 'reject',
                toolUseId: 'current-call',
                toolName: 'write',
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'correlation-cleanup-session' },
            },
          ],
          onReplyPermission(options) {
            replies.push(options.requestId);
          },
        }),
      },
    );

    const events = await collect(
      adapter.run('correlation cleanup probe', {
        permissions: { mode: 'auto' },
      }),
    );
    const denied = events.find((event) => event.type === 'tool_result') as
      | (AgentEvent & { payload: { toolUseId: string; status: string } })
      | undefined;
    expect(denied?.payload).toMatchObject({
      toolUseId: 'current-call',
      status: 'denied',
    });
    expect(replies).toEqual(['reused-request']);
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

    const events = await collect(
      adapter.run('concurrency probe', { permissions: { mode: 'auto' } }),
    );
    const auditRequestIds = events
      .filter((event) => event.type === 'opencode:permission_decision')
      .map((event) => (event.payload as { requestId: string }).requestId);
    expect(auditRequestIds).toEqual(['request-local-a', 'request-local-b']);
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

  it('answers descendant permission controls without emitting child output', async () => {
    const replies: Array<{ sessionId: string; requestId: string }> = [];
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'root-session' },
          events: [
            {
              type: 'session.created',
              properties: {
                sessionID: 'child-session',
                info: {
                  id: 'child-session',
                  parentID: 'root-session',
                },
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'child-session',
                part: { type: 'text', text: 'hidden child output' },
              },
            },
            {
              type: 'permission.asked',
              properties: {
                id: 'child-request',
                sessionID: 'child-session',
                permission: 'doom_loop',
                patterns: ['*'],
                metadata: {},
                always: [],
              },
            },
            {
              type: 'session.created',
              properties: {
                sessionID: 'grandchild-session',
                info: {
                  id: 'grandchild-session',
                  parentID: 'child-session',
                },
              },
            },
            {
              type: 'permission.updated',
              properties: {
                id: 'grandchild-request',
                sessionID: 'grandchild-session',
                type: 'external_directory',
                pattern: '/tmp/*',
                metadata: { path: '/tmp/probe' },
              },
            },
            {
              type: 'permission.asked',
              properties: {
                id: 'foreign-request',
                sessionID: 'foreign-session',
                permission: 'doom_loop',
                patterns: ['*'],
                metadata: {},
                always: [],
              },
            },
            {
              type: 'permission.asked',
              properties: {
                id: 'child-request',
                sessionID: 'child-session',
                permission: 'doom_loop',
                patterns: ['*'],
                metadata: {},
                always: [],
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'root-session' },
            },
          ],
          onReplyPermission(options) {
            replies.push({
              sessionId: options.sessionId,
              requestId: options.requestId,
            });
          },
        }),
      },
    );

    const events = await collect(
      adapter.run('descendant permission probe', {
        permissions: { mode: 'auto' },
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'opencode:permission_decision',
      'opencode:permission_decision',
      'done',
    ]);
    expect(
      events
        .filter((event) => event.type === 'opencode:permission_decision')
        .map(
          (event) =>
            (event.payload as { nativeSessionId: string }).nativeSessionId,
        ),
    ).toEqual(['child-session', 'grandchild-session']);
    expect(replies).toEqual([
      { sessionId: 'child-session', requestId: 'child-request' },
      { sessionId: 'grandchild-session', requestId: 'grandchild-request' },
    ]);
  });

  it('uses the resumed lineage snapshot for a reused child permission ask', async () => {
    const replies: string[] = [];
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: {
            sessionId: 'resumed-root',
            ownedSessionIds: ['resumed-root', 'reused-child'],
          },
          events: [
            {
              type: 'permission.asked',
              properties: {
                id: 'reused-request',
                sessionID: 'reused-child',
                permission: 'read',
                patterns: ['*.env'],
                metadata: {},
                always: [],
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'resumed-root' },
            },
          ],
          onReplyPermission(options) {
            replies.push(options.sessionId);
          },
        }),
      },
    );

    const events = await collect(
      adapter.run('resume child task', {
        resume: 'resumed-root',
        permissions: { mode: 'auto' },
      }),
    );
    expect(replies).toEqual(['reused-child']);
    expect(events[1]).toMatchObject({
      type: 'opencode:permission_decision',
      payload: { nativeSessionId: 'reused-child' },
    });
  });

  it('correlates an untagged child permission reply without emitting child output', async () => {
    const replies: string[] = [];
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'root-session' },
          events: [
            {
              type: 'session.created',
              properties: {
                sessionID: 'child-session',
                info: { id: 'child-session', parentID: 'root-session' },
              },
            },
            {
              type: 'permission.asked',
              properties: {
                id: 'child-request',
                sessionID: 'child-session',
                permission: 'doom_loop',
                patterns: ['*'],
                metadata: {},
                always: [],
              },
            },
            {
              type: 'permission.replied',
              properties: {
                requestID: 'child-request',
                decision: 'rejected',
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'root-session' },
            },
          ],
          onReplyPermission(options) {
            replies.push(options.sessionId);
          },
        }),
      },
    );

    const events = await collect(adapter.run('child reply correlation'));
    expect(replies).toEqual(['child-session']);
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'permission_request',
      'done',
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

    const events = await collect(
      adapter.run('failure probe', { permissions: { mode: 'auto' } }),
    );
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);
    const error = events[1] as AgentEvent & {
      payload: { code?: string; message: string };
    };
    expect(error.payload.code).toBe('OPENCODE_PERMISSION_REPLY_FAILED');
    expect(error.payload.message).toContain('reply-failure-session');
    expect(error.payload.message).toContain('reply-failure-request');
    expect(error.payload.message).toContain('unknown_future_permission');
    expect(events[2]!.payload).toMatchObject({
      status: 'error',
      resumeToken: 'reply-failure-session',
    });
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
                  replySignal?.addEventListener('abort', cancel, {
                    once: true,
                  });
                }
              }),
          }),
        },
      );

      const stream = adapter.run('timeout probe', {
        permissions: { mode: 'auto' },
      });
      expect((await stream.next()).value?.type).toBe('init');

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
      expect(done?.payload).toMatchObject({
        status: 'error',
        resumeToken: 'reply-timeout-session',
      });
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
    expect(events[3]?.payload).toMatchObject({
      status: 'error',
      resumeToken: 'invalid-request-session',
    });
  });

  it('aborts a pending permission reply and cleans up the managed server', async () => {
    const controller = new AbortController();
    const { spawnProcess, invocations } = makeSpawn();
    let closeCalls = 0;
    let shutdownCalls = 0;
    let eventSignal: AbortSignal | undefined;
    let replySignal: AbortSignal | undefined;
    let replyCancelled = false;
    let resolveReplyStarted: () => void = () => {};
    const replyStarted = new Promise<void>((resolve) => {
      resolveReplyStarted = resolve;
    });
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
              resolveReplyStarted();
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
      permissions: { mode: 'auto' },
    });
    expect((await stream.next()).value?.type).toBe('init');

    const terminal = stream.next();
    await replyStarted;
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

  it('escalates managed teardown to SIGKILL after a bounded SIGTERM grace', async () => {
    vi.useFakeTimers();
    try {
      const { spawnProcess, invocations } = makeSpawn({ ignoreSigterm: true });
      const adapter = new OpenCodeAdapter(
        { mode: 'managed', serverUrl: 'http://127.0.0.1:4996' },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'term-resistant-session' },
            events: [
              {
                type: 'session.idle',
                properties: { sessionID: 'term-resistant-session' },
              },
            ],
          }),
          spawnProcess,
          probeCliAvailability: async () => true,
          waitForServerReady: async () => 'http://127.0.0.1:4996',
        },
      );

      const stream = adapter.run('term resistant probe');
      expect((await stream.next()).value?.type).toBe('init');
      expect((await stream.next()).value?.type).toBe('done');
      const teardown = stream.next();

      await vi.advanceTimersByTimeAsync(0);
      await vi.runAllTimersAsync();
      expect(invocations[0]?.process.killSignals).toEqual([
        'SIGTERM',
        'SIGKILL',
      ]);
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
          createClient: () => wrapOpencodeClient(real, { apiVersion: 'v2' }),
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
            createClient: () => wrapOpencodeClient(real, { apiVersion }),
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

  it('does not accumulate reactions on run-lifetime controls per SSE event', async () => {
    const originalThen = Promise.prototype.then;
    const reactionCounts = new WeakMap<Promise<unknown>, number>();
    let maxReactions = 0;
    Promise.prototype.then = function (
      this: Promise<unknown>,
      ...args: unknown[]
    ): Promise<unknown> {
      const count = (reactionCounts.get(this) ?? 0) + 1;
      reactionCounts.set(this, count);
      maxReactions = Math.max(maxReactions, count);
      return Reflect.apply(originalThen, this, args) as Promise<unknown>;
    } as typeof originalThen;

    try {
      const { spawnProcess } = makeSpawn();
      const events = Array.from({ length: 4_096 }, () => ({
        type: 'server.connected',
      }));
      events.push({
        type: 'session.idle',
        properties: { sessionID: 'reaction-session' },
      } as { type: string });
      const adapter = new OpenCodeAdapter(
        { mode: 'managed', serverUrl: 'http://127.0.0.1:4995' },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'reaction-session' },
            events,
          }),
          spawnProcess,
          probeCliAvailability: async () => true,
          waitForServerReady: async () => 'http://127.0.0.1:4995',
        },
      );

      const output = await collect(adapter.run('reaction retention probe'));
      expect(output.map((event) => event.type)).toEqual(['init', 'done']);
      // A run-lifetime promise raced once per event reaches 4,097 here. The
      // re-armed waiter keeps every observed promise at a constant reaction
      // count independent of stream length.
      expect(maxReactions).toBeLessThan(16);
    } finally {
      Promise.prototype.then = originalThen;
    }
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
          eventStreamFactory: async function* (): AsyncGenerator<
            unknown,
            void,
            void
          > {
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
    expect(done.payload).toMatchObject({
      status: 'error',
      resumeToken: 'crash-1',
    });
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
              async *[Symbol.asyncIterator](): AsyncGenerator<
                unknown,
                void,
                void
              > {
                await new Promise<void>((resolve) => {
                  if (capturedEventSignal?.aborted) {
                    resolve();
                    return;
                  }
                  capturedEventSignal?.addEventListener(
                    'abort',
                    () => resolve(),
                    {
                      once: true,
                    },
                  );
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
              async *[Symbol.asyncIterator](): AsyncGenerator<
                unknown,
                void,
                void
              > {
                const signal = streamOptions?.signal as AbortSignal | undefined;
                await new Promise<void>((resolve) => {
                  if (signal?.aborted) {
                    resolve();
                    return;
                  }
                  signal?.addEventListener('abort', () => resolve(), {
                    once: true,
                  });
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

      const done = events.find(
        (event) => event.type === 'done',
      ) as AgentEvent & {
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

  it('delivers interrupted continuity within the engine abort drain', async () => {
    const controller = new AbortController();
    const runOptions: Record<string, unknown>[] = [];
    let streamCount = 0;
    const adapter = new OpenCodeAdapter(
      {
        mode: 'external',
        serverUrl: 'http://opencode.local:7777',
        eventInactivityTimeoutMs: 1_000,
      },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'engine-abort-session' },
          onRun(options) {
            runOptions.push(options);
          },
          eventStreamFactory: () => {
            streamCount++;
            if (streamCount === 1) {
              return {
                async *[Symbol.asyncIterator]() {
                  await new Promise<void>(() => {});
                },
              };
            }
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  type: 'session.idle',
                  properties: { sessionID: 'engine-abort-session' },
                };
              },
            };
          },
          onAbortSession: () => new Promise<void>(() => {}),
        }),
      },
    );
    const agent = new Cligent(adapter);
    const firstRun = agent.run('first', { abortSignal: controller.signal });
    expect((await firstRun.next()).value).toMatchObject({ type: 'init' });

    const startedAt = Date.now();
    controller.abort();
    const interrupted = await firstRun.next();
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(interrupted.value).toMatchObject({
      type: 'done',
      payload: {
        status: 'interrupted',
        resumeToken: 'engine-abort-session',
      },
    });
    expect((await firstRun.next()).done).toBe(true);

    const secondRun = await collect(agent.run('second'));
    expect(secondRun.at(-1)).toMatchObject({
      type: 'done',
      payload: { status: 'success' },
    });
    expect(runOptions[1]).toMatchObject({
      sessionId: 'engine-abort-session',
    });
  });

  describe('event inactivity liveness (TADAPT-035)', () => {
    it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])(
      'rejects non-finite or non-positive inactivity deadline %s',
      (eventInactivityTimeoutMs) => {
        expect(() => new OpenCodeAdapter({ eventInactivityTimeoutMs })).toThrow(
          /eventInactivityTimeoutMs must be a finite number greater than 0/,
        );
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
                let resolveNext:
                  ((result: IteratorResult<unknown>) => void) | undefined;
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
    ])(
      'aborts a silent non-idle session in state $type',
      async (statusResult) => {
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
        expect(events[2]?.payload).toMatchObject({
          status: 'error',
          resumeToken: `silent-${statusResult.type}`,
        });
        expect(events.filter((event) => event.type === 'error')).toHaveLength(
          1,
        );
        expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      },
    );

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
      expect(events[2]?.payload).toMatchObject({
        status: 'error',
        resumeToken: 'silent-query-failure',
      });
    });

    it('reports an unavailable session-abort route as cleanup failure', async () => {
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 5,
        },
        {
          loadSdk: async () => ({
            createClient() {
              return {
                async run() {
                  return {
                    sessionId: 'missing-abort-route',
                    events: (async function* () {
                      await new Promise<void>(() => {});
                    })(),
                  };
                },
                async getSessionStatus() {
                  throw new Error('status endpoint unavailable');
                },
                async close() {},
                async shutdown() {},
              };
            },
          }),
        },
      );

      const events = await collect(adapter.run('prompt'));
      expect(events[1]?.payload).toMatchObject({
        code: 'OPENCODE_INACTIVITY_STATUS_QUERY_FAILED',
      });
      expect((events[1]?.payload as { message: string }).message).toContain(
        'sessionAbort=failed: OpenCode SDK client does not provide session.abort()',
      );
      expect(events[2]?.payload).toMatchObject({
        status: 'error',
        resumeToken: 'missing-abort-route',
      });
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

    it('counts owned descendant progress without emitting child output', async () => {
      vi.useFakeTimers();
      try {
        let statusCalls = 0;
        let abortCalls = 0;
        const replies: Array<{ sessionId: string; requestId: string }> = [];
        const delay = () =>
          new Promise<void>((resolve) => setTimeout(resolve, 20));
        const adapter = new OpenCodeAdapter(
          {
            mode: 'external',
            serverUrl: 'http://opencode.local:7777',
            eventInactivityTimeoutMs: 30,
          },
          {
            loadSdk: makeLoader({
              runResult: { sessionId: 'owned-root' },
              statusResult: { type: 'busy' },
              eventStreamFactory: async function* () {
                await delay();
                yield {
                  type: 'session.created',
                  properties: {
                    sessionID: 'owned-child',
                    info: { id: 'owned-child', parentID: 'owned-root' },
                  },
                };
                await delay();
                yield {
                  type: 'message.part.updated',
                  properties: {
                    sessionID: 'owned-child',
                    part: { type: 'text', text: 'hidden child progress' },
                  },
                };
                await delay();
                yield {
                  type: 'permission.asked',
                  properties: {
                    id: 'owned-child-request',
                    sessionID: 'owned-child',
                    permission: 'doom_loop',
                    patterns: ['*'],
                    metadata: {},
                    always: [],
                  },
                };
                await delay();
                yield {
                  type: 'session.idle',
                  properties: { sessionID: 'owned-root' },
                };
              },
              onGetSessionStatus() {
                statusCalls++;
              },
              onAbortSession() {
                abortCalls++;
              },
              onReplyPermission(options) {
                replies.push({
                  sessionId: options.sessionId,
                  requestId: options.requestId,
                });
              },
            }),
          },
        );

        const eventsPromise = collect(
          adapter.run('owned descendant activity', {
            permissions: { mode: 'auto' },
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(80);
        const events = await eventsPromise;

        expect(statusCalls).toBe(0);
        expect(abortCalls).toBe(0);
        expect(replies).toEqual([
          {
            sessionId: 'owned-child',
            requestId: 'owned-child-request',
          },
        ]);
        expect(events.map((event) => event.type)).toEqual([
          'init',
          'opencode:permission_decision',
          'done',
        ]);
        expect(events[1]).toMatchObject({
          payload: { nativeSessionId: 'owned-child' },
        });
        expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      } finally {
        vi.useRealTimers();
      }
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

    it('does not let untagged workspace traffic reset the deadline', async () => {
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
            runResult: { sessionId: 'untagged-current' },
            statusResult: { type: 'busy' },
            eventStreamFactory: (streamOptions) => ({
              async *[Symbol.asyncIterator]() {
                const signal = streamOptions?.signal as AbortSignal;
                while (!signal.aborted) {
                  await new Promise((resolve) => setTimeout(resolve, 8));
                  yield {
                    type: 'file.watcher.updated',
                    properties: { file: '/repo/other.ts', event: 'change' },
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
      expect(events[1]).toMatchObject({
        payload: {
          code: 'OPENCODE_INACTIVITY_TIMEOUT',
          message: expect.stringContaining(
            'lastRelevantEvent=prompt.dispatched',
          ),
        },
      });
    });

    it('does not count downstream backpressure as provider silence', async () => {
      let statusCalls = 0;
      let abortCalls = 0;
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 15,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'backpressure-session' },
            events: [
              makeV2MessageUpdated(
                'backpressure-session',
                'assistant-message',
                'assistant',
              ),
              makeV2PartUpdated({
                id: 'assistant-part',
                sessionID: 'backpressure-session',
                messageID: 'assistant-message',
                type: 'text',
                text: 'buffered answer',
                time: { start: 1, end: 2 },
              }),
              {
                id: 'backpressure-idle',
                type: 'session.idle',
                properties: { sessionID: 'backpressure-session' },
              } satisfies EventSessionIdle,
            ],
            onGetSessionStatus() {
              statusCalls++;
            },
            onAbortSession() {
              abortCalls++;
            },
          }),
        },
      );

      const stream = adapter.run('prompt');
      expect((await stream.next()).value).toMatchObject({ type: 'init' });
      expect((await stream.next()).value).toMatchObject({
        type: 'text',
        payload: { content: 'buffered answer' },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await stream.next()).value).toMatchObject({
        type: 'done',
        payload: { status: 'success' },
      });
      expect((await stream.next()).done).toBe(true);
      expect(statusCalls).toBe(0);
      expect(abortCalls).toBe(0);
    });

    it('expires without draining an always-ready foreign event backlog', async () => {
      let monotonicNow = 0;
      let nextCalls = 0;
      let iteratorReturns = 0;
      let statusCalls = 0;
      const now = vi
        .spyOn(performance, 'now')
        .mockImplementation(() => monotonicNow);

      try {
        const adapter = new OpenCodeAdapter(
          {
            mode: 'external',
            serverUrl: 'http://opencode.local:7777',
            eventInactivityTimeoutMs: 1,
          },
          {
            loadSdk: makeLoader({
              runResult: { sessionId: 'foreign-backlog-current' },
              statusResult: { type: 'idle' },
              eventStreamFactory: () => ({
                [Symbol.asyncIterator](): AsyncIterator<unknown> {
                  return {
                    next() {
                      nextCalls++;
                      if (nextCalls === 4) monotonicNow = 2;
                      if (nextCalls > 32) {
                        return Promise.reject(
                          new Error('foreign backlog drained past deadline'),
                        );
                      }
                      return Promise.resolve({
                        done: false,
                        value: {
                          type: 'session.status',
                          sessionId: 'foreign-backlog-other',
                          status: { type: 'busy' },
                        },
                      });
                    },
                    async return(value?: unknown) {
                      iteratorReturns++;
                      return { done: true, value };
                    },
                  };
                },
              }),
              onGetSessionStatus() {
                statusCalls++;
              },
            }),
          },
        );

        const events = await collect(adapter.run('prompt'));
        expect(statusCalls).toBe(1);
        expect(nextCalls).toBe(4);
        expect(iteratorReturns).toBe(1);
        expect(events.map((event) => event.type)).toEqual([
          'init',
          'error',
          'done',
        ]);
        expect(events[1]?.payload).toMatchObject({
          code: 'OPENCODE_INACTIVITY_IDLE_RECOVERED',
          recoverable: true,
        });
        expect(events[2]?.payload).toMatchObject({ status: 'success' });
      } finally {
        now.mockRestore();
      }
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
            )?.signal;
            createSignal = sdkSignal;
            if (sdkSignal) {
              const originalRemove =
                sdkSignal.removeEventListener.bind(sdkSignal);
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
            promptSignal = (
              requestOptions as { signal?: AbortSignal } | undefined
            )?.signal;
            resolvePromptStarted();
            return new Promise<never>(() => {});
          },
          abort(args: unknown) {
            abortCalls.push(args);
            return new Promise<never>(() => {});
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
                      new Promise<IteratorResult<unknown>>(
                        (_resolve, reject) => {
                          if (signal?.aborted) {
                            reject(new Error('event stream aborted'));
                            return;
                          }
                          signal?.addEventListener(
                            'abort',
                            () => reject(new Error('event stream aborted')),
                            { once: true },
                          );
                        },
                      ),
                    return() {
                      rawIteratorReturns++;
                      return new Promise<IteratorResult<unknown>>(() => {});
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

      let abortStartedAt = 0;
      let interruptedDoneElapsedMs: number | undefined;
      const eventsPromise = (async () => {
        const events: AgentEvent[] = [];
        for await (const event of adapter.run('prompt', {
          abortSignal: controller.signal,
          cwd: '/repo',
        })) {
          events.push(event);
          if (event.type === 'done' && abortStartedAt > 0) {
            interruptedDoneElapsedMs = Date.now() - abortStartedAt;
          }
        }
        return events;
      })();
      await promptStarted;
      abortStartedAt = Date.now();
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
      expect(interruptedDoneElapsedMs).toBeLessThan(500);
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

    it('gives caller abort precedence over a co-ready stream rejection', async () => {
      const controller = new AbortController();
      const order: string[] = [];
      let markSessionAbortStarted!: () => void;
      const sessionAbortStarted = new Promise<void>((resolve) => {
        markSessionAbortStarted = resolve;
      });
      const adapter = new OpenCodeAdapter(
        {
          mode: 'external',
          serverUrl: 'http://opencode.local:7777',
          eventInactivityTimeoutMs: 1_000,
        },
        {
          loadSdk: makeLoader({
            runResult: { sessionId: 'abort-rejection-race' },
            eventStreamFactory: () => ({
              [Symbol.asyncIterator](): AsyncIterator<unknown> {
                return {
                  next() {
                    return new Promise<IteratorResult<unknown>>((_, reject) => {
                      queueMicrotask(() => {
                        reject(new Error('co-ready stream rejection'));
                        queueMicrotask(() => controller.abort());
                      });
                    });
                  },
                };
              },
            }),
            async onAbortSession() {
              order.push('session-abort-started');
              markSessionAbortStarted();
              await new Promise<void>(() => {});
            },
          }),
        },
      );

      const stream = adapter.run('prompt', { abortSignal: controller.signal });
      const init = await stream.next();
      expect(init.value?.type).toBe('init');

      const terminalPromise = stream.next();
      await sessionAbortStarted;
      expect(order).toEqual(['session-abort-started']);

      const terminal = await terminalPromise;
      order.push('interrupted-done');
      expect(terminal.value).toMatchObject({
        type: 'done',
        payload: {
          status: 'interrupted',
          resumeToken: 'abort-rejection-race',
        },
      });
      expect(order).toEqual(['session-abort-started', 'interrupted-done']);

      vi.useFakeTimers();
      try {
        let cleanupSettled = false;
        const completionPromise = stream.next().then((result) => {
          cleanupSettled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(249);
        expect(cleanupSettled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(cleanupSettled).toBe(true);
        expect((await completionPromise).done).toBe(true);
        expect(order).toEqual(['session-abort-started', 'interrupted-done']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('flushes queued assistant output when abort follows a stream rejection', async () => {
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
            runResult: { sessionId: 'role-session' },
            eventStreamFactory: async function* () {
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
              await new Promise<void>((_, reject) => {
                queueMicrotask(() => {
                  reject(new Error('co-ready stream rejection'));
                  queueMicrotask(() => controller.abort());
                });
              });
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
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'text',
        'done',
      ]);
      expect(events[1]?.payload).toEqual({ content: 'keep me' });
      expect(events[2]?.payload).toMatchObject({
        status: 'interrupted',
        resumeToken: 'role-session',
      });
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
    const payload = events[1].payload as {
      status: string;
      resumeToken?: string;
    };
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

  it('preserves native rules when selecting OpenCode auto mode per ENG-021', () => {
    const auto = mapPermissionsToOpenCodeOptions({ mode: 'auto' });
    expect(auto.permission).toBeUndefined();
  });

  it('rejects PermissionPolicy.mode = "bypass" with an SDK/server architecture error per IR-014', () => {
    expect(() => mapPermissionsToOpenCodeOptions({ mode: 'bypass' })).toThrow(
      /opencode adapter does not support PermissionPolicy.mode: 'bypass'/,
    );
    expect(() => mapPermissionsToOpenCodeOptions({ mode: 'bypass' })).toThrow(
      /SDK\/server session/,
    );
  });

  it('keeps explicit capabilities independent from OpenCode auto mode', () => {
    const config = mapPermissionsToOpenCodeOptions({
      mode: 'auto',
      fileWrite: 'deny',
      networkAccess: 'allow',
    });
    expect(config.permission).toEqual({
      edit: 'deny',
      webfetch: 'allow',
    });
  });

  it('accepts writablePaths and reports ambient enforcement', () => {
    const mapped = mapPermissionsToOpenCodeOptions({
      mode: 'auto',
      writablePaths: ['./.git/', 'generated/./cache//'],
    });

    expect(mapped.permission).toBeUndefined();
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
    subscribeResult?: {
      stream?: AsyncIterable<unknown>;
      events?: AsyncIterable<unknown>;
    };
    onCreateSession?: (args: unknown) => void;
    onPrompt?: (args: unknown) => void;
    onSubscribe?: (args: unknown) => void;
    onDispose?: (args: unknown) => void;
    onChildren?: (args: unknown) => void;
    childrenResult?: unknown;
    onGetSession?: (args: unknown) => void;
    getResult?: unknown;
    onUpdateSession?: (args: unknown) => void;
    updateResult?: unknown;
    onHealth?: (args: unknown) => void;
    healthResult?: unknown;
  }): Record<string, unknown> {
    return {
      global: {
        async health(args: unknown): Promise<unknown> {
          config.onHealth?.(args);
          return (
            config.healthResult ?? {
              data: { healthy: true, version: '1.18.13' },
            }
          );
        },
      },
      session: {
        async create(args?: unknown): Promise<Record<string, unknown>> {
          config.onCreateSession?.(args);
          return (
            config.createResult ?? { id: 'v1-session-1', title: 'Cligent run' }
          );
        },
        async get(args: unknown): Promise<unknown> {
          config.onGetSession?.(args);
          return (
            config.getResult ?? {
              id: 'v1-existing',
              title: 'Existing session',
            }
          );
        },
        async update(args: unknown): Promise<unknown> {
          config.onUpdateSession?.(args);
          return (
            config.updateResult ?? {
              id: 'v1-existing',
              title: 'Cligent run',
            }
          );
        },
        async prompt(args: unknown): Promise<unknown> {
          config.onPrompt?.(args);
          return config.promptResult ?? {};
        },
        async children(args: unknown): Promise<unknown> {
          config.onChildren?.(args);
          return config.childrenResult ?? { data: [] };
        },
      },
      event: {
        async subscribe(args: unknown): Promise<unknown> {
          config.onSubscribe?.(args);
          return (
            config.subscribeResult ?? { stream: (async function* () {})() }
          );
        },
      },
      instance: {
        async dispose(args?: unknown): Promise<void> {
          config.onDispose?.(args);
        },
      },
    };
  }

  function makeV1Loader(
    config: Parameters<typeof makeV1Sdk>[0],
  ): () => Promise<{
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
      body: {
        messageID: string;
        parts: Array<{ type: string; text: string }>;
      };
    };
    expect(promptArgs.path.id).toBe('new-session-42');
    // The run never dictates a message id: OpenCode mints ids in its own
    // format and a foreign one leaves the session busy forever.
    expect(promptArgs.body.messageID).toBeUndefined();
    expect(promptArgs.body.parts).toEqual([{ type: 'text', text: 'hello v1' }]);
  });

  it('suppresses hidden title inference on fresh and default-title roots', async () => {
    const v1GetCalls: unknown[] = [];
    const v1UpdateCalls: unknown[] = [];
    const v1 = wrapOpencodeClient(
      makeV1Sdk({
        getResult: {
          id: 'v1-resume',
          title: 'New session - 2026-08-13T12:00:00.000Z',
        },
        updateResult: { id: 'v1-resume', title: 'Cligent run' },
        onGetSession: (args) => v1GetCalls.push(args),
        onUpdateSession: (args) => v1UpdateCalls.push(args),
      }),
    );

    const fresh = (await v1.run?.({ prompt: 'fresh title' })) as Record<
      string,
      unknown
    >;
    const resumed = (await v1.run?.({
      prompt: 'resumed title',
      sessionId: 'v1-resume',
      cwd: '/workspace',
    })) as Record<string, unknown>;
    expect(fresh.usageCoverageIncomplete).toBeUndefined();
    expect(resumed.usageCoverageIncomplete).toBeUndefined();
    expect(v1GetCalls).toEqual([
      {
        path: { id: 'v1-resume' },
        query: { directory: '/workspace' },
      },
    ]);
    expect(v1UpdateCalls).toEqual([
      {
        path: { id: 'v1-resume' },
        query: { directory: '/workspace' },
        body: { title: 'Cligent run' },
      },
    ]);

    const v2GetCalls: unknown[] = [];
    const v2UpdateCalls: unknown[] = [];
    const v2 = wrapOpencodeClient(
      {
        global: {
          async health() {
            return { data: { healthy: true, version: '1.18.13' } };
          },
        },
        session: {
          async create() {
            return { data: { id: 'v2-fresh', title: 'Cligent run' } };
          },
          async get(args: unknown) {
            v2GetCalls.push(args);
            return {
              data: {
                id: 'v2-resume',
                title: 'New session - 2026-08-13T12:00:00.000Z',
              },
            };
          },
          async update(args: unknown) {
            v2UpdateCalls.push(args);
            return { data: { id: 'v2-resume', title: 'Cligent run' } };
          },
          async promptAsync() {
            return {};
          },
          async children() {
            return { data: [] };
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
    const v2Resumed = (await v2.run?.({
      prompt: 'v2 resumed title',
      sessionId: 'v2-resume',
      cwd: '/workspace',
    })) as Record<string, unknown>;
    expect(v2Resumed.usageCoverageIncomplete).toBeUndefined();
    expect(v2GetCalls).toEqual([
      { sessionID: 'v2-resume', directory: '/workspace' },
    ]);
    expect(v2UpdateCalls).toEqual([
      {
        sessionID: 'v2-resume',
        directory: '/workspace',
        title: 'Cligent run',
      },
    ]);
  });

  it('keeps meaningful resumed titles without requiring an update route', async () => {
    const client = wrapOpencodeClient(
      {
        global: {
          async health() {
            return { data: { healthy: true, version: '1.18.13' } };
          },
        },
        session: {
          async create() {
            return { data: { id: 'unused', title: 'Cligent run' } };
          },
          async get() {
            return { data: { id: 'named-session', title: 'User title' } };
          },
          async promptAsync() {
            return {};
          },
          async children() {
            return { data: [] };
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

    const result = (await client.run?.({
      prompt: 'preserve title',
      sessionId: 'named-session',
    })) as Record<string, unknown>;
    expect(result.usageCoverageIncomplete).toBeUndefined();
  });

  it('accepts an empty resumed title as non-default', async () => {
    const client = wrapOpencodeClient(
      {
        global: {
          async health() {
            return { data: { healthy: true, version: '1.18.13' } };
          },
        },
        session: {
          async create() {
            return { data: { id: 'unused', title: 'Cligent run' } };
          },
          async get() {
            return { data: { id: 'empty-title-session', title: '' } };
          },
          async promptAsync() {
            return {};
          },
          async children() {
            return { data: [] };
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

    const result = (await client.run?.({
      prompt: 'preserve empty title',
      sessionId: 'empty-title-session',
    })) as Record<string, unknown>;
    expect(result.usageCoverageIncomplete).toBeUndefined();
  });

  it('requires pinned server health for complete accounting', async () => {
    const healthCalls: unknown[] = [];
    const pinned = wrapOpencodeClient(
      makeV1Sdk({ onHealth: (args) => healthCalls.push(args) }),
    );
    const pinnedResult = (await pinned.run?.({
      prompt: 'pinned server',
    })) as Record<string, unknown>;
    expect(pinnedResult.usageCoverageIncomplete).toBeUndefined();
    expect(healthCalls).toHaveLength(1);
    expect(healthCalls[0]).toMatchObject({ signal: expect.any(AbortSignal) });

    const mismatched = wrapOpencodeClient(
      makeV1Sdk({
        healthResult: { data: { healthy: true, version: '1.18.14' } },
      }),
    );
    const mismatchedResult = (await mismatched.run?.({
      prompt: 'newer unverified server',
    })) as Record<string, unknown>;
    expect(mismatchedResult.usageCoverageIncomplete).toBe(true);

    const malformed = wrapOpencodeClient(
      makeV1Sdk({ healthResult: { data: { healthy: true } } }),
    );
    const malformedResult = (await malformed.run?.({
      prompt: 'unknown server',
    })) as Record<string, unknown>;
    expect(malformedResult.usageCoverageIncomplete).toBe(true);
  });

  it('marks usage incomplete when title suppression cannot be proven', async () => {
    const missingEcho = wrapOpencodeClient(
      makeV1Sdk({ createResult: { id: 'missing-title' } }),
    );
    const fresh = (await missingEcho.run?.({ prompt: 'fresh' })) as Record<
      string,
      unknown
    >;
    expect(fresh.usageCoverageIncomplete).toBe(true);

    const failedLookup = makeV1Sdk({});
    (failedLookup.session as { get: () => Promise<never> }).get = async () => {
      throw new Error('lookup failed');
    };
    const resumed = (await wrapOpencodeClient(failedLookup).run?.({
      prompt: 'resume',
      sessionId: 'unknown-title',
    })) as Record<string, unknown>;
    expect(resumed.usageCoverageIncomplete).toBe(true);
  });

  it('resumes existing session instead of creating a new one', async () => {
    let createCalled = false;
    let capturedPromptArgs: unknown;
    let capturedChildrenArgs: unknown;

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
          onChildren(args) {
            capturedChildrenArgs = args;
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
    expect(capturedChildrenArgs).toMatchObject({
      path: { id: 'resumed-session' },
    });
    expect(
      (capturedChildrenArgs as { signal?: AbortSignal }).signal,
    ).toBeInstanceOf(AbortSignal);
  });

  it('clears an unconfirmed stale resume before the next run', async () => {
    let createCalls = 0;
    const childLookups: string[] = [];
    const promptTargets: string[] = [];
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://v1.local:7000' },
      {
        loadSdk: makeV1Loader({
          createResult: { id: 'fresh-session' },
          childrenResult: {
            error: { data: { message: 'session not found' } },
          },
          subscribeResult: {
            stream: (async function* () {
              yield {
                type: 'session.idle',
                sessionId: 'fresh-session',
              };
            })(),
          },
          onCreateSession() {
            createCalls++;
          },
          onChildren(args) {
            childLookups.push((args as { path: { id: string } }).path.id);
          },
          onPrompt(args) {
            promptTargets.push((args as { path: { id: string } }).path.id);
          },
        }),
      },
    );
    const agent = new Cligent(adapter);

    const rejectedResume = await collect(
      agent.run('resume stale session', { resume: 'stale-session' }),
    );
    expect(rejectedResume.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);
    expect(rejectedResume[1]?.payload).toMatchObject({
      code: 'OPENCODE_STREAM_ERROR',
      message: expect.stringContaining('session not found'),
    });
    expect(rejectedResume.at(-1)?.payload).not.toHaveProperty('resumeToken');
    expect(agent.resumeToken).toBeUndefined();

    const freshRun = await collect(agent.run('start fresh session'));
    expect(childLookups).toEqual(['stale-session']);
    expect(createCalls).toBe(1);
    expect(promptTargets).toEqual(['fresh-session']);
    expect(freshRun.at(-1)?.payload).toMatchObject({
      status: 'success',
      resumeToken: 'fresh-session',
    });
    expect(agent.resumeToken).toBe('fresh-session');
  });

  it('snapshots a resumed v2 session lineage before prompting', async () => {
    const childrenCalls: unknown[] = [];
    let promptCalled = false;
    const client = wrapOpencodeClient(
      {
        session: {
          async create() {
            throw new Error('resume must not create');
          },
          async children(args: unknown) {
            childrenCalls.push(args);
            const sessionID = (args as { sessionID: string }).sessionID;
            if (sessionID === 'lineage-root') {
              return {
                data: [{ id: 'lineage-child', parentID: 'lineage-root' }],
              };
            }
            if (sessionID === 'lineage-child') {
              return {
                data: [{ id: 'lineage-grandchild', parentID: 'lineage-child' }],
              };
            }
            return { data: [] };
          },
          async promptAsync() {
            promptCalled = true;
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

    const result = (await client.run?.({
      prompt: 'resume lineage',
      sessionId: 'lineage-root',
      cwd: '/repo',
    })) as { ownedSessionIds: string[] };
    expect(childrenCalls).toEqual([
      { sessionID: 'lineage-root', directory: '/repo' },
      { sessionID: 'lineage-child', directory: '/repo' },
      { sessionID: 'lineage-grandchild', directory: '/repo' },
    ]);
    expect(result.ownedSessionIds).toEqual([
      'lineage-root',
      'lineage-child',
      'lineage-grandchild',
    ]);
    expect(promptCalled).toBe(true);
  });

  it('fails before a resumed prompt when lineage discovery stalls', async () => {
    let lineageSignal: AbortSignal | undefined;
    let promptCalled = false;
    const client = wrapOpencodeClient(
      {
        session: {
          async create() {
            throw new Error('resume must not create');
          },
          async children(
            _args: unknown,
            requestOptions?: unknown,
          ): Promise<unknown> {
            lineageSignal = (
              requestOptions as { signal?: AbortSignal } | undefined
            )?.signal;
            return new Promise(() => {});
          },
          async promptAsync() {
            promptCalled = true;
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
      client.run?.({
        prompt: 'resume lineage',
        sessionId: 'lineage-root',
        lineageDiscoveryTimeoutMs: 5,
      }),
    ).rejects.toThrow('session.children timed out after 5ms');
    expect(lineageSignal?.aborted).toBe(true);
    expect(promptCalled).toBe(false);
  });

  it('bounds recursive lineage discovery with one shared deadline', async () => {
    vi.useFakeTimers();
    try {
      const childrenCalls: string[] = [];
      const lineageSignals: AbortSignal[] = [];
      let promptCalled = false;
      const client = wrapOpencodeClient(
        {
          session: {
            async create() {
              throw new Error('resume must not create');
            },
            children(args: unknown, requestOptions?: unknown) {
              const sessionID = (args as { sessionID: string }).sessionID;
              childrenCalls.push(sessionID);
              const lineageSignal = (
                requestOptions as { signal?: AbortSignal } | undefined
              )?.signal;
              if (lineageSignal) lineageSignals.push(lineageSignal);
              if (sessionID === 'lineage-root') {
                return new Promise((resolve) => {
                  setTimeout(
                    () => resolve({ data: [{ id: 'lineage-child' }] }),
                    4,
                  );
                });
              }
              return new Promise(() => {});
            },
            async promptAsync() {
              promptCalled = true;
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

      const runPromise = client.run?.({
        prompt: 'resume lineage',
        sessionId: 'lineage-root',
        lineageDiscoveryTimeoutMs: 5,
      });
      const rejection = expect(runPromise).rejects.toThrow(
        'session.children timed out after 5ms',
      );
      await vi.advanceTimersByTimeAsync(4);
      expect(childrenCalls).toEqual(['lineage-root', 'lineage-child']);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(new Set(lineageSignals).size).toBe(1);
      expect(lineageSignals[0]?.aborted).toBe(true);
      expect(promptCalled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
    const unmanaged = mapPermissionsToOpenCodeOptions(undefined);

    await client.run?.({ prompt: 'fresh native', ...unmanaged });
    await client.run?.({
      prompt: 'resumed native',
      sessionId: 'v1-existing',
      ...unmanaged,
    });

    expect(createCalls).toEqual([{ body: { title: 'Cligent run' } }]);
    expect(promptCalls).toHaveLength(2);
    for (const call of promptCalls) {
      const body = (call as { body: Record<string, unknown> }).body;
      expect(body).not.toHaveProperty('permission');
      expect(body).not.toHaveProperty('tools');
    }

    const explicitlyManaged = mapPermissionsToOpenCodeOptions({});
    await client.run?.({ prompt: 'fresh managed', ...explicitlyManaged });
    await client.run?.({
      prompt: 'resumed managed',
      sessionId: 'v1-existing',
      ...explicitlyManaged,
    });

    expect(createCalls).toEqual([
      { body: { title: 'Cligent run' } },
      { body: { title: 'Cligent run' } },
    ]);
    for (const call of promptCalls.slice(2)) {
      expect(
        (call as { body: Record<string, unknown> }).body.permission,
      ).toEqual({
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
        async children() {
          return { data: [] };
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
        async children() {
          return { data: [] };
        },
      },
      event: {
        async subscribe() {
          return { stream: (async function* () {})() };
        },
      },
    };
    const client = wrapOpencodeClient(real, { apiVersion: 'v2' });
    const unmanaged = mapPermissionsToOpenCodeOptions(undefined);

    await client.run?.({ prompt: 'fresh native', ...unmanaged });
    await client.run?.({
      prompt: 'resumed native',
      sessionId: 'v2-existing',
      ...unmanaged,
    });

    expect(createCalls).toEqual([{ title: 'Cligent run' }]);
    expect(updateCalls).toEqual([]);
    expect(promptCalls).toHaveLength(2);
    for (const call of promptCalls) {
      expect(call).not.toHaveProperty('permission');
      expect(call).not.toHaveProperty('tools');
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
      { title: 'Cligent run' },
      { title: 'Cligent run', permission: askRules },
    ]);
    expect(updateCalls).toEqual([
      {
        sessionID: 'v2-existing',
        permission: askRules,
      },
    ]);
  });

  it('keeps native rules in auto and retains explicit denies on v1 and v2', async () => {
    const mapped = mapPermissionsToOpenCodeOptions({ mode: 'auto' });
    const mappedWithDeny = mapPermissionsToOpenCodeOptions({
      mode: 'auto',
      fileWrite: 'deny',
    });
    const v1Prompts: unknown[] = [];
    const v1 = wrapOpencodeClient(
      makeV1Sdk({
        onPrompt(args) {
          v1Prompts.push(args);
        },
      }),
    );
    await v1.run?.({ prompt: 'v1 auto', ...mapped });
    expect(
      (v1Prompts[0] as { body: { permission?: unknown } }).body.permission,
    ).toBeUndefined();
    await v1.run?.({
      prompt: 'v1 resumed auto',
      sessionId: 'v1-existing',
      ...mapped,
    });
    expect(v1Prompts[1]).toMatchObject({ path: { id: 'v1-existing' } });
    expect(
      (v1Prompts[1] as { body: { permission?: unknown } }).body.permission,
    ).toBeUndefined();
    await v1.run?.({ prompt: 'v1 explicit deny', ...mappedWithDeny });
    expect(v1Prompts[2]).toMatchObject({
      body: { permission: { edit: 'deny' } },
    });

    const v2Create: unknown[] = [];
    const v2Update: unknown[] = [];
    const v2 = wrapOpencodeClient(
      {
        session: {
          async create(args: unknown) {
            v2Create.push(args);
            return { data: { id: 'v2-auto' } };
          },
          async update(args: unknown) {
            v2Update.push(args);
            return {};
          },
          async promptAsync() {
            return {};
          },
          async children() {
            return { data: [] };
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
    expect(v2Create[0]).toEqual({ title: 'Cligent run' });

    await v2.run?.({
      prompt: 'v2 resumed auto',
      sessionId: 'v2-existing',
      cwd: '/workspace',
      ...mapped,
    });
    expect(v2Update).toEqual([]);

    await v2.run?.({ prompt: 'v2 explicit deny', ...mappedWithDeny });
    expect(v2Create[1]).toEqual({
      title: 'Cligent run',
      permission: [{ permission: 'edit', pattern: '*', action: 'deny' }],
    });
    await v2.run?.({
      prompt: 'v2 resumed explicit deny',
      sessionId: 'v2-existing',
      cwd: '/workspace',
      ...mappedWithDeny,
    });
    expect(v2Update).toEqual([
      {
        sessionID: 'v2-existing',
        directory: '/workspace',
        permission: [{ permission: 'edit', pattern: '*', action: 'deny' }],
      },
    ]);
  });

  it('uses once and reject on the correlated legacy v1 response endpoint', async () => {
    const replyArgs: unknown[] = [];
    const controller = new AbortController();
    const real = makeV1Sdk({});
    real.postSessionIdPermissionsPermissionId = async (args: unknown) => {
      replyArgs.push(args);
      return {};
    };
    const client = wrapOpencodeClient(real);

    await client.replyPermission?.({
      sessionId: 'legacy-session',
      requestId: 'legacy-request',
      permission: 'external_directory',
      decision: 'reject',
      cwd: '/workspace',
      signal: controller.signal,
    });

    await client.replyPermission?.({
      sessionId: 'legacy-session',
      requestId: 'legacy-auto-request',
      permission: 'external_directory',
      decision: 'once',
    });

    expect(replyArgs[0]).toEqual({
      path: { id: 'legacy-session', permissionID: 'legacy-request' },
      body: { response: 'reject' },
      query: { directory: '/workspace' },
      signal: controller.signal,
    });
    expect(replyArgs[1]).toEqual({
      path: { id: 'legacy-session', permissionID: 'legacy-auto-request' },
      body: { response: 'once' },
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
          if (replyCalls.length <= 2) return {};
          if (replyCalls.length === 3) {
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
      decision: 'once',
      cwd: '/workspace',
      signal: controller.signal,
    });
    expect(replyCalls[0]).toEqual({
      parameters: {
        requestID: 'v2-reply-request',
        directory: '/workspace',
        reply: 'once',
      },
      requestOptions: { signal: controller.signal },
    });

    await client.replyPermission?.({
      sessionId: 'v2-reply-session',
      requestId: 'v2-reject-request',
      permission: 'future_permission',
      decision: 'reject',
    });
    expect(replyCalls[1]).toEqual({
      parameters: {
        requestID: 'v2-reject-request',
        reply: 'reject',
        message: 'Cligent headless runs reject unresolved permission requests',
      },
      requestOptions: undefined,
    });

    await expect(
      client.replyPermission?.({
        sessionId: 'v2-reply-session',
        requestId: 'v2-missing-request',
        permission: 'future_permission',
        decision: 'reject',
      }),
    ).rejects.toThrow(
      /sessionID="v2-reply-session".*requestID="v2-missing-request".*permission="future_permission".*request disappeared/,
    );

    await expect(
      client.replyPermission?.({
        sessionId: 'v2-reply-session',
        requestId: 'v2-declined-request',
        permission: 'future_permission',
        decision: 'reject',
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
        decision: 'reject',
      }),
    ).rejects.toThrow(
      /sessionID="no-reply-route-session".*requestID="no-reply-route-request".*permission="future_permission".*permission\.reply\(\) not available/,
    );
  });

  it('rejects legacy prompt tools before v1 or v2 SDK calls', async () => {
    const rejection =
      /does not support prompt `tools`.*override native or explicit denies.*independent exact tool registry/;
    let v1CreateCalls = 0;
    let v1PromptCalls = 0;
    let v1SubscribeCalls = 0;
    const v1 = wrapOpencodeClient(
      makeV1Sdk({
        onCreateSession() {
          v1CreateCalls++;
        },
        onPrompt() {
          v1PromptCalls++;
        },
        onSubscribe() {
          v1SubscribeCalls++;
        },
      }),
    );
    await expect(
      v1.run?.({ prompt: 'v1 tool-free', tools: { core: [] } }),
    ).rejects.toThrow(rejection);
    await expect(
      v1.run?.({
        prompt: 'v1 resumed restriction',
        sessionId: 'v1-existing',
        tools: { exclude: ['bash'] },
      }),
    ).rejects.toThrow(rejection);
    expect(v1CreateCalls).toBe(0);
    expect(v1PromptCalls).toBe(0);
    expect(v1SubscribeCalls).toBe(0);

    let v2CreateCalls = 0;
    let v2UpdateCalls = 0;
    let v2PromptCalls = 0;
    let v2SubscribeCalls = 0;
    const v2 = wrapOpencodeClient(
      {
        session: {
          async create() {
            v2CreateCalls++;
            return { data: { id: 'v2-tool-free' } };
          },
          async update() {
            v2UpdateCalls++;
            return {};
          },
          async promptAsync() {
            v2PromptCalls++;
            return {};
          },
        },
        event: {
          async subscribe() {
            v2SubscribeCalls++;
            return { stream: (async function* () {})() };
          },
        },
      },
      { apiVersion: 'v2' },
    );
    await expect(
      v2.run?.({ prompt: 'v2 restricted', tools: { core: ['bash'] } }),
    ).rejects.toThrow(rejection);
    await expect(
      v2.run?.({
        prompt: 'v2 resumed restriction',
        sessionId: 'v2-existing',
        permission: { bash: 'deny' },
        tools: { core: ['bash'] },
      }),
    ).rejects.toThrow(rejection);
    expect(v2CreateCalls).toBe(0);
    expect(v2UpdateCalls).toBe(0);
    expect(v2PromptCalls).toBe(0);
    expect(v2SubscribeCalls).toBe(0);
  });

  it('maps v1 permission options onto the v2 session surface', async () => {
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
    });

    expect(capturedCreateArgs).toEqual({
      directory: '/workspace',
      title: 'Cligent run',
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
        parts: [{ type: 'text', text: 'test options' }],
      }),
    );
    expect(capturedPromptArgs).not.toHaveProperty('permission');
    expect(capturedPromptArgs).not.toHaveProperty('tools');
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
        async children() {
          return { data: [] };
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

  it('clears a v2 resumed session permission ruleset before prompting', async () => {
    const events: string[] = [];
    const updateCalls: unknown[] = [];
    const real = {
      session: {
        async create() {
          throw new Error('create should not be called');
        },
        async update(args: unknown) {
          events.push('update');
          updateCalls.push(args);
          return {};
        },
        async promptAsync() {
          events.push('prompt');
          return {};
        },
        async children() {
          return { data: [] };
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
      prompt: 'install policy',
      sessionId: 'existing-session',
      permission: { edit: 'allow' },
    });
    await client.run?.({
      prompt: 'preserve policy',
      sessionId: 'existing-session',
    });
    await client.run?.({
      prompt: 'clear policy',
      sessionId: 'existing-session',
      ...mapPermissionsToOpenCodeOptions(createPermissionPolicyReset()),
    });

    expect(updateCalls).toEqual([
      {
        sessionID: 'existing-session',
        permission: [{ permission: 'edit', pattern: '*', action: 'allow' }],
      },
      { sessionID: 'existing-session', permission: [] },
    ]);
    expect(events).toEqual(['update', 'prompt', 'prompt', 'update', 'prompt']);
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
    expect(promptArgs.body).not.toHaveProperty('tools');
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
      payload: {
        toolName: string;
        toolUseId: string;
        input: Record<string, unknown>;
      };
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

    expect(v1DisposeCalls).toEqual([{ query: { directory: '/v1-workspace' } }]);
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
        async create() {
          return { id: 'pa-session' };
        },
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
          return {
            stream: (async function* () {
              yield { type: 'session.idle', sessionId: 'pa-session' };
            })(),
          };
        },
      },
    };

    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://v1.local:7000' },
      {
        loadSdk: async () => ({
          createClient() {
            return wrapOpencodeClient(
              real as Record<string, unknown>,
            ) as unknown as MockOpenCodeClient;
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
          onPrompt(args) {
            capturedPromptArgs = args;
          },
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
  const accountingMessage = (
    sessionID: string,
    id: string,
    role: 'user' | 'assistant',
    parentID?: string,
    details: Record<string, unknown> = {},
  ) => ({
    type: 'message.updated',
    properties: {
      sessionID,
      info: {
        id,
        sessionID,
        role,
        ...(parentID ? { parentID } : {}),
        ...details,
      },
    },
  });

  const accountingPart = (
    sessionID: string,
    messageID: string,
    id: string,
    type: string,
    details: Record<string, unknown> = {},
  ) => ({
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: { id, sessionID, messageID, type, ...details },
    },
  });

  const accountingStep = (
    sessionID: string,
    messageID: string,
    id: string,
    cost = 0.01,
  ) =>
    accountingPart(sessionID, messageID, id, 'step-finish', {
      reason: 'stop',
      cost,
      tokens: {
        input: 1,
        output: 2,
        reasoning: 1,
        cache: { read: 0, write: 0 },
      },
    });

  const accountingIdle = (sessionID: string) => ({
    type: 'session.idle',
    properties: { sessionID },
  });

  const collectAccountingUsage = async (
    sessionId: string,
    eventFactory: (promptMessageId: string) => unknown[],
    runResult: Record<string, unknown> = {},
  ): Promise<DonePayload['usage']> => {
    // OpenCode mints the user-message id; the run observes it rather than
    // dictating one, so the fixture owns the value the same way a server does.
    const promptMessageId = 'msg_root-prompt';
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId, ...runResult },
          eventStreamFactory: () => ({
            async *[Symbol.asyncIterator]() {
              for (const event of eventFactory(promptMessageId)) yield event;
            },
          }),
        }),
      },
    );
    const events = await collect(adapter.run('account this run'));
    return (
      events.find((event) => event.type === 'done')!.payload as DonePayload
    ).usage;
  };

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
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);
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
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);
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
                signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
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
    'starts session cancellation before interrupted done after $label queue flush',
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
      const terminal = await terminalPromise;
      expect(terminalSettled).toBe(true);
      expect(terminal.value).toMatchObject({
        type: 'done',
        payload: { status: 'interrupted' },
      });
      releaseAbort?.();
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

    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);
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
            makeV2PartUpdated(
              {
                id: 'text-part',
                sessionID: 'snapshot-session',
                messageID: 'assistant-message',
                type: 'text',
                text: 'A',
              },
              1,
            ),
            makeV2PartUpdated(
              {
                id: 'text-part',
                sessionID: 'snapshot-session',
                messageID: 'assistant-message',
                type: 'text',
                text: 'B',
              },
              2,
            ),
            makeV2PartUpdated(
              {
                id: 'text-part',
                sessionID: 'snapshot-session',
                messageID: 'assistant-message',
                type: 'text',
                text: 'A',
              },
              3,
            ),
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
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);
    expect(events[1]?.payload).toEqual({ content: 'valid output' });
  });

  it('drains incident-scale pending deltas without losing order', async () => {
    const deltaCount = 2_050;
    const pendingDeltas = Array.from(
      { length: deltaCount },
      (_, index) =>
        ({
          id: `bulk-delta-${index}`,
          type: 'message.part.delta' as const,
          properties: {
            sessionID: 'bulk-session',
            messageID: 'assistant-message',
            partID: 'bulk-part',
            field: 'text',
            delta: `${index},`,
          },
        }) satisfies EventMessagePartDelta,
    );
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
    expect(deltas.join('')).toBe(
      pendingDeltas.map((event) => event.properties.delta).join(''),
    );
  });

  it('handles session.error events', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'err-session' },
          events: [
            {
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
            } satisfies EventSessionError,
            {
              id: 'event-auth-idle',
              type: 'session.idle',
              properties: { sessionID: 'err-session' },
            } satisfies EventSessionIdle,
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

  it('does not attribute uncorrelated same-session steps to the invocation', async () => {
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
    expect(payload.usage).toEqual({ toolUses: 0 });
  });

  // TADAPT-039
  it('records each step as its own billable request', async () => {
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
      ...firstStep,
      id: 'step-2',
      messageID: 'message-2',
      cost: 0.002,
      tokens: {
        input: 80,
        output: 30,
        reasoning: 10,
        cache: { read: 4, write: 1 },
      },
    } satisfies StepFinishPart;
    const promptMessageId = 'msg_root-prompt';
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'usage-session' },
          eventStreamFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'message.updated',
                properties: {
                  sessionID: 'usage-session',
                  info: {
                    id: 'message-1',
                    sessionID: 'usage-session',
                    role: 'assistant',
                    parentID: promptMessageId,
                    modelID: 'claude-sonnet-5',
                    providerID: 'anthropic',
                  },
                },
              };
              yield {
                type: 'message.updated',
                properties: {
                  sessionID: 'usage-session',
                  info: {
                    id: 'message-2',
                    sessionID: 'usage-session',
                    role: 'assistant',
                    parentID: promptMessageId,
                  },
                },
              };
              yield {
                type: 'message.part.updated',
                properties: { part: firstStep },
              };
              yield {
                type: 'message.part.updated',
                properties: { part: secondStep },
              };
              yield {
                type: 'session.idle',
                properties: { sessionID: 'usage-session' },
              };
            },
          }),
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const payload = events.find((e) => e.type === 'done')!
      .payload as DonePayload;
    expect(payload.usage.tokens?.coverage).toBe('complete');
    expect(payload.usage.tokens?.records).toEqual([
      {
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        requests: 1,
        tokens: {
          input: {
            total: 115,
            uncached: 100,
            cacheRead: 10,
            cacheWrite: 5,
          },
          output: { total: 70, visible: 50, reasoning: 20 },
        },
        cost: {
          amount: 0.003,
          currency: 'USD',
          source: 'agent-estimate',
        },
      },
      {
        requests: 1,
        tokens: {
          input: {
            total: 85,
            uncached: 80,
            cacheRead: 4,
            cacheWrite: 1,
          },
          output: { total: 40, visible: 30, reasoning: 10 },
        },
        cost: {
          amount: 0.002,
          currency: 'USD',
          source: 'agent-estimate',
        },
      },
    ]);
    expect(payload.usage.cost).toEqual({
      amount: 0.005,
      currency: 'USD',
      source: 'agent-estimate',
    });
  });

  it('keeps exact steps partial when title suppression is unproven', async () => {
    const usage = await collectAccountingUsage(
      'title-session',
      (promptMessageId) => [
        accountingMessage(
          'title-session',
          'title-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep('title-session', 'title-assistant', 'title-step'),
        accountingIdle('title-session'),
      ],
      { usageCoverageIncomplete: true },
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(1);
    expect(usage.cost).toBeUndefined();
  });

  it('accounts canonical compaction and its marked continuation', async () => {
    const usage = await collectAccountingUsage(
      'compaction-session',
      (promptMessageId) => [
        accountingMessage(
          'compaction-session',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep('compaction-session', 'root-assistant', 'root-step'),
        accountingMessage('compaction-session', 'compaction-prompt', 'user'),
        accountingPart(
          'compaction-session',
          'compaction-prompt',
          'compaction-part',
          'compaction',
          { auto: true },
        ),
        accountingMessage(
          'compaction-session',
          'summary-assistant',
          'assistant',
          'compaction-prompt',
          { mode: 'compaction', summary: true },
        ),
        accountingStep(
          'compaction-session',
          'summary-assistant',
          'summary-step',
        ),
        accountingMessage('compaction-session', 'continuation-prompt', 'user'),
        accountingPart(
          'compaction-session',
          'continuation-prompt',
          'continuation-part',
          'text',
          {
            synthetic: true,
            metadata: { compaction_continue: true },
            text: 'Continue if you have next steps.',
          },
        ),
        {
          type: 'session.compacted',
          properties: { sessionID: 'compaction-session' },
        },
        accountingMessage(
          'compaction-session',
          'continuation-assistant',
          'assistant',
          'continuation-prompt',
        ),
        accountingStep(
          'compaction-session',
          'continuation-assistant',
          'continuation-step',
        ),
        accountingIdle('compaction-session'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('complete');
    expect(usage.tokens?.records).toHaveLength(3);
    expect(usage.tokens?.totals).toEqual({
      input: { total: 3, uncached: 3, cacheRead: 0, cacheWrite: 0 },
      output: { total: 9, visible: 6, reasoning: 3 },
    });
    expect(usage.cost).toEqual({
      amount: 0.03,
      currency: 'USD',
      source: 'agent-estimate',
    });
  });

  it('excludes unmarked compaction replay and reports the exact subset', async () => {
    const usage = await collectAccountingUsage(
      'overflow-session',
      (promptMessageId) => [
        accountingMessage(
          'overflow-session',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep('overflow-session', 'root-assistant', 'root-step'),
        accountingMessage('overflow-session', 'compaction-prompt', 'user'),
        accountingPart(
          'overflow-session',
          'compaction-prompt',
          'compaction-part',
          'compaction',
          { auto: true, overflow: true },
        ),
        accountingMessage(
          'overflow-session',
          'summary-assistant',
          'assistant',
          'compaction-prompt',
          { mode: 'compaction', summary: true },
        ),
        accountingStep('overflow-session', 'summary-assistant', 'summary-step'),
        accountingMessage('overflow-session', 'replay-prompt', 'user'),
        {
          type: 'session.compacted',
          properties: { sessionID: 'overflow-session' },
        },
        accountingMessage(
          'overflow-session',
          'replay-assistant',
          'assistant',
          'replay-prompt',
        ),
        accountingStep('overflow-session', 'replay-assistant', 'replay-step'),
        accountingIdle('overflow-session'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(2);
    expect(usage.cost).toBeUndefined();
  });

  it('retains overflow evidence across repeated compaction snapshots', async () => {
    const usage = await collectAccountingUsage(
      'sticky-overflow-session',
      (promptMessageId) => [
        accountingMessage(
          'sticky-overflow-session',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep(
          'sticky-overflow-session',
          'root-assistant',
          'root-step',
        ),
        accountingMessage(
          'sticky-overflow-session',
          'compaction-prompt',
          'user',
        ),
        accountingPart(
          'sticky-overflow-session',
          'compaction-prompt',
          'compaction-part',
          'compaction',
          { auto: true, overflow: true },
        ),
        accountingPart(
          'sticky-overflow-session',
          'compaction-prompt',
          'compaction-part',
          'compaction',
          { auto: true },
        ),
        accountingMessage(
          'sticky-overflow-session',
          'summary-assistant',
          'assistant',
          'compaction-prompt',
          { mode: 'compaction', summary: true },
        ),
        accountingStep(
          'sticky-overflow-session',
          'summary-assistant',
          'summary-step',
        ),
        accountingMessage(
          'sticky-overflow-session',
          'continuation-prompt',
          'user',
        ),
        accountingPart(
          'sticky-overflow-session',
          'continuation-prompt',
          'continuation-part',
          'text',
          {
            synthetic: true,
            text: 'continue',
            metadata: { compaction_continue: true },
          },
        ),
        accountingMessage(
          'sticky-overflow-session',
          'continuation-assistant',
          'assistant',
          'continuation-prompt',
        ),
        accountingStep(
          'sticky-overflow-session',
          'continuation-assistant',
          'continuation-step',
        ),
        {
          type: 'session.compacted',
          properties: { sessionID: 'sticky-overflow-session' },
        },
        accountingIdle('sticky-overflow-session'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(3);
    expect(usage.cost).toBeUndefined();
  });

  it('keeps a marked continuation partial until its assistant settles', async () => {
    const usage = await collectAccountingUsage(
      'pending-continuation',
      (promptMessageId) => [
        accountingMessage(
          'pending-continuation',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep('pending-continuation', 'root-assistant', 'root-step'),
        accountingMessage('pending-continuation', 'compaction-prompt', 'user'),
        accountingPart(
          'pending-continuation',
          'compaction-prompt',
          'compaction-part',
          'compaction',
          { auto: true },
        ),
        accountingMessage(
          'pending-continuation',
          'summary-assistant',
          'assistant',
          'compaction-prompt',
          { mode: 'compaction', summary: true },
        ),
        accountingStep(
          'pending-continuation',
          'summary-assistant',
          'summary-step',
        ),
        accountingMessage(
          'pending-continuation',
          'continuation-prompt',
          'user',
        ),
        accountingPart(
          'pending-continuation',
          'continuation-prompt',
          'continuation-part',
          'text',
          {
            synthetic: true,
            metadata: { compaction_continue: true },
            text: 'Continue if you have next steps.',
          },
        ),
        {
          type: 'session.compacted',
          properties: { sessionID: 'pending-continuation' },
        },
        accountingIdle('pending-continuation'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(2);
    expect(usage.cost).toBeUndefined();
  });

  it('keeps an unrecognized synthetic continuation partial', async () => {
    const usage = await collectAccountingUsage(
      'unknown-internal-session',
      (promptMessageId) => [
        accountingMessage(
          'unknown-internal-session',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep(
          'unknown-internal-session',
          'root-assistant',
          'root-step',
        ),
        accountingMessage(
          'unknown-internal-session',
          'unknown-internal-prompt',
          'user',
        ),
        accountingPart(
          'unknown-internal-session',
          'unknown-internal-prompt',
          'unknown-internal-part',
          'text',
          { synthetic: true, text: 'A future internal continuation marker' },
        ),
        accountingIdle('unknown-internal-session'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(1);
    expect(usage.cost).toBeUndefined();
  });

  it('does not consume an unrecognized child internal prompt as task work', async () => {
    const usage = await collectAccountingUsage(
      'internal-child-root',
      (promptMessageId) => [
        accountingMessage(
          'internal-child-root',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep(
          'internal-child-root',
          'root-assistant',
          'root-step',
          0.01,
        ),
        accountingPart(
          'internal-child-root',
          'root-assistant',
          'task-part',
          'tool',
          {
            callID: 'task-call',
            tool: 'task',
            state: {
              status: 'running',
              metadata: { sessionId: 'internal-child' },
            },
          },
        ),
        accountingMessage('internal-child', 'old-internal-prompt', 'user'),
        accountingPart(
          'internal-child',
          'old-internal-prompt',
          'old-internal-part',
          'text',
          { synthetic: true, text: 'A future internal marker' },
        ),
        accountingMessage(
          'internal-child',
          'old-internal-assistant',
          'assistant',
          'old-internal-prompt',
        ),
        accountingStep(
          'internal-child',
          'old-internal-assistant',
          'old-internal-step',
          0.04,
        ),
        accountingMessage('internal-child', 'actual-task-prompt', 'user'),
        accountingMessage(
          'internal-child',
          'actual-task-assistant',
          'assistant',
          'actual-task-prompt',
        ),
        accountingStep(
          'internal-child',
          'actual-task-assistant',
          'actual-task-step',
          0.02,
        ),
        accountingIdle('internal-child'),
        accountingIdle('internal-child-root'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records?.map((record) => record.cost?.amount)).toEqual(
      [0.01, 0.02],
    );
    expect(usage.cost).toBeUndefined();
  });

  it('marks successful retry accounting partial', async () => {
    const usage = await collectAccountingUsage(
      'retry-session',
      (promptMessageId) => [
        accountingMessage(
          'retry-session',
          'retry-assistant',
          'assistant',
          promptMessageId,
        ),
        {
          type: 'session.status',
          properties: {
            sessionID: 'retry-session',
            status: { type: 'retry', attempt: 1 },
          },
        },
        accountingStep('retry-session', 'retry-assistant', 'retry-step'),
        accountingIdle('retry-session'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(1);
    expect(usage.cost).toBeUndefined();
  });

  it('does not attribute an explicit foreign-session retry to the run', async () => {
    const usage = await collectAccountingUsage(
      'foreign-retry-session',
      (promptMessageId) => [
        accountingMessage(
          'foreign-retry-session',
          'causal-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep(
          'foreign-retry-session',
          'causal-assistant',
          'causal-step',
        ),
        accountingMessage(
          'foreign-retry-session',
          'foreign-assistant',
          'assistant',
          'foreign-prompt',
        ),
        {
          type: 'session.status',
          properties: {
            sessionID: 'foreign-retry-session',
            status: { type: 'retry', attempt: 1 },
          },
        },
        accountingIdle('foreign-retry-session'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('complete');
    expect(usage.tokens?.records).toHaveLength(1);
    expect(usage.cost).toEqual({
      amount: 0.01,
      currency: 'USD',
      source: 'agent-estimate',
    });
  });

  it('accounts command task continuations without inventing a model step', async () => {
    const usage = await collectAccountingUsage(
      'command-root',
      (promptMessageId) => [
        accountingMessage(
          'command-root',
          'task-orchestrator',
          'assistant',
          promptMessageId,
        ),
        accountingPart(
          'command-root',
          'task-orchestrator',
          'task-part',
          'tool',
          {
            callID: 'task-call',
            tool: 'task',
            state: {
              status: 'running',
              input: { command: 'inspect the child' },
              metadata: { sessionId: 'command-child' },
            },
          },
        ),
        accountingMessage('command-child', 'child-prompt', 'user'),
        accountingMessage(
          'command-child',
          'child-assistant',
          'assistant',
          'child-prompt',
        ),
        accountingStep('command-child', 'child-assistant', 'child-step'),
        accountingIdle('command-child'),
        accountingMessage('command-root', 'continuation-prompt', 'user'),
        accountingPart(
          'command-root',
          'continuation-prompt',
          'continuation-part',
          'text',
          {
            synthetic: true,
            text: 'Summarize the task tool output above and continue with your task.',
          },
        ),
        accountingMessage(
          'command-root',
          'continuation-assistant',
          'assistant',
          'continuation-prompt',
        ),
        accountingStep(
          'command-root',
          'continuation-assistant',
          'continuation-step',
        ),
        accountingIdle('command-root'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('complete');
    expect(usage.tokens?.records).toHaveLength(2);
    expect(usage.cost).toEqual({
      amount: 0.02,
      currency: 'USD',
      source: 'agent-estimate',
    });
  });

  it('binds background results one-to-one and keeps pending work partial', async () => {
    const events = (promptMessageId: string, resultCount: number) => [
      accountingMessage(
        'background-root',
        'root-assistant',
        'assistant',
        promptMessageId,
      ),
      accountingStep('background-root', 'root-assistant', 'root-step'),
      accountingPart(
        'background-root',
        'root-assistant',
        'background-task',
        'tool',
        {
          callID: 'background-call',
          tool: 'task',
          state: {
            status: 'running',
            input: { description: 'background work' },
            metadata: {
              sessionId: 'background-child',
              parentSessionId: 'background-root',
              background: true,
            },
          },
        },
      ),
      accountingMessage('background-child', 'child-prompt', 'user'),
      accountingMessage(
        'background-child',
        'child-assistant',
        'assistant',
        'child-prompt',
      ),
      accountingStep('background-child', 'child-assistant', 'child-step'),
      accountingIdle('background-child'),
      ...Array.from({ length: resultCount }, (_, index) => [
        accountingMessage('background-root', `result-prompt-${index}`, 'user'),
        accountingPart(
          'background-root',
          `result-prompt-${index}`,
          `result-part-${index}`,
          'text',
          {
            synthetic: true,
            text: '<task id="background-child" state="completed">\n<task_result>\nfinished\n</task_result>\n</task>',
          },
        ),
        accountingMessage(
          'background-root',
          `result-assistant-${index}`,
          'assistant',
          `result-prompt-${index}`,
        ),
        accountingStep(
          'background-root',
          `result-assistant-${index}`,
          `result-step-${index}`,
        ),
      ]).flat(),
      accountingIdle('background-root'),
    ];

    const complete = await collectAccountingUsage(
      'background-root',
      (promptMessageId) => events(promptMessageId, 1),
    );
    expect(complete.tokens?.coverage).toBe('complete');
    expect(complete.tokens?.records).toHaveLength(3);

    const pending = await collectAccountingUsage(
      'background-root',
      (promptMessageId) => events(promptMessageId, 0),
    );
    expect(pending.tokens?.coverage).toBe('partial');
    expect(pending.tokens?.records).toHaveLength(2);
    expect(pending.cost).toBeUndefined();

    const duplicate = await collectAccountingUsage(
      'background-root',
      (promptMessageId) => events(promptMessageId, 2),
    );
    expect(duplicate.tokens?.coverage).toBe('partial');
    expect(duplicate.tokens?.records).toHaveLength(3);
    expect(duplicate.cost).toBeUndefined();
  });

  it('rejects mismatched background parent metadata as complete evidence', async () => {
    const usage = await collectAccountingUsage(
      'mismatched-background-root',
      (promptMessageId) => [
        accountingMessage(
          'mismatched-background-root',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep(
          'mismatched-background-root',
          'root-assistant',
          'root-step',
        ),
        accountingPart(
          'mismatched-background-root',
          'root-assistant',
          'background-task',
          'tool',
          {
            callID: 'background-call',
            tool: 'task',
            state: {
              status: 'running',
              metadata: {
                sessionId: 'mismatched-background-child',
                parentSessionId: 'wrong-parent',
                background: true,
              },
            },
          },
        ),
        accountingMessage(
          'mismatched-background-child',
          'child-prompt',
          'user',
        ),
        accountingMessage(
          'mismatched-background-child',
          'child-assistant',
          'assistant',
          'child-prompt',
        ),
        accountingStep(
          'mismatched-background-child',
          'child-assistant',
          'child-step',
        ),
        accountingIdle('mismatched-background-child'),
        accountingIdle('mismatched-background-root'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(2);
    expect(usage.cost).toBeUndefined();
  });

  it('marks a causal task without a proven child session partial', async () => {
    const usage = await collectAccountingUsage(
      'unscoped-task-root',
      (promptMessageId) => [
        accountingMessage(
          'unscoped-task-root',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep('unscoped-task-root', 'root-assistant', 'root-step'),
        accountingPart(
          'unscoped-task-root',
          'root-assistant',
          'unscoped-task',
          'tool',
          {
            callID: 'unscoped-call',
            tool: 'task',
            state: { status: 'running', input: { description: 'delegate' } },
          },
        ),
        accountingIdle('unscoped-task-root'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(1);
    expect(usage.cost).toBeUndefined();
  });

  it('retains the first task identity and rejects conflicting snapshots', async () => {
    const usage = await collectAccountingUsage(
      'task-drift-root',
      (promptMessageId) => [
        accountingMessage(
          'task-drift-root',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep('task-drift-root', 'root-assistant', 'root-step'),
        accountingPart(
          'task-drift-root',
          'root-assistant',
          'drifting-task',
          'tool',
          {
            callID: 'drifting-call',
            tool: 'task',
            state: {
              status: 'running',
              metadata: { sessionId: 'task-child-a' },
            },
          },
        ),
        accountingMessage('task-child-a', 'child-a-prompt', 'user'),
        accountingMessage(
          'task-child-a',
          'child-a-assistant',
          'assistant',
          'child-a-prompt',
        ),
        accountingStep('task-child-a', 'child-a-assistant', 'child-a-step'),
        accountingIdle('task-child-a'),
        accountingPart(
          'task-drift-root',
          'root-assistant',
          'drifting-task',
          'tool',
          {
            callID: 'drifting-call',
            tool: 'task',
            state: {
              status: 'running',
              metadata: { sessionId: 'task-child-b' },
            },
          },
        ),
        accountingMessage('task-child-b', 'child-b-prompt', 'user'),
        accountingMessage(
          'task-child-b',
          'child-b-assistant',
          'assistant',
          'child-b-prompt',
        ),
        accountingStep('task-child-b', 'child-b-assistant', 'child-b-step'),
        accountingIdle('task-child-b'),
        accountingIdle('task-drift-root'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(2);
    expect(usage.cost).toBeUndefined();
  });

  it('marks malformed causal task identity partial', async () => {
    const usage = await collectAccountingUsage(
      'malformed-task-root',
      (promptMessageId) => [
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'malformed-task-root',
            part: {
              sessionID: 'malformed-task-root',
              type: 'tool',
              tool: 'task',
              state: {
                status: 'running',
                metadata: { sessionId: 'unscoped-child' },
              },
            },
          },
        },
        accountingMessage(
          'malformed-task-root',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep('malformed-task-root', 'root-assistant', 'root-step'),
        accountingIdle('malformed-task-root'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(1);
    expect(usage.cost).toBeUndefined();
  });

  it('requires descendant idle after its latest causal accounting', async () => {
    const usage = await collectAccountingUsage(
      'settlement-root',
      (promptMessageId) => [
        accountingMessage(
          'settlement-root',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep('settlement-root', 'root-assistant', 'root-step'),
        accountingPart(
          'settlement-root',
          'root-assistant',
          'task-part',
          'tool',
          {
            callID: 'task-call',
            tool: 'task',
            state: {
              status: 'running',
              input: { description: 'delegate' },
              metadata: { sessionId: 'settlement-child' },
            },
          },
        ),
        accountingIdle('settlement-child'),
        accountingMessage('settlement-child', 'child-prompt', 'user'),
        accountingMessage(
          'settlement-child',
          'child-assistant',
          'assistant',
          'child-prompt',
        ),
        accountingStep('settlement-child', 'child-assistant', 'child-step'),
        accountingIdle('settlement-root'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(2);
    expect(usage.cost).toBeUndefined();
  });

  it('requires child idle after a causal nested task launch', async () => {
    const usage = await collectAccountingUsage(
      'nested-settlement-root',
      (promptMessageId) => [
        accountingMessage(
          'nested-settlement-root',
          'root-assistant',
          'assistant',
          promptMessageId,
        ),
        accountingStep('nested-settlement-root', 'root-assistant', 'root-step'),
        accountingPart(
          'nested-settlement-root',
          'root-assistant',
          'child-task',
          'tool',
          {
            callID: 'child-call',
            tool: 'task',
            state: {
              status: 'running',
              metadata: { sessionId: 'nested-settlement-child' },
            },
          },
        ),
        accountingMessage('nested-settlement-child', 'child-prompt', 'user'),
        accountingMessage(
          'nested-settlement-child',
          'child-assistant',
          'assistant',
          'child-prompt',
        ),
        accountingStep(
          'nested-settlement-child',
          'child-assistant',
          'child-step',
        ),
        accountingIdle('nested-settlement-child'),
        accountingPart(
          'nested-settlement-child',
          'child-assistant',
          'grandchild-task',
          'tool',
          {
            callID: 'grandchild-call',
            tool: 'task',
            state: {
              status: 'running',
              metadata: { sessionId: 'nested-settlement-grandchild' },
            },
          },
        ),
        accountingMessage(
          'nested-settlement-grandchild',
          'grandchild-prompt',
          'user',
        ),
        accountingMessage(
          'nested-settlement-grandchild',
          'grandchild-assistant',
          'assistant',
          'grandchild-prompt',
        ),
        accountingStep(
          'nested-settlement-grandchild',
          'grandchild-assistant',
          'grandchild-step',
        ),
        accountingIdle('nested-settlement-grandchild'),
        accountingIdle('nested-settlement-root'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(3);
    expect(usage.cost).toBeUndefined();
  });

  it('accounts the completed task-linked causal tree without exposing child output', async () => {
    const promptMessageId = 'msg_root-prompt';
    const assistantMessage = (
      sessionID: string,
      id: string,
      parentID: string,
      modelID: string,
      providerID: string,
    ) => ({
      type: 'message.updated',
      properties: {
        sessionID,
        info: {
          id,
          sessionID,
          role: 'assistant',
          parentID,
          modelID,
          providerID,
        },
      },
    });
    const userMessage = (sessionID: string, id: string) => ({
      type: 'message.updated',
      properties: {
        sessionID,
        info: { id, sessionID, role: 'user' },
      },
    });
    const step = (
      sessionID: string,
      messageID: string,
      id: string,
      tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
      },
      cost: number,
    ) => ({
      type: 'message.part.updated',
      properties: {
        sessionID,
        part: {
          id,
          sessionID,
          messageID,
          type: 'step-finish',
          reason: 'stop',
          tokens,
          cost,
        },
      },
    });
    const rootInitial = step(
      'usage-root',
      'root-assistant',
      'shared-step',
      {
        input: 10,
        output: 4,
        reasoning: 1,
        cache: { read: 1, write: 1 },
      },
      0.01,
    );
    const rootLatest = step(
      'usage-root',
      'root-assistant',
      'shared-step',
      {
        input: 20,
        output: 8,
        reasoning: 2,
        cache: { read: 3, write: 1 },
      },
      0.02,
    );
    const childLatest = step(
      'usage-child',
      'child-assistant',
      'shared-step',
      {
        input: 7,
        output: 4,
        reasoning: 1,
        cache: { read: 2, write: 0 },
      },
      0.03,
    );

    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'usage-root' },
          eventStreamFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield assistantMessage(
                'usage-root',
                'root-assistant',
                promptMessageId,
                'root-model',
                'root-provider',
              );
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'usage-root',
                  part: {
                    id: 'root-text',
                    sessionID: 'usage-root',
                    messageID: 'root-assistant',
                    type: 'text',
                    text: 'root output',
                  },
                },
              };
              yield rootInitial;
              yield rootInitial;
              yield rootLatest;
              yield {
                type: 'message.part.removed',
                properties: {
                  sessionID: 'usage-root',
                  messageID: 'root-assistant',
                  partID: 'shared-step',
                },
              };
              yield {
                type: 'session.created',
                properties: {
                  info: { id: 'usage-child', parentID: 'usage-root' },
                },
              };
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'usage-root',
                  part: {
                    id: 'root-task',
                    sessionID: 'usage-root',
                    messageID: 'root-assistant',
                    type: 'tool',
                    callID: 'root-task-call',
                    tool: 'task',
                    state: {
                      status: 'running',
                      input: { description: 'delegate' },
                      metadata: { sessionId: 'usage-child' },
                    },
                  },
                },
              };
              yield userMessage('usage-child', 'child-prompt');
              yield assistantMessage(
                'usage-child',
                'child-assistant',
                'child-prompt',
                'child-model',
                'child-provider',
              );
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'usage-child',
                  part: {
                    id: 'child-text',
                    sessionID: 'usage-child',
                    messageID: 'child-assistant',
                    type: 'text',
                    text: 'hidden child output',
                  },
                },
              };
              yield childLatest;
              yield childLatest;
              yield {
                ...childLatest,
                properties: {
                  ...childLatest.properties,
                  part: {
                    ...childLatest.properties.part,
                    tokens: {
                      input: 7,
                      output: 4,
                      reasoning: 1,
                      cache: { read: 2, write: 0 },
                    },
                  },
                },
              };
              yield {
                type: 'message.part.removed',
                properties: {
                  sessionID: 'usage-child',
                  messageID: 'child-assistant',
                  partID: 'shared-step',
                },
              };
              yield {
                type: 'session.created',
                properties: {
                  info: { id: 'usage-grandchild', parentID: 'usage-child' },
                },
              };
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'usage-child',
                  part: {
                    id: 'child-task',
                    sessionID: 'usage-child',
                    messageID: 'child-assistant',
                    type: 'tool',
                    callID: 'child-task-call',
                    tool: 'task',
                    state: {
                      status: 'running',
                      input: { description: 'delegate again' },
                      metadata: { sessionId: 'usage-grandchild' },
                    },
                  },
                },
              };
              yield userMessage('usage-grandchild', 'grandchild-prompt');
              yield assistantMessage(
                'usage-grandchild',
                'grandchild-assistant',
                'grandchild-prompt',
                'grandchild-model',
                'grandchild-provider',
              );
              yield step(
                'usage-grandchild',
                'grandchild-assistant',
                'grandchild-step',
                {
                  input: 5,
                  output: 2,
                  reasoning: 0,
                  cache: { read: 0, write: 1 },
                },
                0,
              );
              yield {
                type: 'message.removed',
                properties: {
                  sessionID: 'usage-grandchild',
                  messageID: 'grandchild-assistant',
                },
              };
              yield {
                type: 'session.created',
                properties: {
                  info: { id: 'usage-foreign', parentID: 'usage-root' },
                },
              };
              yield assistantMessage(
                'usage-foreign',
                'foreign-assistant',
                'foreign-prompt',
                'foreign-model',
                'foreign-provider',
              );
              yield step(
                'usage-foreign',
                'foreign-assistant',
                'foreign-step',
                {
                  input: 1_000,
                  output: 1_000,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                99,
              );
              yield {
                type: 'session.idle',
                properties: { sessionID: 'usage-grandchild' },
              };
              yield {
                type: 'session.idle',
                properties: { sessionID: 'usage-child' },
              };
              yield {
                type: 'session.idle',
                properties: { sessionID: 'usage-foreign' },
              };
              yield {
                type: 'session.idle',
                properties: { sessionID: 'usage-root' },
              };
            },
          }),
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    expect(
      events
        .filter((event) => event.type === 'text')
        .map((event) => (event.payload as { content: string }).content),
    ).toEqual(['root output']);

    const usage = (
      events.find((event) => event.type === 'done')!.payload as DonePayload
    ).usage;
    expect(usage.toolUses).toBe(1);
    expect(usage.tokens).toEqual({
      coverage: 'complete',
      totals: {
        input: {
          total: 39,
          uncached: 32,
          cacheRead: 5,
          cacheWrite: 2,
        },
        output: { total: 17, visible: 14, reasoning: 3 },
      },
      records: [
        {
          model: 'root-model',
          provider: 'root-provider',
          requests: 1,
          tokens: {
            input: {
              total: 24,
              uncached: 20,
              cacheRead: 3,
              cacheWrite: 1,
            },
            output: { total: 10, visible: 8, reasoning: 2 },
          },
          cost: {
            amount: 0.02,
            currency: 'USD',
            source: 'agent-estimate',
          },
        },
        {
          model: 'child-model',
          provider: 'child-provider',
          requests: 1,
          tokens: {
            input: {
              total: 9,
              uncached: 7,
              cacheRead: 2,
              cacheWrite: 0,
            },
            output: { total: 5, visible: 4, reasoning: 1 },
          },
          cost: {
            amount: 0.03,
            currency: 'USD',
            source: 'agent-estimate',
          },
        },
        {
          model: 'grandchild-model',
          provider: 'grandchild-provider',
          requests: 1,
          tokens: {
            input: {
              total: 6,
              uncached: 5,
              cacheRead: 0,
              cacheWrite: 1,
            },
            output: { total: 2, visible: 2, reasoning: 0 },
          },
          cost: {
            amount: 0,
            currency: 'USD',
            source: 'agent-estimate',
          },
        },
      ],
    });
    expect(usage.cost).toEqual({
      amount: 0.05,
      currency: 'USD',
      source: 'agent-estimate',
    });
  });

  it('keeps only task-linked reused-child turns and marks later ambiguity partial', async () => {
    let promptMessageId = '';
    const message = (
      sessionID: string,
      id: string,
      role: 'user' | 'assistant',
      parentID?: string,
    ) => ({
      type: 'message.updated',
      properties: {
        sessionID,
        info: {
          id,
          sessionID,
          role,
          ...(parentID ? { parentID } : {}),
          ...(role === 'assistant'
            ? { modelID: `${id}-model`, providerID: 'test-provider' }
            : {}),
        },
      },
    });
    const step = (
      sessionID: string,
      messageID: string,
      id: string,
      input: number,
      cost: number,
    ) => ({
      type: 'message.part.updated',
      properties: {
        sessionID,
        part: {
          id,
          sessionID,
          messageID,
          type: 'step-finish',
          cost,
          tokens: {
            input,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });
    const task = (id: string) => ({
      type: 'message.part.updated',
      properties: {
        sessionID: 'reuse-root',
        part: {
          id,
          sessionID: 'reuse-root',
          messageID: 'reuse-root-assistant',
          type: 'tool',
          callID: `${id}-call`,
          tool: 'task',
          state: {
            status: 'running',
            input: {},
            metadata: { sessionId: 'reused-child' },
          },
        },
      },
    });

    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'reuse-root' },
          onRun(options) {
            promptMessageId = String(options.promptMessageId);
          },
          eventStreamFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield message(
                'reuse-root',
                'reuse-root-assistant',
                'assistant',
                promptMessageId,
              );
              yield step(
                'reuse-root',
                'reuse-root-assistant',
                'reuse-root-step',
                1,
                0.01,
              );
              yield task('first-task');
              yield message('reused-child', 'first-child-prompt', 'user');
              yield message(
                'reused-child',
                'first-child-assistant',
                'assistant',
                'first-child-prompt',
              );
              yield step(
                'reused-child',
                'first-child-assistant',
                'first-child-step',
                2,
                0.02,
              );

              // This later child turn has no causal task association and
              // must remain outside the invocation report.
              yield message('reused-child', 'background-prompt', 'user');
              yield message(
                'reused-child',
                'background-assistant',
                'assistant',
                'background-prompt',
              );
              yield step(
                'reused-child',
                'background-assistant',
                'background-step',
                1_000,
                99,
              );

              yield task('second-task');
              yield message('reused-child', 'second-child-prompt', 'user');
              yield message(
                'reused-child',
                'second-child-assistant',
                'assistant',
                'second-child-prompt',
              );
              yield step(
                'reused-child',
                'second-child-assistant',
                'second-child-step',
                3,
                0.03,
              );
              yield {
                type: 'session.idle',
                properties: { sessionID: 'reused-child' },
              };
              yield {
                type: 'session.idle',
                properties: { sessionID: 'reuse-root' },
              };
            },
          }),
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const usage = (
      events.find((event) => event.type === 'done')!.payload as DonePayload
    ).usage;
    expect(usage.toolUses).toBe(2);
    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.totals).toEqual({
      input: { total: 6, uncached: 6, cacheRead: 0, cacheWrite: 0 },
      output: { total: 3, visible: 3, reasoning: 0 },
    });
    expect(usage.tokens?.records?.map((record) => record.model)).toEqual([
      'reuse-root-assistant-model',
      'first-child-assistant-model',
      'second-child-assistant-model',
    ]);
    expect(usage).not.toHaveProperty('cost');
  });

  it('excludes ambiguous prompts from a reused task session', async () => {
    const usage = await collectAccountingUsage(
      'reused-task-root',
      (promptMessageId) => [
        accountingMessage(
          'reused-task-root',
          'root-assistant',
          'assistant',
          promptMessageId,
          { modelID: 'root-model' },
        ),
        accountingStep('reused-task-root', 'root-assistant', 'root-step', 0.01),
        accountingPart(
          'reused-task-root',
          'root-assistant',
          'reused-task',
          'tool',
          {
            callID: 'reused-call',
            tool: 'task',
            state: {
              status: 'running',
              input: { task_id: 'reused-task-child' },
              metadata: { sessionId: 'reused-task-child' },
            },
          },
        ),
        accountingMessage('reused-task-child', 'foreign-prompt', 'user'),
        accountingMessage(
          'reused-task-child',
          'foreign-assistant',
          'assistant',
          'foreign-prompt',
          { modelID: 'foreign-model' },
        ),
        accountingStep(
          'reused-task-child',
          'foreign-assistant',
          'foreign-step',
          99,
        ),
        accountingMessage('reused-task-child', 'actual-prompt', 'user'),
        accountingMessage(
          'reused-task-child',
          'actual-assistant',
          'assistant',
          'actual-prompt',
          { modelID: 'actual-model' },
        ),
        accountingStep(
          'reused-task-child',
          'actual-assistant',
          'actual-step',
          0.02,
        ),
        accountingIdle('reused-task-child'),
        accountingIdle('reused-task-root'),
      ],
    );

    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(1);
    expect(usage.tokens?.records?.[0]?.model).toBe('root-model');
    expect(usage.tokens?.records?.[0]?.cost?.amount).toBe(0.01);
    expect(usage.cost).toBeUndefined();
  });

  it('marks accounting partial until every causal child completes', async () => {
    let promptMessageId = '';
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'partial-root' },
          onRun(options) {
            promptMessageId = String(options.promptMessageId);
          },
          eventStreamFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield makeV2MessageUpdated(
                'partial-root',
                'partial-assistant',
                'assistant',
                promptMessageId,
              );
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'partial-root',
                  part: {
                    id: 'partial-step',
                    sessionID: 'partial-root',
                    messageID: 'partial-assistant',
                    type: 'step-finish',
                    reason: 'stop',
                    cost: 0.01,
                    tokens: {
                      input: 3,
                      output: 2,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                  },
                },
              };
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'partial-root',
                  part: {
                    id: 'partial-task',
                    sessionID: 'partial-root',
                    messageID: 'partial-assistant',
                    type: 'tool',
                    callID: 'partial-task-call',
                    tool: 'task',
                    state: {
                      status: 'running',
                      input: {},
                      metadata: { sessionId: 'unfinished-child' },
                    },
                  },
                },
              };
              yield {
                type: 'session.idle',
                properties: { sessionID: 'partial-root' },
              };
            },
          }),
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const usage = (
      events.find((event) => event.type === 'done')!.payload as DonePayload
    ).usage;
    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.totals).toEqual({
      input: { total: 3, uncached: 3, cacheRead: 0, cacheWrite: 0 },
      output: { total: 2, visible: 2, reasoning: 0 },
    });
    expect(usage).not.toHaveProperty('cost');
  });

  it('publishes no token report when canonical step identifiers are missing', async () => {
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'partial-usage-session' },
          events: [
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  sessionID: 'partial-usage-session',
                  type: 'step-finish',
                  tokens: {
                    input: 10,
                    output: 5,
                    reasoning: 1,
                    cache: { read: 0, write: 0 },
                  },
                  cost: 0,
                },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: 'partial-usage-session' },
            },
          ],
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const payload = events.find((event) => event.type === 'done')!
      .payload as DonePayload;
    expect(payload.usage).toEqual({ toolUses: 0 });
  });

  it('treats an explicitly reported zero-valued step as available usage', async () => {
    let promptMessageId = '';
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'zero-usage-session' },
          onRun(options) {
            promptMessageId = String(options.promptMessageId);
          },
          eventStreamFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield makeV2MessageUpdated(
                'zero-usage-session',
                'zero-assistant',
                'assistant',
                promptMessageId,
              );
              yield {
                type: 'message.part.updated',
                properties: {
                  part: {
                    id: 'zero-step',
                    sessionID: 'zero-usage-session',
                    messageID: 'zero-assistant',
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
              };
              yield {
                type: 'session.idle',
                properties: { sessionID: 'zero-usage-session' },
              };
            },
          }),
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage).toEqual({
      toolUses: 0,
      tokens: {
        coverage: 'complete',
        totals: {
          input: {
            total: 0,
            uncached: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          output: { total: 0, visible: 0, reasoning: 0 },
        },
        records: [
          {
            model: 'test-model',
            provider: 'test-provider',
            requests: 1,
            tokens: {
              input: {
                total: 0,
                uncached: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              output: { total: 0, visible: 0, reasoning: 0 },
            },
            cost: {
              amount: 0,
              currency: 'USD',
              source: 'agent-estimate',
            },
          },
        ],
      },
      cost: {
        amount: 0,
        currency: 'USD',
        source: 'agent-estimate',
      },
    });
  });

  it('omits a non-finite aggregate cost while retaining finite step costs', async () => {
    let promptMessageId = '';
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'cost-overflow-session' },
          onRun(options) {
            promptMessageId = String(options.promptMessageId);
          },
          eventStreamFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield makeV2MessageUpdated(
                'cost-overflow-session',
                'cost-overflow-assistant',
                'assistant',
                promptMessageId,
              );
              for (const id of [
                'cost-overflow-step-1',
                'cost-overflow-step-2',
              ]) {
                yield {
                  type: 'message.part.updated',
                  properties: {
                    sessionID: 'cost-overflow-session',
                    part: {
                      id,
                      sessionID: 'cost-overflow-session',
                      messageID: 'cost-overflow-assistant',
                      type: 'step-finish',
                      cost: Number.MAX_VALUE,
                      tokens: {
                        input: 1,
                        output: 1,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                      },
                    },
                  },
                };
              }
              yield {
                type: 'session.idle',
                properties: { sessionID: 'cost-overflow-session' },
              };
            },
          }),
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const usage = (
      events.find((event) => event.type === 'done')!.payload as DonePayload
    ).usage;
    expect(usage.tokens?.coverage).toBe('complete');
    expect(usage.tokens?.records?.map((record) => record.cost?.amount)).toEqual(
      [Number.MAX_VALUE, Number.MAX_VALUE],
    );
    expect(usage).not.toHaveProperty('cost');
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
    ['missing required cache counters', { input: 1, output: 2, reasoning: 0 }],
    [
      'overflowing inclusive input total',
      {
        input: Number.MAX_SAFE_INTEGER,
        output: 0,
        reasoning: 0,
        cache: { read: 1, write: 0 },
      },
    ],
  ])('omits malformed step-finish %s accounting', async (_case, tokens) => {
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
                  id: 'malformed-step',
                  sessionID: 'malformed-usage-session',
                  messageID: 'malformed-assistant',
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
    expect((done.payload as DonePayload).usage).toEqual({ toolUses: 0 });
  });

  it('retains valid causal records when another causal step is malformed', async () => {
    let promptMessageId = '';
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'mixed-usage-session' },
          onRun(options) {
            promptMessageId = String(options.promptMessageId);
          },
          eventStreamFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield makeV2MessageUpdated(
                'mixed-usage-session',
                'mixed-assistant',
                'assistant',
                promptMessageId,
              );
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'mixed-usage-session',
                  part: {
                    id: 'valid-step',
                    sessionID: 'mixed-usage-session',
                    messageID: 'mixed-assistant',
                    type: 'step-finish',
                    cost: 0.01,
                    tokens: {
                      input: 4,
                      output: 2,
                      reasoning: 1,
                      cache: { read: 1, write: 0 },
                    },
                  },
                },
              };
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'mixed-usage-session',
                  part: {
                    id: 'malformed-step',
                    sessionID: 'mixed-usage-session',
                    messageID: 'mixed-assistant',
                    type: 'step-finish',
                    cost: 0.02,
                    tokens: {
                      input: 3,
                      output: 1.5,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                  },
                },
              };
              yield {
                type: 'session.idle',
                properties: { sessionID: 'mixed-usage-session' },
              };
            },
          }),
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const usage = (
      events.find((event) => event.type === 'done')!.payload as DonePayload
    ).usage;
    expect(usage.tokens).toEqual({
      coverage: 'partial',
      totals: {
        input: { total: 5, uncached: 4, cacheRead: 1, cacheWrite: 0 },
        output: { total: 3, visible: 2, reasoning: 1 },
      },
      records: [
        {
          model: 'test-model',
          provider: 'test-provider',
          requests: 1,
          tokens: {
            input: {
              total: 5,
              uncached: 4,
              cacheRead: 1,
              cacheWrite: 0,
            },
            output: { total: 3, visible: 2, reasoning: 1 },
          },
          cost: {
            amount: 0.01,
            currency: 'USD',
            source: 'agent-estimate',
          },
        },
      ],
    });
    expect(usage).not.toHaveProperty('cost');
  });

  it('excludes an uncorrelated owned-session step from a partial report', async () => {
    let promptMessageId = '';
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'mixed-causality-session' },
          onRun(options) {
            promptMessageId = String(options.promptMessageId);
          },
          eventStreamFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield makeV2MessageUpdated(
                'mixed-causality-session',
                'causal-assistant',
                'assistant',
                promptMessageId,
              );
              yield {
                type: 'message.updated',
                properties: {
                  sessionID: 'mixed-causality-session',
                  info: {
                    id: 'uncorrelated-assistant',
                    sessionID: 'mixed-causality-session',
                    role: 'assistant',
                    modelID: 'background-model',
                    providerID: 'background-provider',
                  },
                },
              };
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'mixed-causality-session',
                  part: {
                    id: 'causal-step',
                    sessionID: 'mixed-causality-session',
                    messageID: 'causal-assistant',
                    type: 'step-finish',
                    cost: 0.01,
                    tokens: {
                      input: 4,
                      output: 2,
                      reasoning: 0,
                      cache: { read: 1, write: 0 },
                    },
                  },
                },
              };
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'mixed-causality-session',
                  part: {
                    id: 'uncorrelated-step',
                    sessionID: 'mixed-causality-session',
                    messageID: 'uncorrelated-assistant',
                    type: 'step-finish',
                    cost: 99,
                    tokens: {
                      input: 1_000,
                      output: 1_000,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                  },
                },
              };
              yield {
                type: 'session.idle',
                properties: { sessionID: 'mixed-causality-session' },
              };
            },
          }),
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const usage = (
      events.find((event) => event.type === 'done')!.payload as DonePayload
    ).usage;
    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.totals).toEqual({
      input: { total: 5, uncached: 4, cacheRead: 1, cacheWrite: 0 },
      output: { total: 2, visible: 2, reasoning: 0 },
    });
    expect(usage.tokens?.records).toHaveLength(1);
    expect(usage.tokens?.records?.[0]?.model).toBe('test-model');
    expect(usage).not.toHaveProperty('cost');
  });

  it('reports exact completed steps as partial when the stream ends without idle', async () => {
    let promptMessageId = '';
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'incomplete-usage-session' },
          onRun(options) {
            promptMessageId = String(options.promptMessageId);
          },
          eventStreamFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield makeV2MessageUpdated(
                'incomplete-usage-session',
                'incomplete-assistant',
                'assistant',
                promptMessageId,
              );
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'incomplete-usage-session',
                  part: {
                    id: 'completed-before-error',
                    sessionID: 'incomplete-usage-session',
                    messageID: 'incomplete-assistant',
                    type: 'step-finish',
                    cost: 0.01,
                    tokens: {
                      input: 2,
                      output: 1,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                  },
                },
              };
            },
          }),
        }),
      },
    );

    const events = await collect(adapter.run('test'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).status).toBe('error');
    expect((done.payload as DonePayload).usage.tokens).toMatchObject({
      coverage: 'partial',
      totals: {
        input: { total: 2 },
        output: { total: 1 },
      },
    });
    expect((done.payload as DonePayload).usage).not.toHaveProperty('cost');
  });

  it('reports exact completed steps as partial when the caller aborts', async () => {
    let promptMessageId = '';
    const controller = new AbortController();
    const adapter = new OpenCodeAdapter(
      { mode: 'external', serverUrl: 'http://opencode.local:7777' },
      {
        loadSdk: makeLoader({
          runResult: { sessionId: 'aborted-usage-session' },
          onRun(options) {
            promptMessageId = String(options.promptMessageId);
          },
          eventStreamFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield makeV2MessageUpdated(
                'aborted-usage-session',
                'aborted-assistant',
                'assistant',
                promptMessageId,
              );
              yield {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'aborted-usage-session',
                  part: {
                    id: 'completed-before-abort',
                    sessionID: 'aborted-usage-session',
                    messageID: 'aborted-assistant',
                    type: 'step-finish',
                    cost: 0.01,
                    tokens: {
                      input: 2,
                      output: 1,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                  },
                },
              };
              controller.abort();
            },
          }),
        }),
      },
    );

    const events = await collect(
      adapter.run('test', { abortSignal: controller.signal }),
    );
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).status).toBe('interrupted');
    expect((done.payload as DonePayload).usage.tokens).toMatchObject({
      coverage: 'partial',
      totals: {
        input: { total: 2 },
        output: { total: 1 },
      },
    });
    expect((done.payload as DonePayload).usage).not.toHaveProperty('cost');
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
  ])(
    'ignores generic idle aliases for $label',
    async ({ stepTokens, terminalUsage }) => {
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
      expect((done.payload as DonePayload).usage).toEqual({ toolUses: 0 });
    },
  );

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
    expect((done.payload as DonePayload).usage).toEqual({ toolUses: 1 });
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

  it('ignores generic idle token aliases', async () => {
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
    expect(usage).toEqual({ toolUses: 0 });
  });

  it('does not infer validity from generic idle token aliases', async () => {
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
    expect((done.payload as DonePayload).usage).toEqual({ toolUses: 0 });
  });

  it('ignores generic idle tool-use aliases', async () => {
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
    expect((done.payload as DonePayload).usage).toEqual({ toolUses: 0 });
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
      usage: { toolUses: number };
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

    const toolUses = events.filter((e) => e.type === 'tool_use') as Array<
      AgentEvent & ToolUseLike
    >;
    expect(toolUses.map((e) => e.payload.toolUseId)).toEqual([
      'call-x',
      'call-y',
    ]);
    expect(toolUses[1]!.payload.toolName).toBe('webfetch');

    const toolResults = events.filter((e) => e.type === 'tool_result') as Array<
      AgentEvent & ToolResultLike
    >;
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

    const toolUses = events.filter((e) => e.type === 'tool_use') as Array<
      AgentEvent & ToolUseLike
    >;
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]!.payload.toolUseId).toBe('legacy-1');
    expect(toolUses[0]!.payload.input).toEqual({ command: 'ls' });

    const done = events.find((e) => e.type === 'done') as AgentEvent & DoneLike;
    expect(done.payload.usage.toolUses).toBe(1);
  });
});
