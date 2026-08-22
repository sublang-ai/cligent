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
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus,
} from '@agentclientprotocol/sdk';
import type { AcpSessionConfigOption } from './acp-schema.js';
import {
  ACTED_ON_UPDATES,
  zAcpError as zError,
  zAcpInitializeResponse as zInitializeResponse,
  zAcpNewSessionResponse as zNewSessionResponse,
  zAcpPromptResponse as zPromptResponse,
  zAcpRequestPermissionRequest as zRequestPermissionRequest,
  zAcpResumeSessionResponse as zResumeSessionResponse,
  zAcpSessionNotification as zSessionNotification,
  zAcpSetSessionConfigOptionResponse as zSetSessionConfigOptionResponse,
} from './acp-schema.js';

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
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import {
  assertRuntimeSupported,
  isCliRuntimeSupported,
} from '../runtime-version.js';

const AGENT = 'kimi' as const;
const AUTH_REQUIRED_CODE = -32000;
const ACP_MESSAGE_LIMIT = 16 * 1024 * 1024;
const PROCESS_STDIN_EXIT_GRACE_MS = 10_000;
const PROCESS_SIGNAL_EXIT_GRACE_MS = 1_000;
const CANCEL_TERMINATION_DELAY_MS = 1_000;
const STDERR_BUFFER_LIMIT = 64 * 1024;

const DEFAULT_DONE_USAGE: DonePayload['usage'] = {
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

interface ShutdownOutcome {
  close?: ProcessClose;
  sentSigterm: boolean;
  requiredSigkill: boolean;
  survivedFinalGrace: boolean;
}

interface KimiAdapterDeps {
  spawnProcess?: SpawnProcessFn;
  probeAvailability?: () => Promise<boolean>;
  processStdinExitGraceMs?: number;
  processSignalExitGraceMs?: number;
  cancelTerminationDelayMs?: number;
  reportCleanupFailure?: (error: Error) => void;
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
    // engine-25: an executable that runs is not necessarily one this release
    // supports, and reporting it available here while the readiness verdict
    // calls it unsupported is exactly the disagreement DR-013 forbids.
    return isCliRuntimeSupported(AGENT_RUNTIME_TARGETS.kimi[0]!);
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

/**
 * Validates one inbound message and reports whether it should reach the SDK.
 *
 * A `session/update` naming a case this adapter does not act on is dropped:
 * the adapter would ignore it, while the pinned SDK rejects it against its
 * own closed union and logs an error, so forwarding it produces noise and no
 * behavior. Dropping makes "an unhandled case is ignored" true end to end.
 */
function validateInboundAcpMessage(
  value: unknown,
  pendingRequestIds: Set<string>,
): boolean {
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
        const notification = zSessionNotification.parse(message.params);
        if (!ACTED_ON_UPDATES.has(notification.update.sessionUpdate)) {
          return false;
        }
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
    return true;
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
  return true;
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
        if (!validateInboundAcpMessage(message, pendingRequestIds)) return;
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
  options: AcpSessionConfigOption[] | null | undefined,
  id: string,
): string | undefined {
  const option = options?.find((candidate) => candidate.id === id);
  if (option?.type !== 'select') return undefined;
  // The schema requires a string here for a select, so this narrowing only
  // restates that guarantee for the loose non-select arm of the union.
  const { currentValue } = option as { currentValue?: unknown };
  return typeof currentValue === 'string' ? currentValue : undefined;
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

function shutdownError(outcome: ShutdownOutcome): Error | undefined {
  if (outcome.survivedFinalGrace) {
    return new Error(
      'Kimi ACP process did not exit after stdin closed, SIGTERM, and SIGKILL',
    );
  }
  if (outcome.requiredSigkill) {
    return new Error('Kimi ACP process required SIGKILL during cleanup');
  }
  return outcome.close
    ? processCloseError(outcome.close, outcome.sentSigterm)
    : new Error('Kimi ACP process close state was unavailable');
}

function defaultReportCleanupFailure(error: Error): void {
  console.error(`Kimi ACP cleanup after caller abort failed: ${error.message}`);
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
  private readonly cancelTerminationDelayMs: number;
  private readonly reportCleanupFailure: (error: Error) => void;

  constructor(deps: KimiAdapterDeps = {}) {
    this.spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
    this.probeAvailability = deps.probeAvailability ?? defaultProbeAvailability;
    this.processStdinExitGraceMs =
      deps.processStdinExitGraceMs ?? PROCESS_STDIN_EXIT_GRACE_MS;
    this.processSignalExitGraceMs =
      deps.processSignalExitGraceMs ?? PROCESS_SIGNAL_EXIT_GRACE_MS;
    this.cancelTerminationDelayMs =
      deps.cancelTerminationDelayMs ?? CANCEL_TERMINATION_DELAY_MS;
    this.reportCleanupFailure =
      deps.reportCleanupFailure ?? defaultReportCleanupFailure;
  }

  async isAvailable(): Promise<boolean> {
    return this.probeAvailability();
  }

  async *run(
    prompt: string,
    options?: AgentOptions<KimiEffort>,
  ): AsyncGenerator<AgentEvent, void, void> {
    const startTime = Date.now();
    const initialSessionId = options?.resume || generateSessionId();
    if (options?.abortSignal?.aborted) {
      yield createEvent(
        'done',
        AGENT,
        {
          status: 'interrupted',
          ...kimiResumeTokenPayload(
            'interrupted',
            false,
            initialSessionId,
            options?.resume,
          ),
          usage: { ...DEFAULT_DONE_USAGE },
          durationMs: Date.now() - startTime,
        },
        initialSessionId,
      );
      return;
    }

    // engine-25: gate the direct run path too, not only `isAvailable()`.
    assertRuntimeSupported(
      AGENT_RUNTIME_TARGETS.kimi[0]!,
      `npm install -g ${AGENT_RUNTIME_TARGETS.kimi[0]!.repairSpec}`,
    );
    const mapped = mapAgentOptionsToKimiOptions(options);
    const queue = new AsyncEventQueue();

    let sessionId = initialSessionId;
    let backendSessionKnown = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let closePromise: Promise<ProcessClose> | undefined;
    let processClose: ProcessClose | undefined;
    let connection: ClientSideConnection | undefined;
    let processExited = false;
    let stderr = '';
    let abortRequested = options?.abortSignal?.aborted === true;
    let cancelSent = false;
    let abortFinalizationScheduled = false;
    let terminalQueued = false;
    let protocolFailure: Error | undefined;
    let promptActive = false;
    let stdinEnded = false;
    let cleanupSigtermSent = false;
    let cleanupSigkillSent = false;
    let cleanupFailureReported = false;
    let terminalCause: 'caller-abort' | 'non-abort' | undefined;
    let shutdownPromise: Promise<ShutdownOutcome | undefined> | undefined;
    let abortFinalizationPromise: Promise<void> | undefined;
    let removeAbortListener = (): void => {};
    let assistantText = '';
    let emittedToolUses = 0;
    const tools = new Map<string, ToolState>();

    let terminalDelivered = false;
    let resolveTerminalDelivered: (() => void) | undefined;
    const terminalDelivery = new Promise<void>((resolveDelivery) => {
      resolveTerminalDelivered = resolveDelivery;
    });
    const markTerminalDelivered = (): void => {
      if (terminalDelivered) return;
      terminalDelivered = true;
      resolveTerminalDelivered?.();
    };
    let terminalHandoff: Promise<void> | undefined;
    const waitForTerminalHandoff = (): Promise<void> => {
      // kimi-25: an active consumer advances past the queued terminal first,
      // while one handoff keeps a stalled iterator from blocking containment.
      terminalHandoff ??= Promise.race([
        terminalDelivery,
        new Promise<void>((resolveHandoff) => {
          setImmediate(resolveHandoff);
        }),
      ]);
      return terminalHandoff;
    };

    const commitCallerAbort = (): boolean => {
      if (terminalCause === 'non-abort') return false;
      terminalCause = 'caller-abort';
      abortRequested = true;
      removeAbortListener();
      return true;
    };

    const commitNonAbortCause = (): boolean => {
      if (terminalCause === 'caller-abort') return false;
      terminalCause = 'non-abort';
      removeAbortListener();
      return true;
    };

    let abortDeadlineReached = false;
    let resolveAbortDeadline: (() => void) | undefined;
    const abortDeadline = new Promise<void>((resolveDeadline) => {
      resolveAbortDeadline = resolveDeadline;
    });
    const reachAbortDeadline = (): void => {
      if (abortDeadlineReached) return;
      abortDeadlineReached = true;
      resolveAbortDeadline?.();
    };
    const awaitAcp = async <T>(operation: Promise<T>): Promise<T> => {
      const outcome = await Promise.race([
        operation.then((value) => ({ kind: 'value' as const, value })),
        abortDeadline.then(() => ({ kind: 'abort' as const })),
      ]);
      if (outcome.kind === 'abort') {
        throw new Error('Kimi ACP run aborted before the operation settled');
      }
      return outcome.value;
    };

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
      removeAbortListener();
    };

    let escalationRequested = false;
    let resolveEscalation: (() => void) | undefined;
    const escalation = new Promise<void>((resolveRequested) => {
      resolveEscalation = resolveRequested;
    });
    const requestEscalation = (): void => {
      if (escalationRequested) return;
      escalationRequested = true;
      resolveEscalation?.();
    };

    const waitForCloseOrEscalation = (): Promise<
      'closed' | 'timeout' | 'escalated'
    > =>
      new Promise((resolveWait) => {
        let settled = false;
        const settle = (outcome: 'closed' | 'timeout' | 'escalated'): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveWait(outcome);
        };
        const timer = setTimeout(
          () => settle('timeout'),
          this.processStdinExitGraceMs,
        );
        void closePromise?.then(() => settle('closed'));
        void escalation.then(() => settle('escalated'));
      });

    const sendSigterm = (): void => {
      if (!child || processExited || cleanupSigtermSent) return;
      if (terminalCause !== 'caller-abort') commitNonAbortCause();
      cleanupSigtermSent = true;
      killProcess(child);
    };

    const sendSigkill = (): void => {
      if (!child || processExited || cleanupSigkillSent) return;
      cleanupSigkillSent = true;
      killProcess(child, 'SIGKILL');
    };

    const closeProtocolTransport = (): void => {
      child?.stdout.destroy();
      child?.stdin.destroy();
      child?.stderr.destroy();
    };

    const shutdownProcess = (): Promise<ShutdownOutcome | undefined> => {
      shutdownPromise ??= (async () => {
        if (!child || !closePromise) return undefined;
        if (!processExited && !stdinEnded) {
          stdinEnded = true;
          endOrKill(child);
        }
        if (!processExited) {
          const firstWait = await waitForCloseOrEscalation();
          if (firstWait !== 'closed') {
            if (terminalCause === 'caller-abort') {
              await waitForTerminalHandoff();
            }
            sendSigterm();
            if (
              !(await waitForClose(closePromise, this.processSignalExitGraceMs))
            ) {
              sendSigkill();
              if (
                !(await waitForClose(
                  closePromise,
                  this.processSignalExitGraceMs,
                ))
              ) {
                closeProtocolTransport();
                return {
                  close: processClose,
                  sentSigterm: cleanupSigtermSent,
                  requiredSigkill: cleanupSigkillSent,
                  survivedFinalGrace: true,
                };
              }
            }
          }
        }
        return {
          close: processClose,
          sentSigterm: cleanupSigtermSent,
          requiredSigkill: cleanupSigkillSent,
          survivedFinalGrace: false,
        };
      })();
      return shutdownPromise;
    };

    const reportSecondaryCleanupFailure = (
      outcome: ShutdownOutcome | undefined,
    ): void => {
      if (!outcome || cleanupFailureReported) return;
      const failure = shutdownError(outcome);
      if (!failure) return;
      cleanupFailureReported = true;
      try {
        this.reportCleanupFailure(failure);
      } catch {
        // A diagnostic sink cannot restart or replace terminal cleanup.
      }
    };

    const finalizeAbort = (forceShutdown: boolean): Promise<void> => {
      abortFinalizationPromise ??= (async () => {
        finish('interrupted');
        await waitForTerminalHandoff();
        reachAbortDeadline();
        if (forceShutdown) requestEscalation();
        reportSecondaryCleanupFailure(await shutdownProcess());
      })();
      return abortFinalizationPromise;
    };

    const scheduleAbortFinalization = (
      delayMs: number,
      forceShutdown: boolean,
    ): void => {
      if (abortFinalizationScheduled || terminalQueued) return;
      abortFinalizationScheduled = true;
      const finalize = (): void => {
        void finalizeAbort(forceShutdown);
      };
      if (delayMs === 0) {
        finalize();
      } else {
        setTimeout(finalize, delayMs).unref();
      }
    };

    const recordProtocolFailure = (detail: string): void => {
      const error = malformedAcpTraffic(detail);
      protocolFailure ??= error;
      if (!commitNonAbortCause()) return;
      requestEscalation();
      void shutdownProcess();
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

    const onAbort = (): void => {
      if (terminalQueued || !commitCallerAbort()) return;
      if (child && !processExited && connection && backendSessionKnown) {
        if (cancelSent) {
          if (!promptActive) scheduleAbortFinalization(0, true);
          return;
        }
        cancelSent = true;
        void connection
          .cancel({ sessionId })
          .catch(() => void finalizeAbort(true));
        scheduleAbortFinalization(
          promptActive ? this.cancelTerminationDelayMs : 0,
          true,
        );
        return;
      }
      scheduleAbortFinalization(0, true);
    };

    removeAbortListener = (): void => {
      options?.abortSignal?.removeEventListener('abort', onAbort);
    };

    if (options?.abortSignal && !options.abortSignal.aborted) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    if (abortRequested) {
      commitCallerAbort();
      finish('interrupted');
      for await (const event of queue) {
        yield event;
        if (event.type === 'done') markTerminalDelivered();
      }
      markTerminalDelivered();
      removeAbortListener();
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
            commitNonAbortCause();
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
              if (!commitNonAbortCause()) return;
              requestEscalation();
              void shutdownProcess();
            },
          ),
        );

        if (abortRequested) {
          onAbort();
          throw new Error('Kimi ACP run aborted during startup');
        }

        const initialized = parseAcpResult(
          zInitializeResponse,
          await awaitAcp(
            connection.initialize({
              protocolVersion: PROTOCOL_VERSION,
              clientCapabilities: {},
            }),
          ),
          'initialize',
        );
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(
            `Kimi ACP negotiated unsupported protocol version ${initialized.protocolVersion}; expected ${PROTOCOL_VERSION}`,
          );
        }

        let configOptions: AcpSessionConfigOption[] | null | undefined;
        if (options?.resume) {
          const resumed = parseAcpResult(
            zResumeSessionResponse,
            await awaitAcp(
              connection.resumeSession({
                sessionId: options.resume,
                cwd: mapped.cwd,
                mcpServers: [],
              }),
            ),
            'session/resume',
          );
          sessionId = options.resume;
          backendSessionKnown = true;
          configOptions = resumed.configOptions;
        } else {
          const created = parseAcpResult(
            zNewSessionResponse,
            await awaitAcp(
              connection.newSession({
                cwd: mapped.cwd,
                mcpServers: [],
              }),
            ),
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
            await awaitAcp(
              connection.setSessionConfigOption({
                sessionId,
                configId: 'model',
                value: mapped.model,
              }),
            ),
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
            await awaitAcp(
              connection.setSessionConfigOption({
                sessionId,
                configId: 'thinking',
                value: mapped.effort,
              }),
            ),
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
            await awaitAcp(
              connection.setSessionConfigOption({
                sessionId,
                configId: 'mode',
                value: mapped.permissions.mode,
              }),
            ),
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
          promptResponse = await awaitAcp(
            connection.prompt({
              sessionId,
              prompt: [{ type: 'text', text: prompt }],
            }),
          );
        } finally {
          promptActive = false;
        }
        const result = parseAcpResult(
          zPromptResponse,
          promptResponse,
          'session/prompt',
        );

        if (abortRequested) {
          await finalizeAbort(false);
          return;
        }

        const shutdown = await shutdownProcess();
        if (abortRequested) {
          await finalizeAbort(true);
          return;
        }
        if (!shutdown) {
          throw new Error('Kimi ACP process close state was unavailable');
        }
        if (protocolFailure) throw protocolFailure;
        const closeFailure = shutdownError(shutdown);
        if (closeFailure) throw closeFailure;

        let status: DonePayload['status'];
        if (result.stopReason === 'cancelled') {
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
        // Kimi Code 0.31.1's ACP prompt response does not publish token
        // accounting. Keep the optional wire member isolated from terminal
        // status, but never promote it into Cligent's authentic usage report.
        finish(status);
      } catch (error) {
        if (abortRequested) {
          await finalizeAbort(true);
          return;
        }

        commitNonAbortCause();
        const shutdown = await shutdownProcess();
        const closeFailure = shutdown ? shutdownError(shutdown) : undefined;
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
        if (event.type === 'done') markTerminalDelivered();
      }
      await execution;
    } finally {
      markTerminalDelivered();
      removeAbortListener();
      if (!terminalQueued) {
        onAbort();
        queue.close();
      }
      await execution;
      await abortFinalizationPromise;
    }
  }
}
