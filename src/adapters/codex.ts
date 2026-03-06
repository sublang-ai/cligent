// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createEvent, generateSessionId } from '../events.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  DonePayload,
  PermissionLevel,
  PermissionPolicy,
} from '../types.js';

type CodexSandboxMode = 'danger-full-access' | 'workspace-write' | 'read-only';
type CodexApprovalPolicy = 'never' | 'untrusted' | 'on-request';

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
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  networkAccessEnabled?: boolean;
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
  Codex: new () => CodexClient;
}

interface CodexAdapterDeps {
  loadSdk?: () => Promise<CodexSdk>;
}

const AGENT = 'codex' as const;

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

export interface CodexPermissionOptions {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  networkAccessEnabled: boolean;
}

export function mapPermissionsToCodexOptions(
  policy: PermissionPolicy | undefined,
): CodexPermissionOptions {
  const normalized = normalizePermissions(policy);

  const sandboxMode: CodexSandboxMode =
    normalized.fileWrite === 'deny' || normalized.shellExecute === 'deny'
      ? 'read-only'
      : normalized.fileWrite === 'allow' && normalized.shellExecute === 'allow'
        ? 'danger-full-access'
        : 'workspace-write';

  const allAllow =
    normalized.fileWrite === 'allow' &&
    normalized.shellExecute === 'allow' &&
    normalized.networkAccess === 'allow';

  const anyAsk =
    normalized.fileWrite === 'ask' ||
    normalized.shellExecute === 'ask' ||
    normalized.networkAccess === 'ask';

  const approvalPolicy: CodexApprovalPolicy = allAllow
    ? 'never'
    : anyAsk
      ? 'untrusted'
      : 'on-request';

  const networkAccessEnabled = normalized.networkAccess === 'allow';

  return {
    sandboxMode,
    approvalPolicy,
    networkAccessEnabled,
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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]: unknown })[Symbol.asyncIterator] ===
      'function'
  );
}

interface MappedCodexOptions {
  threadOptions: CodexThreadOptions;
  runOptions: CodexRunOptions;
  cleanupAbort: () => void;
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

  return {
    threadOptions: {
      workingDirectory: options?.cwd,
      model: options?.model,
      sandboxMode: permissions.sandboxMode,
      approvalPolicy: permissions.approvalPolicy,
      networkAccessEnabled: permissions.networkAccessEnabled,
    },
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
  const nested = asRecord(top.error);

  const code =
    asString(top.code) ??
    asString(nested.code) ??
    asString(nested.type);

  const text =
    asString(top.message) ??
    asString(nested.message) ??
    'Codex SDK error';

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

    const { threadOptions, runOptions, cleanupAbort } =
      mapAgentOptionsToCodexOptions(options);

    let codex: CodexClient;
    try {
      codex = new sdk.Codex();
    } catch (err) {
      throw new Error(
        `CodexAdapter failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let thread: CodexThread;
    if (options?.resume) {
      if (typeof codex.resumeThread !== 'function') {
        throw new Error('Codex SDK does not support resumeThread() in this version');
      }
      thread = codex.resumeThread(options.resume, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    const streamResult = await (thread.runStreamed?.(prompt, runOptions) as
      | Promise<{ events: AsyncIterable<unknown> } | AsyncIterable<unknown>>
      | undefined);

    if (!streamResult) {
      throw new Error('Codex SDK does not support runStreamed() in this version');
    }

    // The SDK returns { events: AsyncGenerator }, but handle the case where
    // it returns an AsyncIterable directly or the shape differs.
    const streamObj = streamResult as Record<string, unknown>;
    const runStream = isAsyncIterable(streamObj.events)
      ? (streamObj.events as AsyncIterable<unknown>)
      : isAsyncIterable(streamResult)
        ? streamResult
        : undefined;

    if (!runStream) {
      throw new Error('Codex thread does not provide an async event stream');
    }

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
              ...(backendProvidedSessionId ? { resumeToken: sessionId } : {}),
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
              ? error.message
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
      cleanupAbort();
    }
  }
}
