// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createEvent, generateSessionId } from '../events.js';
import { mapWritablePathsPermission } from '../permissions.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  DonePayload,
  PermissionCapability,
  PermissionLevel,
  PermissionPolicy,
  ReasoningEffort,
  WritablePathsPermissionMapping,
} from '../types.js';
import { doneResumeTokenPayload } from './resume-token.js';

type ClaudePermissionMode =
  | 'auto'
  | 'bypassPermissions'
  | 'acceptEdits'
  | 'default';

type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// The SDK's permission-callback contract, mirrored locally. It is deliberately
// NOT imported from `@anthropic-ai/claude-agent-sdk`: that package is an
// optional peer, and importing its types here would leak an unresolvable
// import into the published `claude-code.d.ts`, breaking CLAUDE-002 (the
// adapter module must typecheck for consumers without the SDK installed).
// Typing the adapter's `canUseTool` against this local mirror still makes
// `npm run typecheck` and `npm run build` reject a `boolean`/`undefined`
// return — the defect that made the SDK raise a `ZodError` on every tool call.
// Drift between this mirror and the real SDK is caught at runtime by the
// TADAPT-019 acceptance probe.
type ClaudePermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ClaudePermissionResult>;

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
  canUseTool?: ClaudeCanUseTool;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  effort?: ClaudeEffort;
  sessionId?: string;
}

interface ClaudeAgentSdk {
  query(options: {
    prompt: string;
    options?: Omit<ClaudeQueryOptions, 'prompt'>;
  }): AsyncIterable<unknown>;
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
  message?: { content?: unknown };
  text?: unknown;
  delta?: unknown;
  sessionId?: unknown;
}

interface ClaudeResultMessage {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  isError?: unknown;
  errors?: unknown;
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
): Record<PermissionCapability, PermissionLevel> {
  return {
    fileWrite: normalizePermissionLevel(policy?.fileWrite),
    shellExecute: normalizePermissionLevel(policy?.shellExecute),
    networkAccess: normalizePermissionLevel(policy?.networkAccess),
  };
}

function identifyCapability(toolName: string | undefined): PermissionCapability | undefined {
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
  canUseTool?: ClaudeCanUseTool;
  writablePaths?: WritablePathsPermissionMapping;
}

export function mapPermissionsToClaudeOptions(
  policy: PermissionPolicy | undefined,
): ClaudePermissionOptions {
  const writablePaths = mapWritablePathsPermission(policy, 'ambient');

  // ENG-021: session-wide auto-mode posture takes precedence over the
  // per-capability levels. 'auto' maps to claude's classifier-backed
  // auto-mode (still blocks high-risk actions, falls back to prompts
  // after consecutive/total denies); 'bypass' maps to the unchecked
  // bypassPermissions mode.
  if (policy?.mode === 'auto') {
    return {
      permissionMode: 'auto',
      ...(writablePaths ? { writablePaths } : {}),
    };
  }
  if (policy?.mode === 'bypass') {
    return {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(writablePaths ? { writablePaths } : {}),
    };
  }

  const normalized = normalizePermissionPolicy(policy);
  const allAllow = Object.values(normalized).every((level) => level === 'allow');

  if (allAllow) {
    return {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(writablePaths ? { writablePaths } : {}),
    };
  }

  if (
    normalized.fileWrite === 'allow' &&
    normalized.shellExecute === 'ask' &&
    normalized.networkAccess === 'ask'
  ) {
    return {
      permissionMode: 'acceptEdits',
      ...(writablePaths ? { writablePaths } : {}),
    };
  }

  // No capability carries an enforceable directive — every capability is
  // 'ask', which includes the common case of a missing `permissions` field
  // (it normalizes to all-'ask'). Per DR-005 a missing policy is no override:
  // install no `canUseTool` and leave the SDK's own `default`-mode handling
  // in charge rather than synthesizing a posture cligent was not asked for.
  const hasDirective = Object.values(normalized).some(
    (level) => level === 'allow' || level === 'deny',
  );
  if (!hasDirective) {
    return {
      permissionMode: 'default',
      ...(writablePaths ? { writablePaths } : {}),
    };
  }

  // Mixed policy: enforce the explicit 'allow'/'deny' capabilities through a
  // callback conforming to the SDK's `CanUseTool` contract.
  const canUseTool: ClaudeCanUseTool = async (toolName, input) => {
    const capability = identifyCapability(toolName);
    // Tools cligent does not classify (Read, Glob, Grep, ...) are not
    // permission-gated capabilities — they must never be blocked here.
    if (!capability) {
      return { behavior: 'allow', updatedInput: input };
    }
    const level = normalized[capability];
    if (level === 'allow') {
      return { behavior: 'allow', updatedInput: input };
    }
    if (level === 'deny') {
      return {
        behavior: 'deny',
        message: `cligent permission policy denies ${capability} (tool '${toolName}').`,
      };
    }
    // 'ask': the capability needs interactive approval, which an adapter run
    // cannot obtain. Deny honestly rather than silently widening 'ask' to
    // 'allow'; set the capability to 'allow' or use permissions.mode 'auto'.
    return {
      behavior: 'deny',
      message:
        `cligent permission policy sets ${capability} to 'ask' (tool ` +
        `'${toolName}'), which needs interactive approval unavailable in a ` +
        `headless run; set it to 'allow' or use permissions.mode 'auto'.`,
    };
  };

  return {
    permissionMode: 'default',
    canUseTool,
    ...(writablePaths ? { writablePaths } : {}),
  };
}

interface ClassifiedResult {
  readonly status: DonePayload['status'];
  readonly errorText?: string;
}

// Preserve Cligent's protocol statuses for known SDK error subtypes (max-turns,
// max-budget) rather than collapsing them into a generic 'error' that would
// hide the protocol-level cause from DonePayload consumers.
function classifyResultMessage(result: ClaudeResultMessage): ClassifiedResult {
  const subtype = asString(result.subtype);
  const errors = Array.isArray(result.errors)
    ? result.errors.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.length > 0,
      )
    : [];
  const errorText = errors.length > 0 ? errors.join('\n') : undefined;

  if (subtype === 'error_max_turns') {
    return { status: 'max_turns', errorText };
  }
  if (subtype === 'error_max_budget_usd') {
    return { status: 'max_budget', errorText };
  }

  const flaggedError =
    result.is_error === true ||
    result.isError === true ||
    (subtype !== undefined && subtype.startsWith('error_'));
  if (flaggedError) {
    return {
      status: 'error',
      errorText:
        errorText ??
        asString(result.result) ??
        subtype ??
        'Claude Code SDK error',
    };
  }

  return {
    status: mapDoneStatus(
      asString(result.status) ??
        asString(result.stopReason) ??
        asString(result.stop_reason),
    ),
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
    typeof usage.inputTokens === 'number'
      ? usage.inputTokens
      : typeof usage.input_tokens === 'number'
        ? usage.input_tokens
        : 0;

  const cacheRead =
    typeof usage.cacheReadInputTokens === 'number'
      ? usage.cacheReadInputTokens
      : typeof usage.cache_read_input_tokens === 'number'
        ? usage.cache_read_input_tokens
        : 0;

  const cacheCreation =
    typeof usage.cacheCreationInputTokens === 'number'
      ? usage.cacheCreationInputTokens
      : typeof usage.cache_creation_input_tokens === 'number'
        ? usage.cache_creation_input_tokens
        : 0;

  const inputTokens = baseInput + cacheRead + cacheCreation;

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

export function mapReasoningEffortToClaudeEffort(
  effort: ReasoningEffort | undefined,
): ClaudeEffort | undefined {
  if (effort === undefined) return undefined;
  // Claude has no 'minimal' tier; use the SDK's lowest effort instead.
  if (effort === 'minimal') return 'low';
  return effort;
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

  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;

  return {
    queryOptions: {
      cwd: options?.cwd,
      model: options?.model,
      maxTurns: options?.maxTurns,
      maxBudgetUsd: options?.maxBudgetUsd,
      resume: options?.resume || undefined,
      allowedTools: options?.allowedTools,
      disallowedTools: options?.disallowedTools,
      permissionMode: permissionOptions.permissionMode,
      allowDangerouslySkipPermissions: permissionOptions.allowDangerouslySkipPermissions,
      canUseTool: permissionOptions.canUseTool,
      abortController,
      env,
      effort: mapReasoningEffortToClaudeEffort(options?.reasoningEffort),
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

    const inboundResume = options?.resume || undefined;
    let sessionId = inboundResume ?? generateSessionId();
    let resumableSessionIdKnown = false;
    const { queryOptions, cleanupAbort } = mapAgentOptionsToClaudeQueryOptions(options);
    if (!inboundResume) {
      // The SDK forwards this typed option to `claude --session-id`. It gives
      // fresh runs a stable id once Claude persists the conversation, but an
      // init-only abort is not resumable yet.
      queryOptions.sessionId = sessionId;
    }

    const startTime = Date.now();
    let doneYielded = false;

    try {
      for await (const message of sdk.query({
        prompt,
        options: queryOptions,
      })) {
        const messageType = isObjectWithType(message) ? message.type : undefined;
        const loadedId = loadSessionId(message);
        if (loadedId) {
          sessionId = loadedId;
        }
        if (messageType && messageType !== 'system') {
          resumableSessionIdKnown = true;
        }

        if (!messageType) {
          continue;
        }

        if (messageType === 'system') {
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

        if (messageType === 'assistant') {
          const assistant = message as ClaudeAssistantMessage;
          const textFromField = asString(assistant.text);
          if (textFromField) {
            yield createEvent('text', AGENT, { content: textFromField }, sessionId);
          }

          const delta = asString(assistant.delta);
          if (delta) {
            yield createEvent('text_delta', AGENT, { delta }, sessionId);
          }

          const contentEvents = parseAssistantContent(
            assistant.content ?? assistant.message?.content,
          );

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

        if (messageType === 'stream' || messageType === 'stream_event' || messageType === 'delta') {
          const delta = asString((message as { delta?: unknown; text?: unknown }).delta) ??
            asString((message as { delta?: unknown; text?: unknown }).text);

          if (delta) {
            yield createEvent('text_delta', AGENT, { delta }, sessionId);
          }
          continue;
        }

        if (messageType === 'result') {
          const result = message as ClaudeResultMessage;
          const { status, errorText } = classifyResultMessage(result);

          const durationMs =
            typeof result.durationMs === 'number'
              ? result.durationMs
              : typeof result.duration_ms === 'number'
                ? result.duration_ms
                : Date.now() - startTime;

          if (status === 'error' && errorText) {
            yield createEvent(
              'error',
              AGENT,
              {
                code: asString(result.subtype) ?? 'CLAUDE_CODE_RESULT_ERROR',
                message: errorText,
                recoverable: false,
              },
              sessionId,
            );
          }

          yield createEvent(
            'done',
            AGENT,
            {
              status,
              result: asString(result.result) ?? errorText,
              ...doneResumeTokenPayload(
                status,
                resumableSessionIdKnown,
                sessionId,
                inboundResume,
              ),
              usage: mapUsage(result.usage),
              durationMs,
            },
            sessionId,
          );
          doneYielded = true;
          return;
        }

        if (messageType === 'error') {
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
              ...doneResumeTokenPayload(
                'interrupted',
                resumableSessionIdKnown,
                sessionId,
                inboundResume,
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
            ...doneResumeTokenPayload(
              'interrupted',
              resumableSessionIdKnown,
              sessionId,
              inboundResume,
            ),
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
