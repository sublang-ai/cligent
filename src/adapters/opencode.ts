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
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import {
  assertRuntimeSupported,
  isCliRuntimeSupported,
  isUnsupportedRuntimeError,
} from '../runtime-version.js';

const AGENT = 'opencode' as const;
const DEFAULT_MANAGED_URL = 'http://127.0.0.1:0';
const DEFAULT_EVENT_INACTIVITY_TIMEOUT_MS = 300_000;
const MAX_STATUS_QUERY_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ITERATOR_CLEANUP_TIMEOUT_MS = 250;
const DEFAULT_MANAGED_SERVER_TERM_GRACE_MS = 1_500;
const DEFAULT_MANAGED_SERVER_KILL_GRACE_MS = 500;

const DEFAULT_DONE_USAGE: DonePayload['usage'] = {
  inputTokens: 0,
  outputTokens: 0,
  toolUses: 0,
};

type OpenCodeMode = 'managed' | 'external';
type OpenCodeSdkApiVersion = 'v1' | 'v2';
type OpenCodeVariant = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type OpenCodeV2PromptBody = NonNullable<SessionPromptAsyncData['body']>;
type OpenCodeV2Tools = NonNullable<OpenCodeV2PromptBody['tools']>;

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
  getSessionStatus?: (options: {
    sessionId: string;
    cwd?: string;
  }) => Promise<unknown>;
  abortSession?: (options: {
    sessionId: string;
    cwd?: string;
  }) => Promise<void>;
  close?: () => Promise<void> | void;
  shutdown?: () => Promise<void> | void;
}

interface OpenCodeSdk {
  createClient: (options?: { baseUrl?: string }) => OpenCodeClient;
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
  permission?: {
    edit: PermissionLevel;
    bash: PermissionLevel;
    webfetch: PermissionLevel;
  };
  writablePaths?: WritablePathsPermissionMapping;
  tools?: {
    core?: string[];
    exclude?: string[];
  };
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

  const baseInput =
    asNumber(usage.inputTokens) ?? asNumber(usage.input_tokens) ?? 0;
  const cacheRead =
    asNumber(usage.cacheReadInputTokens) ?? asNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheCreation =
    asNumber(usage.cacheCreationInputTokens) ?? asNumber(usage.cache_creation_input_tokens) ?? 0;
  const inputTokens = baseInput + cacheRead + cacheCreation;

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
    asString(record.sessionID) ??
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
    return Promise.resolve(result).then(() => {});
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

function createMonotonicInactivityTimer(
  lastActivityAt: number,
  timeoutMs: number,
): {
  promise: Promise<{ kind: 'inactivity' }>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let resolveDeadline!: (value: { kind: 'inactivity' }) => void;
  const promise = new Promise<{ kind: 'inactivity' }>((resolve) => {
    resolveDeadline = resolve;
  });

  const scheduleNextChunk = () => {
    if (cancelled) return;
    const elapsedMs = performance.now() - lastActivityAt;
    const remainingMs = timeoutMs - elapsedMs;
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
  for (const [option, tools] of [
    ['allowedTools', options?.allowedTools],
    ['disallowedTools', options?.disallowedTools],
  ] as const) {
    if (tools?.some((tool) => tool.includes('*'))) {
      throw new TypeError(
        `OpenCode ${option} accepts exact tool identifiers, not wildcard patterns`,
      );
    }
  }
  const writablePaths = mapWritablePathsPermission(policy, 'ambient');
  const allowedListProvided = options?.allowedTools !== undefined;
  const exclude = [...new Set(options?.disallowedTools ?? [])];
  const excluded = new Set(exclude);
  const core = [...new Set(options?.allowedTools ?? [])].filter(
    (tool) => !excluded.has(tool),
  );
  const tools =
    allowedListProvided || exclude.length > 0
      ? {
          ...(allowedListProvided ? { core } : {}),
          ...(exclude.length > 0 ? { exclude } : {}),
        }
      : undefined;

  if (policy === undefined) {
    return tools ? { tools } : {};
  }

  // ENG-021: session-wide mode takes precedence over per-capability levels.
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
        "place to attach. Use mode: 'auto' (the SDK equivalent of " +
        'opencode.json\'s "permission": "allow") or set the per-capability ' +
        'fileWrite / shellExecute / networkAccess levels explicitly.',
    );
  }

  if (policy.mode === 'auto') {
    // SDK equivalent of opencode.json's `"permission": "allow"` global
    // setting: every per-tool permission set to 'allow'. The per-capability
    // path is short-circuited; user-passed allowedTools / disallowedTools
    // (independent from `permissions`) still apply.
    return {
      permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' },
      ...(writablePaths ? { writablePaths } : {}),
      ...(tools ? { tools } : {}),
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
    ...(tools ? { tools } : {}),
  };
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

  for (const key of ['edit', 'bash', 'webfetch'] as const) {
    const action = asPermissionAction(record[key]);
    if (action) {
      rules.push({ permission: key, pattern: '*', action });
    }
  }

  return rules.length > 0 ? rules : undefined;
}

function toOpenCodeV2Tools(tools: unknown): OpenCodeV2Tools | undefined {
  const record = asRecord(tools);
  const hasExplicitCore = Object.prototype.hasOwnProperty.call(record, 'core');
  const core = asStringArray(record.core);
  const exclude = asStringArray(record.exclude);
  const mapped: OpenCodeV2Tools = {};

  if (core.some((tool) => tool.includes('*'))) {
    throw new TypeError(
      'OpenCode prompt allowlist accepts exact tool identifiers, not wildcard patterns',
    );
  }

  if (hasExplicitCore) {
    mapped['*'] = false;
  }
  for (const tool of core) {
    mapped[tool] = true;
  }
  for (const tool of exclude) {
    mapped[tool] = false;
  }

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function toOpenCodeV1Tools(tools: unknown): unknown {
  return toOpenCodeV2Tools(tools);
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
  const eventSubscribe = event.subscribe.bind(event) as (
    args?: unknown,
    requestOptions?: unknown,
  ) => Promise<unknown>;
  const instanceDispose = instance && typeof instance.dispose === 'function'
    ? (instance.dispose.bind(instance) as () => Promise<void>)
    : undefined;

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
      const resumeId = asString(options.sessionId);
      const cwdVal = asString(options.cwd);
      const permissionObj = options.permission;
      const toolsObj = options.tools;
      const v1Tools = toOpenCodeV1Tools(toolsObj);
      const variantVal = asString(options.variant);
      const modelVal = toOpenCodePromptModel(options.model);
      const signal = options.signal instanceof AbortSignal
        ? options.signal
        : undefined;
      const v2PermissionRuleset = toOpenCodeV2PermissionRuleset(permissionObj);
      const v2Tools = toOpenCodeV2Tools(toolsObj);

      let sessionId: string | undefined;
      let resolveRunAbort!: () => void;
      const runAbortPromise = new Promise<void>((resolve) => {
        resolveRunAbort = resolve;
      });
      let dispatchAbortPromise: Promise<void> | undefined;
      const abortKnownSession = (): Promise<void> => {
        if (!sessionId) return Promise.resolve();
        dispatchAbortPromise ??= abortSessionViaSdk(sessionId, cwdVal);
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

      const stopAbortedDispatch = async (): Promise<never> => {
        await promiseSettlesWithin(
          abortKnownSession(),
          ITERATOR_CLEANUP_TIMEOUT_MS,
        );
        throw new Error('OpenCode run aborted during prompt dispatch');
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

      if (resumeId) {
        // Resume an existing session instead of creating a new one.
        sessionId = resumeId;
        if (signal?.aborted) return stopAbortedDispatch();
        if (apiVersion === 'v2' && v2PermissionRuleset) {
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
                  ...(v2PermissionRuleset
                    ? { permission: v2PermissionRuleset }
                    : {}),
                },
                signal ? { signal } : undefined,
              )
            : sessionCreate(signal ? { signal } : undefined)),
        );
        throwIfSdkResultError(created, 'OpenCode session.create failed');
        sessionId = asString(created.id) ?? asString(asRecord(created.data).id);
      }

      if (!sessionId) {
        sessionId = generateSessionId();
      }
      if (signal?.aborted) return stopAbortedDispatch();
      const promptSessionId = sessionId;

      const promptBody = {
        parts: [{ type: 'text', text: options.prompt }],
        ...(modelVal ? { model: modelVal } : {}),
        ...(variantVal ? { variant: variantVal } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.steps !== undefined ? { steps: options.steps } : {}),
        ...(permissionObj !== undefined ? { permission: permissionObj } : {}),
        ...(toolsObj !== undefined ? { tools: v1Tools } : {}),
      };

      const v2PromptParameters: { sessionID: string } & OpenCodeV2PromptBody & {
        directory?: string;
      } = {
        sessionID: promptSessionId,
        parts: [{ type: 'text', text: asString(options.prompt) ?? '' }],
        ...(modelVal ? { model: modelVal as OpenCodeV2PromptBody['model'] } : {}),
        ...(variantVal ? { variant: variantVal } : {}),
        ...(cwdVal ? { directory: cwdVal } : {}),
        ...(v2Tools ? { tools: v2Tools } : {}),
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
                signal
                  ? {
                      signal,
                      ...(cwdVal ? { query: { directory: cwdVal } } : {}),
                    }
                  : undefined,
              ),
        ),
      );
      const rawStream = subResult.stream ?? subResult.events ?? subResult;
      let events: AsyncIterable<unknown> | undefined;
      let eagerFirst: Promise<IteratorResult<unknown>> | undefined;
      let rawIterator: AsyncIterator<unknown> | undefined;

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
                  body: promptBody,
                  ...(signal ? { signal } : {}),
                },
            apiVersion === 'v2' && signal ? { signal } : undefined,
          ),
        );
        throwIfSdkResultError(promptResult, 'OpenCode session.prompt failed');
      }

      if (signal?.aborted) return stopAbortedDispatch();
      signal?.removeEventListener('abort', onRunAbort);

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

      return {
        id: sessionId,
        sessionId,
        ...(events ? { events } : {}),
      };
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
        await instanceDispose();
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

    let sessionId = options?.resume ?? generateSessionId();
    let backendProvidedSessionId = false;

    // Accumulate usage from step-finish parts (OpenCode's session.idle
    // event doesn't carry usage data).
    let accumulatedInputTokens = 0;
    let accumulatedOutputTokens = 0;
    let accumulatedToolUses = 0;
    let accumulatedCost = 0;

    const eventStreamController = new AbortController();
    let resolveCallerAbort!: () => void;
    const callerAbortPromise = new Promise<void>((resolve) => {
      resolveCallerAbort = resolve;
    });
    let iterator: AsyncIterator<unknown> | undefined;

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

    const onAbort = () => {
      abortRequested = true;
      eventStreamController.abort();
      resolveCallerAbort();
      if (serverProcess && !serverClosed) {
        try {
          serverProcess.kill('SIGTERM');
        } catch {
          // ignore kill errors during shutdown
        }
      }
    };

    if (abortRequested) {
      onAbort();
    } else if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    let client: OpenCodeClient | undefined;

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

      const runPromise = runFn({
        prompt,
        cwd: options?.cwd,
        model: options?.model,
        signal: eventStreamController.signal,
        ...(variant ? { variant } : {}),
        ...(options?.maxTurns !== undefined ? { steps: options.maxTurns } : {}),
        ...(options?.resume ? { sessionId: options.resume } : {}),
        ...mappedPermissions,
      });
      const runOutcome = await Promise.race([
        runPromise.then(
          (value) => ({ kind: 'success' as const, value }),
          (error: unknown) => ({ kind: 'failure' as const, error }),
        ),
        callerAbortPromise.then(() => ({ kind: 'caller_abort' as const })),
      ]);
      if (runOutcome.kind === 'caller_abort') {
        await promiseSettlesWithin(runPromise, ITERATOR_CLEANUP_TIMEOUT_MS);
        throw new Error('OpenCode run aborted during prompt dispatch');
      }
      if (runOutcome.kind === 'failure') throw runOutcome.error;
      const runResult = runOutcome.value;

      const loadedId = loadSessionId(runResult);
      if (loadedId) {
        sessionId = loadedId;
        backendProvidedSessionId = true;
      }
      if (abortRequested) {
        if (client.abortSession) {
          await promiseSettlesWithin(
            client.abortSession({
              sessionId,
              ...(options?.cwd ? { cwd: options.cwd } : {}),
            }),
            ITERATOR_CLEANUP_TIMEOUT_MS,
          );
        }
        throw new Error('OpenCode run aborted during prompt dispatch');
      }

      if (!initYielded) {
        const runRecord = asRecord(runResult);
        const configuredTools = asStringArray(mappedPermissions.tools?.core ?? []);
        const runTools = asStringArray(runRecord.tools);
        const configuredAllowlist = options?.allowedTools !== undefined;

        yield createEvent(
          'init',
          AGENT,
          {
            model: options?.model ?? asString(runRecord.model) ?? 'unknown',
            cwd: options?.cwd ?? asString(runRecord.cwd) ?? process.cwd(),
            tools: configuredAllowlist
              ? configuredTools
              : runTools.length > 0
                ? runTools
                : configuredTools,
            capabilities: {
              mode: this.mode,
              toolsKnown:
                configuredAllowlist ||
                runTools.length > 0 ||
                configuredTools.length > 0,
              toolsSource:
                configuredAllowlist
                  ? 'configured'
                  : runTools.length > 0
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

      const stream = resolveEventStream(
        client,
        runResult,
        eventStreamController.signal,
      );
      if (!stream) {
        throw new Error('OpenCode SDK client does not provide an SSE event stream');
      }

      iterator = stream[Symbol.asyncIterator]();
      let lastRelevantActivityAt = performance.now();
      let lastRelevantEvent = 'prompt.dispatched';
      const controlTimeoutMs = Math.min(
        MAX_STATUS_QUERY_TIMEOUT_MS,
        this.eventInactivityTimeoutMs,
      );
      const serverRacePromise =
        this.mode === 'managed' && serverExitPromise
          ? serverExitPromise.then((exit) => ({
              kind: 'server_exit' as const,
              exit,
            }))
          : new Promise<never>(() => {});

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
        runControlOperation<void>(async () => {
          if (!client?.abortSession) {
            throw new Error('OpenCode SDK client does not provide session.abort()');
          }
          await client.abortSession({
            sessionId,
            ...(options?.cwd ? { cwd: options.cwd } : {}),
          });
        }, raceCallerAbort);

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

      const accumulatedUsage = (): DonePayload['usage'] => ({
        inputTokens: accumulatedInputTokens,
        outputTokens: accumulatedOutputTokens,
        toolUses: accumulatedToolUses,
        ...(accumulatedCost > 0 ? { totalCostUsd: accumulatedCost } : {}),
      });

      while (true) {
        const nextPromise = iterator.next();
        const inactivityTimer = createMonotonicInactivityTimer(
          lastRelevantActivityAt,
          this.eventInactivityTimeoutMs,
        );

        const raceResult = await Promise.race([
          nextPromise.then(
            (result) => ({ kind: 'event' as const, result }),
            (error: unknown) => ({ kind: 'iterator_error' as const, error }),
          ),
          serverRacePromise,
          callerAbortPromise.then(() => ({ kind: 'caller_abort' as const })),
          inactivityTimer.promise,
        ]);
        inactivityTimer.cancel();

        if (
          raceResult.kind === 'caller_abort' ||
          (raceResult.kind === 'event' && abortRequested)
        ) {
          nextPromise.catch(() => {});
          await abortActiveSession(false);
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
              usage: { ...DEFAULT_DONE_USAGE },
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
          nextPromise.catch(() => {});
          eventStreamController.abort();
          const elapsedInactivityMs = Math.max(
            0,
            Math.round(performance.now() - lastRelevantActivityAt),
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
            await abortActiveSession(false);
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
                usage: { ...DEFAULT_DONE_USAGE },
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
                  usage: { ...DEFAULT_DONE_USAGE },
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
                  usage: { ...DEFAULT_DONE_USAGE },
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
                usage: { ...DEFAULT_DONE_USAGE },
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
              usage: accumulatedUsage(),
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
          break;
        }

        if (raceResult.kind === 'server_exit') {
          nextPromise.catch(() => {});

          if (doneYielded) break;

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
        const eventSessionId =
          loadStreamSessionId(event) ??
          loadStreamSessionId(event.data) ??
          loadStreamSessionId(event.message) ??
          loadStreamSessionId(asRecord(event.part));

        if (eventSessionId) {
          if (eventSessionId !== sessionId) {
            continue;
          }
          // Only mark backend-provided after confirming the event belongs
          // to this session — foreign events must not flip the flag.
          backendProvidedSessionId = true;
        }

        // OPENCODE-018: only activity that survives current-session
        // filtering resets the liveness deadline. Explicitly foreign traffic
        // on the global multiplexed stream must not keep this run alive.
        lastRelevantActivityAt = performance.now();
        lastRelevantEvent = eventType;

        if (eventType === 'message.part.delta') {
          const delta = asString(event.delta);
          if (delta) {
            yield createEvent('text_delta', AGENT, { delta }, sessionId);
          }
          continue;
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

          // Accumulate usage from step-finish parts.
          if (partType === 'step-finish') {
            const tokens = asRecord(part.tokens);
            accumulatedInputTokens += asNumber(tokens.input) ?? 0;
            accumulatedOutputTokens += asNumber(tokens.output) ?? 0;
            accumulatedCost += asNumber(part.cost) ?? 0;
            continue;
          }

          continue;
        }

        if (eventType === 'permission.updated' || eventType === 'permission.asked') {
          const permission =
            eventType === 'permission.asked' ? event : asRecord(event.permission);
          const reason = asString(permission.reason) ?? asString(event.reason);
          const toolName =
            asString(permission.permission) ??
            asString(permission.toolName) ??
            asString(permission.name) ??
            asString(event.toolName) ??
            'unknown_tool';
          const requestId =
            asString(permission.requestID) ?? asString(permission.id);
          const toolUseId =
            requestId ??
            asString(asRecord(permission.tool).callID) ??
            asString(permission.toolUseId) ??
            asString(event.toolUseId) ??
            generateSessionId();

          if (requestId) {
            // permission.replied carries only requestID; remember which
            // tool call (callID) a later denial must resolve to.
            permissionRequests.set(requestId, {
              toolUseId:
                asString(asRecord(permission.tool).callID) ?? toolUseId,
              toolName,
            });
          }

          yield createEvent(
            'permission_request',
            AGENT,
            {
              toolName,
              toolUseId,
              input: parseToolInput(
                permission.input ?? permission.metadata ?? event.input ?? {},
              ),
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
            asString(event.reply) ??
            ''
          ).toLowerCase();

          if (
            decision === 'denied' ||
            decision === 'rejected' ||
            decision === 'reject'
          ) {
            const requestId =
              asString(permission.requestID) ?? asString(event.requestID);
            const asked = requestId
              ? permissionRequests.get(requestId)
              : undefined;
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
          const status = sessionErrorObserved
            ? 'error'
            : mapDoneStatus(asString(event.status));
          // Use event-provided usage if available, otherwise fall back to
          // values accumulated from step-finish parts.
          const eventUsage = mapUsage(event.usage);
          const hasEventUsage =
            eventUsage.inputTokens > 0 || eventUsage.outputTokens > 0;
          const usage = hasEventUsage
            ? eventUsage
            : {
                inputTokens: accumulatedInputTokens,
                outputTokens: accumulatedOutputTokens,
                toolUses: accumulatedToolUses,
                ...(accumulatedCost > 0
                  ? { totalCostUsd: accumulatedCost }
                  : {}),
              };

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
        const configuredAllowlist = options?.allowedTools !== undefined;
        const configuredTools = asStringArray(
          mappedPermissions.tools?.core ?? [],
        );
        yield createEvent(
          'init',
          AGENT,
          {
            model: options?.model ?? 'unknown',
            cwd: options?.cwd ?? process.cwd(),
            tools: configuredTools,
            capabilities: {
              mode: this.mode,
              toolsKnown:
                configuredAllowlist || configuredTools.length > 0,
              toolsSource:
                configuredAllowlist || configuredTools.length > 0
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
              ...doneResumeTokenPayload(
                'interrupted',
                backendProvidedSessionId,
                sessionId,
                options?.resume,
              ),
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

      eventStreamController.abort();
      if (iterator?.return) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const cleanupTimeout = new Promise<void>((resolve) => {
            cleanupTimer = setTimeout(resolve, ITERATOR_CLEANUP_TIMEOUT_MS);
          });
          await Promise.race([
            Promise.resolve(iterator.return()).then(() => {}),
            cleanupTimeout,
          ]);
        } catch {
          // The stream signal and client disposal are the remaining cleanup
          // boundaries when an iterator rejects its explicit return().
        } finally {
          if (cleanupTimer) clearTimeout(cleanupTimer);
        }
      }

      await maybeCallAsyncWithin(
        client?.close?.bind(client),
        ITERATOR_CLEANUP_TIMEOUT_MS,
      );
      await maybeCallAsyncWithin(
        client?.shutdown?.bind(client),
        ITERATOR_CLEANUP_TIMEOUT_MS,
      );

      if (serverProcess && !serverClosed) {
        try {
          serverProcess.kill('SIGTERM');
        } catch {
          // ignore cleanup errors
        }

        if (serverExitPromise) {
          await promiseSettlesWithin(
            serverExitPromise,
            this.managedServerTermGraceMs,
          );
        }

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
