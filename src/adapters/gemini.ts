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
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  DonePayload,
  PermissionLevel,
  PermissionPolicy,
} from '../types.js';
import { parseNDJSON } from './ndjson.js';

const AGENT = 'gemini' as const;

const DEFAULT_DONE_USAGE: DonePayload['usage'] = {
  inputTokens: 0,
  outputTokens: 0,
  toolUses: 0,
};

type GeminiCapability = keyof Required<PermissionPolicy>;

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
    toolConfig: GeminiToolConfig,
  ) => Promise<GeminiSettingsOverride>;
}

const CAPABILITY_TOOL_GROUPS: Record<GeminiCapability, string[]> = {
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
): Required<PermissionPolicy> {
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

export interface GeminiToolConfig {
  allowedTools: string[];
  disallowedTools: string[];
  args: string[];
}

interface GeminiSettingsOverride {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

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

async function defaultCreateSettingsOverride(
  toolConfig: GeminiToolConfig,
): Promise<GeminiSettingsOverride> {
  const settings = buildGeminiToolSettings(toolConfig);
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
  const normalized = normalizePermissions(policy);

  const allowed = new Set(options?.allowedTools ?? []);
  const disallowed = new Set(options?.disallowedTools ?? []);

  for (const capability of Object.keys(CAPABILITY_TOOL_GROUPS) as GeminiCapability[]) {
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
  };
}

export interface GeminiCommandConfig {
  command: 'gemini';
  args: string[];
  spawnOptions: SpawnOptionsWithoutStdio;
  toolConfig: GeminiToolConfig;
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

  if (options?.model) {
    args.push('--model', options.model);
  }

  if (options?.maxTurns !== undefined) {
    args.push('--max-session-turns', String(options.maxTurns));
  }

  args.push(...toolConfig.args);

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
    toolConfig: GeminiToolConfig,
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
      settingsOverride = await this.createSettingsOverride(mapped.toolConfig);
      const spawnOptions: SpawnOptionsWithoutStdio = {
        ...mapped.spawnOptions,
        env: {
          ...process.env,
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

        if (eventType === 'tool_use') {
          const toolName =
            asString(message.toolName) ??
            asString(message.tool_name) ??
            asString(message.name) ??
            'unknown_tool';

          const toolUseId =
            asString(message.toolUseId) ??
            asString(message.tool_id) ??
            asString(message.id) ??
            asString(message.callId) ??
            generateSessionId();

          yield createEvent(
            'tool_use',
            AGENT,
            {
              toolName,
              toolUseId,
              input: parseToolInput(
                message.input ?? message.parameters ?? message.args ?? message.arguments,
              ),
            },
            sessionId,
          );
          continue;
        }

        if (eventType === 'tool_result') {
          const statusText = asString(message.status)?.toLowerCase();
          const status: 'success' | 'error' | 'denied' =
            statusText === 'denied'
              ? 'denied'
              : message.isError === true ||
                  message.is_error === true ||
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
                'unknown_tool',
              toolUseId:
                asString(message.toolUseId) ??
                asString(message.tool_id) ??
                asString(message.id) ??
                asString(message.callId) ??
                generateSessionId(),
              status,
              output:
                message.output ??
                message.result ??
                message.content ??
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
          yield createEvent(
            'done',
            AGENT,
            {
              status: mapDoneStatus(asString(message.status)),
              result: asString(message.result),
              ...(backendProvidedSessionId ? { resumeToken: sessionId } : {}),
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
        yield createEvent(
          'done',
          AGENT,
          {
            status,
            ...(status === 'error' && stderr.trim().length > 0
              ? { result: stderr.trim() }
              : {}),
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
