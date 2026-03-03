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

type ClaudePermissionMode = 'bypassPermissions' | 'acceptEdits' | 'default';

type ClaudeCapability = 'fileWrite' | 'shellExecute' | 'networkAccess';

interface ClaudeToolUseContext {
  name?: string;
  toolName?: string;
}

interface ClaudeQueryOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: ClaudePermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: (tool: ClaudeToolUseContext) => boolean | undefined;
  abortController?: AbortController;
}

interface ClaudeAgentSdk {
  query(options: ClaudeQueryOptions): AsyncIterable<unknown>;
}

interface ClaudeTextBlock {
  type?: string;
  text?: unknown;
  delta?: unknown;
}

interface ClaudeToolUseBlock {
  type?: string;
  id?: unknown;
  toolUseId?: unknown;
  name?: unknown;
  toolName?: unknown;
  input?: unknown;
}

interface ClaudeToolResultBlock {
  type?: string;
  id?: unknown;
  toolUseId?: unknown;
  tool_use_id?: unknown;
  name?: unknown;
  toolName?: unknown;
  status?: unknown;
  isError?: unknown;
  is_error?: unknown;
  output?: unknown;
  result?: unknown;
  content?: unknown;
  durationMs?: unknown;
  duration_ms?: unknown;
}

interface ClaudeThinkingBlock {
  type?: string;
  summary?: unknown;
}

interface ClaudeSystemMessage {
  type?: unknown;
  model?: unknown;
  cwd?: unknown;
  tools?: unknown;
  sessionId?: unknown;
}

interface ClaudeAssistantMessage {
  type?: unknown;
  content?: unknown;
  text?: unknown;
  delta?: unknown;
  sessionId?: unknown;
}

interface ClaudeResultMessage {
  type?: unknown;
  status?: unknown;
  stopReason?: unknown;
  stop_reason?: unknown;
  result?: unknown;
  usage?: unknown;
  durationMs?: unknown;
  duration_ms?: unknown;
  sessionId?: unknown;
}

interface ClaudeErrorMessage {
  type?: unknown;
  code?: unknown;
  message?: unknown;
  recoverable?: unknown;
  retryable?: unknown;
  error?: unknown;
  sessionId?: unknown;
}

interface ClaudeAdapterDeps {
  loadSdk?: () => Promise<ClaudeAgentSdk>;
}

const AGENT = 'claude-code' as const;

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

function normalizePermissionLevel(value: PermissionLevel | undefined): PermissionLevel {
  return value ?? 'ask';
}

function normalizePermissionPolicy(
  policy: PermissionPolicy | undefined,
): Record<ClaudeCapability, PermissionLevel> {
  return {
    fileWrite: normalizePermissionLevel(policy?.fileWrite),
    shellExecute: normalizePermissionLevel(policy?.shellExecute),
    networkAccess: normalizePermissionLevel(policy?.networkAccess),
  };
}

function identifyCapability(toolName: string | undefined): ClaudeCapability | undefined {
  if (!toolName) return undefined;
  const identifier = toolName.trim().match(/^[A-Za-z][A-Za-z0-9_]*/)?.[0];
  if (!identifier) return undefined;

  if (
    identifier === 'Write' ||
    identifier === 'Edit' ||
    identifier === 'MultiEdit' ||
    identifier === 'NotebookEdit'
  ) {
    return 'fileWrite';
  }
  if (identifier === 'Bash') return 'shellExecute';
  if (identifier === 'WebFetch') return 'networkAccess';
  return undefined;
}

export interface ClaudePermissionOptions {
  permissionMode: ClaudePermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: (tool: ClaudeToolUseContext) => boolean | undefined;
}

export function mapPermissionsToClaudeOptions(
  policy: PermissionPolicy | undefined,
): ClaudePermissionOptions {
  const normalized = normalizePermissionPolicy(policy);
  const allAllow = Object.values(normalized).every((level) => level === 'allow');

  if (allAllow) {
    return {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    };
  }

  if (
    normalized.fileWrite === 'allow' &&
    normalized.shellExecute === 'ask' &&
    normalized.networkAccess === 'ask'
  ) {
    return {
      permissionMode: 'acceptEdits',
    };
  }

  const canUseTool = (tool: ClaudeToolUseContext): boolean | undefined => {
    const capability = identifyCapability(tool.toolName ?? tool.name);
    if (!capability) return undefined;
    const level = normalized[capability];
    if (level === 'allow') return true;
    if (level === 'deny') return false;
    return undefined;
  };

  return {
    permissionMode: 'default',
    canUseTool,
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
    typeof usage.inputTokens === 'number'
      ? usage.inputTokens
      : typeof usage.input_tokens === 'number'
        ? usage.input_tokens
        : 0;

  const outputTokens =
    typeof usage.outputTokens === 'number'
      ? usage.outputTokens
      : typeof usage.output_tokens === 'number'
        ? usage.output_tokens
        : 0;

  const toolUses =
    typeof usage.toolUses === 'number'
      ? usage.toolUses
      : typeof usage.tool_uses === 'number'
        ? usage.tool_uses
        : 0;

  const totalCostUsd =
    typeof usage.totalCostUsd === 'number'
      ? usage.totalCostUsd
      : typeof usage.total_cost_usd === 'number'
        ? usage.total_cost_usd
        : undefined;

  return {
    inputTokens,
    outputTokens,
    toolUses,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

function toErrorPayload(message: ClaudeErrorMessage): {
  code?: string;
  message: string;
  recoverable: boolean;
} {
  const nested =
    typeof message.error === 'object' && message.error !== null
      ? (message.error as Record<string, unknown>)
      : undefined;

  const code =
    asString(message.code) ??
    asString(nested?.code) ??
    asString((nested as { type?: unknown } | undefined)?.type);

  const text =
    asString(message.message) ??
    asString((nested as { message?: unknown } | undefined)?.message) ??
    'Claude Code SDK error';

  const recoverable =
    typeof message.recoverable === 'boolean'
      ? message.recoverable
      : typeof message.retryable === 'boolean'
        ? message.retryable
        : false;

  return {
    ...(code ? { code } : {}),
    message: text,
    recoverable,
  };
}

function loadSessionId(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const candidate = message as {
    sessionId?: unknown;
    session_id?: unknown;
    session?: { id?: unknown };
  };

  return (
    asString(candidate.sessionId) ??
    asString(candidate.session_id) ??
    asString(candidate.session?.id)
  );
}

type AssistantContentEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; summary: string }
  | {
      type: 'tool_use';
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      toolUseId: string;
      toolName: string;
      status: 'success' | 'error' | 'denied';
      output: unknown;
      durationMs?: number;
    };

function parseAssistantContent(content: unknown): AssistantContentEvent[] {
  const events: AssistantContentEvent[] = [];

  if (!Array.isArray(content)) {
    return events;
  }

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;

    const textBlock = block as ClaudeTextBlock;
    if (textBlock.type === 'text' && typeof textBlock.text === 'string') {
      events.push({ type: 'text', content: textBlock.text });
      continue;
    }

    const toolUse = block as ClaudeToolUseBlock;
    if (toolUse.type === 'tool_use') {
      const toolName = asString(toolUse.name) ?? asString(toolUse.toolName) ?? 'unknown_tool';
      const toolUseId = asString(toolUse.id) ?? asString(toolUse.toolUseId) ?? generateSessionId();
      events.push({
        type: 'tool_use',
        toolUseId,
        toolName,
        input: asRecord(toolUse.input),
      });
      continue;
    }

    const toolResult = block as ClaudeToolResultBlock;
    if (toolResult.type === 'tool_result') {
      const statusText = asString(toolResult.status)?.toLowerCase();
      const isError =
        toolResult.isError === true ||
        toolResult.is_error === true ||
        statusText === 'error';

      events.push({
        type: 'tool_result',
        toolUseId:
          asString(toolResult.toolUseId) ??
          asString(toolResult.tool_use_id) ??
          asString(toolResult.id) ??
          generateSessionId(),
        toolName:
          asString(toolResult.name) ??
          asString(toolResult.toolName) ??
          'unknown_tool',
        status:
          statusText === 'denied'
            ? 'denied'
            : isError
              ? 'error'
              : 'success',
        output: toolResult.output ?? toolResult.result ?? toolResult.content ?? null,
        durationMs:
          typeof toolResult.durationMs === 'number'
            ? toolResult.durationMs
            : typeof toolResult.duration_ms === 'number'
              ? toolResult.duration_ms
              : undefined,
      });
      continue;
    }

    const thinking = block as ClaudeThinkingBlock;
    if (thinking.type === 'thinking') {
      const summary = asString(thinking.summary);
      if (summary) {
        events.push({ type: 'thinking', summary });
      }
      continue;
    }
  }

  return events;
}

function isObjectWithType(value: unknown): value is { type: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

export async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdk> {
  const mod = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query?: unknown;
  };

  if (typeof mod.query !== 'function') {
    throw new Error('@anthropic-ai/claude-agent-sdk does not export query()');
  }

  return {
    query: mod.query as ClaudeAgentSdk['query'],
  };
}

interface MappedClaudeOptions {
  queryOptions: Omit<ClaudeQueryOptions, 'prompt'>;
  cleanupAbort: () => void;
}

export function mapAgentOptionsToClaudeQueryOptions(
  options: AgentOptions | undefined,
): MappedClaudeOptions {
  const permissionOptions = mapPermissionsToClaudeOptions(options?.permissions);

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

  return {
    queryOptions: {
      cwd: options?.cwd,
      model: options?.model,
      maxTurns: options?.maxTurns,
      maxBudgetUsd: options?.maxBudgetUsd,
      resume: options?.resume,
      allowedTools: options?.allowedTools,
      disallowedTools: options?.disallowedTools,
      permissionMode: permissionOptions.permissionMode,
      allowDangerouslySkipPermissions: permissionOptions.allowDangerouslySkipPermissions,
      canUseTool: permissionOptions.canUseTool,
      abortController,
    },
    cleanupAbort,
  };
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agent = AGENT;

  private readonly loadSdk: () => Promise<ClaudeAgentSdk>;

  constructor(deps: ClaudeAdapterDeps = {}) {
    this.loadSdk = deps.loadSdk ?? loadClaudeAgentSdk;
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
    let sdk: ClaudeAgentSdk;
    try {
      sdk = await this.loadSdk();
    } catch {
      throw new Error(
        'ClaudeCodeAdapter requires @anthropic-ai/claude-agent-sdk. Install it to use this adapter.',
      );
    }

    const { queryOptions, cleanupAbort } = mapAgentOptionsToClaudeQueryOptions(options);

    let sessionId = options?.resume ?? generateSessionId();
    let backendProvidedSessionId = false;
    const startTime = Date.now();
    let doneYielded = false;

    try {
      for await (const message of sdk.query({
        prompt,
        ...queryOptions,
      })) {
        const loadedId = loadSessionId(message);
        if (loadedId) {
          sessionId = loadedId;
          backendProvidedSessionId = true;
        }

        if (!isObjectWithType(message)) {
          continue;
        }

        if (message.type === 'system') {
          const system = message as ClaudeSystemMessage;
          yield createEvent(
            'init',
            AGENT,
            {
              model: asString(system.model) ?? options?.model ?? 'unknown',
              cwd: asString(system.cwd) ?? options?.cwd ?? process.cwd(),
              tools: asStringArray(system.tools),
            },
            sessionId,
          );
          continue;
        }

        if (message.type === 'assistant') {
          const assistant = message as ClaudeAssistantMessage;
          const textFromField = asString(assistant.text);
          if (textFromField) {
            yield createEvent('text', AGENT, { content: textFromField }, sessionId);
          }

          const delta = asString(assistant.delta);
          if (delta) {
            yield createEvent('text_delta', AGENT, { delta }, sessionId);
          }

          const contentEvents = parseAssistantContent(assistant.content);

          for (const contentEvent of contentEvents) {
            if (contentEvent.type === 'text') {
              yield createEvent(
                'text',
                AGENT,
                { content: contentEvent.content },
                sessionId,
              );
              continue;
            }

            if (contentEvent.type === 'thinking') {
              yield createEvent(
                'thinking',
                AGENT,
                { summary: contentEvent.summary },
                sessionId,
              );
              continue;
            }

            if (contentEvent.type === 'tool_use') {
              yield createEvent(
                'tool_use',
                AGENT,
                {
                  toolName: contentEvent.toolName,
                  toolUseId: contentEvent.toolUseId,
                  input: contentEvent.input,
                },
                sessionId,
              );
              continue;
            }

            if (contentEvent.type === 'tool_result') {
              yield createEvent(
                'tool_result',
                AGENT,
                {
                  toolName: contentEvent.toolName,
                  toolUseId: contentEvent.toolUseId,
                  status: contentEvent.status,
                  output: contentEvent.output,
                  durationMs: contentEvent.durationMs,
                },
                sessionId,
              );
              continue;
            }
          }

          continue;
        }

        if (
          message.type === 'stream' ||
          message.type === 'stream_event' ||
          message.type === 'delta'
        ) {
          const delta = asString((message as { delta?: unknown; text?: unknown }).delta) ??
            asString((message as { delta?: unknown; text?: unknown }).text);

          if (delta) {
            yield createEvent('text_delta', AGENT, { delta }, sessionId);
          }
          continue;
        }

        if (message.type === 'result') {
          const result = message as ClaudeResultMessage;
          const status = mapDoneStatus(
            asString(result.status) ??
              asString(result.stopReason) ??
              asString(result.stop_reason),
          );

          const durationMs =
            typeof result.durationMs === 'number'
              ? result.durationMs
              : typeof result.duration_ms === 'number'
                ? result.duration_ms
                : Date.now() - startTime;

          yield createEvent(
            'done',
            AGENT,
            {
              status,
              result: asString(result.result),
              ...(backendProvidedSessionId ? { resumeToken: sessionId } : {}),
              usage: mapUsage(result.usage),
              durationMs,
            },
            sessionId,
          );
          doneYielded = true;
          return;
        }

        if (message.type === 'error') {
          const errorMessage = message as ClaudeErrorMessage;
          yield createEvent('error', AGENT, toErrorPayload(errorMessage), sessionId);
        }
      }

      if (!doneYielded) {
        if (queryOptions.abortController?.signal.aborted) {
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
            code: 'MISSING_RESULT',
            message:
              'Protocol violation: Claude Code SDK stream ended without a result message',
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
      if (queryOptions.abortController?.signal.aborted) {
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

      const errorText =
        error instanceof Error ? error.message : 'Claude Code adapter failed during stream';
      yield createEvent(
        'error',
        AGENT,
        {
          code: 'SDK_STREAM_ERROR',
          message: errorText,
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
