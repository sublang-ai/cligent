// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile, spawn } from 'node:child_process';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus,
  Usage,
} from '@agentclientprotocol/sdk';
import {
  zError,
  zInitializeResponse,
  zNewSessionResponse,
  zPromptResponse,
  zRequestPermissionRequest,
  zResumeSessionResponse,
  zSessionNotification,
  zSetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js';

import { createEvent, generateSessionId } from '../events.js';
import { assertSupportedEffort } from '../effort.js';
import { mapWritablePathsPermission } from '../permissions.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  DonePayload,
  KimiEffort,
  PermissionPolicy,
  WritablePathsPermissionMapping,
} from '../types.js';
import { doneResumeTokenPayload } from './resume-token.js';

const AGENT = 'kimi' as const;
const AUTH_REQUIRED_CODE = -32000;
const ACP_MESSAGE_LIMIT = 16 * 1024 * 1024;
const PROCESS_STDIN_EXIT_GRACE_MS = 10_000;
const PROCESS_SIGNAL_EXIT_GRACE_MS = 1_000;
const CANCEL_TERMINATION_DELAY_MS = 1_000;
const STDERR_BUFFER_LIMIT = 64 * 1024;

const DEFAULT_DONE_USAGE: DonePayload['usage'] = {
  inputTokens: 0,
  outputTokens: 0,
  toolUses: 0,
};

type SpawnProcessFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface ProcessClose {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface KimiAdapterDeps {
  spawnProcess?: SpawnProcessFn;
  probeAvailability?: () => Promise<boolean>;
  processStdinExitGraceMs?: number;
  processSignalExitGraceMs?: number;
}

export interface KimiPermissionOptions {
  mode?: 'auto';
  writablePaths?: WritablePathsPermissionMapping;
}

export interface KimiMappedOptions {
  cwd: string;
  model?: string;
  effort?: KimiEffort;
  permissions: KimiPermissionOptions;
}

interface ParsedToolInput {
  input: Record<string, unknown>;
  ready: boolean;
}

type AcpStream = ReturnType<typeof ndJsonStream>;

type AcpResultSchema<Result> = {
  parse: (value: unknown) => Result;
};

interface ToolState {
  title?: string;
  kind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[] | null;
  status?: ToolCallStatus | null;
  useEmitted: boolean;
  resultEmitted: boolean;
  startedAt: number;
}

class AsyncEventQueue {
  private readonly values: AgentEvent[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<AgentEvent>) => void
  > = [];
  private ended = false;

  push(value: AgentEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<AgentEvent>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolveNext) => this.waiters.push(resolveNext));
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return { next: () => this.next() };
  }
}

const execFileAsync = promisify(execFile);

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return spawn(command, args, options) as ChildProcessWithoutNullStreams;
}

async function defaultProbeAvailability(): Promise<boolean> {
  try {
    await execFileAsync('kimi', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function mapPermissionsToKimiOptions(
  policy: PermissionPolicy | undefined,
): KimiPermissionOptions {
  const writablePaths = mapWritablePathsPermission(policy, 'ambient');

  if (policy === undefined) {
    return {};
  }

  if (policy.mode === 'bypass') {
    throw new Error(
      'permissions.mode "bypass" is unsupported by Kimi ACP because its yolo mode is not an unchecked bypass',
    );
  }

  if (policy.mode !== 'auto') {
    throw new Error(
      'Kimi ACP requires permissions.mode "auto" when a permission policy is provided; capability-only and empty policies cannot be enforced deterministically',
    );
  }

  return {
    mode: 'auto',
    ...(writablePaths ? { writablePaths } : {}),
  };
}

export function mapAgentOptionsToKimiOptions(
  options: AgentOptions<KimiEffort> | undefined,
): KimiMappedOptions {
  if (options?.allowedTools !== undefined) {
    throw new Error(
      'allowedTools is unsupported by Kimi ACP because it cannot constrain the available tool registry',
    );
  }
  if (options?.disallowedTools !== undefined) {
    throw new Error(
      'disallowedTools is unsupported by Kimi ACP because it cannot constrain the available tool registry',
    );
  }
  if (options?.maxTurns !== undefined) {
    throw new Error(
      'maxTurns is unsupported by Kimi ACP because it has no compatible per-run turn limit',
    );
  }
  if (options?.maxBudgetUsd !== undefined) {
    throw new Error(
      'maxBudgetUsd is unsupported by Kimi ACP because it has no compatible per-run budget limit',
    );
  }
  if (options?.effort !== undefined) {
    assertSupportedEffort(AGENT, options.effort);
  }

  return {
    cwd: resolve(options?.cwd ?? process.cwd()),
    ...(options?.model !== undefined ? { model: options.model } : {}),
    ...(options?.effort !== undefined ? { effort: options.effort } : {}),
    permissions: mapPermissionsToKimiOptions(options?.permissions),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requestIdKey(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number'
    ? `${typeof value}:${String(value)}`
    : undefined;
}

function malformedAcpTraffic(detail: string): Error {
  return new Error(`Malformed Kimi ACP traffic: ${detail}`);
}

function parseAcpResult<Result>(
  schema: AcpResultSchema<Result>,
  value: unknown,
  method: string,
): Result {
  try {
    return schema.parse(value);
  } catch {
    throw malformedAcpTraffic(`invalid ${method} response result`);
  }
}

function validateInboundAcpMessage(
  value: unknown,
  pendingRequestIds: Set<string>,
): void {
  const message = asRecord(value);
  if (!message || message.jsonrpc !== '2.0') {
    throw malformedAcpTraffic('expected a JSON-RPC 2.0 object');
  }

  const hasMethod = hasOwn(message, 'method');
  const hasId = hasOwn(message, 'id');
  const hasResult = hasOwn(message, 'result');
  const hasError = hasOwn(message, 'error');

  if (hasMethod) {
    if (
      typeof message.method !== 'string' ||
      message.method.length === 0 ||
      hasResult ||
      hasError
    ) {
      throw malformedAcpTraffic('invalid request or notification envelope');
    }
    if (hasId && requestIdKey(message.id) === undefined) {
      throw malformedAcpTraffic('request id must be a string or number');
    }

    try {
      if (message.method === 'session/update') {
        if (hasId) {
          throw malformedAcpTraffic('session/update must be a notification');
        }
        zSessionNotification.parse(message.params);
      } else if (message.method === 'session/request_permission') {
        if (!hasId) {
          throw malformedAcpTraffic(
            'session/request_permission must be a request',
          );
        }
        zRequestPermissionRequest.parse(message.params);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Malformed ')) {
        throw error;
      }
      throw malformedAcpTraffic(`invalid ${message.method} parameters`);
    }
    return;
  }

  if (!hasId || hasResult === hasError) {
    throw malformedAcpTraffic(
      'response must contain exactly one result or error',
    );
  }
  const idKey = requestIdKey(message.id);
  if (!idKey || !pendingRequestIds.has(idKey)) {
    throw malformedAcpTraffic('response id does not match a pending request');
  }
  if (hasError) {
    try {
      zError.parse(message.error);
    } catch {
      throw malformedAcpTraffic('invalid JSON-RPC error object');
    }
  }
  pendingRequestIds.delete(idKey);
}

function trackOutboundAcpRequest(
  value: unknown,
  pendingRequestIds: Set<string>,
): void {
  const message = asRecord(value);
  if (
    !message ||
    typeof message.method !== 'string' ||
    !hasOwn(message, 'id')
  ) {
    return;
  }
  const idKey = requestIdKey(message.id);
  if (idKey) pendingRequestIds.add(idKey);
}

function strictAcpStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  onProtocolError: (error: Error) => void,
): AcpStream {
  const pendingRequestIds = new Set<string>();
  const encoder = new TextEncoder();
  const outputDecoder = new TextDecoder('utf-8', { fatal: true });
  const outputWriter = output.getWriter();
  const trackedOutput = new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        const lines = outputDecoder
          .decode(chunk)
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        for (const line of lines) {
          trackOutboundAcpRequest(
            JSON.parse(line) as unknown,
            pendingRequestIds,
          );
        }
      } catch {
        throw new Error('Failed to inspect an outbound Kimi ACP request');
      }
      await outputWriter.write(chunk);
    },
    async close() {
      await outputWriter.close();
      outputWriter.releaseLock();
    },
    async abort(reason) {
      try {
        await outputWriter.abort(reason);
      } finally {
        outputWriter.releaseLock();
      }
    },
  });

  const strictInput = new ReadableStream<Uint8Array>({
    async start(controller) {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const reader = input.getReader();
      let content = '';

      const decode = (
        chunk?: Uint8Array,
        options?: TextDecodeOptions,
      ): string => {
        try {
          return decoder.decode(chunk, options);
        } catch {
          throw malformedAcpTraffic('invalid UTF-8');
        }
      };

      const emitLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        let message: unknown;
        try {
          message = JSON.parse(trimmed) as unknown;
        } catch {
          throw malformedAcpTraffic('invalid JSON');
        }
        validateInboundAcpMessage(message, pendingRequestIds);
        controller.enqueue(encoder.encode(`${trimmed}\n`));
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            content += decode();
            break;
          }
          if (!value) continue;
          content += decode(value, { stream: true });
          if (content.length > ACP_MESSAGE_LIMIT) {
            throw malformedAcpTraffic('message exceeds the size limit');
          }
          const lines = content.split('\n');
          content = lines.pop() ?? '';
          for (const line of lines) emitLine(line);
        }
        emitLine(content);
        controller.close();
      } catch (error) {
        const protocolError =
          error instanceof Error
            ? error
            : malformedAcpTraffic('unknown stream failure');
        onProtocolError(protocolError);
        controller.error(protocolError);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return ndJsonStream(trackedOutput, strictInput) as AcpStream;
}

function parseToolInput(
  value: unknown,
  allowFallback: boolean,
): ParsedToolInput {
  const record = asRecord(value);
  if (record) return { input: record, ready: true };

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      const parsedRecord = asRecord(parsed);
      if (parsedRecord) return { input: parsedRecord, ready: true };
    } catch {
      // Streaming tool JSON may be incomplete until a later update.
    }
    return {
      input: value.length > 0 ? { raw: value } : {},
      ready: allowFallback,
    };
  }

  if (value === undefined || value === null) {
    return { input: {}, ready: allowFallback };
  }

  return { input: { value }, ready: allowFallback };
}

function textFromToolContent(
  content: ToolCallContent[] | null | undefined,
): string | undefined {
  if (!content) return undefined;
  const chunks: string[] = [];
  for (const item of content) {
    if (item.type !== 'content') continue;
    if (item.content.type === 'text') chunks.push(item.content.text);
  }
  return chunks.length > 0 ? chunks.join('\n') : undefined;
}

function toolOutput(state: ToolState): unknown {
  if (state.rawOutput !== undefined) return state.rawOutput;
  const text = textFromToolContent(state.content);
  if (text !== undefined) return text;
  return state.content ?? null;
}

function selectedConfigValue(
  options: SessionConfigOption[] | null | undefined,
  id: string,
): string | undefined {
  const option = options?.find((candidate) => candidate.id === id);
  return option?.type === 'select' ? option.currentValue : undefined;
}

function mapUsage(
  usage: Usage | null | undefined,
  toolUses: number,
): DonePayload['usage'] {
  if (!usage) return { ...DEFAULT_DONE_USAGE, toolUses };
  return {
    inputTokens:
      usage.inputTokens +
      (usage.cachedReadTokens ?? 0) +
      (usage.cachedWriteTokens ?? 0),
    outputTokens: usage.outputTokens,
    toolUses,
  };
}

function errorCode(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'number'
    ? (error as { code: number }).code
    : undefined;
}

function errorMessage(error: unknown, stderr: string): string {
  const baseMessage = error instanceof Error ? error.message : String(error);
  const errorRecord = asRecord(error);
  const data = asRecord(errorRecord?.data);
  const detail = [data?.details, data?.detail, data?.message].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const base =
    detail && !baseMessage.includes(detail)
      ? `${baseMessage}: ${detail}`
      : baseMessage;
  const diagnostic = stderr.trim();
  if (diagnostic.length === 0 || base.includes(diagnostic)) return base;
  return `${base}; kimi stderr: ${diagnostic.slice(-4000)}`;
}

function processCloseError(
  close: ProcessClose,
  cleanupSigtermSent: boolean,
): Error | undefined {
  if (close.error) return close.error;
  if (close.signal) {
    if (close.signal === 'SIGTERM' && cleanupSigtermSent) return undefined;
    return new Error(`Kimi ACP process exited on signal ${close.signal}`);
  }
  if (close.code !== 0) {
    return new Error(`Kimi ACP process exited with code ${String(close.code)}`);
  }
  return undefined;
}

function kimiResumeTokenPayload(
  status: DonePayload['status'],
  backendSessionKnown: boolean,
  sessionId: string,
  resume: string | undefined,
): { resumeToken?: string } {
  if (status === 'error' && !backendSessionKnown && resume) {
    return { resumeToken: resume };
  }
  return doneResumeTokenPayload(status, backendSessionKnown, sessionId, resume);
}

function isAuthenticationError(error: unknown): boolean {
  return (
    errorCode(error) === AUTH_REQUIRED_CODE ||
    /auth(?:entication)?(?:\s+is)?\s+required|auth(?:entication|orization)?\s+failed|not authenticated|unauthori[sz]ed|login required|(?:missing|invalid)\s+(?:api\s+)?key|(?:api\s+)?key\s+(?:is\s+)?invalid/iu.test(
      errorMessage(error, ''),
    )
  );
}

function waitForClose(
  closePromise: Promise<ProcessClose>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolveWait) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveWait(false);
    }, timeoutMs);
    void closePromise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveWait(true);
    });
  });
}

function endOrKill(child: ChildProcessWithoutNullStreams): void {
  try {
    child.stdin.end();
  } catch {
    // The process may already have closed its input stream.
  }
}

function killProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  try {
    child.kill(signal);
  } catch {
    // Ignore shutdown races with a process that already exited.
  }
}

export class KimiAdapter implements AgentAdapter<KimiEffort> {
  readonly agent = AGENT;

  private readonly spawnProcess: SpawnProcessFn;
  private readonly probeAvailability: () => Promise<boolean>;
  private readonly processStdinExitGraceMs: number;
  private readonly processSignalExitGraceMs: number;

  constructor(deps: KimiAdapterDeps = {}) {
    this.spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
    this.probeAvailability = deps.probeAvailability ?? defaultProbeAvailability;
    this.processStdinExitGraceMs =
      deps.processStdinExitGraceMs ?? PROCESS_STDIN_EXIT_GRACE_MS;
    this.processSignalExitGraceMs =
      deps.processSignalExitGraceMs ?? PROCESS_SIGNAL_EXIT_GRACE_MS;
  }

  async isAvailable(): Promise<boolean> {
    return this.probeAvailability();
  }

  async *run(
    prompt: string,
    options?: AgentOptions<KimiEffort>,
  ): AsyncGenerator<AgentEvent, void, void> {
    const mapped = mapAgentOptionsToKimiOptions(options);
    const startTime = Date.now();
    const queue = new AsyncEventQueue();

    let sessionId = options?.resume || generateSessionId();
    let backendSessionKnown = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let closePromise: Promise<ProcessClose> | undefined;
    let processClose: ProcessClose | undefined;
    let connection: ClientSideConnection | undefined;
    let processExited = false;
    let stderr = '';
    let abortRequested = options?.abortSignal?.aborted === true;
    let cancelSent = false;
    let terminationScheduled = false;
    let terminalQueued = false;
    let protocolFailure: Error | undefined;
    let promptActive = false;
    let cleanupSigtermSent = false;
    let assistantText = '';
    let emittedToolUses = 0;
    const tools = new Map<string, ToolState>();

    const push = (event: AgentEvent): void => {
      if (!terminalQueued) queue.push(event);
    };

    const finish = (
      status: DonePayload['status'],
      usage: DonePayload['usage'] = {
        ...DEFAULT_DONE_USAGE,
        toolUses: emittedToolUses,
      },
    ): void => {
      if (terminalQueued) return;
      terminalQueued = true;
      queue.push(
        createEvent(
          'done',
          AGENT,
          {
            status,
            ...(assistantText.length > 0 ? { result: assistantText } : {}),
            ...kimiResumeTokenPayload(
              status,
              backendSessionKnown,
              sessionId,
              options?.resume,
            ),
            usage,
            durationMs: Date.now() - startTime,
          },
          sessionId,
        ),
      );
      queue.close();
    };

    const scheduleTermination = (delayMs: number): void => {
      if (!child || processExited || terminationScheduled) return;
      terminationScheduled = true;
      const terminate = (): void => {
        if (!child || processExited) return;
        killProcess(child);
        setTimeout(() => {
          if (child && !processExited) killProcess(child, 'SIGKILL');
        }, this.processSignalExitGraceMs).unref();
      };
      if (delayMs === 0) {
        terminate();
      } else {
        setTimeout(terminate, delayMs).unref();
      }
    };

    const recordProtocolFailure = (detail: string): void => {
      const error = malformedAcpTraffic(detail);
      protocolFailure ??= error;
      scheduleTermination(0);
    };

    const emitToolUse = (
      toolCallId: string,
      state: ToolState,
      force: boolean,
    ): void => {
      if (state.useEmitted || terminalQueued) return;
      const parsed = parseToolInput(state.rawInput, force);
      if (!parsed.ready) return;
      const toolName = state.title ?? state.kind ?? 'unknown_tool';
      state.useEmitted = true;
      emittedToolUses += 1;
      push(
        createEvent(
          'tool_use',
          AGENT,
          {
            toolName,
            toolUseId: toolCallId,
            input: parsed.input,
            ...(state.title ? { description: state.title } : {}),
          },
          sessionId,
        ),
      );
    };

    const handleToolUpdate = (update: SessionUpdate): void => {
      if (
        update.sessionUpdate !== 'tool_call' &&
        update.sessionUpdate !== 'tool_call_update'
      ) {
        return;
      }

      const existing = tools.get(update.toolCallId);
      const state: ToolState = existing ?? {
        useEmitted: false,
        resultEmitted: false,
        startedAt: Date.now(),
      };
      if (update.title !== undefined && update.title !== null) {
        state.title = update.title;
      }
      if (update.kind !== undefined && update.kind !== null) {
        state.kind = update.kind;
      }
      if (update.rawInput !== undefined) state.rawInput = update.rawInput;
      if (update.rawOutput !== undefined) state.rawOutput = update.rawOutput;
      if (update.content !== undefined) state.content = update.content;
      if (update.status !== undefined) state.status = update.status;
      tools.set(update.toolCallId, state);

      const terminal =
        state.status === 'completed' || state.status === 'failed';
      emitToolUse(update.toolCallId, state, terminal);

      if (terminal && !state.resultEmitted && state.useEmitted) {
        state.resultEmitted = true;
        push(
          createEvent(
            'tool_result',
            AGENT,
            {
              toolName: state.title ?? state.kind ?? 'unknown_tool',
              toolUseId: update.toolCallId,
              status: state.status === 'failed' ? 'error' : 'success',
              output: toolOutput(state),
              durationMs: Date.now() - state.startedAt,
            },
            sessionId,
          ),
        );
      }
    };

    const handleSessionUpdate = async (
      notification: SessionNotification,
    ): Promise<void> => {
      if (terminalQueued) return;
      if (!backendSessionKnown || notification.sessionId !== sessionId) {
        recordProtocolFailure('session/update referenced a non-active session');
        return;
      }
      const update = notification.update;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content.type === 'text') {
            assistantText += update.content.text;
            push(
              createEvent(
                'text_delta',
                AGENT,
                { delta: update.content.text },
                sessionId,
              ),
            );
          }
          return;
        case 'agent_thought_chunk':
        case 'user_message_chunk':
          return;
        case 'tool_call':
        case 'tool_call_update':
          handleToolUpdate(update);
          return;
        case 'plan':
        case 'plan_update':
        case 'plan_removed':
          push(createEvent('kimi:plan', AGENT, update, sessionId));
          return;
        default:
          return;
      }
    };

    const handlePermissionRequest = async (
      request: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      if (
        !backendSessionKnown ||
        !promptActive ||
        request.sessionId !== sessionId
      ) {
        recordProtocolFailure(
          'session/request_permission referenced a non-active prompt session',
        );
        return { outcome: { outcome: 'cancelled' } };
      }
      if (!terminalQueued) {
        push(
          createEvent(
            'permission_request',
            AGENT,
            {
              toolName:
                request.toolCall.title ??
                request.toolCall.kind ??
                'unknown_tool',
              toolUseId: request.toolCall.toolCallId,
              input: parseToolInput(request.toolCall.rawInput, true).input,
              reason: 'Kimi requested permission during a headless ACP run',
            },
            sessionId,
          ),
        );
      }

      if (abortRequested) return { outcome: { outcome: 'cancelled' } };
      const terminalReject = request.options.find(
        (option) =>
          (option.kind === 'reject_once' || option.kind === 'reject_always') &&
          (option.optionId === 'plan_reject_and_exit' ||
            option.name.trim().toLowerCase() === 'reject and exit'),
      );
      const reject =
        terminalReject ??
        request.options.find((option) => option.kind === 'reject_once') ??
        request.options.find((option) => option.kind === 'reject_always');
      return reject
        ? {
            outcome: {
              outcome: 'selected',
              optionId: reject.optionId,
            },
          }
        : { outcome: { outcome: 'cancelled' } };
    };

    const shutdownProcess = async (): Promise<ProcessClose | undefined> => {
      if (!child || !closePromise) return undefined;
      if (!processExited) endOrKill(child);
      if (!(await waitForClose(closePromise, this.processStdinExitGraceMs))) {
        cleanupSigtermSent = true;
        killProcess(child);
        if (
          !(await waitForClose(closePromise, this.processSignalExitGraceMs))
        ) {
          killProcess(child, 'SIGKILL');
          if (
            !(await waitForClose(closePromise, this.processSignalExitGraceMs))
          ) {
            return {
              code: null,
              signal: null,
              error: new Error(
                'Kimi ACP process did not exit after stdin closed, SIGTERM, and SIGKILL',
              ),
            };
          }
        }
      }
      return processClose;
    };

    const onAbort = (): void => {
      abortRequested = true;
      if (!child || processExited) return;
      if (connection && backendSessionKnown) {
        if (cancelSent) return;
        cancelSent = true;
        void connection.cancel({ sessionId }).catch(() => killProcess(child!));
        scheduleTermination(CANCEL_TERMINATION_DELAY_MS);
        return;
      }
      scheduleTermination(0);
    };

    if (options?.abortSignal && !options.abortSignal.aborted) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    if (abortRequested) {
      finish('interrupted');
      for await (const event of queue) yield event;
      options?.abortSignal?.removeEventListener('abort', onAbort);
      return;
    }

    const execute = async (): Promise<void> => {
      try {
        child = this.spawnProcess('kimi', ['acp'], {
          cwd: mapped.cwd,
          env: process.env,
          shell: false,
          stdio: 'pipe',
        });
        const processRef = child;

        processRef.stderr.setEncoding('utf8');
        processRef.stderr.on('data', (chunk: string | Buffer) => {
          stderr = (
            stderr +
            (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
          ).slice(-STDERR_BUFFER_LIMIT);
        });

        closePromise = new Promise<ProcessClose>((resolveClose) => {
          const settleClose = (outcome: ProcessClose): void => {
            if (processClose) return;
            processClose = outcome;
            processExited = true;
            resolveClose(outcome);
          };
          processRef.once('close', (code, signal) => {
            settleClose({ code, signal });
          });
          processRef.once('error', (error) => {
            settleClose({ code: null, signal: null, error });
          });
        });

        const client: Client = {
          requestPermission: handlePermissionRequest,
          sessionUpdate: handleSessionUpdate,
        };
        connection = new ClientSideConnection(
          () => client,
          strictAcpStream(
            Writable.toWeb(processRef.stdin),
            Readable.toWeb(
              processRef.stdout,
            ) as unknown as ReadableStream<Uint8Array>,
            (error) => {
              protocolFailure ??= error;
              scheduleTermination(0);
            },
          ),
        );

        if (abortRequested) {
          onAbort();
          throw new Error('Kimi ACP run aborted during startup');
        }

        const initialized = parseAcpResult(
          zInitializeResponse,
          await connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          }),
          'initialize',
        );
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(
            `Kimi ACP negotiated unsupported protocol version ${initialized.protocolVersion}; expected ${PROTOCOL_VERSION}`,
          );
        }

        let configOptions: SessionConfigOption[] | null | undefined;
        if (options?.resume) {
          const resumed = parseAcpResult(
            zResumeSessionResponse,
            await connection.resumeSession({
              sessionId: options.resume,
              cwd: mapped.cwd,
              mcpServers: [],
            }),
            'session/resume',
          );
          sessionId = options.resume;
          backendSessionKnown = true;
          configOptions = resumed.configOptions;
        } else {
          const created = parseAcpResult(
            zNewSessionResponse,
            await connection.newSession({
              cwd: mapped.cwd,
              mcpServers: [],
            }),
            'session/new',
          );
          if (created.sessionId.trim().length === 0) {
            throw malformedAcpTraffic(
              'session/new returned an empty session id',
            );
          }
          sessionId = created.sessionId;
          backendSessionKnown = true;
          configOptions = created.configOptions;
        }

        if (abortRequested) {
          onAbort();
          throw new Error('Kimi ACP run aborted during session setup');
        }

        let effectiveModel =
          mapped.model ?? selectedConfigValue(configOptions, 'model');
        if (mapped.model !== undefined) {
          const response = parseAcpResult(
            zSetSessionConfigOptionResponse,
            await connection.setSessionConfigOption({
              sessionId,
              configId: 'model',
              value: mapped.model,
            }),
            'session/set_config_option',
          );
          configOptions = response.configOptions;
          effectiveModel =
            selectedConfigValue(configOptions, 'model') ?? mapped.model;
          if (abortRequested) {
            onAbort();
            throw new Error('Kimi ACP run aborted during model configuration');
          }
        }
        if (mapped.effort !== undefined) {
          const response = parseAcpResult(
            zSetSessionConfigOptionResponse,
            await connection.setSessionConfigOption({
              sessionId,
              configId: 'thinking',
              value: mapped.effort,
            }),
            'session/set_config_option',
          );
          configOptions = response.configOptions;
          if (abortRequested) {
            onAbort();
            throw new Error(
              'Kimi ACP run aborted during thinking configuration',
            );
          }
        }
        if (mapped.permissions.mode !== undefined) {
          const response = parseAcpResult(
            zSetSessionConfigOptionResponse,
            await connection.setSessionConfigOption({
              sessionId,
              configId: 'mode',
              value: mapped.permissions.mode,
            }),
            'session/set_config_option',
          );
          configOptions = response.configOptions;
          if (abortRequested) {
            onAbort();
            throw new Error('Kimi ACP run aborted during mode configuration');
          }
        }

        push(
          createEvent(
            'init',
            AGENT,
            {
              model: effectiveModel ?? 'unknown',
              cwd: mapped.cwd,
              tools: [],
              capabilities: {
                toolsKnown: false,
                toolsSource: 'unavailable',
                acpProtocolVersion: initialized.protocolVersion,
                ...(mapped.permissions.writablePaths
                  ? { writablePaths: mapped.permissions.writablePaths }
                  : {}),
              },
            },
            sessionId,
          ),
        );

        promptActive = true;
        let promptResponse: unknown;
        try {
          promptResponse = await connection.prompt({
            sessionId,
            prompt: [{ type: 'text', text: prompt }],
          });
        } finally {
          promptActive = false;
        }
        const result = parseAcpResult(
          zPromptResponse,
          promptResponse,
          'session/prompt',
        );

        const close = await shutdownProcess();
        if (!close) {
          throw new Error('Kimi ACP process close state was unavailable');
        }
        if (protocolFailure) throw protocolFailure;
        if (!abortRequested && result.stopReason !== 'cancelled') {
          const closeError = processCloseError(close, cleanupSigtermSent);
          if (closeError) throw closeError;
        }

        let status: DonePayload['status'];
        if (abortRequested || result.stopReason === 'cancelled') {
          status = 'interrupted';
        } else if (
          result.stopReason === 'max_tokens' ||
          result.stopReason === 'max_turn_requests'
        ) {
          status = 'max_turns';
        } else if (result.stopReason === 'refusal') {
          push(
            createEvent(
              'error',
              AGENT,
              {
                code: 'KIMI_REFUSAL',
                message: 'Kimi refused the prompt',
                recoverable: false,
              },
              sessionId,
            ),
          );
          status = 'error';
        } else {
          status = 'success';
        }
        finish(status, mapUsage(result.usage, emittedToolUses));
      } catch (error) {
        if (abortRequested) {
          finish('interrupted');
          return;
        }

        const closeFailure = processClose
          ? processCloseError(processClose, cleanupSigtermSent)
          : undefined;
        const structuredAuthError = isAuthenticationError(error);
        const reportedError = structuredAuthError
          ? error
          : (protocolFailure ?? closeFailure ?? error);
        const authError =
          structuredAuthError ||
          isAuthenticationError(errorMessage(reportedError, stderr));
        push(
          createEvent(
            'error',
            AGENT,
            {
              code: authError ? 'KIMI_AUTH_REQUIRED' : 'KIMI_ACP_ERROR',
              message: authError
                ? `${errorMessage(reportedError, stderr)}. Authenticate the Kimi Code CLI with \`kimi login\` before using ACP.`
                : errorMessage(reportedError, stderr),
              recoverable: false,
            },
            sessionId,
          ),
        );
        finish('error');
      } finally {
        await shutdownProcess();
      }
    };

    const execution = execute();
    try {
      for await (const event of queue) {
        yield event;
      }
      await execution;
    } finally {
      options?.abortSignal?.removeEventListener('abort', onAbort);
      if (!terminalQueued) {
        abortRequested = true;
        onAbort();
        queue.close();
      }
      await execution;
    }
  }
}
