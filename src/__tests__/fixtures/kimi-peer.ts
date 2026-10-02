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

export interface FakeScenario {
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
  omitModelOption?: boolean;
  ignoreModelSelection?: boolean;
  initialize?: () => Promise<void>;
  imageCapability?: boolean;
  setConfig?: (request: SetSessionConfigOptionRequest) => Promise<void>;
  /**
   * The `thinking` select's `options` for the current model, as Kimi
   * advertises them; `null` advertises no `thinking` option at all.
   */
  thinkingOptions?: (model: string) => unknown[] | null;
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

export class FakeChild extends EventEmitter {
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

export class FakeKimi {
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
      close: () => {
        child.stdout.end();
      },
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
    const thinkingOptions = this.scenario.thinkingOptions
      ? this.scenario.thinkingOptions(this.currentModel)
      : [
          { value: 'off', name: 'Off' },
          { value: 'on', name: 'On' },
        ];
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
      ...(thinkingOptions === null
        ? []
        : [
            {
              type: 'select' as const,
              id: 'thinking',
              name: 'Thinking',
              category: 'thought_level',
              currentValue: this.scenario.thinkingOptions
                ? String(
                    (thinkingOptions[0] as { value?: unknown } | undefined)
                      ?.value ?? 'on',
                  )
                : 'off',
              options: thinkingOptions,
            },
          ]),
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
    ].filter(({ id }) => !(this.scenario.omitModelOption && id === 'model'));
  }

  private agent(connection: AgentSideConnection): Agent {
    return {
      authenticate: async () => ({}),
      initialize: async (request) => {
        this.calls.push('initialize');
        this.initializeRequest = request;
        await this.scenario.initialize?.();
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {} },
            ...(this.scenario.imageCapability !== undefined
              ? { promptCapabilities: { image: this.scenario.imageCapability } }
              : {}),
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
        if (request.configId === 'model' && !this.scenario.ignoreModelSelection)
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
