// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile, spawn } from 'node:child_process';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { promisify } from 'node:util';

import { createEvent, generateSessionId } from '../events.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  DonePayload,
  PermissionLevel,
  PermissionPolicy,
} from '../types.js';

const AGENT = 'opencode' as const;
const DEFAULT_MANAGED_URL = 'http://127.0.0.1:4093';

const DEFAULT_DONE_USAGE: DonePayload['usage'] = {
  inputTokens: 0,
  outputTokens: 0,
  toolUses: 0,
};

type OpenCodeMode = 'managed' | 'external';

type SpawnProcessFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface ServerCloseInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface OpenCodeClient {
  run?: (options: Record<string, unknown>) => Promise<unknown>;
  query?: (options: Record<string, unknown>) => Promise<unknown>;
  events?: (options?: Record<string, unknown>) => AsyncIterable<unknown>;
  subscribe?: (options?: Record<string, unknown>) => AsyncIterable<unknown>;
  close?: () => Promise<void> | void;
  shutdown?: () => Promise<void> | void;
}

interface OpenCodeSdk {
  createClient: (options?: { baseUrl?: string }) => OpenCodeClient;
}

interface OpenCodeAdapterConfig {
  mode?: OpenCodeMode;
  serverUrl?: string;
  readyTimeoutMs?: number;
}

interface OpenCodeAdapterDeps {
  loadSdk?: () => Promise<OpenCodeSdk>;
  spawnProcess?: SpawnProcessFn;
  probeCliAvailability?: () => Promise<boolean>;
  waitForServerReady?: (
    process: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ) => Promise<void>;
}

interface OpenCodePermissionOptions {
  permission: {
    edit: PermissionLevel;
    bash: PermissionLevel;
    webfetch: PermissionLevel;
  };
  tools?: {
    core?: string[];
    exclude?: string[];
  };
}

const execFileAsync = promisify(execFile);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];

  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) {
      result.push(item);
      continue;
    }

    if (typeof item === 'object' && item !== null) {
      const named = asString((item as { name?: unknown }).name);
      if (named) {
        result.push(named);
      }
    }
  }

  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizePermissionLevel(value: PermissionLevel | undefined): PermissionLevel {
  return value ?? 'ask';
}

function normalizePermissions(
  policy: PermissionPolicy | undefined,
): Required<PermissionPolicy> {
  return {
    fileWrite: normalizePermissionLevel(policy?.fileWrite),
    shellExecute: normalizePermissionLevel(policy?.shellExecute),
    networkAccess: normalizePermissionLevel(policy?.networkAccess),
  };
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return { raw: value };
    }
  }

  return asRecord(value);
}

function mapDoneStatus(rawStatus: string | undefined): DonePayload['status'] {
  if (!rawStatus) return 'success';

  const status = rawStatus.toLowerCase();
  if (status === 'success' || status === 'completed' || status === 'ok') {
    return 'success';
  }
  if (status === 'interrupted' || status === 'cancelled' || status === 'aborted') {
    return 'interrupted';
  }
  if (status === 'max_turns' || status === 'maxturns') {
    return 'max_turns';
  }
  if (
    status === 'max_budget' ||
    status === 'maxbudget' ||
    status === 'budget_exceeded'
  ) {
    return 'max_budget';
  }
  if (status === 'error' || status === 'failed') {
    return 'error';
  }

  return 'success';
}

function mapUsage(rawUsage: unknown): DonePayload['usage'] {
  if (typeof rawUsage !== 'object' || rawUsage === null) {
    return { ...DEFAULT_DONE_USAGE };
  }

  const usage = rawUsage as Record<string, unknown>;

  const inputTokens =
    asNumber(usage.inputTokens) ?? asNumber(usage.input_tokens) ?? 0;

  const outputTokens =
    asNumber(usage.outputTokens) ?? asNumber(usage.output_tokens) ?? 0;

  const toolUses =
    asNumber(usage.toolUses) ?? asNumber(usage.tool_uses) ?? 0;

  const totalCostUsd =
    asNumber(usage.totalCostUsd) ?? asNumber(usage.total_cost_usd);

  return {
    inputTokens,
    outputTokens,
    toolUses,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

/** Broad extractor — used for runResult where `id` plausibly is the session. */
function loadSessionId(message: unknown): string | undefined {
  const record = asRecord(message);
  const session = asRecord(record.session);
  const thread = asRecord(record.thread);

  return (
    asString(record.sessionId) ??
    asString(record.session_id) ??
    asString(record.threadId) ??
    asString(record.thread_id) ??
    asString(record.id) ??
    asString(session.id) ??
    asString(thread.id)
  );
}

/** Strict extractor — explicit session/thread fields only, no generic `id`. */
function loadStreamSessionId(message: unknown): string | undefined {
  const record = asRecord(message);
  const session = asRecord(record.session);
  const thread = asRecord(record.thread);

  return (
    asString(record.sessionId) ??
    asString(record.session_id) ??
    asString(record.threadId) ??
    asString(record.thread_id) ??
    asString(session.id) ??
    asString(thread.id)
  );
}

function toErrorPayload(message: unknown): {
  code?: string;
  message: string;
  recoverable: boolean;
} {
  const top = asRecord(message);
  const nested = asRecord(top.error);

  const code =
    asString(top.code) ??
    asString(nested.code) ??
    asString(nested.type);

  const text =
    asString(top.message) ??
    asString(nested.message) ??
    'OpenCode SDK error';

  const recoverable =
    top.recoverable === true ||
    top.retryable === true ||
    nested.recoverable === true ||
    nested.retryable === true;

  return {
    ...(code ? { code } : {}),
    message: text,
    recoverable,
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]: unknown })[Symbol.asyncIterator] ===
      'function'
  );
}

function maybeCallAsync(fn: (() => Promise<void> | void) | undefined): Promise<void> {
  if (!fn) return Promise.resolve();

  try {
    const result = fn();
    return Promise.resolve(result).then(() => {});
  } catch {
    return Promise.resolve();
  }
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return spawn(command, args, options) as ChildProcessWithoutNullStreams;
}

async function defaultProbeCliAvailability(): Promise<boolean> {
  try {
    await execFileAsync('opencode', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function defaultWaitForServerReady(
  processRef: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processRef.removeListener('close', onClose);
      processRef.removeListener('error', onError);
      processRef.stdout?.removeListener('data', onData);
      processRef.stderr?.removeListener('data', onData);

      if (err) {
        reject(err);
        return;
      }

      resolve();
    };

    const onData = (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (/ready|listening|http:\/\//i.test(text)) {
        finish();
      }
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        new Error(
          `OpenCode server exited before ready (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    };

    const onError = (error: Error) => {
      finish(error);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for OpenCode server readiness (${timeoutMs}ms)`));
    }, timeoutMs);

    processRef.stdout?.on('data', onData);
    processRef.stderr?.on('data', onData);
    processRef.once('close', onClose);
    processRef.once('error', onError);
  });
}

async function waitForProcessClose(
  processRef: ChildProcessWithoutNullStreams,
): Promise<ServerCloseInfo> {
  return new Promise<ServerCloseInfo>((resolve) => {
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };

    const onError = () => {
      cleanup();
      resolve({ code: 1, signal: null });
    };

    const cleanup = () => {
      processRef.removeListener('close', onClose);
      processRef.removeListener('error', onError);
    };

    processRef.once('close', onClose);
    processRef.once('error', onError);
  });
}

function parseUrlHostPort(url: string): { host: string; port: string } {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return { host, port };
}

function createManagedServerArgs(serverUrl: string): string[] {
  const { host, port } = parseUrlHostPort(serverUrl);
  return ['serve', '--host', host, '--port', port];
}

function createClientFromSdk(sdk: OpenCodeSdk, baseUrl: string): OpenCodeClient {
  return sdk.createClient({ baseUrl });
}

function resolveRunFunction(client: OpenCodeClient):
  | ((options: Record<string, unknown>) => Promise<unknown>)
  | undefined {
  if (typeof client.run === 'function') return client.run.bind(client);
  if (typeof client.query === 'function') return client.query.bind(client);
  return undefined;
}

function resolveEventStream(
  client: OpenCodeClient,
  runResult: unknown,
  signal: AbortSignal | undefined,
): AsyncIterable<unknown> | undefined {
  if (isAsyncIterable(runResult)) {
    return runResult;
  }

  const resultRecord = asRecord(runResult);
  if (isAsyncIterable(resultRecord.events)) {
    return resultRecord.events;
  }

  if (typeof client.events === 'function') {
    return client.events({ signal });
  }

  if (typeof client.subscribe === 'function') {
    return client.subscribe({ signal });
  }

  return undefined;
}

export function mapPermissionsToOpenCodeOptions(
  policy: PermissionPolicy | undefined,
  options?: Pick<AgentOptions, 'allowedTools' | 'disallowedTools'>,
): OpenCodePermissionOptions {
  const normalized = normalizePermissions(policy);

  const core = [...new Set(options?.allowedTools ?? [])];
  const exclude = [...new Set(options?.disallowedTools ?? [])];

  return {
    permission: {
      edit: normalized.fileWrite,
      bash: normalized.shellExecute,
      webfetch: normalized.networkAccess,
    },
    ...(core.length > 0 || exclude.length > 0
      ? {
          tools: {
            ...(core.length > 0 ? { core } : {}),
            ...(exclude.length > 0 ? { exclude } : {}),
          },
        }
      : {}),
  };
}

export async function loadOpenCodeSdk(): Promise<OpenCodeSdk> {
  const mod = (await import('@opencode-ai/sdk')) as {
    createClient?: unknown;
    OpenCodeClient?: unknown;
    OpenCode?: unknown;
  };

  if (typeof mod.createClient === 'function') {
    return {
      createClient: mod.createClient as OpenCodeSdk['createClient'],
    };
  }

  if (typeof mod.OpenCodeClient === 'function') {
    return {
      createClient: (options?: { baseUrl?: string }) =>
        new (mod.OpenCodeClient as new (options?: { baseUrl?: string }) => OpenCodeClient)(
          options,
        ),
    };
  }

  if (typeof mod.OpenCode === 'function') {
    return {
      createClient: (options?: { baseUrl?: string }) =>
        new (mod.OpenCode as new (options?: { baseUrl?: string }) => OpenCodeClient)(options),
    };
  }

  throw new Error('@opencode-ai/sdk does not export a recognized client factory');
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly agent = AGENT;

  private readonly mode: OpenCodeMode;

  private readonly serverUrl: string;

  private readonly readyTimeoutMs: number;

  private readonly loadSdkFn: () => Promise<OpenCodeSdk>;

  private readonly spawnProcess: SpawnProcessFn;

  private readonly probeCliAvailability: () => Promise<boolean>;

  private readonly waitForServerReady: (
    process: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ) => Promise<void>;

  constructor(
    config: OpenCodeAdapterConfig = {},
    deps: OpenCodeAdapterDeps = {},
  ) {
    this.mode = config.mode ?? 'managed';
    this.serverUrl = config.serverUrl ?? DEFAULT_MANAGED_URL;
    this.readyTimeoutMs = config.readyTimeoutMs ?? 5000;
    this.loadSdkFn = deps.loadSdk ?? loadOpenCodeSdk;
    this.spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
    this.probeCliAvailability = deps.probeCliAvailability ?? defaultProbeCliAvailability;
    this.waitForServerReady = deps.waitForServerReady ?? defaultWaitForServerReady;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.loadSdkFn();
    } catch {
      return false;
    }

    if (this.mode === 'managed') {
      return this.probeCliAvailability();
    }

    return true;
  }

  async *run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    let sdk: OpenCodeSdk;
    try {
      sdk = await this.loadSdkFn();
    } catch {
      throw new Error(
        'OpenCodeAdapter requires @opencode-ai/sdk. Install it to use this adapter.',
      );
    }

    const mappedPermissions = mapPermissionsToOpenCodeOptions(
      options?.permissions,
      {
        allowedTools: options?.allowedTools,
        disallowedTools: options?.disallowedTools,
      },
    );

    const startTime = Date.now();
    let doneYielded = false;
    let initYielded = false;
    let abortRequested = options?.abortSignal?.aborted === true;

    let serverProcess: ChildProcessWithoutNullStreams | undefined;
    let serverClosed = false;
    let serverExitPromise: Promise<ServerCloseInfo> | undefined;

    let sessionId = options?.resume ?? generateSessionId();
    let backendProvidedSessionId = false;

    const onAbort = () => {
      abortRequested = true;
      if (serverProcess && !serverClosed) {
        try {
          serverProcess.kill('SIGTERM');
        } catch {
          // ignore kill errors during shutdown
        }
      }
    };

    if (options?.abortSignal && !options.abortSignal.aborted) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    let client: OpenCodeClient | undefined;

    try {
      if (this.mode === 'managed') {
        const managedArgs = createManagedServerArgs(this.serverUrl);
        serverProcess = this.spawnProcess(
          'opencode',
          managedArgs,
          {
            cwd: options?.cwd,
            stdio: 'pipe',
          },
        );

        serverExitPromise = waitForProcessClose(serverProcess).then((info) => {
          serverClosed = true;
          return info;
        });

        await this.waitForServerReady(serverProcess, this.readyTimeoutMs);

        if (abortRequested) {
          onAbort();
        }
      }

      client = createClientFromSdk(sdk, this.serverUrl);

      const runFn = resolveRunFunction(client);
      if (!runFn) {
        throw new Error('OpenCode SDK client does not provide run()/query()');
      }

      const runResult = await runFn({
        prompt,
        cwd: options?.cwd,
        model: options?.model,
        ...(options?.maxTurns !== undefined ? { steps: options.maxTurns } : {}),
        ...(options?.resume ? { sessionId: options.resume } : {}),
        ...mappedPermissions,
      });

      const loadedId = loadSessionId(runResult);
      if (loadedId) {
        sessionId = loadedId;
        backendProvidedSessionId = true;
      }

      if (!initYielded) {
        const runRecord = asRecord(runResult);
        const configuredTools = asStringArray(mappedPermissions.tools?.core ?? []);
        const runTools = asStringArray(runRecord.tools);

        yield createEvent(
          'init',
          AGENT,
          {
            model: options?.model ?? asString(runRecord.model) ?? 'unknown',
            cwd: options?.cwd ?? asString(runRecord.cwd) ?? process.cwd(),
            tools: runTools.length > 0 ? runTools : configuredTools,
            capabilities: {
              mode: this.mode,
              toolsKnown: runTools.length > 0 || configuredTools.length > 0,
              toolsSource:
                runTools.length > 0
                  ? 'sdk'
                  : configuredTools.length > 0
                    ? 'configured'
                    : 'unavailable',
              ...(mappedPermissions.tools?.exclude
                ? { disallowedTools: mappedPermissions.tools.exclude }
                : {}),
            },
          },
          sessionId,
        );
        initYielded = true;
      }

      const stream = resolveEventStream(client, runResult, options?.abortSignal);
      if (!stream) {
        throw new Error('OpenCode SDK client does not provide an SSE event stream');
      }

      const iterator = stream[Symbol.asyncIterator]();

      while (true) {
        const nextPromise = iterator.next();

        const raceResult =
          this.mode === 'managed' && serverExitPromise
            ? await Promise.race([
                nextPromise.then((result) => ({ kind: 'event' as const, result })),
                serverExitPromise.then((exit) => ({ kind: 'server_exit' as const, exit })),
              ])
            : ({
                kind: 'event' as const,
                result: await nextPromise,
              } as const);

        if (raceResult.kind === 'server_exit') {
          nextPromise.catch(() => {});

          if (doneYielded) break;

          if (abortRequested || options?.abortSignal?.aborted) {
            yield createEvent(
              'done',
              AGENT,
              {
                status: 'interrupted',
                usage: { ...DEFAULT_DONE_USAGE },
                durationMs: Date.now() - startTime,
              },
              sessionId,
            );
            doneYielded = true;
            break;
          }

          yield createEvent(
            'error',
            AGENT,
            {
              code: 'OPENCODE_SERVER_EXIT',
              message: `OpenCode server exited unexpectedly (code=${String(raceResult.exit.code)}, signal=${String(raceResult.exit.signal)})`,
              recoverable: false,
            },
            sessionId,
          );
          yield createEvent(
            'done',
            AGENT,
            {
              status: 'error',
              usage: { ...DEFAULT_DONE_USAGE },
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
          break;
        }

        const { result } = raceResult;
        if (result.done) break;

        const event = asRecord(result.value);
        const eventType = asString(event.type);
        if (!eventType) continue;

        // Use strict extractor — only explicit session fields, no generic `id`
        // that could match message/event IDs and cause false filtering.
        const eventSessionId =
          loadStreamSessionId(event) ??
          loadStreamSessionId(event.data) ??
          loadStreamSessionId(event.message);

        if (eventSessionId) {
          if (eventSessionId !== sessionId) {
            continue;
          }
          // Only mark backend-provided after confirming the event belongs
          // to this session — foreign events must not flip the flag.
          backendProvidedSessionId = true;
        }

        if (eventType === 'message.part.updated') {
          const message = asRecord(event.message);
          const part = asRecord(event.part ?? message.part ?? event.data);
          const partType = asString(part.type)?.toLowerCase();

          if (
            partType === 'text' ||
            partType === 'output_text' ||
            partType === 'message_text'
          ) {
            const delta = asString(part.delta);
            if (delta) {
              yield createEvent('text_delta', AGENT, { delta }, sessionId);
              continue;
            }

            const content =
              asString(part.text) ??
              asString(part.content) ??
              asString(asRecord(part.content).text);

            if (content) {
              yield createEvent('text', AGENT, { content }, sessionId);
            }
            continue;
          }

          if (
            partType === 'tool' ||
            partType === 'tool_call' ||
            partType === 'tool_use'
          ) {
            yield createEvent(
              'tool_use',
              AGENT,
              {
                toolName:
                  asString(part.toolName) ??
                  asString(part.name) ??
                  asString(asRecord(part.tool).name) ??
                  'unknown_tool',
                toolUseId:
                  asString(part.toolUseId) ??
                  asString(part.id) ??
                  asString(part.callId) ??
                  generateSessionId(),
                input: parseToolInput(
                  part.input ??
                    part.arguments ??
                    part.args ??
                    asRecord(part.tool).input,
                ),
                ...(asString(part.description)
                  ? { description: asString(part.description) }
                  : {}),
              },
              sessionId,
            );
            continue;
          }

          if (partType === 'thinking' || partType === 'reasoning') {
            const summary =
              asString(part.summary) ??
              asString(part.text) ??
              asString(part.content);
            if (summary) {
              yield createEvent('thinking', AGENT, { summary }, sessionId);
            }
            continue;
          }

          if (partType === 'file' || partType === 'file_part') {
            yield createEvent('opencode:file_part', AGENT, part, sessionId);
            continue;
          }

          if (partType === 'image' || partType === 'image_part') {
            yield createEvent('opencode:image_part', AGENT, part, sessionId);
            continue;
          }

          continue;
        }

        if (eventType === 'permission.updated') {
          const permission = asRecord(event.permission);
          const reason = asString(permission.reason) ?? asString(event.reason);
          yield createEvent(
            'permission_request',
            AGENT,
            {
              toolName:
                asString(permission.toolName) ??
                asString(permission.name) ??
                asString(event.toolName) ??
                'unknown_tool',
              toolUseId:
                asString(permission.toolUseId) ??
                asString(permission.id) ??
                asString(event.toolUseId) ??
                generateSessionId(),
              input: parseToolInput(permission.input ?? event.input ?? {}),
              ...(reason ? { reason } : {}),
            },
            sessionId,
          );
          continue;
        }

        if (eventType === 'permission.replied') {
          const permission = asRecord(event.permission);
          const decision = (
            asString(permission.decision) ??
            asString(event.decision) ??
            asString(permission.status) ??
            asString(event.status) ??
            ''
          ).toLowerCase();

          if (decision === 'denied' || decision === 'rejected') {
            yield createEvent(
              'tool_result',
              AGENT,
              {
                toolName:
                  asString(permission.toolName) ??
                  asString(permission.name) ??
                  asString(event.toolName) ??
                  'unknown_tool',
                toolUseId:
                  asString(permission.toolUseId) ??
                  asString(permission.id) ??
                  asString(event.toolUseId) ??
                  generateSessionId(),
                status: 'denied',
                output:
                  permission.reason ??
                  event.reason ??
                  permission.output ??
                  event.output ??
                  null,
              },
              sessionId,
            );
          }
          continue;
        }

        if (eventType === 'error') {
          yield createEvent('error', AGENT, toErrorPayload(event), sessionId);
          continue;
        }

        if (eventType === 'session.idle') {
          yield createEvent(
            'done',
            AGENT,
            {
              status: mapDoneStatus(asString(event.status)),
              result: asString(event.result),
              ...(backendProvidedSessionId ? { resumeToken: sessionId } : {}),
              usage: mapUsage(event.usage),
              durationMs:
                asNumber(event.durationMs) ??
                asNumber(event.duration_ms) ??
                Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
          break;
        }
      }

      if (!doneYielded) {
        if (abortRequested || options?.abortSignal?.aborted) {
          yield createEvent(
            'done',
            AGENT,
            {
              status: 'interrupted',
              usage: { ...DEFAULT_DONE_USAGE },
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
        } else {
          yield createEvent(
            'error',
            AGENT,
            {
              code: 'MISSING_SESSION_IDLE',
              message: 'Protocol violation: OpenCode stream ended without session.idle',
              recoverable: false,
            },
            sessionId,
          );
          yield createEvent(
            'done',
            AGENT,
            {
              status: 'error',
              usage: { ...DEFAULT_DONE_USAGE },
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
        }
      }
    } catch (error) {
      if (!initYielded) {
        yield createEvent(
          'init',
          AGENT,
          {
            model: options?.model ?? 'unknown',
            cwd: options?.cwd ?? process.cwd(),
            tools: asStringArray(mappedPermissions.tools?.core ?? []),
            capabilities: {
              mode: this.mode,
              toolsKnown: asStringArray(mappedPermissions.tools?.core ?? []).length > 0,
              toolsSource:
                asStringArray(mappedPermissions.tools?.core ?? []).length > 0
                  ? 'configured'
                  : 'unavailable',
              ...(mappedPermissions.tools?.exclude
                ? { disallowedTools: mappedPermissions.tools.exclude }
                : {}),
            },
          },
          sessionId,
        );
        initYielded = true;
      }

      if (!doneYielded) {
        if (abortRequested || options?.abortSignal?.aborted) {
          yield createEvent(
            'done',
            AGENT,
            {
              status: 'interrupted',
              usage: { ...DEFAULT_DONE_USAGE },
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
        } else {
          yield createEvent(
            'error',
            AGENT,
            {
              code: 'OPENCODE_STREAM_ERROR',
              message:
                error instanceof Error
                  ? error.message
                  : 'OpenCode adapter failed during stream',
              recoverable: false,
            },
            sessionId,
          );
          yield createEvent(
            'done',
            AGENT,
            {
              status: 'error',
              usage: { ...DEFAULT_DONE_USAGE },
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
        }
      }
    } finally {
      if (options?.abortSignal && !options.abortSignal.aborted) {
        options.abortSignal.removeEventListener('abort', onAbort);
      }

      await maybeCallAsync(client?.close?.bind(client));
      await maybeCallAsync(client?.shutdown?.bind(client));

      if (serverProcess && !serverClosed) {
        try {
          serverProcess.kill('SIGTERM');
        } catch {
          // ignore cleanup errors
        }

        if (serverExitPromise) {
          try {
            await Promise.race([
              serverExitPromise,
              new Promise((resolve) => setTimeout(resolve, 1500)),
            ]);
          } catch {
            // ignore cleanup errors
          }
        }
      }
    }
  }
}
