// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createEvent, generateSessionId } from '../events.js';
import { assertSupportedEffort } from '../effort.js';
import { mapWritablePathsPermission } from '../permissions.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  ClaudeEffort,
  DonePayload,
  PermissionCapability,
  PermissionLevel,
  PermissionPolicy,
  UsageRecord,
  WritablePathsPermissionMapping,
} from '../types.js';
import { doneResumeTokenPayload } from './resume-token.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import {
  assertRuntimeSupported,
  isUnsupportedRuntimeError,
} from '../runtime-version.js';
import {
  buildTokenBreakdown,
  buildUsageRecords,
  isUsageRecord,
  readUsageCounter,
} from './usage.js';

type ClaudePermissionMode =
  | 'auto'
  | 'bypassPermissions'
  | 'acceptEdits'
  | 'default';

type ClaudeSdkEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface ClaudeSettings {
  ultracode?: boolean;
  [key: string]: unknown;
}

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
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  settingSources?: Array<'user' | 'project' | 'local'>;
  strictMcpConfig?: boolean;
  permissionMode?: ClaudePermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: ClaudeCanUseTool;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  effort?: ClaudeSdkEffort;
  settings?: ClaudeSettings;
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
  subtype?: unknown;
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
  /** Per-model accounting covering every request the run made (CLAUDE-011). */
  modelUsage?: unknown;
  /** Runtime-computed cost, a sibling of `usage` rather than a member. */
  total_cost_usd?: unknown;
  totalCostUsd?: unknown;
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
  tokenAvailability: 'unavailable',
  inputTokens: 0,
  outputTokens: 0,
  toolUses: 0,
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

const MODEL_USAGE_ALIASES = [
  ['input_tokens', ['inputTokens', 'input_tokens']],
  ['cache_read_input_tokens', ['cacheReadInputTokens', 'cache_read_input_tokens']],
  [
    'cache_creation_input_tokens',
    ['cacheCreationInputTokens', 'cache_creation_input_tokens'],
  ],
  ['output_tokens', ['outputTokens', 'output_tokens']],
] as const;

/**
 * CLAUDE-011: `result.usage` counts the main conversation loop only, while
 * `result.modelUsage` counts every request the run made, including subagents.
 * Fold the per-model entries into one usage-shaped record so the aggregates
 * describe the whole run. Returns undefined when the map is absent or any
 * entry is malformed, leaving the caller on the narrower `usage` surface
 * rather than differencing against a partial total.
 */
function foldModelUsage(
  rawModelUsage: unknown,
): { totals: Record<string, number>; records: UsageRecord[] } | undefined {
  if (!isUsageRecord(rawModelUsage)) return undefined;

  const entries = Object.entries(rawModelUsage);
  if (entries.length === 0) return undefined;

  const totals: Record<string, number> = {};
  const records: UsageRecord[] = [];
  for (const [model, entry] of entries) {
    if (!isUsageRecord(entry)) return undefined;
    const perModel: Record<string, number> = {};
    for (const [field, aliases] of MODEL_USAGE_ALIASES) {
      const reading = readUsageCounter(entry, aliases, true);
      if (!reading.valid) return undefined;
      perModel[field] = reading.value;
      totals[field] = (totals[field] ?? 0) + reading.value;
    }
    const costUsd = asNumber(entry.costUSD) ?? asNumber(entry.costUsd);
    records.push({
      // `canonicalModel` is the id Claude Code prices against; the map key can
      // be an alias or carry a context-window suffix.
      model: asString(entry.canonicalModel) ?? model,
      ...(asString(entry.provider) ? { provider: asString(entry.provider)! } : {}),
      tokens: {
        input: perModel.input_tokens ?? 0,
        cacheRead: perModel.cache_read_input_tokens ?? 0,
        cacheWrite: perModel.cache_creation_input_tokens ?? 0,
      },
      ...(costUsd !== undefined ? { costUsd } : {}),
    });
  }

  return { totals, records };
}

function mapUsage(
  rawUsage: unknown,
  observedToolUses: number,
  reportedCostUsd?: number,
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

  // Claude Code carries cost on the result message, beside `usage`, so the
  // caller supplies it; the in-usage aliases remain a tolerated fallback.
  const totalCostUsd =
    reportedCostUsd ??
    asNumber(rawUsage.totalCostUsd) ??
    asNumber(rawUsage.total_cost_usd);

  const reported =
    baseInput.valid &&
    cacheRead.valid &&
    cacheCreation.valid &&
    outputTokens.valid;
  const inputTokens =
    baseInput.value + cacheRead.value + cacheCreation.value;

  // CLAUDE-003: Anthropic's base input counter is already cache-exclusive, so
  // the three input counters are the partition. The output side is withheld:
  // thinking tokens are billed inside output_tokens and the runtime does not
  // expose them, so no visible-output component can be stated (ENG-028).
  const breakdown = reported
    ? buildTokenBreakdown(
        { inputTokens, outputTokens: outputTokens.value },
        {
          input: baseInput.value,
          ...(cacheRead.present ? { cacheRead: cacheRead.value } : {}),
          ...(cacheCreation.present
            ? { cacheWrite: cacheCreation.value }
            : {}),
        },
      )
    : undefined;

  return {
    tokenAvailability: reported ? 'reported' : 'unavailable',
    inputTokens,
    outputTokens: outputTokens.value,
    toolUses,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(breakdown ? { breakdown } : {}),
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

  // ENG-025: an importable SDK is not necessarily a supported one.
  assertRuntimeSupported(
    AGENT_RUNTIME_TARGETS.claude[0]!,
    `npm install @anthropic-ai/claude-agent-sdk@${AGENT_RUNTIME_TARGETS.claude[0]!.tested}`,
  );

  return {
    query: mod.query as ClaudeAgentSdk['query'],
  };
}

interface MappedClaudeOptions {
  queryOptions: Omit<ClaudeQueryOptions, 'prompt'>;
  cleanupAbort: () => void;
}

interface ClaudeEffortOptions {
  effort?: ClaudeSdkEffort;
  settings?: ClaudeSettings;
}

export function mapEffortToClaudeOptions(
  effort: ClaudeEffort | undefined,
): ClaudeEffortOptions {
  if (effort === undefined) return {};

  assertSupportedEffort(AGENT, effort);

  if (effort === 'ultracode') {
    return {
      effort: 'xhigh',
      settings: { ultracode: true },
    };
  }

  return {
    effort: effort === 'minimal' ? 'low' : effort,
    settings: { ultracode: false },
  };
}

export function mapAgentOptionsToClaudeQueryOptions(
  options: AgentOptions<ClaudeEffort> | undefined,
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

  const effortOptions = mapEffortToClaudeOptions(options?.effort);
  const explicitAllowlist = options?.allowedTools !== undefined;
  const toolFreeIsolation = options?.allowedTools?.length === 0;

  return {
    queryOptions: {
      cwd: options?.cwd,
      model: options?.model,
      maxTurns: options?.maxTurns,
      maxBudgetUsd: options?.maxBudgetUsd,
      resume: options?.resume || undefined,
      tools:
        options?.allowedTools !== undefined
          ? [...options.allowedTools]
          : undefined,
      allowedTools: options?.allowedTools,
      disallowedTools: options?.disallowedTools,
      settingSources: toolFreeIsolation ? [] : undefined,
      strictMcpConfig: explicitAllowlist ? true : undefined,
      permissionMode: permissionOptions.permissionMode,
      allowDangerouslySkipPermissions: permissionOptions.allowDangerouslySkipPermissions,
      canUseTool: permissionOptions.canUseTool,
      abortController,
      env,
      ...effortOptions,
    },
    cleanupAbort,
  };
}

export class ClaudeCodeAdapter implements AgentAdapter<ClaudeEffort> {
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
    options?: AgentOptions<ClaudeEffort>,
  ): AsyncGenerator<AgentEvent, void, void> {
    let sdk: ClaudeAgentSdk;
    try {
      sdk = await this.loadSdk();
    } catch (error) {
      // A version refusal already names the installed version, the required
      // version, the tree, and the repair. Replacing it with "install it"
      // would tell the user to install something already present.
      if (isUnsupportedRuntimeError(error)) throw error;
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
    let initYielded = false;
    // True once this call's stream has produced any model-turn output event
    // (text, text_delta, thinking, tool_use, tool_result). Those are exactly
    // the events the adapter derives from assistant messages and stream
    // deltas — the submitted turn doing work — and exactly what downstream
    // consumers capture to synthesize a final text. `init` stays excluded
    // because the system handshake precedes every turn (including the
    // resume-repair no-op), and `error` events are diagnostics rather than
    // turn output. Guards the internal-no-op result skip below: once real
    // activity has streamed, an empty zero-usage result is a legitimate
    // terminal and must not be swallowed.
    let submittedTurnActivity = false;
    const observedToolUseIds = new Set<string>();

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
          // Claude Code emits `system` for many run-time notices — hook
          // lifecycle, compaction boundaries, retries, thinking-token and
          // status updates — and only the handshake, `subtype: 'init'`,
          // carries the tool surface. Notices arrive both before and after
          // it (SessionStart hook events precede it), so the handshake is
          // identified by its subtype, never by its position.
          const system = message as ClaudeSystemMessage;
          const subtype = asString(system.subtype);
          if ((subtype !== undefined && subtype !== 'init') || initYielded) {
            continue;
          }
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
          initYielded = true;
          continue;
        }

        if (messageType === 'assistant') {
          const assistant = message as ClaudeAssistantMessage;
          const textFromField = asString(assistant.text);
          if (textFromField) {
            submittedTurnActivity = true;
            yield createEvent('text', AGENT, { content: textFromField }, sessionId);
          }

          const delta = asString(assistant.delta);
          if (delta) {
            submittedTurnActivity = true;
            yield createEvent('text_delta', AGENT, { delta }, sessionId);
          }

          const contentEvents = parseAssistantContent(
            assistant.content ?? assistant.message?.content,
          );
          if (contentEvents.length > 0) {
            // Every parsed content entry yields one text / thinking /
            // tool_use / tool_result event below.
            submittedTurnActivity = true;
          }

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
              observedToolUseIds.add(contentEvent.toolUseId);
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
            submittedTurnActivity = true;
            yield createEvent('text_delta', AGENT, { delta }, sessionId);
          }
          continue;
        }

        if (messageType === 'result') {
          const result = message as ClaudeResultMessage;
          const { status, errorText } = classifyResultMessage(result);
          const resultText = asString(result.result);
          // Prefer the whole-run accounting; fall back to the main-loop
          // counters only where the runtime does not supply it.
          const reportedCostUsd =
            asNumber(result.total_cost_usd) ?? asNumber(result.totalCostUsd);
          const folded = foldModelUsage(result.modelUsage);
          const usage = mapUsage(
            folded?.totals ?? result.usage,
            observedToolUseIds.size,
            reportedCostUsd,
          );
          // ENG-030: the per-model entries are this run's billable groups.
          // Claude Code reports no per-model output split, so each record
          // carries the input side only, matching the withheld output side.
          const records = folded
            ? buildUsageRecords(usage.breakdown, folded.records)
            : undefined;
          if (records) {
            usage.records = records;
          }
          // CLAUDE-010's no-op signature is a property of the main-loop
          // result message, not of the run's total accounting: the repair
          // turn reports zero main-loop tokens while the run as a whole may
          // already have spent some. Detect it on the narrow counters so the
          // whole-run aggregates above cannot suppress the skip.
          const mainLoopUsage = mapUsage(result.usage, observedToolUseIds.size);

          // Resuming a session whose previous turn ended with a dangling tool
          // call makes Claude Code first run an internal continuation-repair
          // no-op turn and emit a result message for it — success-classified,
          // no result text, zero token/tool usage — before the submitted turn
          // produces anything. Skip exactly that: the shape alone is not
          // enough, so the skip additionally requires (i) this call resumed a
          // session (`inboundResume` — a fresh run cannot carry the repair
          // turn, and its empty zero-usage success is a genuine, if empty,
          // terminal) and (ii) no submitted-turn output has streamed yet
          // (`submittedTurnActivity` — once text/thinking/tool events have
          // been yielded, an empty result is the real turn's terminal and
          // downstream legitimately derives the final text from the captured
          // events). When the skip applies and the stream then ends with no
          // further result, the MISSING_RESULT path below classifies the
          // abandoned turn as an error.
          const isInternalNoOpResult =
            inboundResume !== undefined &&
            !submittedTurnActivity &&
            status === 'success' &&
            errorText === undefined &&
            resultText === undefined &&
            mainLoopUsage.tokenAvailability === 'reported' &&
            mainLoopUsage.inputTokens === 0 &&
            mainLoopUsage.outputTokens === 0 &&
            mainLoopUsage.toolUses === 0;
          if (isInternalNoOpResult) {
            continue;
          }

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
              result: resultText ?? errorText,
              ...doneResumeTokenPayload(
                status,
                resumableSessionIdKnown,
                sessionId,
                inboundResume,
              ),
              usage,
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
              usage: {
                ...DEFAULT_DONE_USAGE,
                toolUses: observedToolUseIds.size,
              },
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
            usage: {
              ...DEFAULT_DONE_USAGE,
              toolUses: observedToolUseIds.size,
            },
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
            usage: {
              ...DEFAULT_DONE_USAGE,
              toolUses: observedToolUseIds.size,
            },
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
          usage: {
            ...DEFAULT_DONE_USAGE,
            toolUses: observedToolUseIds.size,
          },
          durationMs: Date.now() - startTime,
        },
        sessionId,
      );
    } finally {
      cleanupAbort();
    }
  }
}
