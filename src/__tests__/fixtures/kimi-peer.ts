// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { parse as parseYaml } from 'yaml';
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
  /**
   * Runs inside `session/new` or `session/resume` before its response, so
   * an update it awaits arrives ahead of that response, while work it
   * schedules may follow the response.
   */
  sessionSetup?: (
    connection: AgentSideConnection,
    setup: FakeSessionSetup,
    fake: FakeKimi,
  ) => Promise<void>;
}

export interface FakeSessionSetup {
  readonly sessionId: string;
  readonly cwd: string;
  readonly resumed: boolean;
}

/**
 * The `skill:<name>` commands Kimi Code advertises for a working directory's
 * project skills: the project root is the nearest ancestor holding a `.git`
 * entry, `.kimi-code/skills` is walked breadth-first in name order, a
 * directory holding `SKILL.md` registers its frontmatter name with the
 * trimmed description, and the first registration of a name wins.
 */
export async function listKimiSkillCommands(
  cwd: string,
): Promise<Array<{ name: string; description: string }>> {
  let root = cwd;
  for (let current = cwd; ; current = dirname(current)) {
    if (await exists(join(current, '.git'))) {
      root = current;
      break;
    }
    if (dirname(current) === current) break;
  }
  const commands = new Map<string, string>();
  const queue = [join(root, '.kimi-code', 'skills')];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.name === 'SKILL.md')) {
      const text = await readFile(join(directory, 'SKILL.md'), 'utf8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      const data = match
        ? (parseYaml(match[1]!) as Record<string, unknown> | null)
        : null;
      if (
        typeof data?.name === 'string' &&
        typeof data.description === 'string' &&
        !commands.has(data.name)
      ) {
        commands.set(data.name, data.description.trim());
      }
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) queue.push(join(directory, entry.name));
    }
  }
  return [...commands].map(([name, description]) => ({
    name: `skill:${name}`,
    description,
  }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
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

  /** Write one raw JSON-RPC line to the latest child's stdout, bypassing the SDK's own validation. */
  writeRaw(message: unknown): void {
    this.children.at(-1)?.stdout.write(`${JSON.stringify(message)}\n`);
  }

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
        const sessionId = this.scenario.sessionId ?? 'kimi-session';
        await this.scenario.sessionSetup?.(
          connection,
          { sessionId, cwd: request.cwd, resumed: false },
          this,
        );
        return {
          sessionId,
          configOptions: this.configOptions(),
        };
      },
      resumeSession: async (request) => {
        this.calls.push('session/resume');
        this.resumeRequests.push(request);
        if (this.scenario.failAuth) throw RequestError.authRequired();
        if (this.scenario.sessionError) throw this.scenario.sessionError;
        await this.scenario.sessionSetup?.(
          connection,
          { sessionId: request.sessionId, cwd: request.cwd, resumed: true },
          this,
        );
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
