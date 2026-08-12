// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile, spawn } from 'node:child_process';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { createEvent, generateSessionId } from '../events.js';
import { assertSupportedEffort } from '../effort.js';
import { mapWritablePathsPermission } from '../permissions.js';
import type {
  PermissionRuleset,
  SessionPromptAsyncData,
} from '@opencode-ai/sdk/v2';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  DonePayload,
  OpenCodeEffort,
  PermissionCapability,
  PermissionLevel,
  PermissionPolicy,
  WritablePathsPermissionMapping,
} from '../types.js';
import { doneResumeTokenPayload } from './resume-token.js';
import {
  isPermissionPolicyReset,
  PERMISSION_POLICY_RESET,
} from '../internal/permission-reset.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import {
  assertRuntimeSupported,
  isCliRuntimeSupported,
  isUnsupportedRuntimeError,
} from '../runtime-version.js';
import {
  buildTokenBreakdown,
  isUsageRecord,
  readUsageCounter,
} from './usage.js';

const AGENT = 'opencode' as const;
const DEFAULT_MANAGED_URL = 'http://127.0.0.1:0';
const DEFAULT_EVENT_INACTIVITY_TIMEOUT_MS = 300_000;
const MAX_STATUS_QUERY_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ITERATOR_CLEANUP_TIMEOUT_MS = 250;
const DEFAULT_MANAGED_SERVER_TERM_GRACE_MS = 1_500;
const DEFAULT_MANAGED_SERVER_KILL_GRACE_MS = 500;
const PERMISSION_REPLY_TIMEOUT_MS = 5_000;

const DEFAULT_DONE_USAGE: DonePayload['usage'] = {
  tokenAvailability: 'unavailable',
  inputTokens: 0,
  outputTokens: 0,
  toolUses: 0,
};

type OpenCodeMode = 'managed' | 'external';
type OpenCodeSdkApiVersion = 'v1' | 'v2';
type OpenCodeVariant = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type OpenCodeMessageRole = 'user' | 'assistant';
type OpenCodeContentKind = 'text' | 'reasoning';
type OpenCodePartKind = OpenCodeContentKind | 'other';
type OpenCodeV2PromptBody = NonNullable<SessionPromptAsyncData['body']>;

type SpawnProcessFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface ServerCloseInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

type StreamWaitResult =
  | { kind: 'event'; result: IteratorResult<unknown> }
  | { kind: 'iterator_error'; error: unknown }
  | { kind: 'caller_abort' }
  | { kind: 'inactivity' }
  | { kind: 'server_exit'; exit: ServerCloseInfo };

type PermissionReplyWaitResult =
  | { kind: 'replied' }
  | { kind: 'error'; error: unknown }
  | { kind: 'abort' }
  | { kind: 'timeout' };

interface OpenCodeClient {
  run?: (options: Record<string, unknown>) => Promise<unknown>;
  query?: (options: Record<string, unknown>) => Promise<unknown>;
  events?: (options?: Record<string, unknown>) => AsyncIterable<unknown>;
  subscribe?: (options?: Record<string, unknown>) => AsyncIterable<unknown>;
  getSessionStatus?: (options: {
    sessionId: string;
    cwd?: string;
  }) => Promise<unknown>;
  abortSession?: (options: {
    sessionId: string;
    cwd?: string;
  }) => Promise<void>;
  replyPermission?: (options: {
    sessionId: string;
    requestId: string;
    permission: string;
    decision: 'once' | 'reject';
    cwd?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  close?: () => Promise<void> | void;
  shutdown?: () => Promise<void> | void;
}

interface OpenCodeSdk {
  createClient: (options?: { baseUrl?: string }) => OpenCodeClient;
}

class OpenCodePromptDispatchAbortError extends Error {
  constructor(readonly sessionId?: string) {
    super('OpenCode run aborted during prompt dispatch');
    this.name = 'OpenCodePromptDispatchAbortError';
  }
}

export interface OpenCodeAdapterConfig {
  mode?: OpenCodeMode;
  serverUrl?: string;
  readyTimeoutMs?: number;
  /** Maximum silence between relevant events for the active session. */
  eventInactivityTimeoutMs?: number;
}

interface OpenCodeAdapterDeps {
  loadSdk?: () => Promise<OpenCodeSdk>;
  spawnProcess?: SpawnProcessFn;
  probeCliAvailability?: () => Promise<boolean>;
  waitForServerReady?: (
    process: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ) => Promise<string>;
  managedServerTermGraceMs?: number;
  managedServerKillGraceMs?: number;
}

interface OpenCodePermissionOptions {
  permission?: Record<string, PermissionLevel>;
  writablePaths?: WritablePathsPermissionMapping;
  [PERMISSION_POLICY_RESET]?: true;
}

interface WrapOpencodeClientOptions {
  apiVersion?: OpenCodeSdkApiVersion;
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
): Record<PermissionCapability, PermissionLevel> {
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

function parsePermissionPatterns(...values: unknown[]): string[] {
  for (const value of values) {
    const pattern = asString(value);
    if (pattern) return [pattern];

    const patterns = asStringArray(value);
    if (patterns.length > 0) return patterns;
  }

  return [];
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

function mapUsage(
  rawUsage: unknown,
  observedToolUses: number,
): DonePayload['usage'] {
  if (!isUsageRecord(rawUsage)) {
    return { ...DEFAULT_DONE_USAGE, toolUses: observedToolUses };
  }

  const baseInput = readUsageCounter(
    rawUsage,
    ['inputTokens', 'input_tokens'],
    true,
  );
  const cacheRead = readUsageCounter(
    rawUsage,
    ['cacheReadInputTokens', 'cache_read_input_tokens'],
    false,
  );
  const cacheCreation = readUsageCounter(
    rawUsage,
    ['cacheCreationInputTokens', 'cache_creation_input_tokens'],
    false,
  );
  const outputTokens = readUsageCounter(
    rawUsage,
    ['outputTokens', 'output_tokens'],
    true,
  );
  const reportedToolUses = readUsageCounter(
    rawUsage,
    ['toolUses', 'tool_uses'],
    false,
  );
  const toolUses = Math.max(
    reportedToolUses.valid ? reportedToolUses.value : 0,
    observedToolUses,
  );

  const totalCostUsd =
    asNumber(rawUsage.totalCostUsd) ?? asNumber(rawUsage.total_cost_usd);

  return {
    tokenAvailability:
      baseInput.valid &&
      cacheRead.valid &&
      cacheCreation.valid &&
      outputTokens.valid
        ? 'reported'
        : 'unavailable',
    inputTokens: baseInput.value + cacheRead.value + cacheCreation.value,
    outputTokens: outputTokens.value,
    toolUses,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

const OPENCODE_EVENT_TOKEN_COUNTER_KEYS = [
  'inputTokens',
  'input_tokens',
  'cacheReadInputTokens',
  'cache_read_input_tokens',
  'cacheCreationInputTokens',
  'cache_creation_input_tokens',
  'outputTokens',
  'output_tokens',
] as const;

function hasOpenCodeEventTokenCounters(rawUsage: unknown): boolean {
  if (!isUsageRecord(rawUsage)) return false;
  return OPENCODE_EVENT_TOKEN_COUNTER_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(rawUsage, key),
  );
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
    asString(record.sessionID) ??
    asString(record.sessionId) ??
    asString(record.session_id) ??
    asString(record.threadId) ??
    asString(record.thread_id) ??
    asString(session.id) ??
    asString(thread.id)
  );
}

function loadOpenCodeMessageRole(message: unknown): OpenCodeMessageRole | undefined {
  const record = asRecord(message);
  const info = asRecord(record.info);
  const nestedMessage = asRecord(record.message);
  const role = (
    asString(record.role) ??
    asString(info.role) ??
    asString(nestedMessage.role)
  )?.toLowerCase();

  return role === 'user' || role === 'assistant' ? role : undefined;
}

function loadOpenCodePartMessageId(event: Record<string, unknown>): string | undefined {
  const part = asRecord(
    event.part ?? asRecord(event.message).part ?? event.data,
  );
  const message = asRecord(event.message);

  return (
    asString(event.messageID) ??
    asString(event.messageId) ??
    asString(event.message_id) ??
    asString(event.assistantMessageID) ??
    asString(event.assistantMessageId) ??
    asString(part.messageID) ??
    asString(part.messageId) ??
    asString(part.message_id) ??
    asString(message.id)
  );
}

function loadOpenCodePartId(event: Record<string, unknown>): string | undefined {
  const part = asRecord(
    event.part ?? asRecord(event.message).part ?? event.data,
  );

  return (
    asString(event.partID) ??
    asString(event.partId) ??
    asString(event.part_id) ??
    asString(event.textID) ??
    asString(event.textId) ??
    asString(event.reasoningID) ??
    asString(event.reasoningId) ??
    asString(part.id)
  );
}

function loadOpenCodeUpdatedMessageId(
  event: Record<string, unknown>,
): string | undefined {
  const info = asRecord(event.info);
  const message = asRecord(event.message);

  return (
    asString(event.messageID) ??
    asString(event.messageId) ??
    asString(event.message_id) ??
    asString(info.id) ??
    asString(message.id) ??
    asString(event.id)
  );
}

function loadOpenCodePartKind(
  event: Record<string, unknown>,
): OpenCodePartKind | undefined {
  const message = asRecord(event.message);
  const part = asRecord(event.part ?? message.part ?? event.data);
  const partType = asString(part.type)?.toLowerCase();

  if (!partType) return undefined;

  if (
    partType === 'text' ||
    partType === 'output_text' ||
    partType === 'message_text'
  ) {
    return 'text';
  }
  if (partType === 'thinking' || partType === 'reasoning') {
    return 'reasoning';
  }

  return 'other';
}

function isOpenCodeDeltaEvent(eventType: string): boolean {
  return (
    eventType === 'message.part.delta' ||
    eventType === 'session.next.text.delta' ||
    eventType === 'session.next.reasoning.delta'
  );
}

function normalizeOpenCodeContentEvent(
  eventType: string,
  event: Record<string, unknown>,
  contentKind: OpenCodeContentKind,
  sessionId: string,
): AgentEvent | undefined {
  const message = asRecord(event.message);
  const part = asRecord(event.part ?? message.part ?? event.data);
  const delta = asString(event.delta) ?? asString(part.delta);

  // Canonical v1 message.part.updated places delta beside part. Canonical v2
  // uses generic or explicitly typed delta events. Reasoning deltas are
  // intentionally suppressed in favor of the settled thinking snapshots.
  if (isOpenCodeDeltaEvent(eventType) || delta) {
    if (contentKind === 'reasoning') return undefined;

    return delta
      ? createEvent('text_delta', AGENT, { delta }, sessionId)
      : undefined;
  }

  if (contentKind === 'text') {
    const content =
      asString(part.text) ??
      asString(part.content) ??
      asString(asRecord(part.content).text);
    return content
      ? createEvent('text', AGENT, { content }, sessionId)
      : undefined;
  }

  const summary =
    asString(part.summary) ??
    asString(part.text) ??
    asString(part.content);
  return summary
    ? createEvent('thinking', AGENT, { summary }, sessionId)
    : undefined;
}

function toErrorPayload(message: unknown): {
  code?: string;
  message: string;
  recoverable: boolean;
} {
  const top = asRecord(message);
  const nested = asRecord(top.error);
  const data = asRecord(top.data);
  const nestedData = asRecord(nested.data);

  const code =
    asString(top.code) ??
    asString(nested.code) ??
    asString(nested.type);

  const text =
    asString(top.message) ??
    asString(nested.message) ??
    asString(data.message) ??
    asString(nestedData.message) ??
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
    return Promise.resolve(result).then(
      () => {},
      () => {},
    );
  } catch {
    return Promise.resolve();
  }
}

async function maybeCallAsyncWithin(
  fn: (() => Promise<void> | void) | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!fn) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      maybeCallAsync(fn),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function promiseSettlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createMonotonicInactivityTimer(timeoutMs: number): {
  promise: Promise<{ kind: 'inactivity' }>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let resolveDeadline!: (value: { kind: 'inactivity' }) => void;
  const promise = new Promise<{ kind: 'inactivity' }>((resolve) => {
    resolveDeadline = resolve;
  });
  const deadline = performance.now() + timeoutMs;

  const scheduleNextChunk = () => {
    if (cancelled) return;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      resolveDeadline({ kind: 'inactivity' });
      return;
    }

    timer = setTimeout(
      scheduleNextChunk,
      Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.ceil(remainingMs))),
    );
  };

  scheduleNextChunk();
  return {
    promise,
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function assertFinitePositiveTimeout(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than 0`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function diagnosticJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function unwrapSdkData(value: unknown): unknown {
  const record = asRecord(value);
  return Object.prototype.hasOwnProperty.call(record, 'data')
    ? record.data
    : value;
}

function sessionStatusType(value: unknown): string | undefined {
  return asString(asRecord(value).type)?.toLowerCase() ??
    asString(value)?.toLowerCase();
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
    // ENG-025: PKG-012 pairs this CLI with the SDK, so an executable that
    // merely runs is not necessarily one this release supports.
    return isCliRuntimeSupported(AGENT_RUNTIME_TARGETS.opencode[1]!);
  } catch {
    return false;
  }
}

function defaultWaitForServerReady(
  processRef: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err?: Error, url?: string) => {
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

      resolve(url ?? '');
    };

    let buffer = '';

    const onData = (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const urlMatch = buffer.match(/https?:\/\/[^\s]+/i);
      if (urlMatch) {
        finish(undefined, urlMatch[0]);
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
  return ['serve', '--hostname', host, '--port', port];
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
  assertOpenCodeToolRestrictionsUnsupported(options);
  if (isPermissionPolicyReset(policy)) {
    return { [PERMISSION_POLICY_RESET]: true };
  }
  const writablePaths = mapWritablePathsPermission(policy, 'ambient');

  if (policy === undefined) {
    return {};
  }

  if (policy.mode === 'bypass') {
    // The cligent opencode adapter spawns `opencode serve` and drives it
    // via the SDK — it does not invoke the `opencode run` CLI, so
    // `--dangerously-skip-permissions` has nowhere to attach. Reject
    // rather than silently degrade; the throw surfaces at the first
    // `Cligent.run()` call as a `player_finished` / `captain_finished`
    // `status: 'error'` record per DR-005's first-run failure-surfacing
    // rule. Users wanting unchecked execution can set all three
    // per-capability levels to 'allow' explicitly, or run opencode via
    // its CLI outside cligent.
    throw new Error(
      "opencode adapter does not support PermissionPolicy.mode: 'bypass': " +
        'the cligent opencode adapter drives an `opencode serve` SDK/server ' +
        'session, so the `--dangerously-skip-permissions` CLI flag has no ' +
        "place to attach. Use mode: 'auto' to answer surviving native " +
        'permission asks once while preserving configured rules, or set the ' +
        'per-capability fileWrite / shellExecute / networkAccess levels ' +
        'explicitly.',
    );
  }

  if (policy.mode === 'auto') {
    // OpenCode's native --auto behavior approves only permission asks that
    // survive its configured rules. Do not append a wildcard allow rule:
    // PermissionRuleset uses last-match-wins, so that would override native
    // and user-configured denies. The automation posture and portable
    // capability rules are independent axes; omitted capabilities preserve
    // OpenCode's native rules.
    const permission: Record<string, PermissionLevel> = {};
    if (policy.fileWrite !== undefined) {
      permission.edit = policy.fileWrite;
    }
    if (policy.shellExecute !== undefined) {
      permission.bash = policy.shellExecute;
    }
    if (policy.networkAccess !== undefined) {
      permission.webfetch = policy.networkAccess;
    }
    return {
      ...(Object.keys(permission).length > 0 ? { permission } : {}),
      ...(writablePaths ? { writablePaths } : {}),
    };
  }

  const normalized = normalizePermissions(policy);

  return {
    permission: {
      edit: normalized.fileWrite,
      bash: normalized.shellExecute,
      webfetch: normalized.networkAccess,
    },
    ...(writablePaths ? { writablePaths } : {}),
  };
}

function assertOpenCodeToolRestrictionsUnsupported(
  options?: Pick<AgentOptions, 'allowedTools' | 'disallowedTools'>,
): void {
  if (
    options?.allowedTools === undefined &&
    options?.disallowedTools === undefined
  ) {
    return;
  }

  throw new Error(
    'OpenCode adapter does not support explicit allowedTools or ' +
      'disallowedTools: OpenCode 1.18.13 merges prompt `tools` into ' +
      'persistent session permission rules, where they can override native ' +
      'or explicit denies, and exposes no independent exact per-call tool ' +
      'registry surface. Omit both options or choose an adapter with exact ' +
      'tool filtering.',
  );
}

export function mapEffortToOpenCodeVariant(
  model: string | undefined,
  effort: OpenCodeEffort | undefined,
): OpenCodeVariant | undefined {
  if (effort === undefined) return undefined;
  assertSupportedEffort(AGENT, effort);
  if (!model) return undefined;

  const slashIdx = model.indexOf('/');
  if (slashIdx <= 0) return undefined;

  const provider = model.slice(0, slashIdx);

  if (provider === 'anthropic') {
    return effort === 'xhigh' || effort === 'max'
      ? 'max'
      : 'high';
  }

  if (provider === 'openai') {
    return effort === 'max' ? 'xhigh' : effort;
  }

  if (provider === 'google') {
    return effort === 'high' || effort === 'xhigh' || effort === 'max'
      ? 'high'
      : 'low';
  }

  return undefined;
}

function toOpenCodePromptModel(model: unknown): unknown {
  // OpenCode expects model as { providerID, modelID }. Parse
  // "provider/model" strings into that format; pass other values as-is.
  if (typeof model === 'string' && model.includes('/')) {
    const slashIdx = model.indexOf('/');
    return {
      providerID: model.slice(0, slashIdx),
      modelID: model.slice(slashIdx + 1),
    };
  }

  return model;
}

function asPermissionAction(value: unknown): PermissionLevel | undefined {
  return value === 'allow' || value === 'ask' || value === 'deny'
    ? value
    : undefined;
}

function toOpenCodeV2PermissionRuleset(
  permission: unknown,
): PermissionRuleset | undefined {
  const record = asRecord(permission);
  const rules: PermissionRuleset = [];

  for (const [permissionName, value] of Object.entries(record)) {
    const action = asPermissionAction(value);
    if (action) {
      rules.push({ permission: permissionName, pattern: '*', action });
    }
  }

  return rules.length > 0 ? rules : undefined;
}

function throwIfSdkResultError(result: unknown, operation: string): void {
  const record = asRecord(result);
  const error = record.error;
  if (error === undefined || error === null) return;

  const payload = toErrorPayload(error);
  throw new Error(`${operation}: ${payload.message}`);
}

export function wrapOpencodeClient(
  real: Record<string, unknown>,
  options: WrapOpencodeClientOptions = {},
): OpenCodeClient {
  const apiVersion = options.apiVersion ?? 'v1';

  // Keep references to the real SDK service objects so that method calls
  // retain `this` binding (the generated SDK stores `_client` on each
  // service instance and accesses it via `this._client`).
  const session = real.session as Record<string, unknown> | undefined;
  const event = real.event as Record<string, unknown> | undefined;
  const instance = real.instance as Record<string, unknown> | undefined;
  const permission = real.permission as Record<string, unknown> | undefined;

  if (!session || typeof session.create !== 'function') {
    throw new Error('OpenCode SDK client.session.create() not available');
  }
  if (typeof session.promptAsync !== 'function' && typeof session.prompt !== 'function') {
    throw new Error('OpenCode SDK client.session.{promptAsync,prompt}() not available');
  }
  if (!event || typeof event.subscribe !== 'function') {
    throw new Error('OpenCode SDK client.event.subscribe() not available');
  }

  // Bind methods to their owning service objects to preserve `this`.
  const sessionCreate = session.create.bind(session) as (
    body?: unknown,
    requestOptions?: unknown,
  ) => Promise<unknown>;
  const sessionUpdate = typeof session.update === 'function'
    ? (session.update.bind(session) as (
        args: unknown,
        requestOptions?: unknown,
      ) => Promise<unknown>)
    : undefined;
  const sessionPromptAsync = typeof session.promptAsync === 'function'
    ? (session.promptAsync.bind(session) as (
        args: unknown,
        requestOptions?: unknown,
      ) => Promise<unknown>)
    : undefined;
  const sessionPromptSync = typeof session.prompt === 'function'
    ? (session.prompt.bind(session) as (
        args: unknown,
        requestOptions?: unknown,
      ) => Promise<unknown>)
    : undefined;
  const sessionStatus = typeof session.status === 'function'
    ? (session.status.bind(session) as (args?: unknown) => Promise<unknown>)
    : undefined;
  const sessionAbort = typeof session.abort === 'function'
    ? (session.abort.bind(session) as (args: unknown) => Promise<unknown>)
    : undefined;
  const sessionChildren = typeof session.children === 'function'
    ? (session.children.bind(session) as (
        args: unknown,
        requestOptions?: unknown,
      ) => Promise<unknown>)
    : undefined;
  const eventSubscribe = event.subscribe.bind(event) as (
    args?: unknown,
    requestOptions?: unknown,
  ) => Promise<unknown>;
  const instanceDispose = instance && typeof instance.dispose === 'function'
    ? (instance.dispose.bind(instance) as (args?: unknown) => Promise<unknown>)
    : undefined;
  const permissionReply =
    permission && typeof permission.reply === 'function'
      ? (permission.reply.bind(permission) as (
          args: unknown,
          requestOptions?: unknown,
        ) => Promise<unknown>)
      : undefined;
  const permissionRespond =
    permission && typeof permission.respond === 'function'
      ? (permission.respond.bind(permission) as (
          args: unknown,
          requestOptions?: unknown,
        ) => Promise<unknown>)
      : undefined;
  const legacyPermissionReply =
    typeof real.postSessionIdPermissionsPermissionId === 'function'
      ? (real.postSessionIdPermissionsPermissionId.bind(real) as (
          args: unknown,
        ) => Promise<unknown>)
      : undefined;
  let instanceDirectory: string | undefined;

  const abortSessionViaSdk = async (
    sessionId: string,
    cwd: string | undefined,
  ): Promise<void> => {
    if (!sessionAbort) {
      throw new Error('OpenCode SDK client.session.abort() not available');
    }

    const result = await sessionAbort(
      apiVersion === 'v2'
        ? {
            sessionID: sessionId,
            ...(cwd ? { directory: cwd } : {}),
          }
        : {
            path: { id: sessionId },
            ...(cwd ? { query: { directory: cwd } } : {}),
          },
    );
    throwIfSdkResultError(result, 'OpenCode session.abort failed');
    if (unwrapSdkData(result) === false) {
      throw new Error(`OpenCode session.abort declined session ${sessionId}`);
    }
  };

  return {
    async run(options: Record<string, unknown>): Promise<unknown> {
      if (options.tools !== undefined) {
        throw new Error(
          'OpenCode compatibility client does not support prompt `tools`: ' +
            'OpenCode 1.18.13 merges them into persistent session permission ' +
            'rules, where they can override native or explicit denies, ' +
            'instead of enforcing an independent exact tool registry. Omit ' +
            '`tools` or choose an adapter with exact tool filtering.',
        );
      }
      const resumeId = asString(options.sessionId);
      const cwdVal = asString(options.cwd);
      instanceDirectory = cwdVal;
      const permissionObj = options.permission;
      const resetPermissionPolicy =
        (options as Record<PropertyKey, unknown>)[PERMISSION_POLICY_RESET] ===
        true;
      const effectivePermissionObj = resetPermissionPolicy
        ? {}
        : permissionObj;
      const lineageDiscoveryTimeoutMs =
        asNumber(options.lineageDiscoveryTimeoutMs) ??
        MAX_STATUS_QUERY_TIMEOUT_MS;
      assertFinitePositiveTimeout(
        'lineageDiscoveryTimeoutMs',
        lineageDiscoveryTimeoutMs,
      );
      const variantVal = asString(options.variant);
      const modelVal = toOpenCodePromptModel(options.model);
      const signal = options.signal instanceof AbortSignal
        ? options.signal
        : undefined;
      const v2PermissionRuleset = resetPermissionPolicy
        ? []
        : toOpenCodeV2PermissionRuleset(effectivePermissionObj);

      let sessionId: string | undefined;
      let resolveRunAbort!: () => void;
      const runAbortPromise = new Promise<void>((resolve) => {
        resolveRunAbort = resolve;
      });
      let dispatchAbortPromise: Promise<void> | undefined;
      let eagerFirst: Promise<IteratorResult<unknown>> | undefined;
      let rawIterator: AsyncIterator<unknown> | undefined;
      let rawIteratorTransferred = false;
      let events: AsyncIterable<unknown> | undefined;
      const ownedSessionIds = new Set<string>();
      const observeCreatedSessionId = options.onCreatedSessionId;
      const observeSessionAbort = options.onSessionAbortStarted;
      const abortKnownSession = (): Promise<void> => {
        if (!sessionId) return Promise.resolve();
        if (!dispatchAbortPromise) {
          dispatchAbortPromise = abortSessionViaSdk(sessionId, cwdVal);
          if (typeof observeSessionAbort === 'function') {
            observeSessionAbort(dispatchAbortPromise);
          }
        }
        return dispatchAbortPromise;
      };
      const onRunAbort = () => {
        resolveRunAbort();
        void abortKnownSession().catch(() => {});
      };
      if (signal) {
        if (signal.aborted) onRunAbort();
        else signal.addEventListener('abort', onRunAbort, { once: true });
      }

      const stopAbortedDispatch = (): never => {
        void abortKnownSession().catch(() => {});
        throw new OpenCodePromptDispatchAbortError(sessionId);
      };

      const raceRunOperation = async <T>(operation: Promise<T>): Promise<T> => {
        const outcome = await Promise.race([
          operation.then(
            (value) => ({ kind: 'success' as const, value }),
            (error: unknown) => ({ kind: 'failure' as const, error }),
          ),
          runAbortPromise.then(() => ({ kind: 'abort' as const })),
        ]);
        if (outcome.kind === 'abort') return stopAbortedDispatch();
        if (outcome.kind === 'failure') throw outcome.error;
        return outcome.value;
      };
      const discoverOwnedSessionLineage = async (
        rootSessionId: string,
      ): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const lineageController = new AbortController();
        const abortLineage = () => lineageController.abort();
        if (signal?.aborted) abortLineage();
        else signal?.addEventListener('abort', abortLineage, { once: true });
        const lineageDeadline = performance.now() + lineageDiscoveryTimeoutMs;
        const lineageTimeoutError = () =>
          new Error(
            'OpenCode session.children timed out after ' +
              `${lineageDiscoveryTimeoutMs}ms`,
          );
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            lineageController.abort();
            reject(lineageTimeoutError());
          }, lineageDiscoveryTimeoutMs);
        });
        try {
          const pendingParents = [rootSessionId];
          for (let index = 0; index < pendingParents.length; index++) {
            if (performance.now() >= lineageDeadline) {
              lineageController.abort();
              throw lineageTimeoutError();
            }
            const parentSessionId = pendingParents[index]!;
            const childrenResult = await raceRunOperation(
              Promise.race([
                sessionChildren!(
                  apiVersion === 'v2'
                    ? {
                        sessionID: parentSessionId,
                        ...(cwdVal ? { directory: cwdVal } : {}),
                      }
                    : {
                        path: { id: parentSessionId },
                        ...(cwdVal ? { query: { directory: cwdVal } } : {}),
                        signal: lineageController.signal,
                      },
                  apiVersion === 'v2'
                    ? { signal: lineageController.signal }
                    : undefined,
                ),
                timeoutPromise,
              ]),
            );
            throwIfSdkResultError(
              childrenResult,
              'OpenCode session.children failed',
            );
            const children = unwrapSdkData(childrenResult);
            if (!Array.isArray(children)) {
              throw new Error(
                'OpenCode session.children returned a non-array response',
              );
            }
            for (const child of children) {
              const childId = asString(asRecord(child).id);
              if (!childId || ownedSessionIds.has(childId)) continue;
              ownedSessionIds.add(childId);
              pendingParents.push(childId);
            }
          }
        } finally {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', abortLineage);
        }
      };

      try {
        if (resumeId) {
          // Resume an existing session instead of creating a new one.
          sessionId = resumeId;
          if (signal?.aborted) return stopAbortedDispatch();
          if (apiVersion === 'v2' && v2PermissionRuleset !== undefined) {
            if (!sessionUpdate) {
              throw new Error(
                'OpenCode SDK client.session.update() not available for v2 permission updates',
              );
            }
            const updated = await raceRunOperation(
              sessionUpdate(
                {
                  sessionID: resumeId,
                  ...(cwdVal ? { directory: cwdVal } : {}),
                  permission: v2PermissionRuleset,
                },
                signal ? { signal } : undefined,
              ),
            );
            throwIfSdkResultError(updated, 'OpenCode session.update failed');
          }
        } else {
          const created = asRecord(
            await (apiVersion === 'v2'
              ? sessionCreate(
                  {
                    ...(cwdVal ? { directory: cwdVal } : {}),
                    ...(v2PermissionRuleset !== undefined
                      ? { permission: v2PermissionRuleset }
                      : {}),
                  },
                  signal ? { signal } : undefined,
                )
              : sessionCreate(
                  cwdVal || signal
                    ? {
                        ...(cwdVal ? { query: { directory: cwdVal } } : {}),
                        ...(signal ? { signal } : {}),
                      }
                    : undefined,
                )),
          );
          throwIfSdkResultError(created, 'OpenCode session.create failed');
          sessionId = asString(created.id) ?? asString(asRecord(created.data).id);
          if (sessionId && typeof observeCreatedSessionId === 'function') {
            observeCreatedSessionId(sessionId);
          }
        }

        if (!sessionId) {
          sessionId = generateSessionId();
        }
        ownedSessionIds.add(sessionId);

        if (resumeId) {
          if (!sessionChildren) {
            throw new Error(
              'OpenCode SDK client.session.children() not available for ' +
                'resumed permission ownership discovery',
            );
          }

          await discoverOwnedSessionLineage(sessionId);
        }
        if (signal?.aborted) return stopAbortedDispatch();
        const promptSessionId = sessionId;

        const promptBody = {
          parts: [{ type: 'text', text: options.prompt }],
          ...(modelVal ? { model: modelVal } : {}),
          ...(variantVal ? { variant: variantVal } : {}),
          ...(options.steps !== undefined ? { steps: options.steps } : {}),
          ...(effectivePermissionObj !== undefined
            ? { permission: effectivePermissionObj }
            : {}),
        };

        const v2PromptParameters: { sessionID: string } & OpenCodeV2PromptBody & {
          directory?: string;
        } = {
          sessionID: promptSessionId,
          parts: [{ type: 'text', text: asString(options.prompt) ?? '' }],
          ...(modelVal ? { model: modelVal as OpenCodeV2PromptBody['model'] } : {}),
          ...(variantVal ? { variant: variantVal } : {}),
          ...(cwdVal ? { directory: cwdVal } : {}),
        };

        // The SDK's event stream is a lazy async generator — the HTTP
        // fetch inside it only fires on the first .next() call (see
        // serverSentEvents.gen.js:20).  Eagerly call .next() to establish
        // the SSE connection BEFORE sending the prompt so fast early
        // events are not lost on the live-only (no replay) endpoint.
        const subResult = asRecord(
          await raceRunOperation(
            apiVersion === 'v2'
              ? eventSubscribe(
                  cwdVal ? { directory: cwdVal } : undefined,
                  signal ? { signal } : undefined,
                )
              : eventSubscribe(
                  cwdVal || signal
                    ? {
                        ...(cwdVal ? { query: { directory: cwdVal } } : {}),
                        ...(signal ? { signal } : {}),
                      }
                    : undefined,
                ),
          ),
        );
        const rawStream = subResult.stream ?? subResult.events ?? subResult;

        if (isAsyncIterable(rawStream)) {
          rawIterator = (rawStream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          eagerFirst = rawIterator.next(); // triggers fetch()
          // A prompt-dispatch abort can reject this eager read before the run
          // returns its wrapper. Keep the original rejection for consumers,
          // while also marking it handled if dispatch abort discards the stream.
          void eagerFirst.catch(() => {});
        }

        if (sessionPromptAsync) {
          // Fire-and-forget: promptAsync returns 204 immediately.
          const promptResult = await raceRunOperation(
            sessionPromptAsync(
              apiVersion === 'v2'
                ? v2PromptParameters
                : {
                    path: { id: promptSessionId },
                    ...(cwdVal ? { query: { directory: cwdVal } } : {}),
                    body: promptBody,
                    ...(signal ? { signal } : {}),
                  },
              apiVersion === 'v2' && signal ? { signal } : undefined,
            ),
          );
          throwIfSdkResultError(promptResult, 'OpenCode session.promptAsync failed');
        } else if (sessionPromptSync) {
          const promptResult = await raceRunOperation(
            sessionPromptSync(
              apiVersion === 'v2'
                ? v2PromptParameters
                : {
                    path: { id: promptSessionId },
                    ...(cwdVal ? { query: { directory: cwdVal } } : {}),
                    body: promptBody,
                    ...(signal ? { signal } : {}),
                  },
              apiVersion === 'v2' && signal ? { signal } : undefined,
            ),
          );
          throwIfSdkResultError(promptResult, 'OpenCode session.prompt failed');
        }

        if (signal?.aborted) return stopAbortedDispatch();

        // Wrap the iterator so the eagerly-fetched first result is not lost.
        if (eagerFirst && rawIterator) {
          const first = eagerFirst;
          const rest = rawIterator;
          events = {
            [Symbol.asyncIterator](): AsyncIterator<unknown> {
              let consumedFirst = false;
              return {
                async next() {
                  if (!consumedFirst) {
                    consumedFirst = true;
                    return first;
                  }
                  return rest.next();
                },
                async return(value?: unknown) {
                  consumedFirst = true;
                  return rest.return
                    ? rest.return(value)
                    : { done: true, value };
                },
                async throw(error?: unknown) {
                  consumedFirst = true;
                  if (rest.throw) return rest.throw(error);
                  throw error;
                },
              };
            },
          };
        }

        rawIteratorTransferred = true;
        return {
          id: sessionId,
          sessionId,
          ownedSessionIds: [...ownedSessionIds],
          ...(events ? { events } : {}),
        };
      } finally {
        signal?.removeEventListener('abort', onRunAbort);
        if (!rawIteratorTransferred && rawIterator?.return) {
          try {
            await promiseSettlesWithin(
              Promise.resolve(rawIterator.return()),
              ITERATOR_CLEANUP_TIMEOUT_MS,
            );
          } catch {
            // The request signal and outer adapter cleanup remain the final
            // cancellation boundaries when explicit iterator return rejects.
          }
        }
      }
    },

    async getSessionStatus({ sessionId, cwd }): Promise<unknown> {
      if (!sessionStatus) {
        throw new Error('OpenCode SDK client.session.status() not available');
      }

      const result = await sessionStatus(
        apiVersion === 'v2'
          ? (cwd ? { directory: cwd } : undefined)
          : (cwd ? { query: { directory: cwd } } : undefined),
      );
      throwIfSdkResultError(result, 'OpenCode session.status failed');
      const statuses = asRecord(unwrapSdkData(result));
      const statusMap = Object.prototype.hasOwnProperty.call(statuses, 'sessions')
        ? asRecord(statuses.sessions)
        : statuses;

      // OpenCode's status service keeps only non-idle sessions in its
      // in-memory map. Transitioning to idle deletes the entry, so absence is
      // the canonical idle representation returned by /session/status.
      return statusMap[sessionId] ?? { type: 'idle' };
    },

    async abortSession({ sessionId, cwd }): Promise<void> {
      await abortSessionViaSdk(sessionId, cwd);
    },

    async replyPermission(options): Promise<void> {
      const operation =
        'OpenCode permission reply failed ' +
        `(sessionID=${JSON.stringify(options.sessionId)}, ` +
        `requestID=${JSON.stringify(options.requestId)}, ` +
        `permission=${JSON.stringify(options.permission)})`;
      let result: unknown;

      if (apiVersion === 'v2') {
        if (!permissionReply) {
          throw new Error(
            `${operation}: SDK client.permission.reply() not available`,
          );
        }
        result = await permissionReply(
          {
            requestID: options.requestId,
            ...(options.cwd ? { directory: options.cwd } : {}),
            reply: options.decision,
            ...(options.decision === 'reject'
              ? {
                  message:
                    'Cligent headless runs reject unresolved permission requests',
                }
              : {}),
          },
          options.signal ? { signal: options.signal } : undefined,
        );
      } else if (legacyPermissionReply) {
        result = await legacyPermissionReply({
          path: {
            id: options.sessionId,
            permissionID: options.requestId,
          },
          body: { response: options.decision },
          ...(options.cwd ? { query: { directory: options.cwd } } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } else if (permissionRespond) {
        result = await permissionRespond(
          {
            sessionID: options.sessionId,
            permissionID: options.requestId,
            ...(options.cwd ? { directory: options.cwd } : {}),
            response: options.decision,
          },
          options.signal ? { signal: options.signal } : undefined,
        );
      } else {
        throw new Error(
          `${operation}: SDK permission response API not available`,
        );
      }

      throwIfSdkResultError(result, operation);
      if (unwrapSdkData(result) === false) {
        throw new Error(`${operation}: SDK declined the permission response`);
      }
    },

    events(options?: Record<string, unknown>): AsyncIterable<unknown> {
      // Return an async iterable that lazily calls subscribe
      return {
        [Symbol.asyncIterator]() {
          let innerIterator: AsyncIterator<unknown> | undefined;
          let started = false;

          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (!started) {
                started = true;
                const subResult = asRecord(await eventSubscribe(options));
                const stream = subResult.stream ?? subResult.events ?? subResult;
                if (isAsyncIterable(stream)) {
                  innerIterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
                } else {
                  return { done: true, value: undefined };
                }
              }

              if (!innerIterator) {
                return { done: true, value: undefined };
              }

              return innerIterator.next();
            },
            async return(value?: unknown): Promise<IteratorResult<unknown>> {
              if (innerIterator?.return) return innerIterator.return(value);
              return { done: true, value };
            },
            async throw(error?: unknown): Promise<IteratorResult<unknown>> {
              if (innerIterator?.throw) return innerIterator.throw(error);
              throw error;
            },
          };
        },
      };
    },

    async close(): Promise<void> {
      if (instanceDispose) {
        const result = await instanceDispose(
          apiVersion === 'v2'
            ? (instanceDirectory ? { directory: instanceDirectory } : undefined)
            : (instanceDirectory
                ? { query: { directory: instanceDirectory } }
                : undefined),
        );
        throwIfSdkResultError(result, 'OpenCode instance.dispose failed');
      }
    },
  };
}

export async function loadOpenCodeSdk(): Promise<OpenCodeSdk> {
  // ENG-025: an importable SDK is not necessarily a supported one.
  assertRuntimeSupported(
    AGENT_RUNTIME_TARGETS.opencode[0]!,
    `npm install ${AGENT_RUNTIME_TARGETS.opencode[0]!.repairSpec}`,
  );
  const mod = (await import('@opencode-ai/sdk/v2')) as {
    createOpencodeClient?: unknown;
    createClient?: unknown;
    OpenCodeClient?: unknown;
    OpenCode?: unknown;
  };

  // v2 SDK: createOpencodeClient with nested API and a typed prompt variant field.
  if (typeof mod.createOpencodeClient === 'function') {
    const factory = mod.createOpencodeClient as (
      config?: { baseUrl?: string; directory?: string },
    ) => Record<string, unknown>;

    return {
      createClient: (options?: { baseUrl?: string }) => {
        const real = factory({ baseUrl: options?.baseUrl });
        return wrapOpencodeClient(real, { apiVersion: 'v2' });
      },
    };
  }

  // Legacy fallbacks (pre-1.x)
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

  throw new Error('@opencode-ai/sdk/v2 does not export a recognized client factory');
}

export class OpenCodeAdapter implements AgentAdapter<OpenCodeEffort> {
  readonly agent = AGENT;

  private readonly mode: OpenCodeMode;

  private readonly serverUrl: string;

  private readonly readyTimeoutMs: number;

  private readonly eventInactivityTimeoutMs: number;

  private readonly loadSdkFn: () => Promise<OpenCodeSdk>;

  private readonly spawnProcess: SpawnProcessFn;

  private readonly probeCliAvailability: () => Promise<boolean>;

  private readonly waitForServerReady: (
    process: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ) => Promise<string>;

  private readonly managedServerTermGraceMs: number;

  private readonly managedServerKillGraceMs: number;

  constructor(
    config: OpenCodeAdapterConfig = {},
    deps: OpenCodeAdapterDeps = {},
  ) {
    this.mode = config.mode ?? 'managed';
    this.serverUrl = config.serverUrl ?? DEFAULT_MANAGED_URL;
    this.readyTimeoutMs = config.readyTimeoutMs ?? 5000;
    this.eventInactivityTimeoutMs =
      config.eventInactivityTimeoutMs ?? DEFAULT_EVENT_INACTIVITY_TIMEOUT_MS;
    assertFinitePositiveTimeout(
      'OpenCodeAdapter eventInactivityTimeoutMs',
      this.eventInactivityTimeoutMs,
    );
    this.loadSdkFn = deps.loadSdk ?? loadOpenCodeSdk;
    this.spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
    this.probeCliAvailability = deps.probeCliAvailability ?? defaultProbeCliAvailability;
    this.waitForServerReady = deps.waitForServerReady ?? defaultWaitForServerReady;
    this.managedServerTermGraceMs =
      deps.managedServerTermGraceMs ?? DEFAULT_MANAGED_SERVER_TERM_GRACE_MS;
    this.managedServerKillGraceMs =
      deps.managedServerKillGraceMs ?? DEFAULT_MANAGED_SERVER_KILL_GRACE_MS;
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
    options?: AgentOptions<OpenCodeEffort>,
  ): AsyncGenerator<AgentEvent, void, void> {
    assertOpenCodeToolRestrictionsUnsupported(options);

    let sdk: OpenCodeSdk;
    try {
      sdk = await this.loadSdkFn();
    } catch (err) {
      // A version refusal already names installed, required, tree, and
      // repair; replacing it would advise installing what is present.
      if (isUnsupportedRuntimeError(err)) throw err;
      throw new Error(
        'OpenCodeAdapter requires @opencode-ai/sdk. Install it to use this adapter.' +
          (err instanceof Error ? ` (${err.message})` : ''),
      );
    }

    const mappedPermissions = mapPermissionsToOpenCodeOptions(
      options?.permissions,
      {
        allowedTools: options?.allowedTools,
        disallowedTools: options?.disallowedTools,
      },
    );
    const variant = mapEffortToOpenCodeVariant(
      options?.model,
      options?.effort,
    );

    const startTime = Date.now();
    let doneYielded = false;
    let initYielded = false;
    let abortRequested = options?.abortSignal?.aborted === true;
    let sessionErrorObserved = false;

    let actualServerUrl = this.serverUrl;
    let serverProcess: ChildProcessWithoutNullStreams | undefined;
    let serverClosed = false;
    let serverExitPromise: Promise<ServerCloseInfo> | undefined;
    let serverExitInfo: ServerCloseInfo | undefined;
    let finishStreamWait: ((result: StreamWaitResult) => void) | undefined;
    let abortPermissionWait: (() => void) | undefined;

    let sessionId = options?.resume ?? generateSessionId();
    let backendProvidedSessionId = false;
    let sessionAbortAttempted = false;
    let sessionAbortPromise: Promise<void> | undefined;
    const ownedSessionIds = new Set<string>();

    // Accumulate usage from step-finish parts (OpenCode's session.idle
    // event doesn't carry usage data).
    let accumulatedInputTokens = 0;
    let accumulatedOutputTokens = 0;
    let accumulatedToolUses = 0;
    let accumulatedCost = 0;
    let accumulatedTokenUsageObserved = false;
    let accumulatedTokenUsageComplete = true;
    const accumulatedComponents = {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
    };

    const eventStreamController = new AbortController();
    let resolveCallerAbort!: () => void;
    const callerAbortPromise = new Promise<void>((resolve) => {
      resolveCallerAbort = resolve;
    });
    let iterator: AsyncIterator<unknown> | undefined;
    let iteratorReturnPromise: Promise<void> | undefined;
    const returnActiveIterator = (): Promise<void> => {
      if (iteratorReturnPromise) return iteratorReturnPromise;

      const activeIterator = iterator;
      iterator = undefined;
      if (!activeIterator?.return) return Promise.resolve();

      iteratorReturnPromise = maybeCallAsyncWithin(
        () => Promise.resolve(activeIterator.return!()).then(() => {}),
        ITERATOR_CLEANUP_TIMEOUT_MS,
      );
      return iteratorReturnPromise;
    };

    // OpenCode re-sends the whole ToolPart on every lifecycle transition
    // (pending → running → completed/error), so tool events must be
    // correlated per callID rather than emitted per snapshot.
    const toolCalls = new Map<
      string,
      { toolName: string; useEmitted: boolean; resultEmitted: boolean }
    >();
    // permission.replied carries only requestID; the tool callID it
    // resolves to arrives earlier on permission.asked.
    const permissionRequests = new Map<
      string,
      { toolUseId: string; toolName: string }
    >();
    const repliedPermissionRequests = new Set<string>();
    const permissionRequestKey = (
      permissionSessionId: string,
      requestId: string,
    ) => `${permissionSessionId}\u0000${requestId}`;
    const correlatePermissionSessionId = (
      eventSessionId: string | undefined,
      requestId: string | undefined,
    ): string => {
      if (eventSessionId || !requestId) return eventSessionId ?? sessionId;
      for (const ownedSessionId of ownedSessionIds) {
        const requestKey = permissionRequestKey(ownedSessionId, requestId);
        if (
          permissionRequests.has(requestKey) ||
          repliedPermissionRequests.has(requestKey)
        ) {
          return ownedSessionId;
        }
      }
      return sessionId;
    };

    // OpenCode's shared SSE stream publishes user and assistant messages.
    // Part events can precede the message.updated envelope that supplies the
    // role, so content stays pending until its message role is known.
    const messageRoles = new Map<string, OpenCodeMessageRole>();
    const partKinds = new Map<string, OpenCodePartKind>();
    const partOwners = new Map<string, string>();
    const settledPartSnapshots = new Map<string, Set<string>>();
    const emittedTextDeltas = new Map<
      string,
      { chunks: string[]; length: number }
    >();
    const pendingContentEvents: Array<
      | { removed: true }
      | {
          removed?: false;
          eventType: string;
          event: Record<string, unknown>;
          messageId?: string;
          partId?: string;
          contentKind?: OpenCodeContentKind;
        }
    > = [];
    let pendingContentHead = 0;

    const normalizeContentOnce = (
      eventType: string,
      event: Record<string, unknown>,
      contentKind: OpenCodeContentKind,
    ): AgentEvent | undefined => {
      const message = asRecord(event.message);
      const part = asRecord(event.part ?? message.part ?? event.data);
      const delta = asString(event.delta) ?? asString(part.delta);
      const partId = loadOpenCodePartId(event);

      if (eventType === 'message.part.updated') {
        const hasDelta = delta !== undefined;

        if (!hasDelta && partId) {
          const content = contentKind === 'text'
            ? asString(part.text) ??
              asString(part.content) ??
              asString(asRecord(part.content).text)
            : asString(part.summary) ??
              asString(part.text) ??
              asString(part.content);

          if (content) {
            const signature = `${contentKind}\0${content}`;
            const signatures = settledPartSnapshots.get(partId) ?? new Set();
            if (signatures.has(signature)) {
              return undefined;
            }
            signatures.add(signature);
            settledPartSnapshots.set(partId, signatures);

            // OpenCode commonly streams every text delta and then sends the
            // same settled text snapshot. Cligent consumers concatenate text
            // and text_delta, so forwarding both would duplicate the answer.
            if (
              contentKind === 'text' &&
              emittedTextDeltas.get(partId)?.length === content.length &&
              emittedTextDeltas.get(partId)?.chunks.join('') === content
            ) {
              return undefined;
            }
          }
        }
      }

      const normalized = normalizeOpenCodeContentEvent(
        eventType,
        event,
        contentKind,
        sessionId,
      );
      if (normalized && contentKind === 'text' && partId && delta) {
        const emitted = emittedTextDeltas.get(partId) ?? {
          chunks: [],
          length: 0,
        };
        emitted.chunks.push(delta);
        emitted.length += delta.length;
        emittedTextDeltas.set(partId, emitted);
      }
      return normalized;
    };

    const drainPendingContent = (dropUnresolved = false): AgentEvent[] => {
      const normalizedEvents: AgentEvent[] = [];

      while (pendingContentHead < pendingContentEvents.length) {
        const item = pendingContentEvents[pendingContentHead]!;
        if (item.removed) {
          pendingContentHead++;
          continue;
        }
        // Legacy event shapes without a message identifier have no role to
        // correlate and retain their historical assistant behavior.
        const role = item.messageId
          ? messageRoles.get(item.messageId)
          : 'assistant';
        const contentKind =
          item.contentKind ??
          (item.partId ? partKinds.get(item.partId) : undefined);
        const knownDiscard = role === 'user' || contentKind === 'other';

        if (!knownDiscard && (!role || !contentKind) && !dropUnresolved) {
          break;
        }

        pendingContentHead++;
        if (role === 'assistant' && contentKind && contentKind !== 'other') {
          const normalized = normalizeContentOnce(
            item.eventType,
            item.event,
            contentKind,
          );
          if (normalized) normalizedEvents.push(normalized);
        }
      }

      // Avoid O(n²) Array.shift() behavior on the 30k–44k-delta streams
      // observed in the dogfooding evidence while bounding retained slots.
      if (
        pendingContentHead > 1024 &&
        pendingContentHead * 2 >= pendingContentEvents.length
      ) {
        pendingContentEvents.splice(0, pendingContentHead);
        pendingContentHead = 0;
      }

      return normalizedEvents;
    };

    const queueContent = (
      eventType: string,
      event: Record<string, unknown>,
      contentKind?: OpenCodeContentKind,
    ): AgentEvent[] => {
      const messageId = loadOpenCodePartMessageId(event);
      const partId = loadOpenCodePartId(event);
      const explicitAssistantDelta =
        eventType === 'session.next.text.delta' ||
        eventType === 'session.next.reasoning.delta';
      const inlineRole = explicitAssistantDelta
        ? 'assistant'
        : loadOpenCodeMessageRole(event);
      const inlinePartKind = loadOpenCodePartKind(event);

      if (messageId && inlineRole) {
        messageRoles.set(messageId, inlineRole);
      }
      if (partId && inlinePartKind) {
        partKinds.set(partId, inlinePartKind);
      }
      if (partId && messageId) {
        partOwners.set(partId, messageId);
      }

      pendingContentEvents.push({
        eventType,
        event,
        ...(messageId ? { messageId } : {}),
        ...(partId ? { partId } : {}),
        ...(contentKind ? { contentKind } : {}),
      });
      return drainPendingContent();
    };

    const onAbort = () => {
      abortRequested = true;
      eventStreamController.abort();
      resolveCallerAbort();
      finishStreamWait?.({ kind: 'caller_abort' });
      abortPermissionWait?.();
    };

    if (abortRequested) {
      onAbort();
    } else if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    let client: OpenCodeClient | undefined;
    const startKnownSessionAbort = (): Promise<void> => {
      const activeClient = client;
      const abortSession = activeClient?.abortSession;
      if (sessionAbortPromise) return sessionAbortPromise;
      if (sessionAbortAttempted) return Promise.resolve();
      sessionAbortAttempted = true;

      if (!abortSession) {
        sessionAbortPromise = Promise.reject(
          new Error('OpenCode SDK client does not provide session.abort()'),
        );
        void sessionAbortPromise.catch(() => {});
        return sessionAbortPromise;
      }

      try {
        sessionAbortPromise = Promise.resolve(
          abortSession.call(activeClient, {
            sessionId,
            ...(options?.cwd ? { cwd: options.cwd } : {}),
          }),
        ).then(() => {});
      } catch (error) {
        sessionAbortPromise = Promise.reject(error);
      }
      void sessionAbortPromise.catch(() => {});
      return sessionAbortPromise;
    };

    const accumulatedUsage = (): DonePayload['usage'] => ({
      // Error, interruption, inactivity, and exhaustion are synthesized
      // terminal paths: partial step counters must not be presented as a
      // complete provider measurement, but independently observed tool uses
      // and compatibility-shaped numeric fields remain available.
      tokenAvailability: 'unavailable',
      inputTokens: accumulatedInputTokens,
      outputTokens: accumulatedOutputTokens,
      toolUses: accumulatedToolUses,
      ...(accumulatedCost > 0 ? { totalCostUsd: accumulatedCost } : {}),
    });

    try {
      if (this.mode === 'managed') {
        // ENG-025: the peer gate sits in the SDK loader, but managed mode
        // also spawns the paired CLI, and Cligent.run() reaches here without
        // ever calling `isAvailable()`.
        assertRuntimeSupported(
          AGENT_RUNTIME_TARGETS.opencode[1]!,
          `npm install -g ${AGENT_RUNTIME_TARGETS.opencode[1]!.repairSpec}`,
        );
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
          serverExitInfo = info;
          finishStreamWait?.({ kind: 'server_exit', exit: info });
          return info;
        });

        actualServerUrl = await this.waitForServerReady(serverProcess, this.readyTimeoutMs);

        if (abortRequested) {
          onAbort();
        }
      }

      client = createClientFromSdk(sdk, actualServerUrl);

      const runFn = resolveRunFunction(client);
      if (!runFn) {
        throw new Error('OpenCode SDK client does not provide run()/query()');
      }

      if (abortRequested) {
        throw new Error('OpenCode run aborted before prompt dispatch');
      }

      const observeCreatedSessionId = (observedSessionId: unknown) => {
        const observed = asString(observedSessionId);
        if (!observed) return;
        sessionId = observed;
        backendProvidedSessionId = true;
        ownedSessionIds.add(observed);
      };
      const observeRunSessionAbort = (abortPromise: unknown) => {
        sessionAbortAttempted = true;
        if (sessionAbortPromise || !(abortPromise instanceof Promise)) return;
        sessionAbortPromise = abortPromise.then(() => {});
        void sessionAbortPromise.catch(() => {});
      };
      const runPromise = runFn({
        prompt,
        cwd: options?.cwd,
        model: options?.model,
        signal: eventStreamController.signal,
        onCreatedSessionId: observeCreatedSessionId,
        onSessionAbortStarted: observeRunSessionAbort,
        lineageDiscoveryTimeoutMs: Math.min(
          MAX_STATUS_QUERY_TIMEOUT_MS,
          this.eventInactivityTimeoutMs,
        ),
        ...(variant ? { variant } : {}),
        ...(options?.maxTurns !== undefined ? { steps: options.maxTurns } : {}),
        ...(options?.resume ? { sessionId: options.resume } : {}),
        ...mappedPermissions,
      });
      const runOutcomePromise = runPromise.then(
        (value) => ({ kind: 'success' as const, value }),
        (error: unknown) => ({ kind: 'failure' as const, error }),
      );
      let runOutcome = await Promise.race([
        runOutcomePromise,
        callerAbortPromise.then(() => ({ kind: 'caller_abort' as const })),
      ]);
      if (runOutcome.kind === 'caller_abort') {
        let captureTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const captured = await Promise.race([
            runOutcomePromise.then((outcome) => ({
              kind: 'settled' as const,
              outcome,
            })),
            new Promise<{ kind: 'timeout' }>((resolve) => {
              captureTimer = setTimeout(
                () => resolve({ kind: 'timeout' }),
                ITERATOR_CLEANUP_TIMEOUT_MS,
              );
            }),
          ]);
          if (captured.kind === 'timeout') {
            throw new Error('OpenCode run aborted during prompt dispatch');
          }
          runOutcome = captured.outcome;
        } finally {
          if (captureTimer) clearTimeout(captureTimer);
        }
      }
      if (runOutcome.kind === 'failure') {
        if (runOutcome.error instanceof OpenCodePromptDispatchAbortError) {
          // The wrapper already attempted to cancel any session created before
          // prompt dispatch was interrupted.
          sessionAbortAttempted = true;
          if (runOutcome.error.sessionId) {
            sessionId = runOutcome.error.sessionId;
            backendProvidedSessionId = true;
          }
        }
        throw runOutcome.error;
      }
      const runResult = runOutcome.value;

      const loadedId = loadSessionId(runResult);
      if (loadedId) {
        sessionId = loadedId;
        backendProvidedSessionId = true;
      }
      ownedSessionIds.add(sessionId);
      for (const ownedSessionId of asStringArray(
        asRecord(runResult).ownedSessionIds,
      )) {
        ownedSessionIds.add(ownedSessionId);
      }
      const stream = resolveEventStream(
        client,
        runResult,
        eventStreamController.signal,
      );
      if (stream) {
        iterator = stream[Symbol.asyncIterator]();
      }
      if (abortRequested) {
        startKnownSessionAbort();
        void returnActiveIterator();
        throw new Error('OpenCode run aborted during prompt dispatch');
      }
      if (!stream || !iterator) {
        throw new Error('OpenCode SDK client does not provide an SSE event stream');
      }

      if (!initYielded) {
        const runRecord = asRecord(runResult);
        const runTools = asStringArray(runRecord.tools);

        yield createEvent(
          'init',
          AGENT,
          {
            model: options?.model ?? asString(runRecord.model) ?? 'unknown',
            cwd: options?.cwd ?? asString(runRecord.cwd) ?? process.cwd(),
            tools: runTools,
            capabilities: {
              mode: this.mode,
              toolsKnown: runTools.length > 0,
              toolsSource: runTools.length > 0 ? 'sdk' : 'unavailable',
            },
          },
          sessionId,
        );
        initYielded = true;
      }

      let remainingInactivityMs = this.eventInactivityTimeoutMs;
      let lastRelevantEvent = 'prompt.dispatched';
      const controlTimeoutMs = Math.min(
        MAX_STATUS_QUERY_TIMEOUT_MS,
        this.eventInactivityTimeoutMs,
      );
      type ControlOutcome<T> =
        | { kind: 'success'; value: T }
        | { kind: 'failure'; error: unknown }
        | { kind: 'timeout' }
        | { kind: 'caller_abort' };

      const runControlOperation = async <T>(
        operation: () => Promise<T>,
        raceCallerAbort: boolean,
      ): Promise<ControlOutcome<T>> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<ControlOutcome<T>>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), controlTimeoutMs);
        });
        const operationPromise = operation()
          .then<ControlOutcome<T>>((value) => ({ kind: 'success', value }))
          .catch<ControlOutcome<T>>((error: unknown) => ({
            kind: 'failure',
            error,
          }));

        try {
          return await Promise.race([
            operationPromise,
            timeoutPromise,
            ...(raceCallerAbort
              ? [
                  callerAbortPromise.then<ControlOutcome<T>>(() => ({
                    kind: 'caller_abort',
                  })),
                ]
              : []),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const abortActiveSession = (raceCallerAbort: boolean) =>
        runControlOperation<void>(startKnownSessionAbort, raceCallerAbort);

      const describeControlOutcome = (outcome: ControlOutcome<unknown>): string => {
        if (outcome.kind === 'success') return 'succeeded';
        if (outcome.kind === 'failure') {
          return `failed: ${errorMessage(outcome.error)}`;
        }
        if (outcome.kind === 'timeout') {
          return `timed out after ${controlTimeoutMs}ms`;
        }
        return 'superseded by caller abort';
      };

      while (true) {
        let nextPromise: Promise<IteratorResult<unknown>> | undefined;
        let inactivityTimer:
          ReturnType<typeof createMonotonicInactivityTimer> | undefined;
        let raceResult: StreamWaitResult;
        const waitStartedAt = performance.now();

        if (remainingInactivityMs <= 0) {
          raceResult = { kind: 'inactivity' };
        } else {
          nextPromise = iterator.next();
          inactivityTimer = createMonotonicInactivityTimer(
            remainingInactivityMs,
          );

          // Keep one replaceable control waiter rather than adding a fresh
          // reaction to run-lifetime abort/server promises for every SSE
          // event. A buffered provider event is registered before the timer;
          // non-relevant buffered traffic still consumes the carried active
          // wait budget and cannot starve an expired deadline.
          raceResult = await new Promise<StreamWaitResult>((resolve) => {
            let settled = false;
            const finish = (result: StreamWaitResult) => {
              if (settled) return;
              settled = true;
              if (finishStreamWait === finish) {
                finishStreamWait = undefined;
              }
              resolve(result);
            };

            finishStreamWait = finish;
            nextPromise!.then(
              (result) => finish({ kind: 'event', result }),
              (error: unknown) => finish({ kind: 'iterator_error', error }),
            );
            inactivityTimer!.promise.then(finish);

            // Preserve abort precedence when multiple controls were already
            // settled before this wait was armed.
            if (abortRequested || options?.abortSignal?.aborted) {
              finish({ kind: 'caller_abort' });
            } else if (serverExitInfo) {
              finish({ kind: 'server_exit', exit: serverExitInfo });
            }
          });
          inactivityTimer.cancel();
          remainingInactivityMs = Math.max(
            0,
            remainingInactivityMs - (performance.now() - waitStartedAt),
          );
        }

        if (raceResult.kind === 'inactivity') {
          // Stop the read that missed its deadline before yielding queued
          // content. A consumer may suspend us at each yield, and fresh SSE
          // traffic must not stay live while timeout recovery is underway.
          nextPromise?.catch(() => {});
          eventStreamController.abort();
        }

        if (
          raceResult.kind === 'caller_abort' ||
          raceResult.kind === 'inactivity' ||
          abortRequested
        ) {
          yield* drainPendingContent(true);
        }

        if (raceResult.kind === 'caller_abort' || abortRequested) {
          nextPromise?.catch(() => {});
          startKnownSessionAbort();
          yield createEvent(
            'done',
            AGENT,
            {
              status: 'interrupted',
              ...doneResumeTokenPayload(
                'interrupted',
                backendProvidedSessionId,
                sessionId,
                options?.resume,
              ),
              usage: accumulatedUsage(),
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
          break;
        }

        if (raceResult.kind === 'iterator_error') {
          throw raceResult.error;
        }

        if (raceResult.kind === 'inactivity') {
          const elapsedInactivityMs = Math.max(
            0,
            Math.round(this.eventInactivityTimeoutMs - remainingInactivityMs),
          );
          const serverState =
            this.mode === 'external'
              ? 'external'
              : serverClosed
                ? 'closed'
                : 'running';
          const diagnosticBase =
            `OpenCode event inactivity deadline expired: session=${sessionId}; ` +
            `lastRelevantEvent=${lastRelevantEvent}; ` +
            `inactiveMs=${elapsedInactivityMs}; ` +
            `deadlineMs=${this.eventInactivityTimeoutMs}; ` +
            `serverMode=${this.mode}; serverState=${serverState}`;

          const statusOutcome = await runControlOperation(
            async () => {
              if (!client?.getSessionStatus) {
                throw new Error(
                  'OpenCode SDK client does not provide session.status()',
                );
              }
              return client.getSessionStatus({
                sessionId,
                ...(options?.cwd ? { cwd: options.cwd } : {}),
              });
            },
            true,
          );

          if (statusOutcome.kind === 'caller_abort' || abortRequested) {
            startKnownSessionAbort();
            yield createEvent(
              'done',
              AGENT,
              {
                status: 'interrupted',
                ...doneResumeTokenPayload(
                  'interrupted',
                  backendProvidedSessionId,
                  sessionId,
                  options?.resume,
                ),
                usage: accumulatedUsage(),
                durationMs: Date.now() - startTime,
              },
              sessionId,
            );
            doneYielded = true;
            break;
          }

          if (statusOutcome.kind !== 'success') {
            const abortOutcome = await abortActiveSession(true);
            if (abortRequested) {
              yield createEvent(
                'done',
                AGENT,
                {
                  status: 'interrupted',
                  ...doneResumeTokenPayload(
                    'interrupted',
                    backendProvidedSessionId,
                    sessionId,
                    options?.resume,
                  ),
                  usage: accumulatedUsage(),
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
                code: 'OPENCODE_INACTIVITY_STATUS_QUERY_FAILED',
                message:
                  `${diagnosticBase}; statusQuery=` +
                  `${describeControlOutcome(statusOutcome)}; ` +
                  `sessionAbort=${describeControlOutcome(abortOutcome)}`,
                recoverable: false,
              },
              sessionId,
            );
            if (abortRequested) {
              yield createEvent(
                'done',
                AGENT,
                {
                  status: 'interrupted',
                  ...doneResumeTokenPayload(
                    'interrupted',
                    backendProvidedSessionId,
                    sessionId,
                    options?.resume,
                  ),
                  usage: accumulatedUsage(),
                  durationMs: Date.now() - startTime,
                },
                sessionId,
              );
              doneYielded = true;
              break;
            }
            yield createEvent(
              'done',
              AGENT,
              {
                status: 'error',
                ...doneResumeTokenPayload(
                  'error',
                  backendProvidedSessionId,
                  sessionId,
                  options?.resume,
                ),
                usage: accumulatedUsage(),
                durationMs: Date.now() - startTime,
              },
              sessionId,
            );
            doneYielded = true;
            break;
          }

          const queriedStatus = statusOutcome.value;
          const queriedStatusType = sessionStatusType(queriedStatus);
          if (queriedStatusType === 'idle') {
            const recoveredStatus = sessionErrorObserved ? 'error' : 'success';
            yield createEvent(
              'error',
              AGENT,
              {
                code: 'OPENCODE_INACTIVITY_IDLE_RECOVERED',
                message:
                  `${diagnosticBase}; queriedSessionState=` +
                  diagnosticJson(queriedStatus),
                recoverable: true,
              },
              sessionId,
            );
            if (abortRequested) {
              yield createEvent(
                'done',
                AGENT,
                {
                  status: 'interrupted',
                  ...doneResumeTokenPayload(
                    'interrupted',
                    backendProvidedSessionId,
                    sessionId,
                    options?.resume,
                  ),
                  usage: accumulatedUsage(),
                  durationMs: Date.now() - startTime,
                },
                sessionId,
              );
              doneYielded = true;
              break;
            }
            yield createEvent(
              'done',
              AGENT,
              {
                status: recoveredStatus,
                ...doneResumeTokenPayload(
                  recoveredStatus,
                  backendProvidedSessionId,
                  sessionId,
                  options?.resume,
                ),
                usage: accumulatedUsage(),
                durationMs: Date.now() - startTime,
              },
              sessionId,
            );
            doneYielded = true;
            break;
          }

          const abortOutcome = await abortActiveSession(true);
          if (abortRequested) {
            yield createEvent(
              'done',
              AGENT,
              {
                status: 'interrupted',
                ...doneResumeTokenPayload(
                  'interrupted',
                  backendProvidedSessionId,
                  sessionId,
                  options?.resume,
                ),
                usage: accumulatedUsage(),
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
              code: 'OPENCODE_INACTIVITY_TIMEOUT',
              message:
                `${diagnosticBase}; queriedSessionState=` +
                `${diagnosticJson(queriedStatus)}; ` +
                `sessionAbort=${describeControlOutcome(abortOutcome)}`,
              recoverable: false,
            },
            sessionId,
          );
          if (abortRequested) {
            yield createEvent(
              'done',
              AGENT,
              {
                status: 'interrupted',
                ...doneResumeTokenPayload(
                  'interrupted',
                  backendProvidedSessionId,
                  sessionId,
                  options?.resume,
                ),
                usage: accumulatedUsage(),
                durationMs: Date.now() - startTime,
              },
              sessionId,
            );
            doneYielded = true;
            break;
          }
          yield createEvent(
            'done',
            AGENT,
            {
              status: 'error',
              ...doneResumeTokenPayload(
                'error',
                backendProvidedSessionId,
                sessionId,
                options?.resume,
              ),
              usage: accumulatedUsage(),
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
          break;
        }

        if (raceResult.kind === 'server_exit') {
          nextPromise?.catch(() => {});

          if (doneYielded) break;
          for (const normalized of drainPendingContent(true)) {
            yield normalized;
          }

          if (abortRequested || options?.abortSignal?.aborted) {
            yield createEvent(
              'done',
              AGENT,
              {
                status: 'interrupted',
                ...doneResumeTokenPayload(
                  'interrupted',
                  backendProvidedSessionId,
                  sessionId,
                  options?.resume,
                ),
                usage: accumulatedUsage(),
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
              ...doneResumeTokenPayload(
                'error',
                backendProvidedSessionId,
                sessionId,
                options?.resume,
              ),
              usage: accumulatedUsage(),
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
          break;
        }

        const { result } = raceResult;
        if (result.done) break;

        const rawEvent = asRecord(result.value);
        const eventType = asString(rawEvent.type);
        if (!eventType) continue;

        // OpenCode SSE events wrap data in { type, properties: { ... } }.
        // Flatten so downstream code can access fields directly.
        const props = asRecord(rawEvent.properties);
        const event =
          Object.keys(props).length > 0
            ? { ...props, type: eventType }
            : rawEvent;

        // Use strict extractor — only explicit session fields, no generic `id`
        // that could match message/event IDs and cause false filtering.
        const canonicalSessionInfoId =
          eventType === 'session.created' ||
          eventType === 'session.updated' ||
          eventType === 'session.deleted'
            ? asString(asRecord(event.info).id)
            : undefined;
        const eventSessionId =
          loadStreamSessionId(event) ??
          loadStreamSessionId(event.data) ??
          loadStreamSessionId(event.info) ??
          loadStreamSessionId(event.message) ??
          loadStreamSessionId(asRecord(event.part)) ??
          canonicalSessionInfoId;
        const sessionInfo = asRecord(event.info);
        const sessionLifecycle =
          eventType === 'session.created' ||
          eventType === 'session.updated' ||
          eventType === 'session.deleted';
        const lifecycleSessionId = sessionLifecycle
          ? (asString(sessionInfo.id) ?? eventSessionId)
          : undefined;
        const lifecycleParentId = sessionLifecycle
          ? asString(sessionInfo.parentID)
          : undefined;
        if (
          eventType !== 'session.deleted' &&
          lifecycleSessionId &&
          lifecycleParentId &&
          ownedSessionIds.has(lifecycleParentId)
        ) {
          ownedSessionIds.add(lifecycleSessionId);
        }

        const permissionControlEvent =
          eventType === 'permission.updated' ||
          eventType === 'permission.asked' ||
          eventType === 'permission.replied';
        const ownedPermissionControl =
          permissionControlEvent &&
          eventSessionId !== undefined &&
          ownedSessionIds.has(eventSessionId);
        const ownedSessionLifecycle =
          sessionLifecycle &&
          lifecycleSessionId !== undefined &&
          ownedSessionIds.has(lifecycleSessionId);
        const rootSessionEvent = eventSessionId === sessionId;
        const ownedSessionEvent =
          eventSessionId !== undefined && ownedSessionIds.has(eventSessionId);

        // Session ownership and output visibility are distinct scopes. Every
        // explicitly tagged event from the root or one of its descendants
        // proves that this run is progressing, while ordinary descendant
        // output remains filtered below.
        if (ownedSessionEvent) {
          remainingInactivityMs = this.eventInactivityTimeoutMs;
          lastRelevantEvent = eventType;
        }

        if (
          eventSessionId &&
          !rootSessionEvent &&
          !ownedPermissionControl &&
          !ownedSessionLifecycle
        ) {
          continue;
        }
        if (rootSessionEvent) {
          // Only mark backend-provided after confirming the event belongs
          // to this session — foreign events must not flip the flag.
          backendProvidedSessionId = true;
        }

        if (ownedSessionLifecycle && !rootSessionEvent) {
          if (eventType === 'session.deleted' && lifecycleSessionId) {
            ownedSessionIds.delete(lifecycleSessionId);
          }
          continue;
        }

        if (eventType === 'message.removed') {
          const messageId = loadOpenCodeUpdatedMessageId(event);
          if (messageId) {
            for (
              let index = pendingContentHead;
              index < pendingContentEvents.length;
              index++
            ) {
              const item = pendingContentEvents[index];
              if (!item?.removed && item.messageId === messageId) {
                // Replace rather than annotate so a removed message's raw
                // payload is released even while an earlier item blocks head.
                pendingContentEvents[index] = { removed: true };
              }
            }
            messageRoles.delete(messageId);
            for (const [partId, ownerId] of partOwners) {
              if (ownerId !== messageId) continue;
              partOwners.delete(partId);
              partKinds.delete(partId);
              settledPartSnapshots.delete(partId);
              emittedTextDeltas.delete(partId);
            }
          }
          for (const normalized of drainPendingContent()) {
            yield normalized;
          }
          continue;
        }

        if (eventType === 'message.updated') {
          const messageId = loadOpenCodeUpdatedMessageId(event);
          const role = loadOpenCodeMessageRole(event);
          if (messageId && role) {
            messageRoles.set(messageId, role);
            for (const normalized of drainPendingContent()) {
              yield normalized;
            }
          }
          continue;
        }

        if (eventType === 'message.part.removed') {
          const partId = loadOpenCodePartId(event);
          if (partId) {
            for (
              let index = pendingContentHead;
              index < pendingContentEvents.length;
              index++
            ) {
              const item = pendingContentEvents[index];
              if (!item?.removed && item.partId === partId) {
                pendingContentEvents[index] = { removed: true };
              }
            }
            partKinds.delete(partId);
            partOwners.delete(partId);
            settledPartSnapshots.delete(partId);
            emittedTextDeltas.delete(partId);
          }
          for (const normalized of drainPendingContent()) {
            yield normalized;
          }
          continue;
        }

        if (
          eventType === 'session.next.text.delta' ||
          eventType === 'session.next.reasoning.delta'
        ) {
          const contentKind = eventType === 'session.next.text.delta'
            ? 'text'
            : 'reasoning';
          for (const normalized of queueContent(
            eventType,
            event,
            contentKind,
          )) {
            yield normalized;
          }
          continue;
        }

        if (eventType === 'message.part.delta') {
          const partId = loadOpenCodePartId(event);
          const inlinePartKind = loadOpenCodePartKind(event);
          // A generic delta without either a correlatable part identifier or
          // inline part metadata can never become classifiable. Fail closed
          // immediately so malformed traffic cannot hold the ordered queue.
          if (!partId && !inlinePartKind) continue;
          if (inlinePartKind === 'other') continue;

          for (const normalized of queueContent(
            eventType,
            event,
            inlinePartKind,
          )) {
            yield normalized;
          }
          continue;
        }

        if (eventType === 'message.part.updated') {
          const message = asRecord(event.message);
          const part = asRecord(event.part ?? message.part ?? event.data);
          const partType = asString(part.type)?.toLowerCase();
          const partId = loadOpenCodePartId(event);
          const messageId = loadOpenCodePartMessageId(event);
          const partKind = loadOpenCodePartKind(event);

          if (partId && partKind) {
            partKinds.set(partId, partKind);
            if (messageId) partOwners.set(partId, messageId);
            for (const normalized of drainPendingContent()) {
              yield normalized;
            }
          }

          if (partKind === 'text' || partKind === 'reasoning') {
            for (const normalized of queueContent(
              eventType,
              event,
              partKind,
            )) {
              yield normalized;
            }
            continue;
          }

          if (
            partType === 'tool' ||
            partType === 'tool_call' ||
            partType === 'tool_use'
          ) {
            const state = asRecord(part.state);
            const stateStatus = asString(state.status)?.toLowerCase();

            // OPENCODE-016: correlation uses callID — the provider's
            // invocation id, which permission.asked also references —
            // not part.id, which names the enclosing message part.
            const toolUseId =
              asString(part.callID) ??
              asString(part.callId) ??
              asString(part.toolUseId) ??
              asString(part.id) ??
              generateSessionId();

            const toolName =
              asString(part.toolName) ??
              asString(part.name) ??
              asString(part.tool) ??
              asString(asRecord(part.tool).name) ??
              'unknown_tool';

            let call = toolCalls.get(toolUseId);
            if (!call) {
              call = { toolName, useEmitted: false, resultEmitted: false };
              toolCalls.set(toolUseId, call);
            } else if (toolName !== 'unknown_tool') {
              call.toolName = toolName;
            }

            // Pending snapshots stream partially parsed arguments; the
            // input is settled once the call runs or terminates. Parts
            // without lifecycle state emit immediately (legacy shape).
            // A call already terminated by a permission denial gets no
            // late tool_use behind its terminal result.
            if (
              stateStatus !== 'pending' &&
              !call.useEmitted &&
              !call.resultEmitted
            ) {
              call.useEmitted = true;
              accumulatedToolUses++;
              const description =
                asString(part.description) ?? asString(state.title);
              yield createEvent(
                'tool_use',
                AGENT,
                {
                  toolName: call.toolName,
                  toolUseId,
                  input: parseToolInput(
                    state.input ??
                      part.input ??
                      part.arguments ??
                      part.args ??
                      asRecord(part.tool).input,
                  ),
                  ...(description ? { description } : {}),
                },
                sessionId,
              );
            }

            if (
              (stateStatus === 'completed' || stateStatus === 'error') &&
              !call.resultEmitted
            ) {
              call.resultEmitted = true;
              const time = asRecord(state.time);
              const start = asNumber(time.start);
              const end = asNumber(time.end);
              yield createEvent(
                'tool_result',
                AGENT,
                {
                  toolUseId,
                  toolName: call.toolName,
                  status: stateStatus === 'completed' ? 'success' : 'error',
                  output:
                    (stateStatus === 'completed'
                      ? state.output
                      : state.error) ?? null,
                  ...(start !== undefined && end !== undefined
                    ? { durationMs: end - start }
                    : {}),
                },
                sessionId,
              );
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

          // Accumulate usage from step-finish parts.
          if (partType === 'step-finish') {
            const tokens = asRecord(part.tokens);
            const cache = asRecord(tokens.cache);
            const inputTokens = readUsageCounter(tokens, ['input'], true);
            const outputTokens = readUsageCounter(tokens, ['output'], true);
            const reasoningTokens = readUsageCounter(
              tokens,
              ['reasoning'],
              true,
            );
            const cacheReadTokens = readUsageCounter(cache, ['read'], true);
            const cacheWriteTokens = readUsageCounter(cache, ['write'], true);
            accumulatedTokenUsageObserved = true;
            // OpenCode already normalizes to the DR-014 frame: `input` is
            // cache-exclusive and `output` excludes `reasoning`, so the five
            // counters are the partition and the aggregates are their sums.
            accumulatedComponents.input += inputTokens.value;
            accumulatedComponents.cacheRead += cacheReadTokens.value;
            accumulatedComponents.cacheWrite += cacheWriteTokens.value;
            accumulatedComponents.output += outputTokens.value;
            accumulatedComponents.reasoning += reasoningTokens.value;
            accumulatedInputTokens +=
              inputTokens.value +
              cacheReadTokens.value +
              cacheWriteTokens.value;
            accumulatedOutputTokens +=
              outputTokens.value + reasoningTokens.value;
            if (
              !inputTokens.valid ||
              !outputTokens.valid ||
              !reasoningTokens.valid ||
              !cacheReadTokens.valid ||
              !cacheWriteTokens.valid
            ) {
              accumulatedTokenUsageComplete = false;
            }
            accumulatedCost += asNumber(part.cost) ?? 0;
            continue;
          }

          continue;
        }

        if (
          eventType === 'permission.updated' ||
          eventType === 'permission.asked'
        ) {
          const permissionSessionId = eventSessionId ?? sessionId;
          const nestedPermission = asRecord(event.permission);
          const permission =
            eventType === 'permission.asked' ||
            Object.keys(nestedPermission).length === 0
              ? event
              : nestedPermission;
          const reason = asString(permission.reason) ?? asString(event.reason);
          const toolName =
            (eventType === 'permission.updated'
              ? asString(props.type)
              : undefined) ??
            asString(permission.permission) ??
            asString(permission.toolName) ??
            asString(permission.name) ??
            asString(event.toolName) ??
            'unknown_tool';
          const requestId =
            asString(permission.requestID) ??
            asString(permission.id) ??
            asString(event.requestID);
          const toolUseId =
            asString(asRecord(permission.tool).callID) ??
            asString(permission.callID) ??
            asString(permission.toolUseId) ??
            asString(event.toolUseId) ??
            requestId ??
            generateSessionId();
          const input = parseToolInput(
            permission.input ?? permission.metadata ?? event.input ?? {},
          );
          const patterns = parsePermissionPatterns(
            permission.patterns,
            permission.pattern,
            event.patterns,
            event.pattern,
          );

          if (requestId) {
            const requestKey = permissionRequestKey(
              permissionSessionId,
              requestId,
            );
            if (repliedPermissionRequests.has(requestKey)) {
              continue;
            }
            // permission.replied carries only requestID; remember which
            // tool call (callID) a later denial must resolve to.
            permissionRequests.set(requestKey, {
              toolUseId:
                asString(asRecord(permission.tool).callID) ??
                asString(permission.callID) ??
                toolUseId,
              toolName,
            });
          }

          if (options?.permissions?.mode !== 'auto') {
            yield createEvent(
              'permission_request',
              AGENT,
              {
                toolName,
                toolUseId,
                input,
                ...(reason ? { reason } : {}),
              },
              sessionId,
            );
          }

          if (abortRequested || options?.abortSignal?.aborted) {
            yield* drainPendingContent(true);
            startKnownSessionAbort();
            yield createEvent(
              'done',
              AGENT,
              {
                status: 'interrupted',
                ...doneResumeTokenPayload(
                  'interrupted',
                  backendProvidedSessionId,
                  sessionId,
                  options?.resume,
                ),
                usage: accumulatedUsage(),
                durationMs: Date.now() - startTime,
              },
              sessionId,
            );
            doneYielded = true;
            break;
          }

          if (!requestId) {
            // No deterministic reply is possible, so stop the transport before
            // yielding queued output on this terminal path.
            eventStreamController.abort();
            yield* drainPendingContent(true);
            await abortActiveSession(true);
            if (abortRequested || options?.abortSignal?.aborted) {
              yield createEvent(
                'done',
                AGENT,
                {
                  status: 'interrupted',
                  ...doneResumeTokenPayload(
                    'interrupted',
                    backendProvidedSessionId,
                    sessionId,
                    options?.resume,
                  ),
                  usage: accumulatedUsage(),
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
                code: 'OPENCODE_PERMISSION_REQUEST_INVALID',
                message:
                  'Cannot resolve OpenCode headless permission request ' +
                  `(sessionID=${JSON.stringify(permissionSessionId)}, ` +
                  'requestID="<missing>", ' +
                  `permission=${JSON.stringify(toolName)}): ` +
                  'the event did not include a permission request ID',
                recoverable: false,
              },
              sessionId,
            );
            if (abortRequested || options?.abortSignal?.aborted) {
              yield createEvent(
                'done',
                AGENT,
                {
                  status: 'interrupted',
                  ...doneResumeTokenPayload(
                    'interrupted',
                    backendProvidedSessionId,
                    sessionId,
                    options?.resume,
                  ),
                  usage: accumulatedUsage(),
                  durationMs: Date.now() - startTime,
                },
                sessionId,
              );
              doneYielded = true;
              break;
            }
            yield createEvent(
              'done',
              AGENT,
              {
                status: 'error',
                ...doneResumeTokenPayload(
                  'error',
                  backendProvidedSessionId,
                  sessionId,
                  options?.resume,
                ),
                usage: accumulatedUsage(),
                durationMs: Date.now() - startTime,
              },
              sessionId,
            );
            doneYielded = true;
            break;
          }

          const requestKey = permissionRequestKey(
            permissionSessionId,
            requestId,
          );
          repliedPermissionRequests.add(requestKey);

          const decision =
            options?.permissions?.mode === 'auto' ? 'once' : 'reject';
          const replyPromise = client?.replyPermission
            ? client.replyPermission({
                sessionId: permissionSessionId,
                requestId,
                permission: toolName,
                decision,
                ...(options?.cwd ? { cwd: options.cwd } : {}),
                signal: eventStreamController.signal,
              })
            : Promise.reject(
                new Error('SDK client permission reply API not available'),
              );
          const replyRace = await new Promise<PermissionReplyWaitResult>(
            (resolve) => {
              let settled = false;
              let replyTimeout: ReturnType<typeof setTimeout> | undefined;
              const finish = (result: PermissionReplyWaitResult) => {
                if (settled) return;
                settled = true;
                if (replyTimeout) clearTimeout(replyTimeout);
                if (abortPermissionWait === abortCurrentReply) {
                  abortPermissionWait = undefined;
                }
                resolve(result);
              };
              const abortCurrentReply = () => finish({ kind: 'abort' });

              abortPermissionWait = abortCurrentReply;
              replyPromise.then(
                () => finish({ kind: 'replied' }),
                (error: unknown) => finish({ kind: 'error', error }),
              );
              replyTimeout = setTimeout(
                () => finish({ kind: 'timeout' }),
                PERMISSION_REPLY_TIMEOUT_MS,
              );

              if (abortRequested || options?.abortSignal?.aborted) {
                abortCurrentReply();
              }
            },
          );

          if (replyRace.kind === 'replied' && decision === 'once') {
            yield createEvent(
              'opencode:permission_decision',
              AGENT,
              {
                requestId,
                nativeSessionId: permissionSessionId,
                permission: toolName,
                patterns,
                toolUseId,
                decision,
                automated: true,
                input,
                ...(reason ? { reason } : {}),
              },
              sessionId,
            );
          }

          if (
            replyRace.kind === 'abort' ||
            abortRequested ||
            options?.abortSignal?.aborted
          ) {
            replyPromise.catch(() => {});
            yield* drainPendingContent(true);
            startKnownSessionAbort();
            yield createEvent(
              'done',
              AGENT,
              {
                status: 'interrupted',
                ...doneResumeTokenPayload(
                  'interrupted',
                  backendProvidedSessionId,
                  sessionId,
                  options?.resume,
                ),
                usage: accumulatedUsage(),
                durationMs: Date.now() - startTime,
              },
              sessionId,
            );
            doneYielded = true;
            break;
          }

          if (replyRace.kind === 'error' || replyRace.kind === 'timeout') {
            // Cancel the failed response request and paired SSE transport
            // before yielding queued output. The caller may suspend the
            // generator at that yield, but native I/O must already be stopped.
            eventStreamController.abort();
            replyPromise.catch(() => {});
            yield* drainPendingContent(true);
            await abortActiveSession(true);
            if (abortRequested || options?.abortSignal?.aborted) {
              yield createEvent(
                'done',
                AGENT,
                {
                  status: 'interrupted',
                  ...doneResumeTokenPayload(
                    'interrupted',
                    backendProvidedSessionId,
                    sessionId,
                    options?.resume,
                  ),
                  usage: accumulatedUsage(),
                  durationMs: Date.now() - startTime,
                },
                sessionId,
              );
              doneYielded = true;
              break;
            }
            const detail =
              replyRace.kind === 'timeout'
                ? `timed out after ${PERMISSION_REPLY_TIMEOUT_MS}ms`
                : replyRace.error instanceof Error
                  ? replyRace.error.message
                  : String(replyRace.error);
            yield createEvent(
              'error',
              AGENT,
              {
                code: 'OPENCODE_PERMISSION_REPLY_FAILED',
                message:
                  'Failed to resolve OpenCode headless permission request ' +
                  `(sessionID=${JSON.stringify(permissionSessionId)}, ` +
                  `requestID=${JSON.stringify(requestId)}, ` +
                  `permission=${JSON.stringify(toolName)}): ${detail}`,
                recoverable: false,
              },
              sessionId,
            );
            if (abortRequested || options?.abortSignal?.aborted) {
              yield createEvent(
                'done',
                AGENT,
                {
                  status: 'interrupted',
                  ...doneResumeTokenPayload(
                    'interrupted',
                    backendProvidedSessionId,
                    sessionId,
                    options?.resume,
                  ),
                  usage: accumulatedUsage(),
                  durationMs: Date.now() - startTime,
                },
                sessionId,
              );
              doneYielded = true;
              break;
            }
            yield createEvent(
              'done',
              AGENT,
              {
                status: 'error',
                ...doneResumeTokenPayload(
                  'error',
                  backendProvidedSessionId,
                  sessionId,
                  options?.resume,
                ),
                usage: accumulatedUsage(),
                durationMs: Date.now() - startTime,
              },
              sessionId,
            );
            doneYielded = true;
            break;
          }
          continue;
        }

        if (eventType === 'permission.replied') {
          const permission = asRecord(event.permission);
          const requestId =
            asString(permission.requestID) ??
            asString(event.requestID) ??
            asString(permission.permissionID) ??
            asString(event.permissionID);
          const permissionSessionId = correlatePermissionSessionId(
            eventSessionId,
            requestId,
          );
          const asked = requestId
            ? permissionRequests.get(
                permissionRequestKey(permissionSessionId, requestId),
              )
            : undefined;
          if (requestId) {
            // A reply is terminal correlation state regardless of decision.
            // Keeping successful `once` replies would grow the correlation
            // state for the lifetime of a long-running session.
            permissionRequests.delete(
              permissionRequestKey(permissionSessionId, requestId),
            );
          }
          if (permissionSessionId !== sessionId) {
            continue;
          }
          const decision = (
            asString(permission.decision) ??
            asString(event.decision) ??
            asString(permission.status) ??
            asString(event.status) ??
            asString(permission.response) ??
            asString(event.response) ??
            asString(event.reply) ??
            ''
          ).toLowerCase();

          if (
            decision === 'denied' ||
            decision === 'rejected' ||
            decision === 'reject'
          ) {
            const toolUseId =
              asked?.toolUseId ??
              asString(asRecord(permission.tool).callID) ??
              asString(permission.toolUseId) ??
              asString(permission.id) ??
              asString(event.toolUseId) ??
              generateSessionId();

            // OPENCODE-016: the denial is the call's terminal result; the
            // tool part will still transition to an error state afterwards
            // and must not produce a second one — and a call that already
            // terminated gets no denied result behind its terminal one.
            let call = toolCalls.get(toolUseId);
            if (call?.resultEmitted) {
              continue;
            }

            // The ask names the permission it gates ('edit'), not the
            // tool; the tracked call holds the tool name from part.tool.
            const trackedName =
              call && call.toolName !== 'unknown_tool'
                ? call.toolName
                : undefined;
            const toolName =
              trackedName ??
              asString(permission.toolName) ??
              asString(permission.name) ??
              asString(event.toolName) ??
              asked?.toolName ??
              'unknown_tool';

            if (!call) {
              call = { toolName, useEmitted: false, resultEmitted: false };
              toolCalls.set(toolUseId, call);
            }
            call.resultEmitted = true;

            yield createEvent(
              'tool_result',
              AGENT,
              {
                toolName,
                toolUseId,
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

        if (eventType === 'error' || eventType === 'session.error') {
          if (eventType === 'session.error') {
            sessionErrorObserved = true;
          }
          const errorData = eventType === 'session.error'
            ? toErrorPayload(event.error ?? event)
            : toErrorPayload(event);
          yield createEvent('error', AGENT, errorData, sessionId);
          continue;
        }

        // session.idle (OpenCode sends { sessionID } with no usage/status)
        // or session.status with status.type === 'idle'.
        if (
          eventType === 'session.idle' ||
          (eventType === 'session.status' &&
            asString(asRecord(event.status).type) === 'idle')
        ) {
          for (const normalized of drainPendingContent(true)) {
            yield normalized;
          }
          if (abortRequested || options?.abortSignal?.aborted) {
            startKnownSessionAbort();
            yield createEvent(
              'done',
              AGENT,
              {
                status: 'interrupted',
                ...doneResumeTokenPayload(
                  'interrupted',
                  backendProvidedSessionId,
                  sessionId,
                  options?.resume,
                ),
                usage: accumulatedUsage(),
                durationMs: Date.now() - startTime,
              },
              sessionId,
            );
            doneYielded = true;
            break;
          }
          const status = sessionErrorObserved
            ? 'error'
            : mapDoneStatus(asString(event.status));
          // Use event-provided usage if available, otherwise fall back to
          // values accumulated from step-finish parts.
          const eventUsage = mapUsage(event.usage, accumulatedToolUses);
          const eventTokenUsageObserved = hasOpenCodeEventTokenCounters(
            event.usage,
          );
          const accumulatedReported =
            accumulatedTokenUsageObserved && accumulatedTokenUsageComplete;
          // OPENCODE-005: only complete step accounting yields a partition;
          // ENG-027 suppresses the breakdown on unavailable accounting.
          const accumulatedBreakdown = accumulatedReported
            ? buildTokenBreakdown(
                {
                  inputTokens: accumulatedInputTokens,
                  outputTokens: accumulatedOutputTokens,
                },
                accumulatedComponents,
              )
            : undefined;
          const accumulatedEventUsage: DonePayload['usage'] = {
            tokenAvailability: accumulatedReported ? 'reported' : 'unavailable',
            inputTokens: accumulatedInputTokens,
            outputTokens: accumulatedOutputTokens,
            toolUses: Math.max(eventUsage.toolUses, accumulatedToolUses),
            ...(accumulatedCost > 0
              ? { totalCostUsd: accumulatedCost }
              : {}),
            ...(accumulatedBreakdown
              ? { breakdown: accumulatedBreakdown }
              : {}),
          };
          const usage: DonePayload['usage'] = eventTokenUsageObserved
            ? {
                ...eventUsage,
                // A malformed mapped counter from either provider source
                // poisons availability; a valid source must not hide it.
                tokenAvailability:
                  eventUsage.tokenAvailability === 'reported' &&
                  (!accumulatedTokenUsageObserved ||
                    accumulatedTokenUsageComplete)
                    ? 'reported'
                    : 'unavailable',
                toolUses: Math.max(
                  eventUsage.toolUses,
                  accumulatedToolUses,
                ),
              }
            : accumulatedTokenUsageObserved
              ? accumulatedEventUsage
              : eventUsage;

          yield createEvent(
            'done',
            AGENT,
            {
              status,
              result: asString(event.result),
              ...doneResumeTokenPayload(
                status,
                backendProvidedSessionId,
                sessionId,
                options?.resume,
              ),
              usage,
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
        for (const normalized of drainPendingContent(true)) {
          yield normalized;
        }
        if (abortRequested || options?.abortSignal?.aborted) {
          startKnownSessionAbort();
          yield createEvent(
            'done',
            AGENT,
            {
              status: 'interrupted',
              ...doneResumeTokenPayload(
                'interrupted',
                backendProvidedSessionId,
                sessionId,
                options?.resume,
              ),
              usage: accumulatedUsage(),
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
              ...doneResumeTokenPayload(
                'error',
                backendProvidedSessionId,
                sessionId,
                options?.resume,
              ),
              usage: accumulatedUsage(),
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
            tools: [],
            capabilities: {
              mode: this.mode,
              toolsKnown: false,
              toolsSource: 'unavailable',
            },
          },
          sessionId,
        );
        initYielded = true;
      }

      if (!doneYielded) {
        for (const normalized of drainPendingContent(true)) {
          yield normalized;
        }
        if (abortRequested || options?.abortSignal?.aborted) {
          startKnownSessionAbort();
          yield createEvent(
            'done',
            AGENT,
            {
              status: 'interrupted',
              ...doneResumeTokenPayload(
                'interrupted',
                backendProvidedSessionId,
                sessionId,
                options?.resume,
              ),
              usage: accumulatedUsage(),
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
              ...doneResumeTokenPayload(
                'error',
                backendProvidedSessionId,
                sessionId,
                options?.resume,
              ),
              usage: accumulatedUsage(),
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

      eventStreamController.abort();

      // The managed control plane must begin shutting down before any SDK
      // cleanup wait. Each SDK cleanup attempt is independently bounded, so
      // a rejected or non-settling hook cannot suppress the others or child
      // termination.
      if (serverProcess && !serverClosed) {
        try {
          serverProcess.kill('SIGTERM');
        } catch {
          // ignore cleanup errors
        }

      }

      const sdkCleanup = Promise.all([
        sessionAbortPromise
          ? promiseSettlesWithin(
              sessionAbortPromise,
              ITERATOR_CLEANUP_TIMEOUT_MS,
            ).then(() => {})
          : Promise.resolve(),
        returnActiveIterator(),
        maybeCallAsyncWithin(
          client?.close?.bind(client),
          ITERATOR_CLEANUP_TIMEOUT_MS,
        ),
        maybeCallAsyncWithin(
          client?.shutdown?.bind(client),
          ITERATOR_CLEANUP_TIMEOUT_MS,
        ),
      ]).then(() => {});
      const termCleanup =
        serverProcess && !serverClosed && serverExitPromise
          ? promiseSettlesWithin(
              serverExitPromise,
              this.managedServerTermGraceMs,
            ).then(() => {})
          : Promise.resolve();

      await Promise.all([sdkCleanup, termCleanup]);

      if (serverProcess && !serverClosed) {
        if (!serverClosed) {
          try {
            serverProcess.kill('SIGKILL');
          } catch {
            // The adapter owns this child, but there is no stronger process
            // primitive after a failed SIGKILL attempt.
          }

          if (serverExitPromise) {
            await promiseSettlesWithin(
              serverExitPromise,
              this.managedServerKillGraceMs,
            );
          }
        }
      }
    }
  }
}
