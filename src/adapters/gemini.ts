// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile, spawn } from 'node:child_process';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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
import { parseNDJSON } from './ndjson.js';
import { doneResumeTokenPayload } from './resume-token.js';

const AGENT = 'gemini' as const;

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

interface CloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface GeminiAdapterDeps {
  spawnProcess?: SpawnProcessFn;
  probeAvailability?: () => Promise<boolean>;
  createSettingsOverride?: (
    settingsConfig: GeminiSettingsConfig,
  ) => Promise<GeminiSettingsOverride>;
}

const CAPABILITY_TOOL_GROUPS: Record<PermissionCapability, string[]> = {
  fileWrite: ['edit'],
  shellExecute: ['ShellTool'],
  networkAccess: ['webfetch'],
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
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed);
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
    'Gemini CLI error';

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

function mapExitCodeToDoneStatus(
  close: CloseResult,
  aborted: boolean,
): DonePayload['status'] {
  if (aborted || close.signal === 'SIGTERM') {
    return 'interrupted';
  }

  if (close.code === 0) return 'success';
  if (close.code === 53) return 'max_turns';
  if (close.code === 1 || close.code === 42) return 'error';
  return 'error';
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return spawn(command, args, options) as ChildProcessWithoutNullStreams;
}

const execFileAsync = promisify(execFile);

async function defaultProbeAvailability(): Promise<boolean> {
  try {
    await execFileAsync('gemini', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gemini CLI `--approval-mode` value. `'yolo'` auto-approves all operations
 * — used as the target for ENG-021 `mode: 'auto'` since gemini exposes no
 * distinct "auto with safety" tier (its `auto_edit` only covers edits, not
 * the full automation intent).
 */
export type GeminiApprovalMode = 'default' | 'auto_edit' | 'yolo';

export interface GeminiToolConfig {
  allowedTools: string[];
  disallowedTools: string[];
  args: string[];
  approvalMode?: GeminiApprovalMode;
  writablePaths?: WritablePathsPermissionMapping;
}

export type GeminiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface GeminiThinkingConfig {
  thinkingLevel?: GeminiThinkingLevel;
  thinkingBudget?: number;
}

export interface GeminiModelAliasConfig {
  alias: string;
  model: string;
  thinkingConfig: GeminiThinkingConfig;
}

export interface GeminiSettingsConfig {
  toolConfig: GeminiToolConfig;
  modelAlias?: GeminiModelAliasConfig;
}

interface GeminiSettingsOverride {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export const GEMINI_REASONING_EFFORT_ALIAS = 'cligent-reasoning-effort';

const NOOP_SETTINGS_OVERRIDE: GeminiSettingsOverride = {
  env: {},
  cleanup: async () => {},
};

export function buildGeminiToolSettings(
  toolConfig: GeminiToolConfig,
): { tools: { core?: string[]; exclude?: string[] } } | undefined {
  const tools: { core?: string[]; exclude?: string[] } = {};

  if (toolConfig.allowedTools.length > 0) {
    tools.core = toolConfig.allowedTools;
  }
  if (toolConfig.disallowedTools.length > 0) {
    tools.exclude = toolConfig.disallowedTools;
  }

  if (!tools.core && !tools.exclude) {
    return undefined;
  }

  return { tools };
}

export function mapReasoningEffortToGeminiModelAlias(
  model: string | undefined,
  effort: ReasoningEffort | undefined,
): GeminiModelAliasConfig | undefined {
  if (!model || !effort) return undefined;

  if (/^gemini-3/.test(model)) {
    return {
      alias: GEMINI_REASONING_EFFORT_ALIAS,
      model,
      thinkingConfig: {
        thinkingLevel: mapReasoningEffortToGemini3ThinkingLevel(effort),
      },
    };
  }

  if (/^gemini-2\.5/.test(model)) {
    return {
      alias: GEMINI_REASONING_EFFORT_ALIAS,
      model,
      thinkingConfig: {
        thinkingBudget: mapReasoningEffortToGemini25ThinkingBudget(model, effort),
      },
    };
  }

  return undefined;
}

function mapReasoningEffortToGemini3ThinkingLevel(
  effort: ReasoningEffort,
): GeminiThinkingLevel {
  switch (effort) {
    case 'minimal':
      return 'MINIMAL';
    case 'low':
      return 'LOW';
    case 'medium':
      return 'MEDIUM';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'HIGH';
  }
}

function mapReasoningEffortToGemini25ThinkingBudget(
  model: string,
  effort: ReasoningEffort,
): number {
  switch (effort) {
    case 'minimal':
      return 1024;
    case 'low':
      return 4096;
    case 'medium':
      return 8192;
    case 'high':
      return 16384;
    case 'xhigh':
      return 24576;
    case 'max':
      return /^gemini-2\.5-pro/.test(model) ? 32768 : 24576;
  }
}

export function buildGeminiSettings(
  settingsConfig: GeminiSettingsConfig,
): {
  tools?: { core?: string[]; exclude?: string[] };
  modelConfigs?: {
    customAliases: Record<string, {
      modelConfig: {
        model: string;
        generateContentConfig: {
          thinkingConfig: GeminiThinkingConfig;
        };
      };
    }>;
  };
} | undefined {
  const toolSettings = buildGeminiToolSettings(settingsConfig.toolConfig);
  const alias = settingsConfig.modelAlias;

  if (!toolSettings && !alias) {
    return undefined;
  }

  return {
    ...(toolSettings ?? {}),
    ...(alias
      ? {
          modelConfigs: {
            customAliases: {
              [alias.alias]: {
                modelConfig: {
                  model: alias.model,
                  generateContentConfig: {
                    thinkingConfig: alias.thinkingConfig,
                  },
                },
              },
            },
          },
        }
      : {}),
  };
}

async function defaultCreateSettingsOverride(
  settingsConfig: GeminiSettingsConfig,
): Promise<GeminiSettingsOverride> {
  const settings = buildGeminiSettings(settingsConfig);
  if (!settings) {
    return NOOP_SETTINGS_OVERRIDE;
  }

  const dir = await mkdtemp(join(tmpdir(), 'cligent-gemini-'));
  const filePath = join(dir, 'settings.json');
  await writeFile(filePath, `${JSON.stringify(settings)}\n`, 'utf8');

  return {
    env: {
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: filePath,
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function mapPermissionsToGeminiToolConfig(
  policy: PermissionPolicy | undefined,
  options?: Pick<AgentOptions, 'allowedTools' | 'disallowedTools'>,
): GeminiToolConfig {
  const writablePaths = mapWritablePathsPermission(policy, 'ambient');

  // ENG-021: session-wide mode takes precedence over per-capability levels.
  // gemini exposes a single prompt-less SDK setting (`--approval-mode yolo`),
  // so both 'auto' and 'bypass' map to it — gemini does not differentiate
  // a sandbox-protected auto-mode from an unchecked bypass beyond yolo
  // itself. The per-capability allow/deny derivation is skipped to honor
  // the precedence rule; user-passed allowedTools / disallowedTools are
  // independent from `permissions` and still apply.
  if (policy?.mode === 'auto' || policy?.mode === 'bypass') {
    const allowed = new Set(options?.allowedTools ?? []);
    const disallowed = new Set(options?.disallowedTools ?? []);
    if (allowed.size > 0) {
      for (const tool of disallowed) {
        allowed.delete(tool);
      }
    }
    const allowedTools = [...allowed].sort();
    const disallowedTools = [...disallowed].sort();
    const args: string[] = [];
    if (allowedTools.length > 0) {
      args.push('--allowed-tools', allowedTools.join(','));
    }
    return {
      allowedTools,
      disallowedTools,
      args,
      approvalMode: 'yolo',
      ...(writablePaths ? { writablePaths } : {}),
    };
  }

  const normalized = normalizePermissions(policy);

  const allowed = new Set(options?.allowedTools ?? []);
  const disallowed = new Set(options?.disallowedTools ?? []);

  for (const capability of Object.keys(CAPABILITY_TOOL_GROUPS) as PermissionCapability[]) {
    const level = normalized[capability];

    if (level === 'allow') {
      for (const tool of CAPABILITY_TOOL_GROUPS[capability]) {
        allowed.add(tool);
      }
      continue;
    }

    if (level === 'deny') {
      for (const tool of CAPABILITY_TOOL_GROUPS[capability]) {
        disallowed.add(tool);
      }
    }
  }

  if (allowed.size > 0) {
    for (const tool of disallowed) {
      allowed.delete(tool);
    }
  }

  const allowedTools = [...allowed].sort();
  const disallowedTools = [...disallowed].sort();

  const args: string[] = [];
  if (allowedTools.length > 0) {
    args.push('--allowed-tools', allowedTools.join(','));
  }

  return {
    allowedTools,
    disallowedTools,
    args,
    ...(writablePaths ? { writablePaths } : {}),
  };
}

export interface GeminiCommandConfig {
  command: 'gemini';
  args: string[];
  spawnOptions: SpawnOptionsWithoutStdio;
  toolConfig: GeminiToolConfig;
  settingsConfig: GeminiSettingsConfig;
}

export function mapAgentOptionsToGeminiCommand(
  prompt: string,
  options: AgentOptions | undefined,
): GeminiCommandConfig {
  const toolConfig = mapPermissionsToGeminiToolConfig(options?.permissions, {
    allowedTools: options?.allowedTools,
    disallowedTools: options?.disallowedTools,
  });

  const args = ['--output-format', 'stream-json'] as string[];
  const modelAlias = mapReasoningEffortToGeminiModelAlias(
    options?.model,
    options?.reasoningEffort,
  );

  if (modelAlias) {
    args.push('--model', modelAlias.alias);
  } else if (options?.model) {
    args.push('--model', options.model);
  }

  // Note: Gemini CLI does not support a turn-limit flag.
  // options.maxTurns is intentionally not forwarded.

  args.push(...toolConfig.args);

  if (toolConfig.approvalMode) {
    args.push('--approval-mode', toolConfig.approvalMode);
  }

  // Prompt as positional argument (--prompt is deprecated)
  args.push(prompt);

  return {
    command: 'gemini',
    args,
    spawnOptions: {
      cwd: options?.cwd,
      stdio: 'pipe',
    },
    toolConfig,
    settingsConfig: {
      toolConfig,
      ...(modelAlias ? { modelAlias } : {}),
    },
  };
}

function buildInitPayload(
  sourceEvent: Record<string, unknown> | undefined,
  options: AgentOptions | undefined,
  toolConfig: GeminiToolConfig,
): {
  model: string;
  cwd: string;
  tools: string[];
  capabilities: Record<string, unknown>;
} {
  const sourceTools = asStringArray(sourceEvent?.tools);

  const tools =
    sourceTools.length > 0
      ? sourceTools
      : toolConfig.allowedTools.length > 0
        ? toolConfig.allowedTools
        : [];

  return {
    model: options?.model ?? asString(sourceEvent?.model) ?? 'unknown',
    cwd: options?.cwd ?? asString(sourceEvent?.cwd) ?? process.cwd(),
    tools,
    capabilities: {
      toolsKnown: sourceTools.length > 0 || toolConfig.allowedTools.length > 0,
      toolsSource:
        sourceTools.length > 0
          ? 'stream'
          : toolConfig.allowedTools.length > 0
            ? 'configured'
            : 'unavailable',
      disallowedTools: toolConfig.disallowedTools,
    },
  };
}

export class GeminiAdapter implements AgentAdapter {
  readonly agent = AGENT;

  private readonly spawnProcess: SpawnProcessFn;

  private readonly probeAvailability: () => Promise<boolean>;

  private readonly createSettingsOverride: (
    settingsConfig: GeminiSettingsConfig,
  ) => Promise<GeminiSettingsOverride>;

  constructor(deps: GeminiAdapterDeps = {}) {
    this.spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
    this.probeAvailability = deps.probeAvailability ?? defaultProbeAvailability;
    this.createSettingsOverride =
      deps.createSettingsOverride ?? defaultCreateSettingsOverride;
  }

  async isAvailable(): Promise<boolean> {
    return this.probeAvailability();
  }

  async *run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    const mapped = mapAgentOptionsToGeminiCommand(prompt, options);

    let processExited = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let closePromise: Promise<CloseResult> | undefined;
    let settingsOverride: GeminiSettingsOverride = NOOP_SETTINGS_OVERRIDE;

    const startTime = Date.now();
    let sessionId = options?.resume ?? generateSessionId();
    let backendProvidedSessionId = false;
    let doneYielded = false;
    let initYielded = false;
    let abortRequested = options?.abortSignal?.aborted === true;
    let stderr = '';

    const onAbort = () => {
      abortRequested = true;
      if (!child || processExited) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore kill errors during shutdown
      }
    };

    if (options?.abortSignal && !options.abortSignal.aborted) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      settingsOverride = await this.createSettingsOverride(mapped.settingsConfig);
      const spawnOptions: SpawnOptionsWithoutStdio = {
        ...mapped.spawnOptions,
        env: {
          ...process.env,
          GEMINI_CLI_TRUST_WORKSPACE:
            process.env.GEMINI_CLI_TRUST_WORKSPACE ?? 'true',
          ...(mapped.spawnOptions.env ?? {}),
          ...settingsOverride.env,
        },
      };

      child = this.spawnProcess(
        mapped.command,
        mapped.args,
        spawnOptions,
      );

      const processRef = child;

      if (!processRef.stdout) {
        throw new Error('Gemini CLI process does not expose stdout stream');
      }

      if (processRef.stderr) {
        processRef.stderr.setEncoding('utf8');
        processRef.stderr.on('data', (chunk: string | Buffer) => {
          stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
      }

      closePromise = new Promise<CloseResult>((resolve, reject) => {
        const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
          processExited = true;
          cleanup();
          resolve({ code, signal });
        };

        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };

        const cleanup = () => {
          processRef.removeListener('close', onClose);
          processRef.removeListener('error', onError);
        };

        processRef.once('close', onClose);
        processRef.once('error', onError);
      });

      if (abortRequested) {
        onAbort();
      }

      for await (const parsed of parseNDJSON(processRef.stdout)) {
        if (!parsed.ok) {
          if (!initYielded) {
            yield createEvent(
              'init',
              AGENT,
              buildInitPayload(undefined, options, mapped.toolConfig),
              sessionId,
            );
            initYielded = true;
          }

          if (!doneYielded) {
            yield createEvent(
              'error',
              AGENT,
              {
                code: 'NDJSON_PARSE_ERROR',
                message: `Failed to parse NDJSON line: ${parsed.error}; raw: ${parsed.raw}`,
                recoverable: true,
              },
              sessionId,
            );
          }
          continue;
        }

        const message = asRecord(parsed.data);
        const loadedId = loadSessionId(parsed.data);
        if (loadedId) {
          sessionId = loadedId;
          backendProvidedSessionId = true;
        }
        const eventType = asString(message.type);

        if (!eventType) continue;

        if (eventType === 'init') {
          if (!initYielded) {
            yield createEvent(
              'init',
              AGENT,
              buildInitPayload(message, options, mapped.toolConfig),
              sessionId,
            );
            initYielded = true;
          }
          continue;
        }

        if (!initYielded) {
          yield createEvent(
            'init',
            AGENT,
            buildInitPayload(message, options, mapped.toolConfig),
            sessionId,
          );
          initYielded = true;
        }

        if (doneYielded) continue;

        if (eventType === 'message') {
          const content =
            asString(message.content) ??
            asString(message.text) ??
            asString(message.message);

          if (content) {
            yield createEvent('text', AGENT, { content }, sessionId);
          }
          continue;
        }

        if (eventType === 'tool_use' || eventType === 'tool_call_request') {
          // Tool info may sit at: top level, inside a `functionCall` /
          // `function_call` key, or inside a `value` wrapper that itself
          // may contain a `functionCall` sub-object.
          const wrapper = asRecord(message.value);
          const nested = asRecord(
            wrapper.functionCall ??
              wrapper.function_call ??
              message.functionCall ??
              message.function_call ??
              message.value,
          );

          const toolName =
            asString(message.toolName) ??
            asString(message.tool_name) ??
            asString(message.name) ??
            asString(nested.name) ??
            asString(nested.toolName) ??
            asString(nested.tool_name) ??
            'unknown_tool';

          const toolUseId =
            asString(message.toolUseId) ??
            asString(message.tool_id) ??
            asString(message.id) ??
            asString(message.callId) ??
            asString(nested.callId) ??
            asString(nested.id) ??
            asString(nested.tool_id) ??
            generateSessionId();

          yield createEvent(
            'tool_use',
            AGENT,
            {
              toolName,
              toolUseId,
              input: parseToolInput(
                message.input ??
                  message.parameters ??
                  message.args ??
                  message.arguments ??
                  nested.args ??
                  nested.parameters ??
                  nested.input,
              ),
            },
            sessionId,
          );
          continue;
        }

        if (eventType === 'tool_result' || eventType === 'tool_call_response') {
          // Tool results may sit at: top level, inside a `functionResponse`
          // / `function_response` key, or inside a `value` wrapper that
          // itself may contain a `functionResponse` sub-object.
          const wrapper = asRecord(message.value);
          const nested = asRecord(
            wrapper.functionResponse ??
              wrapper.function_response ??
              message.functionResponse ??
              message.function_response ??
              message.value,
          );

          const nestedStatus = asString(nested.status)?.toLowerCase();
          const statusText =
            asString(message.status)?.toLowerCase() ?? nestedStatus;
          const status: 'success' | 'error' | 'denied' =
            statusText === 'denied'
              ? 'denied'
              : message.isError === true ||
                  message.is_error === true ||
                  nested.isError === true ||
                  statusText === 'error'
                ? 'error'
                : 'success';

          yield createEvent(
            'tool_result',
            AGENT,
            {
              toolName:
                asString(message.toolName) ??
                asString(message.tool_name) ??
                asString(message.name) ??
                asString(nested.name) ??
                asString(nested.toolName) ??
                asString(nested.tool_name) ??
                'unknown_tool',
              toolUseId:
                asString(message.toolUseId) ??
                asString(message.tool_id) ??
                asString(message.id) ??
                asString(message.callId) ??
                asString(nested.callId) ??
                asString(nested.id) ??
                asString(nested.tool_id) ??
                generateSessionId(),
              status,
              output:
                message.output ??
                message.result ??
                message.content ??
                nested.output ??
                nested.result ??
                nested.response ??
                null,
              durationMs:
                asNumber(message.durationMs) ?? asNumber(message.duration_ms),
            },
            sessionId,
          );
          continue;
        }

        if (eventType === 'error') {
          yield createEvent('error', AGENT, toErrorPayload(message), sessionId);
          continue;
        }

        if (eventType === 'result') {
          const doneStatus = mapDoneStatus(asString(message.status));

          // Surface terminal error from result event (e.g. auth/quota/model).
          // Extract from known fields; fall back to a raw dump so the
          // provider error is never silently swallowed.
          if (doneStatus === 'error') {
            const resultError = asRecord(message.error);
            const errorMsg =
              asString(resultError.message) ??
              asString((message as Record<string, unknown>).errorMessage) ??
              asString(message.result);
            const diagMsg = errorMsg
              || `Gemini result error (raw: ${JSON.stringify({ error: message.error, result: message.result, status: message.status })})`;

            yield createEvent(
              'error',
              AGENT,
              {
                ...(errorMsg ? toErrorPayload(message) : {
                  code: 'GEMINI_RESULT_ERROR',
                  message: diagMsg,
                  recoverable: false,
                }),
              },
              sessionId,
            );
          }

          const resultText =
            asString(message.result) ??
            asString(asRecord(message.error).message);

          yield createEvent(
            'done',
            AGENT,
            {
              status: doneStatus,
              result: resultText,
              ...doneResumeTokenPayload(
                doneStatus,
                backendProvidedSessionId,
                sessionId,
                options?.resume,
              ),
              usage: mapUsage(message.stats),
              durationMs:
                asNumber(message.durationMs) ??
                asNumber(message.duration_ms) ??
                Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
          continue;
        }
      }

      const close = await closePromise;

      if (!initYielded) {
        yield createEvent(
          'init',
          AGENT,
          buildInitPayload(undefined, options, mapped.toolConfig),
          sessionId,
        );
        initYielded = true;
      }

      if (!doneYielded) {
        const status = mapExitCodeToDoneStatus(close, abortRequested);
        const stderrText = stderr.trim();
        const fallbackMsg = stderrText || (status === 'error'
          ? `Gemini CLI exited with code ${close?.code ?? 'null'} without a result event`
          : undefined);

        if (status === 'error' && fallbackMsg) {
          yield createEvent(
            'error',
            AGENT,
            {
              code: 'GEMINI_EXIT_ERROR',
              message: fallbackMsg,
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
            ...doneResumeTokenPayload(
              status,
              backendProvidedSessionId,
              sessionId,
              options?.resume,
            ),
            ...(fallbackMsg ? { result: fallbackMsg } : {}),
            usage: { ...DEFAULT_DONE_USAGE },
            durationMs: Date.now() - startTime,
          },
          sessionId,
        );
      }
    } catch (error) {
      if (!initYielded) {
        yield createEvent(
          'init',
          AGENT,
          buildInitPayload(undefined, options, mapped.toolConfig),
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
          return;
        }

        yield createEvent(
          'error',
          AGENT,
          {
            code: 'GEMINI_STREAM_ERROR',
            message:
              error instanceof Error
                ? error.message
                : 'Gemini adapter failed while reading stream',
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
    } finally {
      if (options?.abortSignal && !options.abortSignal.aborted) {
        options.abortSignal.removeEventListener('abort', onAbort);
      }

      if (child && !processExited) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore cleanup errors
        }

        if (closePromise) {
          try {
            await closePromise;
          } catch {
            // ignore cleanup errors
          }
        }
      }

      await settingsOverride.cleanup();
    }
  }
}
