// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type {
  Agent,
  InitializeRequest,
  NewSessionRequest,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  KimiAdapter,
  mapAgentOptionsToKimiOptions,
  mapPermissionsToKimiOptions,
} from '../adapters/kimi.js';
import type { AgentEvent, AgentOptions, KimiEffort } from '../types.js';

interface FakeScenario {
  sessionId?: string;
  failAuth?: boolean;
  sessionError?: Error;
  exitCode?: number;
  ignoreInputEnd?: boolean;
  ignoreSigterm?: boolean;
  inputEndDelayMs?: number;
  stopReason?: PromptResponse['stopReason'];
  initialize?: () => Promise<void>;
  setConfig?: (request: SetSessionConfigOptionRequest) => Promise<void>;
  prompt?: (
    connection: AgentSideConnection,
    request: PromptRequest,
    fake: FakeKimi,
  ) => Promise<PromptResponse>;
}

interface CapturedSpawn {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: NodeJS.Signals[] = [];
  private closed = false;
  private readonly ignoreSigterm: boolean;

  constructor(
    exitCode = 0,
    ignoreInputEnd = false,
    ignoreSigterm = false,
    inputEndDelayMs = 0,
  ) {
    super();
    this.ignoreSigterm = ignoreSigterm;
    this.stdin.once('finish', () => {
      if (ignoreInputEnd) return;
      if (inputEndDelayMs > 0) {
        setTimeout(() => this.close(exitCode, null), inputEndDelayMs);
      } else {
        this.close(exitCode, null);
      }
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    if (signal === 'SIGTERM' && this.ignoreSigterm) return true;
    this.close(null, signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', code, signal));
  }
}

class FakeKimi {
  readonly calls: string[] = [];
  readonly newRequests: NewSessionRequest[] = [];
  readonly resumeRequests: ResumeSessionRequest[] = [];
  readonly configRequests: SetSessionConfigOptionRequest[] = [];
  readonly promptRequests: PromptRequest[] = [];
  readonly children: FakeChild[] = [];
  readonly spawns: CapturedSpawn[] = [];
  permissionOutcome: unknown;
  initializeRequest?: InitializeRequest;
  connection?: AgentSideConnection;
  private currentModel = 'kimi-default';
  private readonly scenario: FakeScenario;

  constructor(scenario: FakeScenario = {}) {
    this.scenario = scenario;
  }

  readonly spawn = (
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ): ReturnType<typeof import('node:child_process').spawn> => {
    this.spawns.push({ command, args, options });
    const child = new FakeChild(
      this.scenario.exitCode,
      this.scenario.ignoreInputEnd,
      this.scenario.ignoreSigterm,
      this.scenario.inputEndDelayMs,
    );
    this.children.push(child);

    const output = new WritableStream<Uint8Array>({
      write: (chunk) => {
        const midpoint = Math.max(1, Math.floor(chunk.byteLength / 2));
        child.stdout.write(chunk.subarray(0, midpoint));
        child.stdout.write(chunk.subarray(midpoint));
      },
      close: () => child.stdout.end(),
    });
    const input = Readable.toWeb(
      child.stdin,
    ) as unknown as ReadableStream<Uint8Array>;

    this.connection = new AgentSideConnection(
      (connection) => this.agent(connection),
      ndJsonStream(output, input),
    );
    return child as unknown as ReturnType<
      typeof import('node:child_process').spawn
    >;
  };

  private configOptions() {
    return [
      {
        type: 'select' as const,
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: this.currentModel,
        options: [
          { value: 'kimi-default', name: 'Default' },
          { value: 'kimi-k3', name: 'K3' },
        ],
      },
      {
        type: 'select' as const,
        id: 'thinking',
        name: 'Thinking',
        category: 'thought_level',
        currentValue: 'off',
        options: [
          { value: 'off', name: 'Off' },
          { value: 'on', name: 'On' },
        ],
      },
      {
        type: 'select' as const,
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'auto', name: 'Auto' },
        ],
      },
    ];
  }

  private agent(connection: AgentSideConnection): Agent {
    return {
      initialize: async (request) => {
        this.calls.push('initialize');
        this.initializeRequest = request;
        await this.scenario.initialize?.();
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {} },
          },
        };
      },
      newSession: async (request) => {
        this.calls.push('session/new');
        this.newRequests.push(request);
        if (this.scenario.failAuth) throw RequestError.authRequired();
        if (this.scenario.sessionError) throw this.scenario.sessionError;
        return {
          sessionId: this.scenario.sessionId ?? 'kimi-session',
          configOptions: this.configOptions(),
        };
      },
      resumeSession: async (request) => {
        this.calls.push('session/resume');
        this.resumeRequests.push(request);
        if (this.scenario.failAuth) throw RequestError.authRequired();
        if (this.scenario.sessionError) throw this.scenario.sessionError;
        return { configOptions: this.configOptions() };
      },
      setSessionConfigOption: async (request) => {
        this.calls.push(`config:${request.configId}`);
        this.configRequests.push(request);
        await this.scenario.setConfig?.(request);
        if (request.configId === 'model')
          this.currentModel = String(request.value);
        return { configOptions: this.configOptions() };
      },
      prompt: async (request) => {
        this.calls.push('session/prompt');
        this.promptRequests.push(request);
        if (this.scenario.prompt) {
          return this.scenario.prompt(connection, request, this);
        }
        return { stopReason: this.scenario.stopReason ?? 'end_turn' };
      },
      cancel: async () => {
        this.calls.push('session/cancel');
      },
    } as Agent;
  }
}

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function eventOf<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }> {
  const event = events.find((candidate) => candidate.type === type);
  if (!event) throw new Error(`Missing ${type} event`);
  return event as Extract<AgentEvent, { type: T }>;
}

describe('KimiAdapter', () => {
  it('probes availability through its injected version check', async () => {
    const available = vi.fn(async () => true);
    const missing = vi.fn(async () => false);
    expect(new KimiAdapter({ probeAvailability: available }).agent).toBe(
      'kimi',
    );
    await expect(
      new KimiAdapter({ probeAvailability: available }).isAvailable(),
    ).resolves.toBe(true);
    await expect(
      new KimiAdapter({ probeAvailability: missing }).isAvailable(),
    ).resolves.toBe(false);
    expect(available).toHaveBeenCalledOnce();
    expect(missing).toHaveBeenCalledOnce();
  });

  it('maps the supported permission and native effort surface', () => {
    expect(mapPermissionsToKimiOptions(undefined)).toEqual({});
    expect(
      mapPermissionsToKimiOptions({
        mode: 'auto',
        fileWrite: 'deny',
        writablePaths: ['./.git/', 'generated/cache'],
      }),
    ).toEqual({
      mode: 'auto',
      writablePaths: {
        paths: ['.git', 'generated/cache'],
        enforcement: 'ambient',
      },
    });
    expect(
      mapAgentOptionsToKimiOptions({ cwd: '.', effort: 'on' }),
    ).toMatchObject({ effort: 'on', permissions: {} });
  });

  it.each([
    [{ permissions: {} }, 'requires permissions.mode "auto"'],
    [
      { permissions: { mode: 'bypass' } },
      'yolo mode is not an unchecked bypass',
    ],
    [{ allowedTools: [] }, 'allowedTools is unsupported'],
    [{ disallowedTools: [] }, 'disallowedTools is unsupported'],
    [{ maxTurns: 1 }, 'maxTurns is unsupported'],
    [{ maxBudgetUsd: 1 }, 'maxBudgetUsd is unsupported'],
    [{ effort: 'high' }, 'must be one of: off, on'],
    [
      { permissions: { mode: 'auto', writablePaths: ['../outside'] } },
      "permissions.writablePaths[0] must not contain '..'",
    ],
  ] as Array<[AgentOptions<KimiEffort>, string]>)(
    'rejects unsupported options before spawning: %j',
    async (options, message) => {
      const fake = new FakeKimi();
      const adapter = new KimiAdapter({ spawnProcess: fake.spawn });
      await expect(collect(adapter.run('test', options))).rejects.toThrow(
        message,
      );
      expect(fake.spawns).toHaveLength(0);
    },
  );

  it('normalizes a fresh ACP run without exposing raw thought', async () => {
    const fake = new FakeKimi({
      sessionId: 'fresh-kimi-session',
      prompt: async (connection, request, state) => {
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'private reasoning' },
          },
        });
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello ' },
          },
        });
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Read',
            kind: 'read',
            status: 'pending',
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: '{"path":"display-only.txt"}',
                },
              },
            ],
          },
        });
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            title: 'Read',
            status: 'in_progress',
            rawInput: { path: 'README.md' },
          },
        });
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
            rawOutput: { text: 'contents' },
          },
        });
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'plan',
            entries: [
              {
                content: 'Inspect project',
                priority: 'high',
                status: 'completed',
              },
            ],
          },
        });
        const permission = await connection.requestPermission({
          sessionId: request.sessionId,
          toolCall: {
            toolCallId: 'tool-2',
            title: 'Write',
            kind: 'edit',
            rawInput: { path: 'out.txt' },
          },
          options: [
            { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
            { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
          ],
        });
        state.permissionOutcome = permission;
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'world' },
          },
        });
        return {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            totalTokens: 17,
            cachedReadTokens: 2,
            cachedWriteTokens: 1,
          },
        };
      },
    });
    const adapter = new KimiAdapter({ spawnProcess: fake.spawn });

    const events = await collect(
      adapter.run('Do the work', {
        cwd: '.',
        model: 'kimi-k3',
        effort: 'on',
        permissions: { mode: 'auto', writablePaths: ['./.git/'] },
      }),
    );

    expect(fake.spawns[0]).toMatchObject({ command: 'kimi', args: ['acp'] });
    expect(fake.spawns[0]?.options).toMatchObject({
      shell: false,
      stdio: 'pipe',
    });
    expect(fake.initializeRequest).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(fake.newRequests[0]?.mcpServers).toEqual([]);
    expect(fake.calls).toEqual([
      'initialize',
      'session/new',
      'config:model',
      'config:thinking',
      'config:mode',
      'session/prompt',
    ]);
    expect(
      fake.configRequests.map(({ configId, value }) => [configId, value]),
    ).toEqual([
      ['model', 'kimi-k3'],
      ['thinking', 'on'],
      ['mode', 'auto'],
    ]);

    expect(events[0]).toMatchObject({
      type: 'init',
      agent: 'kimi',
      sessionId: 'fresh-kimi-session',
      payload: {
        model: 'kimi-k3',
        tools: [],
        capabilities: {
          toolsKnown: false,
          toolsSource: 'unavailable',
          acpProtocolVersion: 1,
          writablePaths: { paths: ['.git'], enforcement: 'ambient' },
        },
      },
    });
    expect(events.some((event) => event.type === 'thinking')).toBe(false);
    expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(1);
    expect(eventOf(events, 'tool_use').payload).toMatchObject({
      toolName: 'Read',
      toolUseId: 'tool-1',
      input: { path: 'README.md' },
    });
    expect(eventOf(events, 'tool_result').payload).toMatchObject({
      toolName: 'Read',
      toolUseId: 'tool-1',
      status: 'success',
      output: { text: 'contents' },
    });
    expect(eventOf(events, 'permission_request').payload).toMatchObject({
      toolName: 'Write',
      toolUseId: 'tool-2',
      input: { path: 'out.txt' },
    });
    expect(fake.permissionOutcome).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    expect(events.some((event) => event.type === 'kimi:plan')).toBe(true);
    expect(eventOf(events, 'done').payload).toMatchObject({
      status: 'success',
      result: 'Hello world',
      resumeToken: 'fresh-kimi-session',
      usage: { inputTokens: 13, outputTokens: 4, toolUses: 1 },
    });
    expect(fake.children[0]).toMatchObject({
      exitCode: 0,
      killed: false,
    });
  });

  it('resumes without loading or replaying history', async () => {
    const fake = new FakeKimi();
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Continue', {
        cwd: '.',
        resume: 'existing-session',
      }),
    );

    expect(fake.newRequests).toHaveLength(0);
    expect(fake.resumeRequests).toEqual([
      expect.objectContaining({
        sessionId: 'existing-session',
        mcpServers: [],
      }),
    ]);
    expect(fake.calls).not.toContain('session/load');
    expect(
      events.every((event) => event.sessionId === 'existing-session'),
    ).toBe(true);
    expect(eventOf(events, 'done').payload.resumeToken).toBe(
      'existing-session',
    );
  });

  it('selects Kimi plan review Reject and Exit over Revise', async () => {
    const fake = new FakeKimi({
      prompt: async (connection, request, state) => {
        state.permissionOutcome = await connection.requestPermission({
          sessionId: request.sessionId,
          toolCall: {
            toolCallId: 'plan-review',
            title: 'Review plan',
            kind: 'think',
          },
          options: [
            {
              kind: 'reject_once',
              name: 'Revise',
              optionId: 'plan_revise',
            },
            {
              kind: 'reject_once',
              name: 'Reject and Exit',
              optionId: 'plan_reject_and_exit',
            },
          ],
        });
        return { stopReason: 'end_turn' };
      },
    });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Review the plan'),
    );

    expect(fake.permissionOutcome).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'plan_reject_and_exit',
      },
    });
    expect(eventOf(events, 'done').payload.status).toBe('success');
  });

  it('rejects a permission request for a non-active session', async () => {
    const privateInput = 'must-not-reach-console';
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const fake = new FakeKimi({
      sessionId: 'active-session',
      prompt: async (connection) => {
        await connection.requestPermission({
          sessionId: 'other-session',
          toolCall: {
            toolCallId: 'cross-session',
            title: 'Write',
            kind: 'edit',
            rawInput: { privateInput },
          },
          options: [
            { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
          ],
        });
        return { stopReason: 'end_turn' };
      },
    });
    let events: AgentEvent[] = [];
    let logged = '';
    try {
      events = await collect(
        new KimiAdapter({ spawnProcess: fake.spawn }).run('Hello'),
      );
      logged = consoleError.mock.calls
        .flat()
        .map((value) => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })
        .join('\n');
    } finally {
      consoleError.mockRestore();
    }

    expect(events.some((event) => event.type === 'permission_request')).toBe(
      false,
    );
    expect(events.every((event) => event.sessionId === 'active-session')).toBe(
      true,
    );
    expect(eventOf(events, 'error').payload.message).toContain(
      'non-active prompt session',
    );
    expect(eventOf(events, 'done').payload.status).toBe('error');
    expect(logged).not.toContain(privateInput);
  });

  it('does not log a cross-session thought notification', async () => {
    const privateThought = 'private-thought-must-not-be-logged';
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const fake = new FakeKimi({
      sessionId: 'active-session',
      prompt: async (connection) => {
        await connection.sessionUpdate({
          sessionId: 'other-session',
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: privateThought },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });
    let events: AgentEvent[] = [];
    let logged = '';
    try {
      events = await collect(
        new KimiAdapter({ spawnProcess: fake.spawn }).run('Hello'),
      );
      logged = consoleError.mock.calls
        .flat()
        .map((value) => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })
        .join('\n');
    } finally {
      consoleError.mockRestore();
    }

    expect(events.some((event) => event.type === 'thinking')).toBe(false);
    expect(eventOf(events, 'error').payload.message).toContain(
      'session/update referenced a non-active session',
    );
    expect(eventOf(events, 'done').payload.status).toBe('error');
    expect(logged).not.toContain(privateThought);
  });

  it('cancels an active prompt and preserves continuity', async () => {
    let releasePrompt: ((response: PromptResponse) => void) | undefined;
    const fake = new FakeKimi({
      sessionId: 'abortable-session',
      prompt: async () =>
        new Promise<PromptResponse>((resolvePrompt) => {
          releasePrompt = resolvePrompt;
        }),
    });
    const originalSpawn = fake.spawn;
    const spawn = (...args: Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      const waitForCancel = setInterval(() => {
        if (fake.calls.includes('session/cancel')) {
          clearInterval(waitForCancel);
          releasePrompt?.({ stopReason: 'cancelled' });
        }
      }, 1);
      return child;
    };
    const controller = new AbortController();
    const run = collect(
      new KimiAdapter({ spawnProcess: spawn }).run('Wait', {
        abortSignal: controller.signal,
      }),
    );
    while (!fake.calls.includes('session/prompt')) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
    controller.abort();
    const events = await run;

    expect(fake.calls).toContain('session/cancel');
    expect(eventOf(events, 'done').payload).toMatchObject({
      status: 'interrupted',
      resumeToken: 'abortable-session',
    });
  });

  it('does not prompt after an abort during session configuration', async () => {
    let releaseConfig: (() => void) | undefined;
    const fake = new FakeKimi({
      setConfig: async (request) => {
        if (request.configId !== 'model') return;
        await new Promise<void>((resolveConfig) => {
          releaseConfig = resolveConfig;
        });
      },
    });
    const controller = new AbortController();
    const run = collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Do not send', {
        model: 'kimi-k3',
        effort: 'on',
        permissions: { mode: 'auto' },
        abortSignal: controller.signal,
      }),
    );
    while (!releaseConfig) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
    controller.abort();
    releaseConfig();
    const events = await run;

    expect(fake.calls.filter((call) => call === 'session/cancel')).toHaveLength(
      1,
    );
    expect(fake.calls).not.toContain('config:thinking');
    expect(fake.calls).not.toContain('config:mode');
    expect(fake.calls).not.toContain('session/prompt');
    expect(events.some((event) => event.type === 'init')).toBe(false);
    expect(eventOf(events, 'done').payload.status).toBe('interrupted');
  });

  it('does not spawn when already aborted', async () => {
    const fake = new FakeKimi();
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('No work', {
        resume: 'inbound-session',
        abortSignal: controller.signal,
      }),
    );
    expect(fake.spawns).toHaveLength(0);
    expect(eventOf(events, 'done').payload).toMatchObject({
      status: 'interrupted',
      resumeToken: 'inbound-session',
    });
  });

  it('terminates a child when aborted during ACP initialization', async () => {
    let initializeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      initializeStarted = resolveStarted;
    });
    const fake = new FakeKimi({
      initialize: async () => {
        initializeStarted?.();
        await new Promise(() => {});
      },
    });
    const controller = new AbortController();
    const run = collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('No prompt', {
        abortSignal: controller.signal,
      }),
    );
    await started;
    controller.abort();
    const events = await run;

    expect(fake.newRequests).toHaveLength(0);
    expect(fake.children[0]?.killSignals).toEqual(['SIGTERM']);
    expect(eventOf(events, 'done').payload.status).toBe('interrupted');
  });

  it.each([
    ['invalid JSON', '{"jsonrpc":\n'],
    ['a response without result or error', '{"jsonrpc":"2.0","id":0}\n'],
  ])('rejects malformed ACP traffic containing %s', async (_case, response) => {
    const child = new FakeChild();
    child.stdin.once('data', () => child.stdout.write(response));
    const events = await collect(
      new KimiAdapter({
        spawnProcess: () =>
          child as unknown as ReturnType<
            typeof import('node:child_process').spawn
          >,
      }).run('Hello'),
    );

    expect(eventOf(events, 'error').payload).toMatchObject({
      code: 'KIMI_ACP_ERROR',
      message: expect.stringContaining('Malformed Kimi ACP traffic'),
      recoverable: false,
    });
    expect(events.some((event) => event.type === 'init')).toBe(false);
    expect(eventOf(events, 'done').payload.status).toBe('error');
    expect(child.killSignals).toEqual(['SIGTERM']);
  });

  it('validates ACP response results before consuming them', async () => {
    const child = new FakeChild();
    child.stdin.once('data', () => {
      child.stdout.write(
        '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"1"}}\n',
      );
    });
    const events = await collect(
      new KimiAdapter({
        spawnProcess: () =>
          child as unknown as ReturnType<
            typeof import('node:child_process').spawn
          >,
      }).run('Hello'),
    );

    expect(eventOf(events, 'error').payload.message).toContain(
      'invalid initialize response result',
    );
    expect(eventOf(events, 'done').payload.status).toBe('error');
  });

  it('rejects invalid UTF-8 in ACP traffic', async () => {
    const child = new FakeChild();
    child.stdin.once('data', () => {
      child.stdout.write(
        Buffer.concat([
          Buffer.from(
            '{"jsonrpc":"2.0","id":0,"error":{"code":-32603,"message":"',
          ),
          Buffer.from([0xff]),
          Buffer.from('"}}\n'),
        ]),
      );
    });
    const events = await collect(
      new KimiAdapter({
        spawnProcess: () =>
          child as unknown as ReturnType<
            typeof import('node:child_process').spawn
          >,
      }).run('Hello'),
    );

    expect(eventOf(events, 'error').payload.message).toContain('invalid UTF-8');
    expect(eventOf(events, 'done').payload.status).toBe('error');
  });

  it('rejects malformed session update parameters', async () => {
    const fake = new FakeKimi({
      prompt: async (_connection, _request, state) => {
        state.children[0]?.stdout.write(
          '{"jsonrpc":"2.0","method":"session/update","params":{}}\n',
        );
        return new Promise<PromptResponse>(() => {});
      },
    });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Hello'),
    );

    expect(eventOf(events, 'error').payload.message).toContain(
      'invalid session/update parameters',
    );
    expect(eventOf(events, 'done').payload.status).toBe('error');
  });

  it('turns a premature child exit during a request into an error', async () => {
    const child = new FakeChild();
    child.stdin.once('data', () => child.close(0, null));
    const events = await collect(
      new KimiAdapter({
        spawnProcess: () =>
          child as unknown as ReturnType<
            typeof import('node:child_process').spawn
          >,
      }).run('Hello'),
    );

    expect(events.some((event) => event.type === 'init')).toBe(false);
    expect(eventOf(events, 'error').payload.code).toBe('KIMI_ACP_ERROR');
    expect(eventOf(events, 'done').payload.status).toBe('error');
  });

  it('rejects an empty ACP session id', async () => {
    const fake = new FakeKimi({ sessionId: '   ' });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Hello'),
    );

    expect(eventOf(events, 'error').payload.message).toContain(
      'session/new returned an empty session id',
    );
    expect(eventOf(events, 'done').payload.status).toBe('error');
  });

  it('surfaces authentication failures with external login guidance', async () => {
    const fake = new FakeKimi({ failAuth: true });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Hello'),
    );
    expect(eventOf(events, 'error').payload).toMatchObject({
      code: 'KIMI_AUTH_REQUIRED',
      recoverable: false,
    });
    expect(eventOf(events, 'error').payload.message).toContain('kimi login');
    expect(eventOf(events, 'done').payload.status).toBe('error');
    expect(fake.calls).not.toContain('authenticate');
  });

  it('preserves an inbound resume token when resume setup fails', async () => {
    const fake = new FakeKimi({ failAuth: true });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Continue', {
        resume: 'still-resumable',
      }),
    );

    expect(fake.resumeRequests).toHaveLength(1);
    expect(eventOf(events, 'done').payload).toMatchObject({
      status: 'error',
      resumeToken: 'still-resumable',
    });
  });

  it('recognizes provider API-key authentication failures', async () => {
    const fake = new FakeKimi({
      sessionError: new Error('Unauthorized: invalid API key'),
    });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Hello'),
    );

    expect(eventOf(events, 'error').payload).toMatchObject({
      code: 'KIMI_AUTH_REQUIRED',
      message: expect.stringContaining('kimi login'),
    });
    expect(eventOf(events, 'done').payload.status).toBe('error');
  });

  it('turns a nonzero post-prompt child exit into an error', async () => {
    const fake = new FakeKimi({ exitCode: 7 });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Hello'),
    );

    expect(eventOf(events, 'error').payload).toMatchObject({
      code: 'KIMI_ACP_ERROR',
      message: expect.stringContaining('exited with code 7'),
    });
    expect(eventOf(events, 'done').payload.status).toBe('error');
  });

  it('keeps a successful turn successful after its cleanup SIGTERM', async () => {
    const fake = new FakeKimi({ ignoreInputEnd: true });
    const events = await collect(
      new KimiAdapter({
        spawnProcess: fake.spawn,
        processStdinExitGraceMs: 20,
        processSignalExitGraceMs: 20,
      }).run('Hello'),
    );

    expect(fake.children[0]?.killSignals).toEqual(['SIGTERM']);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(eventOf(events, 'done').payload.status).toBe('success');
  });

  it('lets exact-target background cleanup outlive the old grace', async () => {
    const fake = new FakeKimi({ inputEndDelayMs: 1_500 });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Hello'),
    );

    expect(fake.children[0]?.killSignals).toEqual([]);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(eventOf(events, 'done').payload.status).toBe('success');
  });

  it('escalates teardown to SIGKILL for a wedged child', async () => {
    const fake = new FakeKimi({
      ignoreInputEnd: true,
      ignoreSigterm: true,
    });
    const events = await collect(
      new KimiAdapter({
        spawnProcess: fake.spawn,
        processStdinExitGraceMs: 20,
        processSignalExitGraceMs: 20,
      }).run('Hello'),
    );

    expect(fake.children[0]?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(eventOf(events, 'error').payload.message).toContain('SIGKILL');
    expect(eventOf(events, 'done').payload.status).toBe('error');
  });

  it('normalizes a synchronous process spawn failure', async () => {
    const adapter = new KimiAdapter({
      spawnProcess: () => {
        throw new Error('spawn kimi ENOENT');
      },
    });
    const events = await collect(adapter.run('Hello'));

    expect(eventOf(events, 'error').payload).toMatchObject({
      code: 'KIMI_ACP_ERROR',
      message: expect.stringContaining('ENOENT'),
    });
    expect(eventOf(events, 'done').payload).toMatchObject({ status: 'error' });
    expect(eventOf(events, 'done').payload).not.toHaveProperty('resumeToken');
  });

  it('generates a local correlation id for an empty resume token', async () => {
    const adapter = new KimiAdapter({
      spawnProcess: () => {
        throw new Error('spawn kimi ENOENT');
      },
    });
    const events = await collect(adapter.run('Hello', { resume: '' }));

    expect(events.every((event) => event.sessionId.length > 0)).toBe(true);
    expect(eventOf(events, 'done').payload).not.toHaveProperty('resumeToken');
  });

  it('isolates concurrent runs on one adapter instance', async () => {
    const makeFake = (sessionId: string, delayMs: number) =>
      new FakeKimi({
        sessionId,
        prompt: async (connection, request) => {
          await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
          const content = request.prompt[0];
          await connection.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content:
                content?.type === 'text'
                  ? content
                  : { type: 'text', text: 'unexpected prompt' },
            },
          });
          return { stopReason: 'end_turn' };
        },
      });
    const fakes = [makeFake('concurrent-a', 4), makeFake('concurrent-b', 1)];
    let spawnIndex = 0;
    const adapter = new KimiAdapter({
      spawnProcess: (...args) => fakes[spawnIndex++]!.spawn(...args),
    });

    const [first, second] = await Promise.all([
      collect(adapter.run('first prompt')),
      collect(adapter.run('second prompt')),
    ]);

    expect(eventOf(first, 'done').payload.result).toBe('first prompt');
    expect(eventOf(second, 'done').payload.result).toBe('second prompt');
    expect(new Set(first.map((event) => event.sessionId))).toEqual(
      new Set(['concurrent-a']),
    );
    expect(new Set(second.map((event) => event.sessionId))).toEqual(
      new Set(['concurrent-b']),
    );
  });

  it.each([
    ['max_tokens', 'max_turns'],
    ['max_turn_requests', 'max_turns'],
    ['cancelled', 'interrupted'],
    ['refusal', 'error'],
  ] as const)('maps stop reason %s to %s', async (stopReason, status) => {
    const fake = new FakeKimi({ stopReason });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Hello'),
    );
    expect(eventOf(events, 'done').payload.status).toBe(status);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    if (stopReason === 'refusal') {
      expect(eventOf(events, 'error').payload.code).toBe('KIMI_REFUSAL');
    }
  });
});
