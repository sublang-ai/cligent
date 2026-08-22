// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { isAbsolute, resolve } from 'node:path';
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
  exitSignal?: NodeJS.Signals;
  ignoreInputEnd?: boolean;
  ignoreSigterm?: boolean;
  ignoreSigkill?: boolean;
  inputEndDelayMs?: number;
  lifecycle?: string[];
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
  private readonly ignoreSigkill: boolean;
  private readonly lifecycle: string[] | undefined;

  constructor(scenario: FakeScenario = {}) {
    super();
    this.ignoreSigterm = scenario.ignoreSigterm ?? false;
    this.ignoreSigkill = scenario.ignoreSigkill ?? false;
    this.lifecycle = scenario.lifecycle;
    this.stdin.once('finish', () => {
      this.lifecycle?.push('stdin:end');
      if (scenario.ignoreInputEnd) return;
      const close = () =>
        this.close(
          scenario.exitSignal ? null : (scenario.exitCode ?? 0),
          scenario.exitSignal ?? null,
        );
      if ((scenario.inputEndDelayMs ?? 0) > 0) {
        setTimeout(close, scenario.inputEndDelayMs);
      } else {
        close();
      }
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    this.lifecycle?.push(`kill:${signal}`);
    if (signal === 'SIGTERM' && this.ignoreSigterm) return true;
    if (signal === 'SIGKILL' && this.ignoreSigkill) return true;
    this.close(null, signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle?.push('close');
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
    const child = new FakeChild(this.scenario);
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
  onEvent?: (event: AgentEvent) => void,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    onEvent?.(event);
    events.push(event);
  }
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

    // kimi-3 / kimi-4: the child and the session both take the resolved
    // absolute cwd, so `cwd: '.'` never leaves the run rooted on a relative
    // path or on the parent process's directory by accident.
    const expectedCwd = resolve('.');
    expect(fake.spawns[0]).toMatchObject({ command: 'kimi', args: ['acp'] });
    expect(fake.spawns[0]?.options).toMatchObject({
      cwd: expectedCwd,
      shell: false,
      stdio: 'pipe',
    });
    expect(isAbsolute(expectedCwd)).toBe(true);
    expect(fake.newRequests[0]?.cwd).toBe(expectedCwd);
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
      usage: {
        toolUses: 1,
      },
    });
    expect(fake.children[0]).toMatchObject({
      exitCode: 0,
      killed: false,
    });
  });

  it('queues configuration updates until after init in arrival order', async () => {
    let fake: FakeKimi;
    fake = new FakeKimi({
      sessionId: 'pre-init-session',
      setConfig: async (request) => {
        const connection = fake.connection;
        if (!connection) throw new Error('Missing fake ACP connection');

        if (request.configId === 'model') {
          await connection.sessionUpdate({
            sessionId: 'pre-init-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'configured ' },
            },
          });
        } else if (request.configId === 'thinking') {
          await connection.sessionUpdate({
            sessionId: 'pre-init-session',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'pre-init-tool',
              title: 'Read',
              kind: 'read',
              status: 'completed',
              rawInput: { path: 'README.md' },
              rawOutput: { text: 'contents' },
            },
          });
        } else if (request.configId === 'mode') {
          await connection.sessionUpdate({
            sessionId: 'pre-init-session',
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
        }
      },
      prompt: async (connection, request) => {
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'prompt' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });

    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Keep order', {
        model: 'kimi-k3',
        effort: 'on',
        permissions: { mode: 'auto' },
      }),
    );

    // kimi-16 / kimi-30 / kimi-230: all configuration-time updates retain
    // their normalization order, but init remains the first unified event.
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text_delta',
      'tool_use',
      'tool_result',
      'kimi:plan',
      'text_delta',
      'done',
    ]);
    expect(events[1]).toMatchObject({
      type: 'text_delta',
      payload: { delta: 'configured ' },
    });
    expect(events[2]).toMatchObject({
      type: 'tool_use',
      payload: {
        toolName: 'Read',
        toolUseId: 'pre-init-tool',
        input: { path: 'README.md' },
      },
    });
    expect(events[3]).toMatchObject({
      type: 'tool_result',
      payload: {
        toolName: 'Read',
        toolUseId: 'pre-init-tool',
        status: 'success',
        output: { text: 'contents' },
      },
    });
    expect(events[4]).toMatchObject({
      type: 'kimi:plan',
      payload: {
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
    expect(events[5]).toMatchObject({
      type: 'text_delta',
      payload: { delta: 'prompt' },
    });
    expect(fake.calls).toEqual([
      'initialize',
      'session/new',
      'config:model',
      'config:thinking',
      'config:mode',
      'session/prompt',
    ]);
    expect(eventOf(events, 'done').payload).toMatchObject({
      status: 'success',
      result: 'configured prompt',
      usage: { toolUses: 1 },
    });
  });

  it('does not promote hypothetical ACP usage into token accounting', async () => {
    const fake = new FakeKimi({
      prompt: async () => ({
        stopReason: 'end_turn',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      }),
    });
    const adapter = new KimiAdapter({ spawnProcess: fake.spawn });

    const events = await collect(adapter.run('Do nothing'));
    expect(eventOf(events, 'done').payload.usage).toEqual({
      toolUses: 0,
    });
  });

  it('degrades malformed ACP accounting without failing the turn', async () => {
    const fake = new FakeKimi({
      prompt: async (connection, request) => {
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'kept' },
          },
        });
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'usage-tool',
            title: 'Read',
            kind: 'read',
            rawInput: { path: 'README.md' },
          },
        });
        return {
          stopReason: 'end_turn',
          usage: {
            totalTokens: 1,
            inputTokens: -1,
            outputTokens: 2,
          },
        };
      },
    });
    const adapter = new KimiAdapter({ spawnProcess: fake.spawn });

    const events = await collect(adapter.run('Do nothing'));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(eventOf(events, 'done').payload).toMatchObject({
      status: 'success',
      result: 'kept',
      usage: {
        toolUses: 1,
      },
    });
  });

  it('ignores unused thought detail and nullable optional caches', async () => {
    const fake = new FakeKimi({
      prompt: async () => ({
        stopReason: 'end_turn',
        usage: {
          totalTokens: 8,
          inputTokens: 5,
          outputTokens: 3,
          thoughtTokens: 2.5,
          cachedReadTokens: null,
          cachedWriteTokens: null,
        },
      }),
    });

    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Do nothing'),
    );
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(eventOf(events, 'done').payload).toMatchObject({
      status: 'success',
      usage: {
        toolUses: 0,
      },
    });
  });

  it('reports a failed tool once and marks absent token usage unavailable', async () => {
    const fake = new FakeKimi({
      prompt: async (connection, request) => {
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-fail',
            title: 'Bash',
            kind: 'execute',
            rawInput: { command: 'exit 1' },
          },
        });
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-fail',
            status: 'failed',
            rawOutput: { stderr: 'boom' },
          },
        });
        // A redundant terminal update must not produce a second tool_result.
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-fail',
            status: 'failed',
            rawOutput: { stderr: 'boom' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });

    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Run it', {
        cwd: '.',
      }),
    );

    const results = events.filter((event) => event.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(eventOf(events, 'tool_result').payload).toMatchObject({
      toolName: 'Bash',
      toolUseId: 'tool-fail',
      status: 'error',
      output: { stderr: 'boom' },
    });
    expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(1);
    // kimi-13: ACP supplies no authentic accounting in the pinned runtime;
    // toolUses remains independently observed.
    expect(eventOf(events, 'done').payload.usage).toEqual({
      toolUses: 1,
    });
  });

  it('fails closed when a permission request offers no reject option', async () => {
    const fake = new FakeKimi({
      prompt: async (connection, request, state) => {
        state.permissionOutcome = await connection.requestPermission({
          sessionId: request.sessionId,
          toolCall: {
            toolCallId: 'tool-allow-only',
            title: 'Write',
            kind: 'edit',
            rawInput: { path: 'out.txt' },
          },
          options: [
            { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
            { kind: 'allow_always', name: 'Always', optionId: 'always' },
          ],
        });
        return { stopReason: 'end_turn' };
      },
    });

    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Write it', {
        cwd: '.',
      }),
    );

    // kimi-22: a headless run must never auto-approve. With no reject
    // option available the adapter returns a cancelled outcome rather than
    // selecting one of the allow options.
    expect(fake.permissionOutcome).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(eventOf(events, 'permission_request').payload).toMatchObject({
      toolUseId: 'tool-allow-only',
    });
  });

  it('falls back to a reject_always option when no reject_once exists', async () => {
    const fake = new FakeKimi({
      prompt: async (connection, request, state) => {
        state.permissionOutcome = await connection.requestPermission({
          sessionId: request.sessionId,
          toolCall: { toolCallId: 'tool-3', title: 'Write', kind: 'edit' },
          options: [
            { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
            { kind: 'reject_always', name: 'Never', optionId: 'never' },
          ],
        });
        return { stopReason: 'end_turn' };
      },
    });

    await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Write it', {
        cwd: '.',
      }),
    );

    expect(fake.permissionOutcome).toEqual({
      outcome: { outcome: 'selected', optionId: 'never' },
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

  it('gives an already-aborted caller precedence over option validation', async () => {
    const fake = new FakeKimi();
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('No work', {
        resume: 'inbound-session',
        effort: 'ultra' as KimiEffort,
        abortSignal: controller.signal,
      }),
    );
    expect(fake.spawns).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(['done']);
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
    // kimi-220 / kimi-12: no backend id was observed and no inbound
    // resume was supplied, so the locally generated correlation id must not
    // leak out as a resumable token.
    expect(eventOf(events, 'done').payload).not.toHaveProperty('resumeToken');
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

  // IR-039 / kimi-27: the owned pre-filter is the only layer that can raise
  // malformed traffic. The SDK's own parser sits behind it and, since 1.3.0,
  // salvages rather than rejects — a malformed update it drops would otherwise
  // let the turn finish `success` with the defect invisible. These drive real
  // wire bytes rather than the typed helper, because the typed helper cannot
  // express the malformed shapes.
  it.each([
    [
      'a text chunk missing its text',
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text' } },
    ],
    [
      'a tool call with a non-protocol status',
      { sessionUpdate: 'tool_call', toolCallId: 'tool-1', status: 'exploded' },
    ],
    [
      'a tool call whose title is not a string',
      { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: { a: 1 } },
    ],
    [
      'nested tool content whose text is missing',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        content: [{ type: 'content', content: { type: 'text' } }],
      },
    ],
    [
      'a plan entry with an unrecognized status',
      {
        sessionUpdate: 'plan',
        entries: [{ content: 'step', priority: 'high', status: 'invented' }],
      },
    ],
    [
      'a plan update with no plan content',
      { sessionUpdate: 'plan_update' },
    ],
    [
      'a plan removal with no plan id',
      { sessionUpdate: 'plan_removed' },
    ],
  ])('rejects %s rather than letting the turn succeed', async (_case, update) => {
    const fake = new FakeKimi({
      prompt: async (_connection, request, state) => {
        state.children[0]?.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: request.sessionId, update },
          })}\n`,
        );
        return new Promise<PromptResponse>(() => {});
      },
    });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Hello'),
    );

    expect(eventOf(events, 'error').payload).toMatchObject({
      message: expect.stringContaining(
        'Malformed Kimi ACP traffic: invalid session/update parameters',
      ),
      recoverable: false,
    });
    expect(eventOf(events, 'done').payload.status).toBe('error');
  });

  // Results are validated on the raw wire, not on what the SDK hands back:
  // SDK 1.3 salvages a malformed `configOptions` into an empty array, so a
  // check applied after its parse would never see the offending value.
  it('rejects a malformed response result before the SDK can salvage it', async () => {
    const child = new FakeChild();
    let seenId: number | undefined;
    child.stdin.on('data', (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        const text = line.trim();
        if (!text) continue;
        const message = JSON.parse(text) as { id?: number; method?: string };
        if (message.method === 'initialize') {
          child.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`,
          );
        } else if (message.method === 'session/new') {
          seenId = message.id;
          // A `select` option without `currentValue`: the adapter reads that
          // field, and the SDK would drop the whole option rather than reject.
          child.stdout.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: seenId,
              result: {
                sessionId: 'sess-1',
                configOptions: [{ id: 'model', type: 'select', name: 'Model', options: [] }],
              },
            })}\n`,
          );
        }
      }
    });
    const events = await collect(
      new KimiAdapter({
        spawnProcess: () =>
          child as unknown as ReturnType<
            typeof import('node:child_process').spawn
          >,
      }).run('Hello'),
    );

    expect(eventOf(events, 'error').payload).toMatchObject({
      message: expect.stringContaining(
        'Malformed Kimi ACP traffic: invalid session/new response result',
      ),
    });
    expect(eventOf(events, 'done').payload.status).toBe('error');
  });

  // The other half of the same contract: protocol growth is not malformed.
  it('ignores an unknown session update case and completes the turn', async () => {
    const consoleErrors: string[] = [];
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args.map((a) => String(a)).join(' '));
      });
    const fake = new FakeKimi({
      prompt: async (_connection, request, state) => {
        state.children[0]?.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: request.sessionId,
              update: {
                sessionUpdate: 'a_case_from_a_later_protocol',
                payload: { anything: true },
              },
            },
          })}\n`,
        );
        return { stopReason: 'end_turn' } as PromptResponse;
      },
    });
    const events = await collect(
      new KimiAdapter({ spawnProcess: fake.spawn }).run('Hello'),
    );

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(eventOf(events, 'done').payload.status).toBe('success');
    // Ignored must mean ignored: the pinned SDK rejects any case outside its
    // own closed union, so forwarding one would log an Invalid params error
    // even though the turn succeeds. The filter drops it before that.
    expect(consoleErrors.join('\n')).not.toMatch(/Invalid params|-32602/);
    consoleSpy.mockRestore();
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

  const terminalCandidates = [
    { name: 'success', stopReason: 'end_turn', callerAbort: false },
    { name: 'refusal', stopReason: 'refusal', callerAbort: false },
    {
      name: 'native cancellation',
      stopReason: 'cancelled',
      callerAbort: false,
    },
    { name: 'caller abort', stopReason: 'end_turn', callerAbort: true },
  ] as const;
  const closeStates = [
    {
      name: 'clean close',
      scenario: { inputEndDelayMs: 1 },
      diagnostic: undefined,
    },
    {
      name: 'nonzero close',
      scenario: { exitCode: 7, inputEndDelayMs: 1 },
      diagnostic: 'code 7',
    },
    {
      name: 'unexpected-signal close',
      scenario: { exitSignal: 'SIGHUP' as const, inputEndDelayMs: 1 },
      diagnostic: 'SIGHUP',
    },
    {
      name: 'forced SIGKILL close',
      scenario: { ignoreInputEnd: true, ignoreSigterm: true },
      diagnostic: 'SIGKILL',
    },
  ] as const;

  it.each(
    terminalCandidates.flatMap((candidate) =>
      closeStates.map((closeState) => ({ candidate, closeState })),
    ),
  )(
    'selects $candidate.name against $closeState.name',
    async ({ candidate, closeState }) => {
      const lifecycle: string[] = [];
      const cleanupFailures: Error[] = [];
      const controller = new AbortController();
      const fake = new FakeKimi({
        ...closeState.scenario,
        lifecycle,
        prompt: async () => {
          if (candidate.callerAbort) controller.abort();
          return { stopReason: candidate.stopReason };
        },
      });
      const events = await collect(
        new KimiAdapter({
          spawnProcess: fake.spawn,
          processStdinExitGraceMs: 5,
          processSignalExitGraceMs: 5,
          cancelTerminationDelayMs: 5,
          reportCleanupFailure: (error) => cleanupFailures.push(error),
        }).run('Resolve precedence', {
          abortSignal: controller.signal,
        }),
        (event) => lifecycle.push(`event:${event.type}`),
      );

      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(lifecycle.filter((entry) => entry === 'stdin:end')).toHaveLength(
        1,
      );
      const expectedSignals =
        closeState.name === 'forced SIGKILL close'
          ? ['SIGTERM', 'SIGKILL']
          : [];
      expect(fake.children[0]?.killSignals).toEqual(expectedSignals);

      if (candidate.callerAbort) {
        expect(events.map((event) => event.type)).toEqual(['init', 'done']);
        expect(eventOf(events, 'done').payload.status).toBe('interrupted');
        expect(
          fake.calls.filter((call) => call === 'session/cancel'),
        ).toHaveLength(1);
        expect(lifecycle.indexOf('event:done')).toBeLessThan(
          lifecycle.indexOf('stdin:end'),
        );
        expect(lifecycle.indexOf('event:done')).toBeLessThan(
          lifecycle.indexOf('close'),
        );
        if (closeState.diagnostic) {
          expect(cleanupFailures).toHaveLength(1);
          expect(cleanupFailures[0]?.message).toContain(closeState.diagnostic);
        } else {
          expect(cleanupFailures).toEqual([]);
        }
        return;
      }

      expect(cleanupFailures).toEqual([]);
      expect(lifecycle.indexOf('close')).toBeLessThan(
        lifecycle.indexOf('event:done'),
      );
      if (closeState.diagnostic) {
        expect(events.map((event) => event.type)).toEqual([
          'init',
          'error',
          'done',
        ]);
        expect(eventOf(events, 'error').payload).toMatchObject({
          code: 'KIMI_ACP_ERROR',
          recoverable: false,
        });
        expect(eventOf(events, 'error').payload.message).toContain(
          closeState.diagnostic,
        );
        expect(eventOf(events, 'done').payload.status).toBe('error');
        return;
      }

      if (candidate.stopReason === 'refusal') {
        expect(events.map((event) => event.type)).toEqual([
          'init',
          'error',
          'done',
        ]);
        expect(eventOf(events, 'error').payload.code).toBe('KIMI_REFUSAL');
        expect(eventOf(events, 'done').payload.status).toBe('error');
      } else {
        expect(events.map((event) => event.type)).toEqual(['init', 'done']);
        expect(eventOf(events, 'done').payload.status).toBe(
          candidate.stopReason === 'cancelled' ? 'interrupted' : 'success',
        );
      }
    },
  );

  it('finishes one abort cleanup when the child ignores SIGKILL', async () => {
    const lifecycle: string[] = [];
    const cleanupFailures: Error[] = [];
    const controller = new AbortController();
    const fake = new FakeKimi({
      ignoreInputEnd: true,
      ignoreSigterm: true,
      ignoreSigkill: true,
      lifecycle,
      prompt: async () => new Promise<PromptResponse>(() => {}),
    });
    const run = collect(
      new KimiAdapter({
        spawnProcess: fake.spawn,
        processStdinExitGraceMs: 5,
        processSignalExitGraceMs: 5,
        cancelTerminationDelayMs: 5,
        reportCleanupFailure: (error) => cleanupFailures.push(error),
      }).run('Stay wedged', { abortSignal: controller.signal }),
      (event) => lifecycle.push(`event:${event.type}`),
    );
    while (!fake.calls.includes('session/prompt')) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
    controller.abort();
    const events = await run;

    expect(events.map((event) => event.type)).toEqual(['init', 'done']);
    expect(eventOf(events, 'done').payload.status).toBe('interrupted');
    expect(fake.calls.filter((call) => call === 'session/cancel')).toHaveLength(
      1,
    );
    expect(fake.children[0]?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(lifecycle.filter((entry) => entry === 'stdin:end')).toHaveLength(1);
    expect(lifecycle).not.toContain('close');
    expect(lifecycle.indexOf('event:done')).toBeLessThan(
      lifecycle.indexOf('kill:SIGTERM'),
    );
    expect(cleanupFailures).toHaveLength(1);
    expect(cleanupFailures[0]?.message).toContain('did not exit');
  });

  it('reports abort cleanup failures through the default diagnostic', async () => {
    const controller = new AbortController();
    const fake = new FakeKimi({
      exitCode: 7,
      inputEndDelayMs: 1,
      prompt: async () => {
        controller.abort();
        return { stopReason: 'end_turn' };
      },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
      // Capture the default cleanup diagnostic without writing test output.
    });

    try {
      const events = await collect(
        new KimiAdapter({
          spawnProcess: fake.spawn,
          processStdinExitGraceMs: 5,
          processSignalExitGraceMs: 5,
        }).run('Report cleanup', { abortSignal: controller.signal }),
      );

      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(eventOf(events, 'done').payload.status).toBe('interrupted');
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        'Kimi ACP cleanup after caller abort failed: Kimi ACP process exited with code 7',
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('replaces the default abort cleanup diagnostic', async () => {
    const controller = new AbortController();
    const fake = new FakeKimi({
      exitCode: 7,
      inputEndDelayMs: 1,
      prompt: async () => {
        controller.abort();
        return { stopReason: 'end_turn' };
      },
    });
    const reportCleanupFailure = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
      // A supplied reporter replaces the default console diagnostic.
    });

    try {
      const events = await collect(
        new KimiAdapter({
          spawnProcess: fake.spawn,
          processStdinExitGraceMs: 5,
          processSignalExitGraceMs: 5,
          reportCleanupFailure,
        }).run('Replace cleanup report', { abortSignal: controller.signal }),
      );

      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(eventOf(events, 'done').payload.status).toBe('interrupted');
      expect(reportCleanupFailure).toHaveBeenCalledTimes(1);
      expect(reportCleanupFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Kimi ACP process exited with code 7',
        }),
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('contains a throwing replacement cleanup diagnostic', async () => {
    const lifecycle: string[] = [];
    const controller = new AbortController();
    const fake = new FakeKimi({
      ignoreInputEnd: true,
      ignoreSigterm: true,
      lifecycle,
      prompt: async () => {
        controller.abort();
        return { stopReason: 'end_turn' };
      },
    });
    const reportCleanupFailure = vi.fn((_error: Error) => {
      throw new Error('diagnostic sink failed');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
      // A supplied reporter replaces the default console diagnostic.
    });

    try {
      const events = await collect(
        new KimiAdapter({
          spawnProcess: fake.spawn,
          processStdinExitGraceMs: 5,
          processSignalExitGraceMs: 5,
          reportCleanupFailure,
        }).run('Contain diagnostic', { abortSignal: controller.signal }),
      );

      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(eventOf(events, 'done').payload.status).toBe('interrupted');
      expect(fake.children[0]?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(lifecycle.filter((entry) => entry === 'stdin:end')).toHaveLength(
        1,
      );
      expect(reportCleanupFailure).toHaveBeenCalledTimes(1);
      expect(reportCleanupFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Kimi ACP process required SIGKILL during cleanup',
        }),
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps caller-abort priority while awaiting post-prompt close', async () => {
    const lifecycle: string[] = [];
    const cleanupFailures: Error[] = [];
    const controller = new AbortController();
    const fake = new FakeKimi({
      ignoreInputEnd: true,
      lifecycle,
      stopReason: 'end_turn',
    });
    const run = collect(
      new KimiAdapter({
        spawnProcess: fake.spawn,
        processStdinExitGraceMs: 50,
        processSignalExitGraceMs: 5,
        reportCleanupFailure: (error) => cleanupFailures.push(error),
      }).run('Abort during close', { abortSignal: controller.signal }),
      (event) => lifecycle.push(`event:${event.type}`),
    );
    while (!lifecycle.includes('stdin:end')) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
    controller.abort();
    const events = await run;

    expect(events.map((event) => event.type)).toEqual(['init', 'done']);
    expect(eventOf(events, 'done').payload.status).toBe('interrupted');
    expect(fake.children[0]?.killSignals).toEqual(['SIGTERM']);
    expect(lifecycle.indexOf('stdin:end')).toBeLessThan(
      lifecycle.indexOf('event:done'),
    );
    expect(lifecycle.indexOf('event:done')).toBeLessThan(
      lifecycle.indexOf('kill:SIGTERM'),
    );
    expect(cleanupFailures).toEqual([]);
  });

  it('bounds abort teardown when terminal consumption stalls', async () => {
    const lifecycle: string[] = [];
    const controller = new AbortController();
    const fake = new FakeKimi({ ignoreInputEnd: true, lifecycle });
    const stream = new KimiAdapter({
      spawnProcess: fake.spawn,
      processStdinExitGraceMs: 10,
      processSignalExitGraceMs: 5,
    }).run('Hold delivery', { abortSignal: controller.signal });

    const first = await stream.next();
    expect(first.value?.type).toBe('init');
    while (!lifecycle.includes('stdin:end')) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
    controller.abort();
    expect(fake.children[0]?.killSignals).toEqual([]);

    await new Promise<void>((resolveHandoff) => {
      setImmediate(resolveHandoff);
    });
    expect(fake.children[0]?.killSignals).toEqual(['SIGTERM']);
    expect(lifecycle).toContain('close');

    const terminal = await stream.next();
    expect(terminal.value?.type).toBe('done');
    expect(terminal.value?.payload.status).toBe('interrupted');

    const completion = await stream.next();
    expect(completion.done).toBe(true);
    expect(fake.children[0]?.killSignals).toEqual(['SIGTERM']);
  });

  it('keeps a protocol cause when abort arrives after teardown starts', async () => {
    const lifecycle: string[] = [];
    const controller = new AbortController();
    const fake = new FakeKimi({
      ignoreInputEnd: true,
      ignoreSigterm: true,
      lifecycle,
      prompt: async (_connection, request, state) => {
        state.children[0]?.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: request.sessionId,
              update: { sessionUpdate: 'agent_message_chunk' },
            },
          })}\n`,
        );
        return new Promise<PromptResponse>(() => {});
      },
    });
    const run = collect(
      new KimiAdapter({
        spawnProcess: fake.spawn,
        processStdinExitGraceMs: 5,
        processSignalExitGraceMs: 50,
      }).run('Fail before abort', { abortSignal: controller.signal }),
      (event) => lifecycle.push(`event:${event.type}`),
    );
    while (!lifecycle.includes('kill:SIGTERM')) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
    controller.abort();
    const events = await run;

    expect(fake.calls).not.toContain('session/cancel');
    expect(fake.children[0]?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);
    expect(eventOf(events, 'error').payload).toMatchObject({
      code: 'KIMI_ACP_ERROR',
      message: expect.stringContaining('Malformed Kimi ACP traffic'),
      recoverable: false,
    });
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
