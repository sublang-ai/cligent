// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvent, generateSessionId } from '../events.js';
import { mapWritablePathsPermission } from '../permissions.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  DonePayload,
  PermissionPolicy,
  ReasoningEffort,
  WritablePathsPermissionMapping,
} from '../types.js';
import { doneResumeTokenPayload } from './resume-token.js';

type CodexApprovalPolicy = 'never' | 'untrusted' | 'on-request';
type CodexWorkspaceExtraWritesProfile = 'cligent-workspace-extra-writes';
type CodexDefaultPermissions =
  | ':danger-full-access'
  | ':workspace'
  | ':read-only'
  | CodexWorkspaceExtraWritesProfile;
type CodexApprovalsReviewer = 'auto_review';

type CodexModelReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };

interface CodexConstructorOptions {
  codexPathOverride?: string;
  config?: {
    [key: string]: CodexConfigValue | undefined;
    default_permissions?: CodexDefaultPermissions;
    approvals_reviewer?: CodexApprovalsReviewer;
  };
  env?: Record<string, string>;
}

interface CodexItem {
  type?: unknown;
  role?: unknown;
  text?: unknown;
  content?: unknown;
  name?: unknown;
  toolName?: unknown;
  id?: unknown;
  toolUseId?: unknown;
  callId?: unknown;
  tool_call_id?: unknown;
  input?: unknown;
  arguments?: unknown;
  args?: unknown;
  status?: unknown;
  isError?: unknown;
  is_error?: unknown;
  output?: unknown;
  result?: unknown;
  durationMs?: unknown;
  duration_ms?: unknown;
  file?: unknown;
  path?: unknown;
}

interface CodexThreadOptions {
  workingDirectory?: string;
  model?: string;
  modelReasoningEffort?: CodexModelReasoningEffort;
  approvalPolicy?: CodexApprovalPolicy;
  skipGitRepoCheck?: boolean;
}

interface CodexRunOptions {
  signal?: AbortSignal;
}

interface CodexThread {
  runStreamed?: (
    prompt: string,
    options?: CodexRunOptions,
  ) => Promise<{ events: AsyncIterable<unknown> }>;
  run?: (prompt: string, options?: CodexRunOptions) => AsyncIterable<unknown>;
}

interface CodexClient {
  startThread: (options?: CodexThreadOptions) => CodexThread;
  resumeThread?: (threadId: string, options?: CodexThreadOptions) => CodexThread;
}

interface CodexSdk {
  Codex: new (options?: CodexConstructorOptions) => CodexClient;
}

interface CodexAdapterDeps {
  loadSdk?: () => Promise<CodexSdk>;
}

const AGENT = 'codex' as const;
const CODEX_WORKSPACE_EXTRA_WRITES_PROFILE: CodexWorkspaceExtraWritesProfile =
  'cligent-workspace-extra-writes';
const requireFromHere = createRequire(import.meta.url);

const DEFAULT_DONE_USAGE: DonePayload['usage'] = {
  inputTokens: 0,
  outputTokens: 0,
  toolUses: 0,
};

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
      if (named) result.push(named);
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asErrorRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (Object.keys(record).length > 0) {
    return record;
  }

  const text = asString(value)?.trim();
  if (!text?.startsWith('{')) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function codexErrorMessage(value: unknown, depth = 0): string | undefined {
  const text = asString(value);
  if (text) {
    if (depth >= 3) {
      return text;
    }

    const parsed = asErrorRecord(text);
    if (Object.keys(parsed).length > 0) {
      return codexErrorMessage(parsed, depth + 1) ?? text;
    }
    return text;
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }

  return (
    codexErrorMessage(record.detail, depth + 1) ??
    codexErrorMessage(record.message, depth + 1) ??
    codexErrorMessage(record.error_description, depth + 1) ??
    codexErrorMessage(record.error, depth + 1)
  );
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface CodexPermissionOptions {
  approvalPolicy?: CodexApprovalPolicy;
  codexOptions?: CodexConstructorOptions;
  codexCliExecArgs?: string[];
  codexCliConfigOverrides?: string[];
  writablePaths?: WritablePathsPermissionMapping;
}

function codexDefaultPermissions(
  policy: PermissionPolicy,
): CodexDefaultPermissions {
  if (policy.mode === 'bypass') {
    return ':danger-full-access';
  }

  if (
    policy.fileWrite === 'allow' &&
    policy.shellExecute === 'allow' &&
    policy.networkAccess === 'allow'
  ) {
    return ':danger-full-access';
  }

  if (policy.fileWrite === 'deny' || policy.shellExecute === 'deny') {
    return ':read-only';
  }

  return ':workspace';
}

function codexApprovalPolicy(
  policy: PermissionPolicy,
): CodexApprovalPolicy {
  if (policy.mode === 'auto') {
    return 'on-request';
  }
  if (policy.mode === 'bypass') {
    return 'never';
  }

  if (
    policy.fileWrite === 'allow' &&
    policy.shellExecute === 'allow' &&
    policy.networkAccess === 'allow'
  ) {
    return 'never';
  }

  if (
    policy.fileWrite === 'ask' ||
    policy.shellExecute === 'ask' ||
    policy.networkAccess === 'ask'
  ) {
    return 'untrusted';
  }

  return 'on-request';
}

function codexTomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexWorkspaceExtraWritesProfileConfigOverride(
  paths: readonly string[],
): string {
  const rules = paths
    .map((path) => `${codexTomlString(path)}=${codexTomlString('write')}`)
    .join(', ');
  return (
    `permissions.${CODEX_WORKSPACE_EXTRA_WRITES_PROFILE}=` +
    `{extends=${codexTomlString(':workspace')}, ` +
    `filesystem={${codexTomlString(':workspace_roots')}={${rules}}}}`
  );
}

export function mapPermissionsToCodexOptions(
  policy: PermissionPolicy | undefined,
): CodexPermissionOptions {
  if (!policy) {
    return {};
  }

  const defaultPermissions = codexDefaultPermissions(policy);
  const writablePaths = mapWritablePathsPermission(
    policy,
    defaultPermissions === ':danger-full-access' ? 'ambient' : 'profile',
  );

  if (writablePaths && defaultPermissions === ':read-only') {
    throw new Error(
      'Codex permission policy cannot combine non-empty writablePaths with read-only local access',
    );
  }

  const config: NonNullable<CodexConstructorOptions['config']> = {
    default_permissions:
      writablePaths && defaultPermissions === ':workspace'
        ? CODEX_WORKSPACE_EXTRA_WRITES_PROFILE
        : defaultPermissions,
    ...(policy.mode === 'auto' ? { approvals_reviewer: 'auto_review' } : {}),
  };

  const codexCliConfigOverrides =
    writablePaths && defaultPermissions === ':workspace'
      ? [codexWorkspaceExtraWritesProfileConfigOverride(writablePaths.paths)]
      : undefined;

  return {
    approvalPolicy: codexApprovalPolicy(policy),
    codexOptions: { config },
    codexCliExecArgs: ['--ignore-user-config'],
    ...(codexCliConfigOverrides ? { codexCliConfigOverrides } : {}),
    ...(writablePaths ? { writablePaths } : {}),
  };
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

interface MappedCodexOptions {
  codexOptions?: CodexConstructorOptions;
  codexCliExecArgs?: string[];
  codexCliConfigOverrides?: string[];
  threadOptions: CodexThreadOptions;
  runOptions: CodexRunOptions;
  cleanupAbort: () => void;
}

export function mapReasoningEffortToCodexEffort(
  effort: ReasoningEffort | undefined,
): CodexModelReasoningEffort | undefined {
  if (effort === undefined) return undefined;
  // Codex tops out at 'xhigh'; collapse Claude's 'max' to the nearest value.
  if (effort === 'max') return 'xhigh';
  return effort;
}

export function mapAgentOptionsToCodexOptions(
  options: AgentOptions | undefined,
): MappedCodexOptions {
  const permissions = mapPermissionsToCodexOptions(options?.permissions);

  let cleanupAbort = () => {};
  let abortController: AbortController | undefined;

  if (options?.abortSignal) {
    abortController = new AbortController();
    const onAbort = () => abortController?.abort();

    if (options.abortSignal.aborted) {
      onAbort();
    } else {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
      cleanupAbort = () => options.abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  const signal = abortController?.signal;

  const threadOptions: CodexThreadOptions = {
    workingDirectory: options?.cwd,
    model: options?.model,
    modelReasoningEffort: mapReasoningEffortToCodexEffort(options?.reasoningEffort),
    // The CLI's git-repo gate is an interactive-user safety net; programmatic
    // callers (tmux-play, scripts, tests) choose workingDirectory deliberately
    // and frequently target tmpdirs that are not git repos.
    skipGitRepoCheck: true,
  };

  if (permissions.approvalPolicy) {
    threadOptions.approvalPolicy = permissions.approvalPolicy;
  }

  return {
    codexOptions: permissions.codexOptions,
    ...(permissions.codexCliExecArgs
      ? { codexCliExecArgs: permissions.codexCliExecArgs }
      : {}),
    ...(permissions.codexCliConfigOverrides
      ? { codexCliConfigOverrides: permissions.codexCliConfigOverrides }
      : {}),
    threadOptions,
    runOptions: {
      signal,
    },
    cleanupAbort,
  };
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed);
    } catch {
      return { raw: value };
    }
  }
  return asRecord(value);
}

function loadSessionId(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const candidate = message as {
    sessionId?: unknown;
    session_id?: unknown;
    threadId?: unknown;
    thread_id?: unknown;
    session?: { id?: unknown };
    thread?: { id?: unknown };
  };

  return (
    asString(candidate.sessionId) ??
    asString(candidate.session_id) ??
    asString(candidate.threadId) ??
    asString(candidate.thread_id) ??
    asString(candidate.session?.id) ??
    asString(candidate.thread?.id)
  );
}

interface NormalizedToolUse {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

interface NormalizedToolResult {
  toolName: string;
  toolUseId: string;
  status: 'success' | 'error' | 'denied';
  output: unknown;
  durationMs?: number;
}

type NormalizedItemEvent =
  | { type: 'text'; payload: { content: string } }
  | { type: 'tool_use'; payload: NormalizedToolUse }
  | { type: 'tool_result'; payload: NormalizedToolResult }
  | { type: 'codex:file_change'; payload: unknown };

function parseItemCompleted(itemRaw: unknown): NormalizedItemEvent[] {
  const events: NormalizedItemEvent[] = [];

  const item = asRecord(itemRaw) as CodexItem;
  const content = Array.isArray(item.content) ? item.content : [];
  const topText = asString(item.text);

  const pushToolUse = (
    source: CodexItem,
    target: NormalizedItemEvent[],
  ): void => {
    const toolName =
      asString(source.toolName) ??
      asString(source.name) ??
      'unknown_tool';

    const toolUseId =
      asString(source.toolUseId) ??
      asString(source.callId) ??
      asString(source.tool_call_id) ??
      asString(source.id) ??
      generateSessionId();

    target.push({
      type: 'tool_use',
      payload: {
        toolName,
        toolUseId,
        input: parseToolInput(source.input ?? source.arguments ?? source.args),
      },
    });
  };

  const pushToolResult = (
    source: CodexItem,
    target: NormalizedItemEvent[],
  ): void => {
    const statusText = asString(source.status)?.toLowerCase();
    const status: 'success' | 'error' | 'denied' =
      statusText === 'denied'
        ? 'denied'
        : source.isError === true || source.is_error === true || statusText === 'error'
          ? 'error'
          : 'success';

    target.push({
      type: 'tool_result',
      payload: {
        toolName:
          asString(source.toolName) ??
          asString(source.name) ??
          'unknown_tool',
        toolUseId:
          asString(source.toolUseId) ??
          asString(source.callId) ??
          asString(source.tool_call_id) ??
          asString(source.id) ??
          generateSessionId(),
        status,
        output: source.output ?? source.result ?? source.content ?? null,
        durationMs:
          asNumber(source.durationMs) ?? asNumber(source.duration_ms),
      },
    });
  };

  const itemType = asString(item.type);
  const hasContentBlocks = content.length > 0;

  if (!hasContentBlocks) {
    if (topText) {
      events.push({ type: 'text', payload: { content: topText } });
    }

    if (
      itemType === 'tool_call' ||
      itemType === 'function_call' ||
      itemType === 'tool_use'
    ) {
      pushToolUse(item, events);
    }

    if (
      itemType === 'tool_result' ||
      itemType === 'function_call_result' ||
      itemType === 'tool_output'
    ) {
      pushToolResult(item, events);
    }

    if (itemType === 'file_change' || itemType === 'file.changed') {
      events.push({ type: 'codex:file_change', payload: item.file ?? item });
    }
  } else {
    const contentEvents: NormalizedItemEvent[] = [];
    let hasContentTextBlock = false;

    for (const blockRaw of content) {
      const block = asRecord(blockRaw) as CodexItem;
      const blockType = asString(block.type);

      if (
        blockType === 'text' ||
        blockType === 'output_text' ||
        blockType === 'message_text'
      ) {
        const text = asString(block.text);
        if (text) {
          hasContentTextBlock = true;
          contentEvents.push({ type: 'text', payload: { content: text } });
        }
        continue;
      }

      if (
        blockType === 'tool_call' ||
        blockType === 'function_call' ||
        blockType === 'tool_use'
      ) {
        pushToolUse(block, contentEvents);
        continue;
      }

      if (
        blockType === 'tool_result' ||
        blockType === 'function_call_result' ||
        blockType === 'tool_output'
      ) {
        pushToolResult(block, contentEvents);
        continue;
      }

      if (blockType === 'file_change' || blockType === 'file.changed') {
        contentEvents.push({ type: 'codex:file_change', payload: block.file ?? block });
        continue;
      }
    }

    if (topText && !hasContentTextBlock) {
      events.push({ type: 'text', payload: { content: topText } });
    }
    events.push(...contentEvents);
  }

  return events;
}

function toErrorPayload(message: unknown): {
  code?: string;
  message: string;
  recoverable: boolean;
} {
  const top = asRecord(message);
  const nested = asErrorRecord(top.error);
  const messageRecord = asErrorRecord(top.message);
  const records = [top, nested, messageRecord];

  const code =
    firstString(records, ['code', 'error_code']) ??
    firstString([nested, messageRecord], ['type']);

  const text =
    codexErrorMessage(top.message) ??
    codexErrorMessage(top.detail) ??
    codexErrorMessage(top.error) ??
    'Codex SDK error';

  const recoverable = records.some(
    (record) => record.recoverable === true || record.retryable === true,
  );

  return {
    ...(code ? { code } : {}),
    message: text,
    recoverable,
  };
}

function firstString(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = asString(record[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

interface CodexConfigOverrideWrapper {
  path: string;
  cleanup: () => Promise<void>;
}

function resolveCodexBinPath(): string {
  return requireFromHere.resolve('@openai/codex/bin/codex.js');
}

function codexWrapperScript(
  codexBinPath: string,
  configOverrides: readonly string[],
  execArgs: readonly string[],
): string {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';

const codexBinPath = ${JSON.stringify(codexBinPath)};
const configOverrides = ${JSON.stringify(configOverrides)};
const execArgs = ${JSON.stringify(execArgs)};
const [subcommand, ...rest] = process.argv.slice(2);
const injectedExecArgs = subcommand === 'exec' ? execArgs : [];
const injected = configOverrides.flatMap((override) => ['--config', override]);
const args = subcommand
  ? [codexBinPath, subcommand, ...injectedExecArgs, ...injected, ...rest]
  : [codexBinPath, ...injected];
const child = spawn(process.execPath, args, {
  env: process.env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
`;
}

export async function createCodexConfigOverrideWrapper(
  configOverrides: readonly string[],
  execArgs: readonly string[] = [],
): Promise<CodexConfigOverrideWrapper | undefined> {
  if (configOverrides.length === 0 && execArgs.length === 0) {
    return undefined;
  }

  const codexBinPath = resolveCodexBinPath();
  const dir = await mkdtemp(join(tmpdir(), 'cligent-codex-config-'));
  const scriptPath = join(dir, 'codex-wrapper.mjs');
  const wrapperPath =
    process.platform === 'win32' ? join(dir, 'codex-wrapper.cmd') : scriptPath;

  await writeFile(
    scriptPath,
    codexWrapperScript(codexBinPath, configOverrides, execArgs),
    'utf8',
  );

  if (process.platform === 'win32') {
    await writeFile(
      wrapperPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      'utf8',
    );
  } else {
    await chmod(scriptPath, 0o700);
  }

  return {
    path: wrapperPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function loadCodexSdk(): Promise<CodexSdk> {
  const mod = (await import('@openai/codex-sdk')) as {
    Codex?: unknown;
  };

  if (typeof mod.Codex !== 'function') {
    throw new Error('@openai/codex-sdk does not export Codex');
  }

  return {
    Codex: mod.Codex as CodexSdk['Codex'],
  };
}

export class CodexAdapter implements AgentAdapter {
  readonly agent = AGENT;

  private readonly loadSdk: () => Promise<CodexSdk>;

  constructor(deps: CodexAdapterDeps = {}) {
    this.loadSdk = deps.loadSdk ?? loadCodexSdk;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.loadSdk();
      return true;
    } catch {
      return false;
    }
  }

  async *run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    let sdk: CodexSdk;
    try {
      sdk = await this.loadSdk();
    } catch {
      throw new Error(
        'CodexAdapter requires @openai/codex-sdk. Install it to use this adapter.',
      );
    }

    const {
      codexOptions,
      codexCliExecArgs,
      codexCliConfigOverrides,
      threadOptions,
      runOptions,
      cleanupAbort,
    } = mapAgentOptionsToCodexOptions(options);

    const codexConfigWrapper = await createCodexConfigOverrideWrapper(
      codexCliConfigOverrides ?? [],
      codexCliExecArgs ?? [],
    );
    const effectiveCodexOptions = codexConfigWrapper
      ? {
          ...codexOptions,
          codexPathOverride: codexConfigWrapper.path,
        }
      : codexOptions;
    let cleanedUp = false;
    const cleanupCodexRun = async (): Promise<void> => {
      if (cleanedUp) return;
      cleanedUp = true;
      cleanupAbort();
      await codexConfigWrapper?.cleanup();
    };

    let codex: CodexClient;
    try {
      codex = new sdk.Codex(effectiveCodexOptions);
    } catch (err) {
      await cleanupCodexRun();
      throw new Error(
        `CodexAdapter failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let thread: CodexThread;
    let streamResult:
      | { events: AsyncIterable<unknown> }
      | AsyncIterable<unknown>
      | undefined;
    try {
      if (options?.resume) {
        if (typeof codex.resumeThread !== 'function') {
          throw new Error('Codex SDK does not support resumeThread() in this version');
        }
        thread = codex.resumeThread(options.resume, threadOptions);
      } else {
        thread = codex.startThread(threadOptions);
      }

      streamResult = await (thread.runStreamed?.(prompt, runOptions) as
        | Promise<{ events: AsyncIterable<unknown> } | AsyncIterable<unknown>>
        | undefined);
    } catch (err) {
      await cleanupCodexRun();
      throw err;
    }

    if (!streamResult) {
      await cleanupCodexRun();
      throw new Error('Codex SDK does not support runStreamed() in this version');
    }

    // The SDK normally returns { events: AsyncGenerator }. Prefer .events
    // but fall back to iterating the result directly if the shape differs
    // (e.g. due to transpilation or a non-standard SDK version).
    const streamObj = streamResult as Record<string, unknown>;
    const runStream = (streamObj.events ?? streamResult) as AsyncIterable<unknown>;

    let sessionId = options?.resume ?? generateSessionId();
    let backendProvidedSessionId = false;
    const startTime = Date.now();
    let doneYielded = false;
    let initYielded = false;

    const buildInitPayload = (
      sourceEvent?: Record<string, unknown>,
    ): {
      model: string;
      cwd: string;
      tools: string[];
      capabilities: Record<string, unknown>;
    } => {
      const hasConfiguredAllowedTools =
        Array.isArray(options?.allowedTools) && options.allowedTools.length > 0;
      const configuredAllowedTools = hasConfiguredAllowedTools
        ? (options?.allowedTools ?? [])
        : [];

      const sourceSession = asRecord(sourceEvent?.session);
      const sourceTurn = asRecord(sourceEvent?.turn);

      const eventTools = asStringArray(sourceEvent?.tools);
      const sessionTools = asStringArray(sourceSession.tools);
      const turnTools = asStringArray(sourceTurn.tools);

      const inferredTools =
        eventTools.length > 0
          ? eventTools
          : sessionTools.length > 0
            ? sessionTools
            : turnTools;

      const tools = hasConfiguredAllowedTools
        ? configuredAllowedTools
        : inferredTools.length > 0
          ? inferredTools
          : [];

      return {
        model: options?.model ?? asString(sourceEvent?.model) ?? 'unknown',
        cwd: options?.cwd ?? asString(sourceEvent?.cwd) ?? process.cwd(),
        tools,
        capabilities: {
          toolsKnown: hasConfiguredAllowedTools || inferredTools.length > 0,
          toolsSource: hasConfiguredAllowedTools
            ? 'allowedTools'
            : inferredTools.length > 0
              ? 'sdk'
              : 'unavailable',
        },
      };
    };

    try {
      for await (const rawEvent of runStream) {
        const loadedId = loadSessionId(rawEvent);
        if (loadedId) {
          sessionId = loadedId;
          backendProvidedSessionId = true;
        }

        const event = asRecord(rawEvent);
        if (!initYielded) {
          yield createEvent('init', AGENT, buildInitPayload(event), sessionId);
          initYielded = true;
        }

        const eventType = asString(event.type);
        if (!eventType) continue;

        if (eventType === 'item.completed') {
          const itemEvents = parseItemCompleted(event.item);

          for (const itemEvent of itemEvents) {
            if (itemEvent.type === 'text') {
              yield createEvent('text', AGENT, itemEvent.payload, sessionId);
              continue;
            }

            if (itemEvent.type === 'tool_use') {
              yield createEvent('tool_use', AGENT, itemEvent.payload, sessionId);
              continue;
            }

            if (itemEvent.type === 'tool_result') {
              yield createEvent('tool_result', AGENT, itemEvent.payload, sessionId);
              continue;
            }

            if (itemEvent.type === 'codex:file_change') {
              yield createEvent('codex:file_change', AGENT, itemEvent.payload, sessionId);
              continue;
            }
          }

          continue;
        }

        if (
          eventType === 'file_change' ||
          eventType === 'file.changed' ||
          eventType === 'item.file_change'
        ) {
          const payload = event.file ?? event.change ?? event.item ?? event;
          yield createEvent('codex:file_change', AGENT, payload, sessionId);
          continue;
        }

        if (eventType === 'error') {
          yield createEvent('error', AGENT, toErrorPayload(event), sessionId);
          continue;
        }

        if (eventType === 'turn.failed') {
          // Codex emits turn.failed when a turn cannot complete (model
          // mismatch, server-side rejection, etc.) and then exits with a
          // non-zero code. Yield the structured error and a terminal done
          // so the underlying message reaches the caller before the SDK's
          // exec wrapper raises a generic "Codex Exec exited" exception.
          const payload = toErrorPayload(event);
          yield createEvent('error', AGENT, payload, sessionId);
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
              usage: mapUsage(event.usage),
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
          return;
        }

        if (eventType === 'turn.completed') {
          const turn = asRecord(event.turn);
          const status = mapDoneStatus(
            asString(turn.status) ?? asString(event.status),
          );

          const durationMs =
            asNumber(turn.durationMs) ??
            asNumber(turn.duration_ms) ??
            asNumber(event.durationMs) ??
            asNumber(event.duration_ms) ??
            Date.now() - startTime;

          yield createEvent(
            'done',
            AGENT,
            {
              status,
              result: asString(turn.result) ?? asString(event.result),
              ...doneResumeTokenPayload(
                status,
                backendProvidedSessionId,
                sessionId,
                options?.resume,
              ),
              usage: mapUsage(turn.usage ?? event.usage),
              durationMs,
            },
            sessionId,
          );
          doneYielded = true;
          return;
        }
      }

      if (!initYielded) {
        yield createEvent('init', AGENT, buildInitPayload(), sessionId);
        initYielded = true;
      }

      if (!doneYielded) {
        if (options?.abortSignal?.aborted || runOptions.signal?.aborted) {
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
          return;
        }

        yield createEvent(
          'error',
          AGENT,
          {
            code: 'MISSING_TURN_DONE',
            message: 'Protocol violation: Codex stream ended without turn.completed',
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
      }
    } catch (error) {
      if (!initYielded) {
        yield createEvent('init', AGENT, buildInitPayload(), sessionId);
        initYielded = true;
      }

      if (options?.abortSignal?.aborted || runOptions.signal?.aborted) {
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
        return;
      }

      yield createEvent(
        'error',
        AGENT,
        {
          code: 'SDK_STREAM_ERROR',
          message:
            error instanceof Error
              ? (codexErrorMessage(error.message) ?? error.message)
              : 'Codex adapter failed during stream',
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
    } finally {
      await cleanupCodexRun();
    }
  }
}
