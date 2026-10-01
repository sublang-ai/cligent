// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createEvent, generateSessionId } from '../events.js';
import { prepareAttachments, readAttachment } from '../attachments.js';
import {
  normalizeMcpServers,
  prepareMcpServers,
  type McpServers,
} from '../mcp.js';
import { mediaFromMcpContent } from '../media.js';
import { assertSupportedEffort } from '../effort.js';
import { assertBuiltInFastModeOption } from '../fast-mode.js';
import {
  assertBuiltInSubagentEffortOption,
  assertBuiltInSubagentModelOption,
  subagentEffortValues,
  type ClaudeSubagentEffort,
} from '../subagent-model.js';
import { mapWritablePathsPermission } from '../permissions.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  ClaudeEffort,
  DonePayload,
  FastModeDisabledReason,
  FastModeObservation,
  FastModeResponseSpeed,
  FastModeState,
  FastModeTerminalObservation,
  PermissionCapability,
  PermissionLevel,
  PermissionPolicy,
  UsageRecord,
  WritablePathsPermissionMapping,
} from '../types.js';
import {
  CLAUDE_SDK_PACKAGE,
  claudeExecutableCandidates,
  claudeExecutablePackage,
  probeClaudeExecutable,
  type ClaudeExecutableProbe,
} from './claude-executable.js';
import { doneResumeTokenPayload } from './resume-token.js';
import { ordinaryErrorCode } from './session-resume.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import {
  assertRuntimeSupported,
  isUnsupportedRuntimeError,
} from '../runtime-version.js';
import {
  buildTokenUsage,
  buildTokenUsageReport,
  buildUsageCost,
  isUsageRecord,
  readUsageCounter,
  sumTokenUsage,
} from './usage.js';

type ClaudePermissionMode =
  'auto' | 'bypassPermissions' | 'acceptEdits' | 'default';

type ClaudeSdkEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface ClaudeSettings {
  ultracode?: boolean;
  fastMode?: boolean;
  disableClaudeAiConnectors?: boolean;
  [key: string]: unknown;
}

// The SDK's permission-callback contract, mirrored locally. It is deliberately
// NOT imported from `@anthropic-ai/claude-agent-sdk`: that package is an
// optional peer, and importing its types here would leak an unresolvable
// import into the published `claude-code.d.ts`, breaking claude-code-2 (the
// adapter module must typecheck for consumers without the SDK installed).
// Typing the adapter's `canUseTool` against this local mirror still makes
// `npm run typecheck` and `npm run build` reject a `boolean`/`undefined`
// return — the defect that made the SDK raise a `ZodError` on every tool call.
// Drift between this mirror and the real SDK is rejected at compile time by
// the installed-declaration conformance check in package-104.
type ClaudePermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ClaudePermissionResult>;

// The SDK's `systemPrompt` option shape, mirrored locally for the same reason
// as `ClaudeCanUseTool` above; package-104's conformance check rejects drift.
type ClaudeSystemPrompt =
  | string
  | string[]
  | { type: 'custom'; prompt: string | string[]; snapshot?: boolean }
  | {
      type: 'preset';
      preset: 'claude_code';
      append?: string;
      excludeDynamicSections?: boolean;
      snapshot?: boolean;
    };

// The SDK's `AgentDefinition` fields the adapter sets, mirrored locally for
// the same reason; package-104's conformance check rejects drift.
export interface ClaudeAgentDefinition {
  description: string;
  prompt: string;
  model?: string;
  effort?: ClaudeSdkEffort;
}

/** The custom, unsnapshotted system prompt the adapter composes. */
export interface ClaudeComposedSystemPrompt {
  type: 'custom';
  prompt: string;
  snapshot: false;
}

interface ClaudeUserMessage {
  type: 'user';
  parent_tool_use_id: null;
  message: {
    role: 'user';
    content: Array<
      | { type: 'text'; text: string }
      | {
          type: 'image';
          source: {
            type: 'base64';
            media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
            data: string;
          };
        }
      | {
          type: 'document';
          source: {
            type: 'base64';
            media_type: 'application/pdf';
            data: string;
          };
        }
    >;
  };
}

type ClaudePrompt = string | AsyncIterable<ClaudeUserMessage>;

type ClaudeMcpServer =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: 'http'; url: string; headers?: Record<string, string> };

interface ClaudeQueryOptions {
  prompt: ClaudePrompt;
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
  mcpServers?: Record<string, ClaudeMcpServer>;
  permissionMode?: ClaudePermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: ClaudeCanUseTool;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  effort?: ClaudeSdkEffort;
  settings?: ClaudeSettings;
  systemPrompt?: ClaudeSystemPrompt;
  agents?: Record<string, ClaudeAgentDefinition>;
  sessionId?: string;
}

interface ClaudeAgentSdk {
  query(options: {
    prompt: ClaudePrompt;
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
  mcp_servers?: unknown;
  sessionId?: unknown;
  fast_mode_state?: unknown;
  fast_mode_disabled_reason?: unknown;
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
  /** Per-model accounting covering every request the run made (claude-code-12). */
  modelUsage?: unknown;
  /** Runtime-computed cost, a sibling of `usage` rather than a member. */
  total_cost_usd?: unknown;
  totalCostUsd?: unknown;
  fast_mode_state?: unknown;
  fast_mode_disabled_reason?: unknown;
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
  /**
   * Where the SDK's native binary stands (claude-code-57). The real lookup
   * over the tree this module resolves the SDK from is the default only
   * alongside the default loader: an injected `loadSdk` supplies no
   * installed tree to search, so its binary counts as present unless this
   * is injected too.
   */
  probeExecutable?: () => ClaudeExecutableProbe;
}

const INJECTED_SDK_EXECUTABLE: ClaudeExecutableProbe = {
  state: 'present',
  path: 'injected-sdk',
};

/**
 * The refusal a binary the lookup did not find earns (claude-code-56): on a
 * host the SDK publishes no binary for, that fact, since no reinstall can
 * help; otherwise the package the SDK tries first on this host, the host,
 * and the reinstall that restores it.
 */
function claudeExecutableRefusal(
  probe: Exclude<ClaudeExecutableProbe, { state: 'present' }>,
): string {
  const host =
    probe.state === 'no-sdk'
      ? `${process.platform}-${process.arch}`
      : `${probe.platform}-${probe.arch}`;
  if (probe.state === 'unsupported') {
    return (
      `ClaudeCodeAdapter cannot run on ${host}: ${CLAUDE_SDK_PACKAGE} ` +
      `publishes no native binary for ${host}.`
    );
  }
  let pkg: string;
  if (probe.state === 'missing') {
    pkg = probe.package;
  } else {
    const [first] = claudeExecutableCandidates();
    pkg =
      first === undefined ? CLAUDE_SDK_PACKAGE : claudeExecutablePackage(first);
  }
  const tested = AGENT_RUNTIME_TARGETS.claude[0]!.tested;
  return (
    `ClaudeCodeAdapter found ${CLAUDE_SDK_PACKAGE} but not the native binary ` +
    `it spawns: the optional platform package ${pkg} is not installed for ` +
    `${host}. Reinstall so npm installs it: run npm ci in a checkout, or ` +
    `reinstall the SDK where '@sublang/cligent' resolves it (npm install ` +
    `${CLAUDE_SDK_PACKAGE}@${tested}, with -g for a global install), without ` +
    `--omit=optional.`
  );
}

const AGENT = 'claude-code' as const;

const DEFAULT_DONE_USAGE: DonePayload['usage'] = {
  toolUses: 0,
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
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

function asFastModeState(value: unknown): FastModeState | undefined {
  return value === 'off' || value === 'cooldown' || value === 'on'
    ? value
    : undefined;
}

function asFastModeDisabledReason(
  value: unknown,
): FastModeDisabledReason | undefined {
  return value === 'free' ||
    value === 'preference' ||
    value === 'extra_usage_disabled' ||
    value === 'network_error' ||
    value === 'unknown' ||
    value === 'not_first_party' ||
    value === 'disabled_by_env' ||
    value === 'model_not_allowed' ||
    value === 'sdk_opt_in_required' ||
    value === 'pending'
    ? value
    : undefined;
}

function readFastModeObservation(source: {
  fast_mode_state?: unknown;
  fast_mode_disabled_reason?: unknown;
}): FastModeObservation | undefined {
  const state = asFastModeState(source.fast_mode_state);
  const disabledReason = asFastModeDisabledReason(
    source.fast_mode_disabled_reason,
  );
  if (state === undefined && disabledReason === undefined) return undefined;
  return {
    ...(state !== undefined ? { state } : {}),
    ...(disabledReason !== undefined ? { disabledReason } : {}),
  };
}

function readFastModeResponseSpeed(
  rawUsage: unknown,
): FastModeResponseSpeed | undefined {
  if (!isUsageRecord(rawUsage)) return undefined;
  const speed = rawUsage.speed;
  if (speed !== 'standard' && speed !== 'fast') return undefined;

  const hasCompletedResponse = [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'output_tokens',
  ].some((key) => {
    const value = rawUsage[key];
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    );
  });
  return hasCompletedResponse ? speed : undefined;
}

function readTerminalFastModeObservation(
  result: ClaudeResultMessage,
): FastModeTerminalObservation | undefined {
  const observation = readFastModeObservation(result);
  const responseSpeed = readFastModeResponseSpeed(result.usage);
  if (observation === undefined && responseSpeed === undefined)
    return undefined;
  return {
    ...(observation ?? {}),
    ...(responseSpeed !== undefined ? { responseSpeed } : {}),
  };
}

function normalizePermissionLevel(
  value: PermissionLevel | undefined,
): PermissionLevel {
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

function identifyCapability(
  toolName: string | undefined,
): PermissionCapability | undefined {
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

  // engine-52: session-wide auto-mode posture takes precedence over the
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
  const allAllow = Object.values(normalized).every(
    (level) => level === 'allow',
  );

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
  if (
    status === 'interrupted' ||
    status === 'cancelled' ||
    status === 'aborted'
  ) {
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
  [
    'cache_read_input_tokens',
    ['cacheReadInputTokens', 'cache_read_input_tokens'],
  ],
  [
    'cache_creation_input_tokens',
    ['cacheCreationInputTokens', 'cache_creation_input_tokens'],
  ],
  ['output_tokens', ['outputTokens', 'output_tokens']],
] as const;

/**
 * claude-code-12 and claude-code-29: `result.modelUsage` counts every request
 * the run made, including subagents. Fold its per-model entries into authentic
 * records and matching engine-59 totals. Return undefined when the map is
 * absent or malformed rather than publishing a partial table.
 */
function foldModelUsage(rawModelUsage: unknown):
  | {
      totals: NonNullable<DonePayload['usage']['tokens']>['totals'];
      records: UsageRecord[];
    }
  | undefined {
  if (!isUsageRecord(rawModelUsage)) return undefined;

  const entries = Object.entries(rawModelUsage);
  if (entries.length === 0) return undefined;

  const records: UsageRecord[] = [];
  for (const [model, entry] of entries) {
    if (!isUsageRecord(entry)) return undefined;
    const perModel: Record<string, number> = {};
    for (const [field, aliases] of MODEL_USAGE_ALIASES) {
      const reading = readUsageCounter(entry, aliases, true);
      if (!reading.valid) return undefined;
      perModel[field] = reading.value;
    }

    const inputTotal =
      (perModel.input_tokens ?? 0) +
      (perModel.cache_read_input_tokens ?? 0) +
      (perModel.cache_creation_input_tokens ?? 0);
    const tokens = buildTokenUsage(
      {
        total: inputTotal,
        uncached: perModel.input_tokens ?? 0,
        cacheRead: perModel.cache_read_input_tokens ?? 0,
        cacheWrite: perModel.cache_creation_input_tokens ?? 0,
      },
      { total: perModel.output_tokens ?? 0 },
    );
    if (!tokens) return undefined;

    const cost = buildUsageCost(
      asNumber(entry.costUSD) ?? asNumber(entry.costUsd),
      'agent-estimate',
    );
    const webSearchRequests = readUsageCounter(
      entry,
      ['webSearchRequests', 'web_search_requests'],
      false,
    );
    records.push({
      // `canonicalModel` is the id Claude Code prices against; the map key can
      // be an alias or carry a context-window suffix.
      model: asString(entry.canonicalModel) ?? model,
      ...(asString(entry.provider)
        ? { provider: asString(entry.provider)! }
        : {}),
      tokens,
      ...(cost ? { cost } : {}),
      ...(webSearchRequests.valid && webSearchRequests.present
        ? {
            pricedUnits: [
              {
                name: 'web_search_request',
                quantity: webSearchRequests.value,
              },
            ],
          }
        : {}),
    });
  }

  const totals = sumTokenUsage(records);
  return totals ? { totals, records } : undefined;
}

function readToolUses(rawUsage: unknown, observedToolUses: number): number {
  if (!isUsageRecord(rawUsage)) return observedToolUses;

  const reported = readUsageCounter(rawUsage, ['toolUses', 'tool_uses'], false);
  return Math.max(reported.valid ? reported.value : 0, observedToolUses);
}

/** claude-code-28 uses only main-loop counters to identify a repair no-op. */
function isZeroMainLoopUsage(
  rawUsage: unknown,
  observedToolUses: number,
): boolean {
  if (!isUsageRecord(rawUsage)) return false;

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
  const valid =
    baseInput.valid &&
    cacheRead.valid &&
    cacheCreation.valid &&
    outputTokens.valid;
  const inputTokens = baseInput.value + cacheRead.value + cacheCreation.value;
  return (
    valid &&
    Number.isSafeInteger(inputTokens) &&
    inputTokens === 0 &&
    outputTokens.value === 0 &&
    readToolUses(rawUsage, observedToolUses) === 0
  );
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
    ...(code ? { code: ordinaryErrorCode(code, 'SDK_STREAM_ERROR') } : {}),
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
      const toolName =
        asString(toolUse.name) ?? asString(toolUse.toolName) ?? 'unknown_tool';
      const toolUseId =
        asString(toolUse.id) ??
        asString(toolUse.toolUseId) ??
        generateSessionId();
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
          statusText === 'denied' ? 'denied' : isError ? 'error' : 'success',
        output:
          toolResult.output ?? toolResult.result ?? toolResult.content ?? null,
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

  // engine-25: an importable SDK is not necessarily a supported one.
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

/** The literal `subagentModel` value naming the run's own model (DR-029). */
const INHERIT_SUBAGENT_MODEL = 'inherit';

/**
 * What the delegation directive names: the subagents' model, or `'inherit'`
 * for the agent's own, and their effort, omitted when the agent chooses.
 */
export interface SubagentDirectiveSelection {
  model: string;
  effort?: string;
}

/**
 * claude-code-61: the delegation directive an accepted `subagentModel`
 * contributes. Only its first sentence follows the model and effort; a bare
 * model string reads as `{ model }`.
 */
export function subagentDirective(
  selection: string | SubagentDirectiveSelection,
): string {
  const { model, effort } =
    typeof selection === 'string' ? { model: selection } : selection;
  const subject =
    model === INHERIT_SUBAGENT_MODEL
      ? 'Your subagents run on your own model'
      : `Your subagents run on ${model}`;
  const first =
    effort === undefined
      ? `${subject}; give each one the effort its task warrants.`
      : `${subject} at ${effort} effort.`;
  return (
    `${first} Offload to them the work you can specify completely and ` +
    'bound tightly — well-defined, fine-grained tasks a subagent can ' +
    'implement well — and keep the deep thinking, reasoning, and design ' +
    'work yourself. Offloading must never lower the quality of what you ' +
    'deliver: brief each subagent fully, and verify its result before you ' +
    'build on it.'
  );
}

/** claude-code-67: the one prompt every registered definition carries. */
const DELEGATE_PROMPT =
  'You are a delegate subagent. Complete exactly the task you are given, ' +
  'within the bounds it sets, using the tools available to you. Do not ' +
  'widen the task or change anything it does not ask for. When you finish, ' +
  'report precisely what you did and what you verified, and name anything ' +
  'you could not do or could not verify.';

function toClaudeSdkEffort(effort: ClaudeSubagentEffort): ClaudeSdkEffort {
  // claude-code-8's mapping; a subagent effort is never `ultracode`.
  return mapEffortToClaudeOptions(effort).effort as ClaudeSdkEffort;
}

/** claude-code-67: what a definition's description says it runs on. */
function runsOn(model: string, effort: ClaudeSdkEffort): string {
  const subject = model === INHERIT_SUBAGENT_MODEL ? 'your model' : model;
  return `${subject} at ${effort} effort`;
}

/**
 * claude-code-67: the effort `general-purpose` runs at where the agent
 * chooses: the level a session runs at when none is set.
 */
const CHOSEN_GENERAL_PURPOSE_EFFORT: ClaudeSdkEffort = 'medium';

const GENERAL_PURPOSE_DESCRIPTION =
  'General-purpose agent for research, code search and multi-step tasks';

/**
 * claude-code-67: the subagent definitions a query registers. A pinned
 * effort registers `delegate`; otherwise one `delegate-<effort>` per
 * distinct SDK effort, so the agent's choice of effort is a choice of
 * definition. Both replace the built-in `general-purpose` by name, the type
 * a call naming none runs as — at the pinned effort, or at `medium` with a
 * pointer to the delegates — so no subagent inherits the agent's effort by
 * omission. `Explore` and `Plan` are left alone, since a replacement would
 * cost them their read-only tool restrictions and their own prompts.
 */
function claudeSubagentDefinitions(
  model: string,
  effort: ClaudeSubagentEffort | undefined,
): Record<string, ClaudeAgentDefinition> {
  const delegate = (sdkEffort: ClaudeSdkEffort): ClaudeAgentDefinition => ({
    description: `Runs on ${runsOn(model, sdkEffort)}.`,
    prompt: DELEGATE_PROMPT,
    model,
    effort: sdkEffort,
  });
  // No model: claude-code-60's environment binds it, as for any built-in.
  const generalPurpose = (
    sdkEffort: ClaudeSdkEffort,
    pointer: string,
  ): ClaudeAgentDefinition => ({
    description: `${GENERAL_PURPOSE_DESCRIPTION}, on ${runsOn(model, sdkEffort)}${pointer}.`,
    prompt: DELEGATE_PROMPT,
    effort: sdkEffort,
  });

  if (effort !== undefined) {
    const sdkEffort = toClaudeSdkEffort(effort);
    return {
      delegate: delegate(sdkEffort),
      'general-purpose': generalPurpose(sdkEffort, ''),
    };
  }

  const agents: Record<string, ClaudeAgentDefinition> = {};
  for (const value of subagentEffortValues(AGENT) ?? []) {
    const sdkEffort = toClaudeSdkEffort(value as ClaudeSubagentEffort);
    agents[`delegate-${sdkEffort}`] ??= delegate(sdkEffort);
  }
  agents['general-purpose'] = generalPurpose(
    CHOSEN_GENERAL_PURPOSE_EFFORT,
    '; start a delegate-<effort> subagent for another effort',
  );
  return agents;
}

/**
 * claude-code-62: compose the SDK `systemPrompt` from ordered parts, joined
 * by one blank line. A future caller-supplied prompt comes first; each
 * Cligent directive follows, so it is joined, never replaced. No part means
 * no `systemPrompt`, leaving the query exactly as it was before any part
 * existed. Unsnapshotted, so a changed or cleared part is phrased afresh on
 * the next request rather than replaying a recorded prompt.
 */
export function composeClaudeSystemPrompt(
  parts: readonly string[],
): ClaudeComposedSystemPrompt | undefined {
  if (parts.length === 0) return undefined;
  return { type: 'custom', prompt: parts.join('\n\n'), snapshot: false };
}

export function mapAgentOptionsToClaudeQueryOptions(
  options:
    | AgentOptions<ClaudeEffort, boolean, string, ClaudeSubagentEffort>
    | undefined,
): MappedClaudeOptions {
  const mcpServers = normalizeMcpServers(options?.mcpServers);
  assertClaudeMcpAllowlist(options, mcpServers);
  const sdkMcpServers =
    mcpServers === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(mcpServers).map(([name, server]) => [
            name,
            server.type === 'stdio'
              ? {
                  type: 'stdio' as const,
                  command: server.command,
                  ...(server.args === undefined
                    ? {}
                    : { args: [...server.args] }),
                  ...(server.env === undefined
                    ? {}
                    : { env: { ...server.env } }),
                }
              : {
                  type: 'http' as const,
                  url: server.url,
                  ...(server.headers === undefined
                    ? {}
                    : { headers: { ...server.headers } }),
                },
          ]),
        );
  const mcpToolGrants = Object.keys(mcpServers ?? {}).map(
    (name) => `mcp__${name}__*`,
  );
  assertBuiltInFastModeOption(AGENT, options?.fastMode);
  assertBuiltInSubagentModelOption(AGENT, options?.subagentModel);
  assertBuiltInSubagentEffortOption(
    AGENT,
    options?.subagentModel,
    options?.subagentEffort,
  );
  const permissionOptions = mapPermissionsToClaudeOptions(options?.permissions);
  const effortOptions = mapEffortToClaudeOptions(options?.effort);
  // claude-code-70: a run's MCP surface is the servers the query passes,
  // never the account's auto-fetched claude.ai connectors, whose
  // "connectors need authorizing" reminder otherwise reaches the transcript.
  // `strictMcpConfig` below removes the other ambient MCP sources.
  const settings: ClaudeSettings = {
    disableClaudeAiConnectors: true,
    ...effortOptions.settings,
    ...(options?.fastMode !== undefined ? { fastMode: options.fastMode } : {}),
  };

  let cleanupAbort = () => {};
  let abortController: AbortController | undefined;

  if (options?.abortSignal) {
    abortController = new AbortController();
    const onAbort = () => abortController?.abort();

    if (options.abortSignal.aborted) {
      onAbort();
    } else {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
      cleanupAbort = () =>
        options.abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;

  // claude-code-60 / claude-code-61 / claude-code-67: FORCE makes the model
  // bind every subagent, including built-in ones whose definitions pin a
  // model and any per-call `model` the agent passes; FORCE alone binds them
  // to the run's own model, so `inherit` clears any caller model. The
  // definitions carry the effort, and the directive is the final part.
  const systemPromptParts: string[] = [];
  let agents: Record<string, ClaudeAgentDefinition> | undefined;
  const subagentModel = options?.subagentModel;
  if (subagentModel !== undefined) {
    if (subagentModel === INHERIT_SUBAGENT_MODEL) {
      delete env.CLAUDE_CODE_SUBAGENT_MODEL;
    } else {
      env.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel;
    }
    env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
    const subagentEffort = options?.subagentEffort;
    agents = claudeSubagentDefinitions(subagentModel, subagentEffort);
    systemPromptParts.push(
      subagentDirective({
        model: subagentModel,
        ...(subagentEffort !== undefined
          ? { effort: toClaudeSdkEffort(subagentEffort) }
          : {}),
      }),
    );
  }
  const systemPrompt = composeClaudeSystemPrompt(systemPromptParts);

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
      allowedTools:
        mcpToolGrants.length > 0 ? mcpToolGrants : options?.allowedTools,
      disallowedTools: options?.disallowedTools,
      settingSources: toolFreeIsolation ? [] : undefined,
      strictMcpConfig: true,
      ...(sdkMcpServers === undefined ? {} : { mcpServers: sdkMcpServers }),
      permissionMode: permissionOptions.permissionMode,
      allowDangerouslySkipPermissions:
        permissionOptions.allowDangerouslySkipPermissions,
      canUseTool: permissionOptions.canUseTool,
      abortController,
      env,
      ...effortOptions,
      settings,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(agents !== undefined ? { agents } : {}),
    },
    cleanupAbort,
  };
}

function assertClaudeMcpAllowlist(
  options:
    | AgentOptions<ClaudeEffort, boolean, string, ClaudeSubagentEffort>
    | undefined,
  mcpServers: McpServers | undefined,
): void {
  if (
    options?.allowedTools !== undefined &&
    (options.browser === true || Object.keys(mcpServers ?? {}).length > 0)
  ) {
    throw new Error(
      'ClaudeCodeAdapter cannot combine allowedTools with nonempty mcpServers or browser: true; ' +
        'the SDK cannot enforce the portable allowlist on explicit MCP tools. Use disallowedTools to deny selected tools.',
    );
  }
}

export class ClaudeCodeAdapter implements AgentAdapter<
  ClaudeEffort,
  boolean,
  string,
  ClaudeSubagentEffort
> {
  readonly agent = AGENT;

  private readonly loadSdk: () => Promise<ClaudeAgentSdk>;
  private readonly probeExecutable: () => ClaudeExecutableProbe;

  constructor(deps: ClaudeAdapterDeps = {}) {
    this.loadSdk = deps.loadSdk ?? loadClaudeAgentSdk;
    this.probeExecutable =
      deps.probeExecutable ??
      (deps.loadSdk === undefined
        ? () => probeClaudeExecutable()
        : () => INJECTED_SDK_EXECUTABLE);
  }

  /** claude-code-13: the SDK loads and the native binary it spawns is
   * installed. An importable SDK whose optional platform package npm
   * dropped is not available, since its first run fails on "executable not
   * found". */
  async isAvailable(): Promise<boolean> {
    try {
      await this.loadSdk();
      return this.probeExecutable().state === 'present';
    } catch {
      return false;
    }
  }

  async *run(
    prompt: string,
    options?: AgentOptions<ClaudeEffort, boolean, string, ClaudeSubagentEffort>,
  ): AsyncGenerator<AgentEvent, void, void> {
    const attachmentPreparationStart = Date.now();
    let sdkPrompt: ClaudePrompt = prompt;
    let mcpServers: McpServers | undefined;
    try {
      options?.abortSignal?.throwIfAborted();
      mcpServers = normalizeMcpServers(options?.mcpServers);
      assertClaudeMcpAllowlist(options, mcpServers);
      const attachments = await prepareAttachments(
        AGENT,
        options?.attachments,
        options?.cwd,
        options?.abortSignal,
      );
      if (attachments.length > 0) {
        const content: ClaudeUserMessage['message']['content'] = [
          { type: 'text', text: prompt },
        ];
        // Read before constructing the SDK iterable: a generator read failure
        // is otherwise masked by the SDK as "aborted by user".
        for (const attachment of attachments) {
          const data = (
            await readAttachment(attachment, options?.abortSignal)
          ).toString('base64');
          if (attachment.mimeType === 'application/pdf') {
            content.push({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data },
            });
          } else {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: attachment.mimeType as
                  'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data,
              },
            });
          }
        }
        sdkPrompt = (async function* () {
          yield {
            type: 'user' as const,
            parent_tool_use_id: null,
            message: { role: 'user' as const, content },
          };
        })();
      }
      mcpServers = await prepareMcpServers({ ...options, mcpServers });
      options?.abortSignal?.throwIfAborted();
    } catch (error) {
      if (!options?.abortSignal?.aborted) throw error;
      const sessionId = options.resume || generateSessionId();
      yield createEvent(
        'done',
        AGENT,
        {
          status: 'interrupted',
          ...doneResumeTokenPayload(
            'interrupted',
            false,
            sessionId,
            options.resume,
          ),
          usage: { ...DEFAULT_DONE_USAGE },
          durationMs: Date.now() - attachmentPreparationStart,
        },
        sessionId,
      );
      return;
    }
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
    // claude-code-56: refuse before any SDK call rather than let the SDK
    // fail on the binary it cannot spawn.
    const executable = this.probeExecutable();
    if (executable.state !== 'present') {
      throw new Error(claudeExecutableRefusal(executable));
    }

    const inboundResume = options?.resume || undefined;
    let sessionId = inboundResume ?? generateSessionId();
    let resumableSessionIdKnown = false;
    const { queryOptions, cleanupAbort } = mapAgentOptionsToClaudeQueryOptions({
      ...options,
      browser: false,
      mcpServers,
    });
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
    // the events the adapter derives from assistant messages, tool-result
    // user messages, and stream deltas — the submitted turn doing work — and what downstream
    // consumers capture to synthesize a final text. `init` stays excluded
    // because the system handshake precedes every turn (including the
    // resume-repair no-op), and `error` events are diagnostics rather than
    // turn output. Guards the internal-no-op result skip below: once real
    // activity has streamed, an empty zero-usage result is a legitimate
    // terminal and must not be swallowed.
    let submittedTurnActivity = false;
    const observedToolUseIds = new Set<string>();
    const toolNames = new Map<string, string>();

    try {
      for await (const message of sdk.query({
        prompt: sdkPrompt,
        options: queryOptions,
      })) {
        const messageType = isObjectWithType(message)
          ? message.type
          : undefined;
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
          const fastMode = readFastModeObservation(system);
          const reportedModel = asString(system.model);
          yield createEvent(
            'init',
            AGENT,
            {
              model: reportedModel ?? options?.model ?? 'unknown',
              ...(reportedModel !== undefined ? { reportedModel } : {}),
              cwd: asString(system.cwd) ?? options?.cwd ?? process.cwd(),
              tools: asStringArray(system.tools),
              ...(fastMode !== undefined ? { fastMode } : {}),
            },
            sessionId,
          );
          initYielded = true;
          if (mcpServers && Array.isArray(system.mcp_servers)) {
            // Native cached clients report pending while connecting in the
            // background; only definitive unavailability ends the run here.
            for (const entry of system.mcp_servers) {
              const server = asRecord(entry);
              const name = asString(server.name);
              const status = asString(server.status);
              if (
                name &&
                Object.hasOwn(mcpServers, name) &&
                (status === 'failed' ||
                  status === 'needs-auth' ||
                  status === 'disabled')
              ) {
                throw new Error(
                  `Claude MCP server "${name}" is unavailable (${status}). ` +
                    'Check its command or endpoint, authentication, and native policy before retrying.',
                );
              }
            }
          }
          continue;
        }

        if (messageType === 'assistant') {
          const assistant = message as ClaudeAssistantMessage;
          const textFromField = asString(assistant.text);
          if (textFromField) {
            submittedTurnActivity = true;
            yield createEvent(
              'text',
              AGENT,
              { content: textFromField },
              sessionId,
            );
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
              toolNames.set(contentEvent.toolUseId, contentEvent.toolName);
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
                  toolName:
                    toolNames.get(contentEvent.toolUseId) ??
                    contentEvent.toolName,
                  toolUseId: contentEvent.toolUseId,
                  status: contentEvent.status,
                  output: contentEvent.output,
                  durationMs: contentEvent.durationMs,
                },
                sessionId,
              );
              for (const media of mediaFromMcpContent(
                contentEvent.output,
                contentEvent.toolUseId,
              )) {
                yield createEvent('media', AGENT, media, sessionId);
              }
              continue;
            }
          }

          continue;
        }

        if (messageType === 'user') {
          const user = message as {
            isReplay?: boolean;
            message?: { content?: unknown };
          };
          if (user.isReplay === true || !Array.isArray(user.message?.content)) {
            continue;
          }
          // Tool execution results are user messages in the real SDK, not
          // assistant messages. Do not echo ordinary user text or attachments.
          const results = parseAssistantContent(
            user.message.content.filter(
              (block: unknown) =>
                isObjectWithType(block) && block.type === 'tool_result',
            ),
          );
          for (const result of results) {
            if (result.type !== 'tool_result') continue;
            submittedTurnActivity = true;
            yield createEvent(
              'tool_result',
              AGENT,
              {
                toolName: toolNames.get(result.toolUseId) ?? result.toolName,
                toolUseId: result.toolUseId,
                status: result.status,
                output: result.output,
                durationMs: result.durationMs,
              },
              sessionId,
            );
            for (const media of mediaFromMcpContent(
              result.output,
              result.toolUseId,
            )) {
              yield createEvent('media', AGENT, media, sessionId);
            }
          }
          continue;
        }

        if (
          messageType === 'stream' ||
          messageType === 'stream_event' ||
          messageType === 'delta'
        ) {
          const delta =
            asString((message as { delta?: unknown; text?: unknown }).delta) ??
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
          // Only modelUsage covers every request caused by the invocation,
          // including subagents and internal inference. Main-loop `usage`
          // remains useful for the claude-code-28 no-op signature below, but must
          // never be presented as whole-run accounting.
          const cost = buildUsageCost(
            asNumber(result.total_cost_usd) ?? asNumber(result.totalCostUsd),
            'agent-estimate',
          );
          const folded = foldModelUsage(result.modelUsage);
          const tokens = folded
            ? buildTokenUsageReport('complete', folded.totals, folded.records)
            : undefined;
          const usage: DonePayload['usage'] = {
            toolUses: observedToolUseIds.size,
            ...(tokens ? { tokens } : {}),
            ...(cost ? { cost } : {}),
          };
          const fastMode = readTerminalFastModeObservation(result);
          // claude-code-28's no-op signature is a property of the main-loop
          // result message, not of the run's total accounting: the repair
          // turn reports zero main-loop tokens while the run as a whole may
          // already have spent some. Detect it on the narrow counters so the
          // whole-run aggregates above cannot suppress the skip.
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
            isZeroMainLoopUsage(result.usage, observedToolUseIds.size);
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
                code:
                  ordinaryErrorCode(
                    asString(result.subtype),
                    'CLAUDE_CODE_RESULT_ERROR',
                  ) ?? 'CLAUDE_CODE_RESULT_ERROR',
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
              ...(fastMode !== undefined ? { fastMode } : {}),
            },
            sessionId,
          );
          doneYielded = true;
          return;
        }

        if (messageType === 'error') {
          const errorMessage = message as ClaudeErrorMessage;
          yield createEvent(
            'error',
            AGENT,
            toErrorPayload(errorMessage),
            sessionId,
          );
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
        error instanceof Error
          ? error.message
          : 'Claude Code adapter failed during stream';
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
