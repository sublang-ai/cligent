// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describeCapabilities, CapabilityError } from '../capabilities.js';

import { execFile, spawn } from 'node:child_process';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import { promisify } from 'node:util';

import { createEvent, generateSessionId } from '../events.js';
import {
  assertGeminiAttachmentContext,
  prepareGeminiAttachments,
} from './gemini-attachments.js';
import {
  normalizeMcpServers,
  prepareMcpServers,
  withMcpResources,
  type McpServers,
} from '../mcp.js';
import { assertSupportedEffort } from '../effort.js';
import { assertBuiltInFastModeOption } from '../fast-mode.js';
import {
  assertBuiltInSubagentEffortOption,
  assertBuiltInSubagentModelOption,
} from '../subagent-model.js';
import { mapWritablePathsPermission } from '../permissions.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  DonePayload,
  GeminiEffort,
  PermissionCapability,
  PermissionLevel,
  PermissionPolicy,
  TokenUsageReport,
  UsageRecord,
  WritablePathsPermissionMapping,
} from '../types.js';
import { createGeminiHomeOverlay, foldGeminiSkillName } from './gemini-home.js';
import { prepareSkills, type PreparedSkill } from '../skills.js';
import { parseNDJSON } from './ndjson.js';
import { doneResumeTokenPayload } from './resume-token.js';
import { ordinaryErrorCode } from './session-resume.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import {
  assertRuntimeSupported,
  isCliRuntimeSupported,
} from '../runtime-version.js';
import {
  buildTokenUsage,
  buildTokenUsageReport,
  isUsageRecord,
  sumTokenUsage,
} from './usage.js';

const AGENT = 'gemini' as const;
const GEMINI_API_RESPONSE_EVENT = 'gemini_cli.api_response';
const GEMINI_API_ERROR_EVENT = 'gemini_cli.api_error';

const DEFAULT_DONE_USAGE: DonePayload['usage'] = {
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
  error?: Error;
}

interface GeminiTelemetryCapture {
  env: Record<string, string>;
  read: () => Promise<string>;
  cleanup: () => Promise<void>;
}

interface GeminiAdapterDeps {
  spawnProcess?: SpawnProcessFn;
  probeAvailability?: () => Promise<boolean>;
  createSettingsOverride?: (
    settingsConfig: GeminiSettingsConfig,
    context: GeminiSettingsOverrideContext,
  ) => Promise<GeminiSettingsOverride>;
  createPolicyOverride?: (
    toolConfig: GeminiToolConfig,
    runtimePolicySources?: readonly string[],
  ) => Promise<GeminiPolicyOverride>;
  createTelemetryCapture?: () => Promise<GeminiTelemetryCapture>;
  /** Replaces the runtime's system-file admission check (gemini-34). */
  admitsSystemSettingsFile?: GeminiSystemFileAdmission;
  /**
   * The platform whose admission rule the default check applies
   * (gemini-34); defaults to the host's.
   */
  admissionPlatform?: NodeJS.Platform;
  /**
   * The platform whose rules for naming environment variables the child's
   * environment follows (gemini-56); defaults to the host's.
   */
  environmentPlatform?: NodeJS.Platform;
}

/**
 * Whether a Gemini child would load the system settings or system defaults
 * file at an absolute path, skip it, or neither can be established here
 * (gemini-34).
 */
type GeminiSystemFileAdmission = (
  path: string,
) => Promise<'admitted' | 'rejected' | 'unknown'>;

const CAPABILITY_TOOL_GROUPS: Record<PermissionCapability, string[]> = {
  fileWrite: ['replace', 'write_file'],
  shellExecute: ['run_shell_command'],
  networkAccess: ['google_web_search', 'web_fetch'],
};

const POLICY_PRIORITY = {
  deny: 999,
  explicitAllow: 999,
  explicitAllowCatchAll: 998,
  capability: 997,
} as const;

/** The tool through which Gemini loads a skill's instructions (gemini-52). */
const ACTIVATE_SKILL_TOOL = 'activate_skill';

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
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizePermissionLevel(
  value: PermissionLevel | undefined,
): PermissionLevel {
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

function requiredCounter(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Parse the file exporter's consecutive, pretty-printed JSON objects. */
function parseJsonObjectSequence(source: string): unknown[] | undefined {
  const values: unknown[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (start < 0) {
      if (/\s/u.test(char)) continue;
      if (char !== '{') return undefined;
      start = index;
      depth = 1;
      continue;
    }

    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          values.push(JSON.parse(source.slice(start, index + 1)) as unknown);
        } catch {
          return undefined;
        }
        start = -1;
      }
    }
  }

  return start < 0 && !quoted && values.length > 0 ? values : undefined;
}

interface GeminiApiResponseUsage {
  model: string;
  authType: string;
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  tool: number;
  total: number;
  identity: string;
  signature: string;
}

function readApiResponseUsage(
  value: unknown,
): GeminiApiResponseUsage | null | undefined {
  if (!isUsageRecord(value) || !isUsageRecord(value.attributes)) return null;
  const attributes = value.attributes;
  if (attributes['event.name'] !== GEMINI_API_RESPONSE_EVENT) return null;

  const model = asString(attributes.model);
  const promptId = asString(attributes.prompt_id);
  const authType = asString(attributes.auth_type);
  const input = requiredCounter(attributes, 'input_token_count');
  const output = requiredCounter(attributes, 'output_token_count');
  const cached = requiredCounter(attributes, 'cached_content_token_count');
  const thoughts = requiredCounter(attributes, 'thoughts_token_count');
  const tool = requiredCounter(attributes, 'tool_token_count');
  const total = requiredCounter(attributes, 'total_token_count');
  const timestamp =
    value.timestamp ??
    value.timeUnixNano ??
    value.hrTime ??
    value.observedTimestamp;

  if (
    !model ||
    !promptId ||
    !authType ||
    input === undefined ||
    output === undefined ||
    cached === undefined ||
    thoughts === undefined ||
    tool === undefined ||
    total === undefined ||
    timestamp === undefined ||
    cached > input ||
    total !== input + output + tool + thoughts
  ) {
    return undefined;
  }

  return {
    model,
    authType,
    input,
    output,
    cached,
    thoughts,
    tool,
    total,
    identity: JSON.stringify([timestamp, promptId, model]),
    signature: JSON.stringify([
      authType,
      attributes.role,
      input,
      output,
      cached,
      thoughts,
      tool,
      total,
      attributes.duration_ms,
      attributes.status_code,
    ]),
  };
}

interface GeminiStreamTokenStats {
  total: number;
  input: number;
  output: number;
  cached: number;
  uncached: number;
}

function readStreamTokenStats(
  value: unknown,
): GeminiStreamTokenStats | undefined {
  if (!isUsageRecord(value)) return undefined;
  const total = requiredCounter(value, 'total_tokens');
  const input = requiredCounter(value, 'input_tokens');
  const output = requiredCounter(value, 'output_tokens');
  const cached = requiredCounter(value, 'cached');
  const uncached = requiredCounter(value, 'input');
  if (
    total === undefined ||
    input === undefined ||
    output === undefined ||
    cached === undefined ||
    uncached === undefined ||
    cached + uncached !== input
  ) {
    return undefined;
  }
  return { total, input, output, cached, uncached };
}

function sameStreamStats(
  left: GeminiStreamTokenStats,
  right: GeminiStreamTokenStats,
): boolean {
  return (
    left.total === right.total &&
    left.input === right.input &&
    left.output === right.output &&
    left.cached === right.cached &&
    left.uncached === right.uncached
  );
}

function addStreamStats(
  target: GeminiStreamTokenStats,
  source: GeminiStreamTokenStats,
): boolean {
  target.total += source.total;
  target.input += source.input;
  target.output += source.output;
  target.cached += source.cached;
  target.uncached += source.uncached;
  return Object.values(target).every(Number.isSafeInteger);
}

function mapTelemetryUsage(
  telemetrySource: string,
  rawStreamStats: unknown,
): TokenUsageReport | undefined {
  const values = parseJsonObjectSequence(telemetrySource);
  if (!values || !isUsageRecord(rawStreamStats)) return undefined;

  const responses: GeminiApiResponseUsage[] = [];
  const identities = new Map<string, string>();
  let sawApiError = false;
  for (const value of values) {
    if (
      isUsageRecord(value) &&
      isUsageRecord(value.attributes) &&
      value.attributes['event.name'] === GEMINI_API_ERROR_EVENT
    ) {
      // The failed request is causal work, but this event has no token
      // counters. Preserve exact successful-response accounting as partial.
      sawApiError = true;
    }
    const response = readApiResponseUsage(value);
    if (response === undefined) return undefined;
    if (!response) continue;
    const prior = identities.get(response.identity);
    if (prior !== undefined) {
      if (prior !== response.signature) return undefined;
      continue;
    }
    identities.set(response.identity, response.signature);
    responses.push(response);
  }
  if (responses.length === 0) return undefined;

  const records: UsageRecord[] = [];
  const byModel = new Map<string, GeminiStreamTokenStats>();
  const telemetryTotal: GeminiStreamTokenStats = {
    total: 0,
    input: 0,
    output: 0,
    cached: 0,
    uncached: 0,
  };

  for (const response of responses) {
    const tokens = buildTokenUsage(
      {
        // Gemini's UsageMetadata counts tool-result prompts separately from
        // promptTokenCount, but they are still model input. StreamStats keeps
        // the raw prompt counter, so normalize the inclusive public total only
        // after the raw counters have been retained for reconciliation below.
        total: response.input + response.tool,
        uncached: response.input - response.cached + response.tool,
        cacheRead: response.cached,
      },
      {
        total: response.output + response.thoughts,
        visible: response.output,
        reasoning: response.thoughts,
      },
    );
    if (!tokens) return undefined;
    records.push({
      model: response.model,
      // Gemini CLI authentication selects materially different quota and
      // billing families (Developer API, Vertex, Code Assist, or gateway).
      provider: response.authType,
      requests: 1,
      tokens,
    });

    const responseStats: GeminiStreamTokenStats = {
      total: response.total,
      input: response.input,
      output: response.output,
      cached: response.cached,
      uncached: response.input - response.cached,
    };
    if (!addStreamStats(telemetryTotal, responseStats)) return undefined;
    const modelStats = byModel.get(response.model) ?? {
      total: 0,
      input: 0,
      output: 0,
      cached: 0,
      uncached: 0,
    };
    if (!addStreamStats(modelStats, responseStats)) return undefined;
    byModel.set(response.model, modelStats);
  }

  const streamTotal = readStreamTokenStats(rawStreamStats);
  const streamModels = rawStreamStats.models;
  if (
    !streamTotal ||
    !isUsageRecord(streamModels) ||
    !sameStreamStats(streamTotal, telemetryTotal)
  ) {
    return undefined;
  }

  const remainingModels = new Map(byModel);
  for (const [model, value] of Object.entries(streamModels)) {
    const streamModel = readStreamTokenStats(value);
    if (!streamModel) return undefined;
    const telemetryModel = remainingModels.get(model);
    if (!telemetryModel) {
      // StreamStats can retain a routed model whose failed requests consumed
      // no tokens and therefore emitted no successful api_response log.
      if (Object.values(streamModel).some((count) => count !== 0))
        return undefined;
      sawApiError = true;
      continue;
    }
    if (!sameStreamStats(streamModel, telemetryModel)) return undefined;
    remainingModels.delete(model);
  }
  if (remainingModels.size > 0) return undefined;

  const totals = sumTokenUsage(records);
  return totals
    ? buildTokenUsageReport(
        sawApiError ? 'partial' : 'complete',
        totals,
        records,
      )
    : undefined;
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
    asString(top.code) ?? asString(nested.code) ?? asString(nested.type);

  const text =
    asString(top.message) ?? asString(nested.message) ?? 'Gemini CLI error';

  const recoverable =
    top.recoverable === true ||
    top.retryable === true ||
    nested.recoverable === true ||
    nested.retryable === true;

  return {
    ...(code ? { code: ordinaryErrorCode(code, 'GEMINI_STREAM_ERROR') } : {}),
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
    // engine-25: an executable that runs is not necessarily one this release
    // supports, and reporting it available here while the readiness verdict
    // calls it unsupported is exactly the disagreement DR-013 forbids.
    return isCliRuntimeSupported(AGENT_RUNTIME_TARGETS.gemini[0]!);
  } catch {
    return false;
  }
}

/**
 * Gemini CLI `--approval-mode` value. `'yolo'` auto-approves all operations
 * — used as the target for engine-52 `mode: 'auto'` since gemini exposes no
 * distinct "auto with safety" tier (its `auto_edit` only covers edits, not
 * the full automation intent).
 */
export type GeminiApprovalMode = 'default' | 'auto_edit' | 'yolo';

export interface GeminiToolConfig {
  allowedTools: string[];
  disallowedTools: string[];
  args: string[];
  policyRules?: GeminiPolicyRule[];
  approvalMode?: GeminiApprovalMode;
  writablePaths?: WritablePathsPermissionMapping;
  /**
   * gemini-55: `true` when the policy holds only the skills `activate_skill`
   * allow, so the runtime's own policy sources follow it.
   */
  skillsOnlyPolicy?: boolean;
}

export type GeminiPolicyDecision = 'allow' | 'ask_user' | 'deny';

export interface GeminiPolicyRule {
  toolName: string;
  decision: GeminiPolicyDecision;
  priority: number;
  interactive: false;
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
  mcpServers?: McpServers;
  /** gemini-51: the run's prepared skills. */
  skills?: readonly PreparedSkill[];
}

interface GeminiSettingsOverride {
  env: NodeJS.ProcessEnv;
  /**
   * `false` when a selected effort alias cannot reach the CLI, so the run
   * sends the concrete model instead.
   */
  deliversAlias?: boolean;
  deliversMcp?: boolean;
  deliversSkills?: boolean;
  cleanup: () => Promise<void>;
}

interface GeminiSettingsOverrideContext {
  /**
   * The run cwd resolved lexically, against which the caller's own relative
   * paths, such as skill paths, resolve.
   */
  cwd: string;
  /**
   * The working directory the child reports and resolves every relative path
   * it is given against: the real path of the run cwd as given, or the run
   * cwd resolved on Windows (gemini-34).
   */
  childCwd: string;
  /**
   * The environment the child inherits before the overlay and telemetry
   * apply, with gemini-10's default (gemini-34).
   */
  env: GeminiChildEnv;
  /**
   * The environment the runtime loads its settings in: `env` with the
   * variable the runtime sets where it relaunches to load them (gemini-34).
   */
  runtimeEnv: GeminiChildEnv;
  /** Cancels settings setup, including skill materialization. */
  signal?: AbortSignal;
  /** Defaults to the runtime's own admission check (gemini-34). */
  admitsSystemSettingsFile?: GeminiSystemFileAdmission;
}

interface GeminiPolicyOverride {
  args: string[];
  cleanup: () => Promise<void>;
}

export const GEMINI_REASONING_EFFORT_ALIAS = 'cligent-reasoning-effort';

const NOOP_SETTINGS_OVERRIDE: GeminiSettingsOverride = {
  env: {},
  cleanup: async () => {},
};

const NOOP_POLICY_OVERRIDE: GeminiPolicyOverride = {
  args: [],
  cleanup: async () => {},
};

const NOOP_TELEMETRY_CAPTURE: GeminiTelemetryCapture = {
  env: {},
  read: async () => '',
  cleanup: async () => {},
};

async function defaultCreateTelemetryCapture(): Promise<GeminiTelemetryCapture> {
  const dir = await mkdtemp(join(tmpdir(), 'cligent-gemini-telemetry-'));
  const filePath = join(dir, 'telemetry.json');

  return {
    // These controls are deliberately applied after every ambient and
    // settings-derived environment entry. The file belongs to this child,
    // prompts are excluded, and shutdown flushes it before Cligent reads it.
    env: {
      GEMINI_TELEMETRY_ENABLED: 'true',
      GEMINI_TELEMETRY_TARGET: 'local',
      GEMINI_TELEMETRY_OUTFILE: filePath,
      GEMINI_TELEMETRY_LOG_PROMPTS: 'false',
      GEMINI_TELEMETRY_TRACES_ENABLED: 'false',
      GEMINI_TELEMETRY_USE_COLLECTOR: 'false',
    },
    read: async () => readFile(filePath, 'utf8'),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

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

function hasUnpairedUnicodeSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}

function validateGeminiToolNames(
  option: 'allowedTools' | 'disallowedTools',
  values: readonly string[] | undefined,
): void {
  if (!values) return;

  for (const [index, value] of values.entries()) {
    if (value.length === 0) {
      throw new Error(`${option}[${index}] must not be empty`);
    }
    if (value.includes('*')) {
      throw new Error(
        `${option}[${index}] must not contain Gemini Policy Engine wildcard syntax "*"`,
      );
    }
    if (hasUnpairedUnicodeSurrogate(value)) {
      throw new Error(
        `${option}[${index}] must not contain an unpaired Unicode surrogate`,
      );
    }
  }
}

function escapeTomlBasicString(value: string): string {
  let escaped = '';

  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    switch (character) {
      case '"':
        escaped += '\\"';
        break;
      case '\\':
        escaped += '\\\\';
        break;
      case '\b':
        escaped += '\\b';
        break;
      case '\t':
        escaped += '\\t';
        break;
      case '\n':
        escaped += '\\n';
        break;
      case '\f':
        escaped += '\\f';
        break;
      case '\r':
        escaped += '\\r';
        break;
      default:
        if (codePoint <= 0x1f || codePoint === 0x7f) {
          escaped += `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
        } else {
          escaped += character;
        }
    }
  }

  return escaped;
}

export function buildGeminiPolicyToml(
  rules: readonly GeminiPolicyRule[],
): string | undefined {
  if (rules.length === 0) return undefined;

  return `${rules
    .map((rule) =>
      [
        '[[rule]]',
        `toolName = "${escapeTomlBasicString(rule.toolName)}"`,
        `decision = "${rule.decision}"`,
        `priority = ${rule.priority}`,
        'interactive = false',
      ].join('\n'),
    )
    .join('\n\n')}\n`;
}

export function mapEffortToGeminiModelAlias(
  model: string | undefined,
  effort: GeminiEffort | undefined,
): GeminiModelAliasConfig | undefined {
  if (effort === undefined) return undefined;
  assertSupportedEffort(AGENT, effort);
  if (!model) return undefined;

  if (/^gemini-3/.test(model)) {
    return {
      alias: GEMINI_REASONING_EFFORT_ALIAS,
      model,
      thinkingConfig: {
        thinkingLevel: mapEffortToGemini3ThinkingLevel(effort),
      },
    };
  }

  if (/^gemini-2\.5/.test(model)) {
    return {
      alias: GEMINI_REASONING_EFFORT_ALIAS,
      model,
      thinkingConfig: {
        thinkingBudget: mapEffortToGemini25ThinkingBudget(model, effort),
      },
    };
  }

  return undefined;
}

function mapEffortToGemini3ThinkingLevel(
  effort: GeminiEffort,
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

function mapEffortToGemini25ThinkingBudget(
  model: string,
  effort: GeminiEffort,
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

export function buildGeminiSettings(settingsConfig: GeminiSettingsConfig):
  | {
      tools?: { core?: string[]; exclude?: string[] };
      modelConfigs?: {
        customAliases: Record<
          string,
          {
            modelConfig: {
              model: string;
              generateContentConfig: {
                thinkingConfig: GeminiThinkingConfig;
              };
            };
          }
        >;
      };
    }
  | undefined {
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

function buildGeminiModelAliasSettings(alias: GeminiModelAliasConfig): {
  modelConfigs: {
    customAliases: Record<
      string,
      {
        modelConfig: {
          model: string;
          generateContentConfig: {
            thinkingConfig: GeminiThinkingConfig;
          };
        };
      }
    >;
  };
} {
  return {
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
  };
}

/**
 * gemini-34: the context a Gemini child's settings are read in. The child
 * runs in the directory the operating system resolves the run cwd as given
 * to, a relative one from this process's cwd as spawn resolves it, so its
 * `process.cwd()` reports that directory's real path except on Windows.
 * Resolving the run cwd lexically first would drop a `..` that follows a
 * symbolic link, which the operating system applies to the link's target.
 */
async function geminiSettingsOverrideContext(
  cwd: string,
  {
    environmentPlatform = process.platform,
    ...extra
  }: Pick<
    GeminiSettingsOverrideContext,
    'signal' | 'admitsSystemSettingsFile'
  > & {
    environmentPlatform?: NodeJS.Platform;
  } = {},
): Promise<GeminiSettingsOverrideContext> {
  const effective = resolve(cwd);
  let childCwd = effective;
  if (process.platform !== 'win32') {
    try {
      childCwd = await realpath(cwd);
    } catch {
      // No directory to run in; the spawn then fails on its own.
    }
  }
  const inherited = geminiChildEnv(process.env, environmentPlatform);
  // gemini-10: the default only where no case variant is present.
  const env = inherited.has('GEMINI_CLI_TRUST_WORKSPACE')
    ? inherited
    : inherited.with({ GEMINI_CLI_TRUST_WORKSPACE: 'true' });
  // The runtime relaunches itself to load its settings unless either
  // variable is non-empty, marking the relaunched process.
  const runtimeEnv =
    env.get('GEMINI_CLI_NO_RELAUNCH') || env.get('SANDBOX')
      ? env
      : env.with({ GEMINI_CLI_NO_RELAUNCH: 'true' });
  return { cwd: effective, childCwd, env, runtimeEnv, ...extra };
}

/**
 * gemini-56: an environment as a Gemini child receives and reads it, where
 * Windows names variables in any letter case.
 */
interface GeminiChildEnv {
  /** Whether the variable is present, even set to the empty string. */
  has(name: string): boolean;
  /** The variable's value, its name matched in any letter case on Windows. */
  get(name: string): string | undefined;
  /**
   * This environment with each override replacing every variant of its name
   * in letter case on Windows, an `undefined` value removing them.
   */
  with(overrides: NodeJS.ProcessEnv): GeminiChildEnv;
  /** The variables, as the environment a child is spawned with. */
  record(): Record<string, string>;
}

function geminiEnvironment(
  entries: ReadonlyMap<string, string>,
  platform: NodeJS.Platform,
): GeminiChildEnv {
  const fold = (name: string): string =>
    platform === 'win32' ? name.toUpperCase() : name;
  const names = new Map<string, string>();
  for (const name of entries.keys()) names.set(fold(name), name);
  return {
    has: (name) => names.has(fold(name)),
    get: (name) => {
      const stored = names.get(fold(name));
      return stored === undefined ? undefined : entries.get(stored);
    },
    with: (overrides) => {
      const next = new Map(entries);
      for (const [name, value] of Object.entries(overrides)) {
        for (const stored of [...next.keys()]) {
          if (fold(stored) === fold(name)) next.delete(stored);
        }
        if (value !== undefined) next.set(name, value);
      }
      return geminiEnvironment(next, platform);
    },
    record: () => Object.fromEntries(entries),
  };
}

/**
 * gemini-56: the environment Node's spawn gives a child from `env`. A
 * Windows worker thread's `process.env` is a plain, case-sensitive object,
 * so there spawn sorts the names and keeps only the first of each name's
 * variants in letter case, which the child then reads in any letter case.
 */
function geminiChildEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): GeminiChildEnv {
  let names: string[] = [];
  // Spawn copies inherited enumerable names too.
  for (const name in env) names.push(name);
  if (platform === 'win32') {
    const seen = new Set<string>();
    names = names.sort().filter((name) => {
      const folded = name.toUpperCase();
      if (seen.has(folded)) return false;
      seen.add(folded);
      return true;
    });
  }
  const entries = new Map<string, string>();
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) entries.set(name, value);
  }
  return geminiEnvironment(entries, platform);
}

/**
 * gemini-34: the system settings path as the child takes it, verbatim from
 * its override or else the platform's.
 */
function systemSettingsPath(env: GeminiChildEnv): string {
  const configured = env.get('GEMINI_CLI_SYSTEM_SETTINGS_PATH');
  if (configured) return configured;
  if (process.platform === 'darwin') {
    return '/Library/Application Support/GeminiCli/settings.json';
  }
  if (process.platform === 'win32') {
    return 'C:\\ProgramData\\gemini-cli\\settings.json';
  }
  return '/etc/gemini-cli/settings.json';
}

/** gemini-34: the system defaults path, joined beside the settings path. */
function systemDefaultsPath(env: GeminiChildEnv): string {
  return (
    env.get('GEMINI_CLI_SYSTEM_DEFAULTS_PATH') ||
    join(dirname(systemSettingsPath(env)), 'system-defaults.json')
  );
}

/**
 * gemini-34, gemini-55: the file a Gemini child opens at a path it takes
 * verbatim, or undefined where it finds none. On POSIX the child's existence
 * check tests that spelling, a relative one from its working directory,
 * where the operating system applies each `..` to the directory the link
 * before it names and finds nothing at a trailing `/` or `/.`, or a `..`,
 * after a file; so the spelling, joined without lexical normalization, must
 * exist before its real path names the file, since macOS reads a real path
 * even for such a spelling. Windows normalizes `..` lexically.
 */
async function geminiOpenedFile(
  childCwd: string,
  path: string,
): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const resolved = resolve(childCwd, path);
      await stat(resolved);
      return resolved;
    }
    // A leading `//` may name something else, so the root adds no slash.
    const spelled = isAbsolute(path)
      ? path
      : `${childCwd.replace(/\/+$/, '')}/${path}`;
    // `existsSync` checks access to the spelling as given.
    await access(spelled);
    return await realpath(spelled);
  } catch {
    return undefined;
  }
}

/**
 * One path's check in Gemini's system-file admission: a missing entry
 * passes; otherwise the entry must have the expected type, a symbolic link
 * must itself be root-owned, and its target must be root-owned and writable
 * by neither group nor others.
 */
async function geminiSystemPathSecure(
  path: string,
  expected: 'file' | 'directory',
): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await stat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if (expected === 'directory' ? !stats.isDirectory() : !stats.isFile()) {
    return false;
  }
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink() && link.uid !== 0) return false;
  } catch {
    // The runtime ignores an lstat failure once stat has succeeded.
  }
  return stats.uid === 0 && (stats.mode & 0o022) === 0;
}

/** A directory and each directory above it, up to the filesystem root. */
function directoryAndAncestors(directory: string): string[] {
  const directories: string[] = [];
  let current = directory;
  for (;;) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

/**
 * gemini-34: Gemini CLI 0.61.0's POSIX admission of a system settings or
 * system defaults file. An absent file is admitted, since nothing loads.
 * Otherwise the file and every directory above it must pass, along both its
 * given and its real path; the runtime's separate root-ownership check of
 * each symbolic-link directory on the given path repeats the per-directory
 * check, so it decides nothing more.
 */
const posixSystemFileAdmission: GeminiSystemFileAdmission = async (path) => {
  const given = resolve(path);
  try {
    await stat(given);
  } catch {
    return 'admitted';
  }
  let real = given;
  try {
    const resolved = await realpath(given);
    if (resolved.length > 0) real = resolve(resolved);
  } catch {
    // The runtime keeps the given path where its real path cannot be read.
  }
  const checks: [string, 'file' | 'directory'][] = [
    ...directoryAndAncestors(dirname(given)).map(
      (directory) => [directory, 'directory'] as [string, 'directory'],
    ),
    [given, 'file'],
  ];
  if (real !== given) {
    checks.push(
      [real, 'file'],
      ...directoryAndAncestors(dirname(real)).map(
        (directory) => [directory, 'directory'] as [string, 'directory'],
      ),
    );
  }
  for (const [checked, expected] of checks) {
    if (!(await geminiSystemPathSecure(checked, expected))) return 'rejected';
  }
  return 'admitted';
};

/**
 * gemini-34: on Windows the runtime admits an existing file only where a
 * PowerShell script it runs finds the file and every directory above it
 * below the drive root owned by, and writable only by, administrator,
 * system, service, or creator identities; this adapter does not run that
 * script, so the admission of the existing file it is asked about is
 * unknown.
 */
const windowsSystemFileAdmission: GeminiSystemFileAdmission = async () =>
  'unknown';

function geminiSystemFileAdmission(
  platform: NodeJS.Platform,
): GeminiSystemFileAdmission {
  return platform === 'win32'
    ? windowsSystemFileAdmission
    : posixSystemFileAdmission;
}

const defaultAdmitsSystemSettingsFile = geminiSystemFileAdmission(
  process.platform,
);

function jsonObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function stripJsonComments(content: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    const next = content[index + 1];

    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false;
        result += character;
      } else {
        result += ' ';
      }
      continue;
    }

    if (blockComment) {
      if (character === '*' && next === '/') {
        result += '  ';
        index += 1;
        blockComment = false;
      } else {
        result += character === '\n' || character === '\r' ? character : ' ';
      }
      continue;
    }

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === '/' && next === '/') {
      result += '  ';
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === '/' && next === '*') {
      result += '  ';
      index += 1;
      blockComment = true;
      continue;
    }

    result += character;
  }

  return result;
}

/**
 * Reads one Gemini settings file, which may carry JSON comments. An absent
 * file reads as `{}`; any other failure rejects naming the file.
 */
async function readGeminiSettingsFile(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  let content: string;

  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(content)) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse Gemini ${label} at ${path}: ${detail}`);
  }

  return jsonObject(parsed, `Gemini ${label} at ${path}`);
}

/** A settings layer whose unreadable or malformed file counts as empty. */
function readOptionalGeminiSettings(
  path: string,
): Promise<Record<string, unknown>> {
  return readGeminiSettingsFile(path, 'settings').catch(() => ({}));
}

/** gemini-34: a settings file a decision reads. */
interface GeminiSettingsLayer {
  /** Names the file in a rejection (gemini-51). */
  label: string;
  /**
   * The path naming the file, at which the runtime checks a system file's
   * admission, resolved lexically.
   */
  path: string;
  /**
   * The file's settings expanded, before the runtime's validation coerces
   * any string; empty where the child opens no file or the runtime skips it.
   */
  expanded: Record<string, unknown>;
  /** Whether the runtime's admission of the file is unknown here. */
  unknown: boolean;
}

/** The settings layers, in the order the runtime merges them. */
const GEMINI_LAYER_ORDER = [
  'systemDefaults',
  'user',
  'workspace',
  'system',
] as const;
type GeminiLayerName = (typeof GEMINI_LAYER_ORDER)[number];
type GeminiSettingsLayers = Record<GeminiLayerName, GeminiSettingsLayer>;
/** One reading of each layer, which a decision draws on. */
type GeminiLayerSettings = Record<GeminiLayerName, Record<string, unknown>>;

/**
 * gemini-34: the system settings and system defaults a Gemini child would
 * load, each expanded, empty where the child finds no file or the runtime
 * would skip it, and read where its admission is unknown, for each consumer
 * to settle. As the runtime does, the file's existence is checked where the
 * child opens it, but its admission at the path resolved lexically, which
 * also names it.
 */
async function readGeminiSystemLayers(
  context: GeminiSettingsOverrideContext,
): Promise<Pick<GeminiSettingsLayers, 'system' | 'systemDefaults'>> {
  const admits =
    context.admitsSystemSettingsFile ?? defaultAdmitsSystemSettingsFile;
  const read = async (
    given: string,
    label: string,
  ): Promise<GeminiSettingsLayer> => {
    const path = resolve(context.childCwd, given);
    const opened = await geminiOpenedFile(context.childCwd, given);
    if (opened === undefined) {
      return { label, path, expanded: {}, unknown: false };
    }
    const admission = await admits(path);
    return {
      label,
      path,
      expanded:
        admission === 'rejected'
          ? {}
          : expandGeminiSettings(
              await readOptionalGeminiSettings(opened),
              context.runtimeEnv,
            ),
      unknown: admission === 'unknown',
    };
  };
  return {
    system: await read(systemSettingsPath(context.env), 'system settings'),
    systemDefaults: await read(
      systemDefaultsPath(context.env),
      'system defaults',
    ),
  };
}

/**
 * gemini-34: every settings layer a decision reads, each expanded: the
 * system layers, the given user settings, and the workspace settings the
 * child reads from its own working directory.
 */
async function readGeminiSettingsLayers(
  context: GeminiSettingsOverrideContext,
  userSettings: Record<string, unknown>,
): Promise<GeminiSettingsLayers> {
  const workspacePath = geminiWorkspaceSettingsPath(context);
  return {
    ...(await readGeminiSystemLayers(context)),
    user: {
      label: 'user settings',
      path: join(geminiRealHome(context), '.gemini', 'settings.json'),
      expanded: expandGeminiSettings(userSettings, context.runtimeEnv),
      unknown: false,
    },
    workspace: {
      label: 'workspace settings',
      path: workspacePath,
      expanded: expandGeminiSettings(
        await readOptionalGeminiSettings(workspacePath),
        context.runtimeEnv,
      ),
      unknown: false,
    },
  };
}

/**
 * gemini-34: the boolean-typed settings decisions read, which the runtime's
 * schema validation makes booleans from `true` or `false` in any letter
 * case, but only where the whole file validates; `tools.sandbox` comes
 * before an object `tools.sandbox`'s `enabled`, a boolean being its first
 * form.
 */
const GEMINI_COERCED_SETTINGS = [
  'security.folderTrust.enabled',
  'skills.enabled',
  'advanced.ignoreLocalEnv',
  'tools.sandbox',
  'tools.sandbox.enabled',
] as const;
type GeminiCoercedSetting = (typeof GEMINI_COERCED_SETTINGS)[number];

/** A setting's value, reached through plain objects only. */
function geminiSettingAt(
  settings: Record<string, unknown>,
  setting: string,
): unknown {
  let value: unknown = settings;
  for (const key of setting.split('.')) {
    if (!isGeminiPlainObject(value)) return undefined;
    value = value[key];
  }
  return value;
}

/** A copy of `settings` with the value at `path` replaced. */
function withGeminiSettingAt(
  settings: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [key, ...rest] = path;
  return {
    ...settings,
    [key!]:
      rest.length === 0
        ? value
        : withGeminiSettingAt(
            settings[key!] as Record<string, unknown>,
            rest,
            value,
          ),
  };
}

/** The boolean the runtime's validation makes of a value, if any. */
function coercedGeminiBoolean(value: unknown): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  return lower === 'true' ? true : lower === 'false' ? false : undefined;
}

/**
 * gemini-34: a layer as the runtime reads a file its validation accepts,
 * each coerced setting's `true` or `false` string made a boolean.
 */
function coerceGeminiSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  let coerced = settings;
  for (const setting of GEMINI_COERCED_SETTINGS) {
    const value = coercedGeminiBoolean(geminiSettingAt(coerced, setting));
    if (value !== undefined) {
      coerced = withGeminiSettingAt(coerced, setting.split('.'), value);
    }
  }
  return coerced;
}

/**
 * gemini-34: the settings among `reads` whose readings as written and
 * coerced differ in effect, so that how a decision reads them depends on
 * whether the runtime's validation accepts the whole file. Every reader
 * takes these settings by truthiness, where only a `false` string differs
 * from `false`, except that a top-level `tools.sandbox` string requests a
 * sandbox unless it is exactly empty, `0`, or `false`.
 */
function geminiCoercionDependent(
  settings: Record<string, unknown>,
  reads: readonly GeminiCoercedSetting[],
): GeminiCoercedSetting[] {
  return reads.filter((setting) => {
    const value = geminiSettingAt(settings, setting);
    if (coercedGeminiBoolean(value) !== false) return false;
    return setting !== 'tools.sandbox' || value !== 'false';
  });
}

interface GeminiLayerReading {
  kind: 'skipped' | 'as written' | 'coerced';
  settings: Record<string, unknown>;
}

/**
 * gemini-34, gemini-51: the readings of a layer for a decision reading
 * `reads`: as written and coerced where those differ for one of them, or
 * else coerced, and also skipped where `skip` is set and the runtime's
 * admission of the file is unknown.
 */
function geminiLayerReadings(
  layer: GeminiSettingsLayer,
  reads: readonly GeminiCoercedSetting[],
  skip: boolean,
): GeminiLayerReading[] {
  const coerced: GeminiLayerReading = {
    kind: 'coerced',
    settings: coerceGeminiSettings(layer.expanded),
  };
  const counted: GeminiLayerReading[] =
    geminiCoercionDependent(layer.expanded, reads).length > 0
      ? [{ kind: 'as written', settings: layer.expanded }, coerced]
      : [coerced];
  return skip && layer.unknown
    ? [{ kind: 'skipped', settings: {} }, ...counted]
    : counted;
}

/** A decision drawn under every combination of the layers' readings. */
async function geminiLayerOutcomes<T>(
  layers: GeminiSettingsLayers,
  reads: readonly GeminiCoercedSetting[],
  skip: boolean,
  decide: (settings: GeminiLayerSettings) => Promise<T>,
): Promise<{
  readings: GeminiLayerReading[][];
  combinations: number[][];
  outcomes: T[];
}> {
  const readings = GEMINI_LAYER_ORDER.map((name) =>
    geminiLayerReadings(layers[name], reads, skip),
  );
  let combinations: number[][] = [[]];
  for (const options of readings) {
    combinations = combinations.flatMap((combination) =>
      options.map((_reading, index) => [...combination, index]),
    );
  }
  const outcomes: T[] = [];
  for (const combination of combinations) {
    outcomes.push(
      await decide(
        Object.fromEntries(
          GEMINI_LAYER_ORDER.map((name, layer) => [
            name,
            readings[layer]![combination[layer]!]!.settings,
          ]),
        ) as GeminiLayerSettings,
      ),
    );
  }
  return { readings, combinations, outcomes };
}

/**
 * gemini-51: a decision for a run with skills, drawn under every reading of
 * the layers and returned only where all agree; otherwise it rejects,
 * naming once, in merge order, each file whose change of reading, under
 * some reading of the others, changes the decision.
 */
async function settleGeminiLayers<T>(
  layers: GeminiSettingsLayers,
  reads: readonly GeminiCoercedSetting[],
  decision: string,
  decide: (settings: GeminiLayerSettings) => Promise<T>,
  same: (left: T, right: T) => boolean,
): Promise<T> {
  const { readings, combinations, outcomes } = await geminiLayerOutcomes(
    layers,
    reads,
    true,
    decide,
  );
  const first = outcomes[0]!;
  if (outcomes.every((outcome) => same(outcome, first))) return first;

  const named: string[] = [];
  let admissions = 0;
  const coerced: GeminiCoercedSetting[] = [];
  // Each reason in the order its first file is named.
  const reasonKinds: ('admission' | 'coercion')[] = [];
  GEMINI_LAYER_ORDER.forEach((name, layer) => {
    const changes = new Set<'admission' | 'coercion'>();
    combinations.forEach((left, l) => {
      combinations.forEach((right, r) => {
        if (
          r <= l ||
          !left.every(
            (reading, other) => other === layer || reading === right[other],
          ) ||
          same(outcomes[l]!, outcomes[r]!)
        ) {
          return;
        }
        const kinds = [left[layer]!, right[layer]!].map(
          (reading) => readings[layer]![reading]!.kind,
        );
        changes.add(kinds.includes('skipped') ? 'admission' : 'coercion');
      });
    });
    if (changes.size === 0) return;
    const file = `the Gemini ${layers[name].label} at ${layers[name].path}`;
    const settings = changes.has('coercion')
      ? geminiCoercionDependent(layers[name].expanded, reads)
      : [];
    for (const kind of ['admission', 'coercion'] as const) {
      if (changes.has(kind) && !reasonKinds.includes(kind)) {
        reasonKinds.push(kind);
      }
    }
    if (changes.has('admission')) admissions += 1;
    coerced.push(...settings);
    named.push(
      !changes.has('admission')
        ? `the runtime's coercion of ${settings.join(' and ')} in ${file}`
        : settings.length === 0
          ? `the runtime's admission of ${file}`
          : `the runtime's admission of ${file} and its coercion of ${settings.join(' and ')} there`,
    );
  });

  const reasons = reasonKinds.map((kind) =>
    kind === 'admission'
      ? `this adapter does not run the runtime's PowerShell check of ${admissions > 1 ? "those files'" : "that file's"} ownership and write access`
      : `the runtime coerces ${coerced.length > 1 ? 'those strings' : 'that string'} only where the whole file validates, which this adapter does not check`,
  );
  throw new Error(
    `skills for adapter "${AGENT}" cannot be delivered while ${named.join(' and ')} would change ${decision}, because ${reasons.join(', and ')}`,
  );
}

function mergeGeminiModelAlias(
  settings: Record<string, unknown>,
  alias: GeminiModelAliasConfig,
  path: string,
): Record<string, unknown> {
  const existingModelConfigs =
    settings.modelConfigs === undefined
      ? {}
      : jsonObject(
          settings.modelConfigs,
          `Gemini user settings modelConfigs at ${path}`,
        );
  const existingAliases =
    existingModelConfigs.customAliases === undefined
      ? {}
      : jsonObject(
          existingModelConfigs.customAliases,
          `Gemini user settings modelConfigs.customAliases at ${path}`,
        );
  const generatedAlias =
    buildGeminiModelAliasSettings(alias).modelConfigs.customAliases[
      alias.alias
    ]!;

  return {
    ...settings,
    modelConfigs: {
      ...existingModelConfigs,
      customAliases: {
        ...existingAliases,
        [alias.alias]: generatedAlias,
      },
    },
  };
}

/**
 * The home a Gemini child resolves before any Cligent overlay applies. The
 * child takes `GEMINI_CLI_HOME` verbatim but joins path segments to it,
 * which drops each `..` lexically, so it resolves lexically here.
 */
function geminiRealHome(context: GeminiSettingsOverrideContext): string {
  const configured = context.env.get('GEMINI_CLI_HOME');
  return configured ? resolve(context.childCwd, configured) : homedir();
}

async function comparablePath(path: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    resolved = resolve(path);
  }
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}

/**
 * gemini-34: whether the child's working directory is the real home, where
 * Gemini reads no workspace settings.
 */
async function geminiWorkspaceIsHome(
  context: GeminiSettingsOverrideContext,
  realHome: string,
): Promise<boolean> {
  return (
    (await comparablePath(context.childCwd)) ===
    (await comparablePath(realHome))
  );
}

/** The workspace settings file a Gemini child reads from its own cwd. */
function geminiWorkspaceSettingsPath(
  context: GeminiSettingsOverrideContext,
): string {
  return join(context.childCwd, '.gemini', 'settings.json');
}

function isGeminiPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The settings the runtime merges by its union strategy (gemini-34). */
const GEMINI_UNION_SETTINGS = new Set([
  JSON.stringify(['policyPaths']),
  JSON.stringify(['advanced', 'excludedEnvVars']),
]);

/**
 * gemini-34: Gemini's `customDeepMerge` of settings layers over the schema's
 * empty `policyPaths` and its `advanced.excludedEnvVars` of `DEBUG` and
 * `DEBUG_MODE`, later layers winning: a plain object merges into a plain
 * object key by key, any other value, arrays included, replaces, and
 * prototype keys are skipped, except that either of those settings merging
 * into a list takes the union strategy, appending a list or a lone value,
 * each value once. No other schema default or merge strategy changes a
 * decision this adapter draws.
 */
function mergeGeminiSettings(
  ...layers: Record<string, unknown>[]
): Record<string, unknown> {
  const mergeInto = (
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    path: readonly string[],
  ): void => {
    for (const [key, value] of Object.entries(source)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype')
        continue;
      if (value === undefined) continue;
      const setting = [...path, key];
      const existing = target[key];
      if (
        Array.isArray(existing) &&
        GEMINI_UNION_SETTINGS.has(JSON.stringify(setting))
      ) {
        const appended = Array.isArray(value) ? value : [value];
        target[key] = [...new Set([...existing, ...appended])];
      } else if (isGeminiPlainObject(value)) {
        const merged = isGeminiPlainObject(existing) ? existing : {};
        mergeInto(merged, value, setting);
        target[key] = merged;
      } else {
        target[key] = value;
      }
    }
  };
  const merged: Record<string, unknown> = {
    policyPaths: [],
    advanced: { excludedEnvVars: ['DEBUG', 'DEBUG_MODE'] },
  };
  for (const layer of layers) mergeInto(merged, layer, []);
  return merged;
}

/**
 * gemini-34: whether a merged `tools.sandbox` turns Gemini's sandbox on, as
 * `loadSandboxConfig` and `getSandboxCommand` read it: a plain object counts
 * as its `command`, `true` where that is unset or null, where its `enabled`
 * is truthy and as `false` otherwise, and an array as nothing; then `true` or
 * a string other than empty, `0`, or `false` requests a sandbox, and any
 * other truthy value finds one only on macOS, whose `sandbox-exec` is always
 * present.
 */
function sandboxSettingEnables(value: unknown): boolean {
  if (Array.isArray(value)) return false;
  const configured = isGeminiPlainObject(value)
    ? value.enabled
      ? (value.command ?? true)
      : false
    : value;
  if (configured === '0' || configured === 'false' || !configured) {
    return false;
  }
  if (configured === true || typeof configured === 'string') return true;
  return process.platform === 'darwin';
}

/**
 * gemini-34: dotenv 17.1.0's `parse`, which Gemini CLI 0.61.0 pins: each
 * line's optionally `export`-prefixed name and value, the value trimmed and
 * unquoted, with `\n` and `\r` escapes expanded in a double-quoted one.
 */
function parseGeminiDotEnv(source: string): Record<string, string> {
  const line =
    /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
  const parsed: Record<string, string> = {};
  const lines = source.replace(/\r\n?/gm, '\n');
  let match: RegExpExecArray | null;
  while ((match = line.exec(lines)) !== null) {
    const key = match[1]!;
    let value = (match[2] || '').trim();
    const maybeQuote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
    if (maybeQuote === '"') {
      value = value.replace(/\\n/g, '\n');
      value = value.replace(/\\r/g, '\r');
    }
    parsed[key] = value;
  }
  return parsed;
}

/**
 * gemini-34: the one `.env` file the runtime loads after its settings: from
 * the child's working directory upward, in each directory the `.gemini/.env`
 * where the workspace is trusted and then the `.env` unless local files are
 * ignored and the directory is not the home as the child spells it, and
 * past the root the home's `.gemini/.env` where trusted and then its `.env`.
 * A path is returned as the child spells it; a relative home's files resolve
 * against the child's working directory. Each file exists as the runtime's
 * `existsSync` finds it, which on Windows also reads the status of the
 * file a symbolic link names, so a dangling link does not exist there.
 */
async function findGeminiEnvFile(
  childCwd: string,
  home: string,
  trusted: boolean,
  ignoreLocalEnv: boolean,
): Promise<string | undefined> {
  const exists = (path: string): Promise<boolean> => {
    const resolved = resolve(childCwd, path);
    const found: Promise<unknown> =
      process.platform === 'win32' ? stat(resolved) : access(resolved);
    return found.then(
      () => true,
      () => false,
    );
  };
  let current = resolve(childCwd);
  for (;;) {
    if (trusted) {
      const geminiEnv = join(current, '.gemini', '.env');
      if (await exists(geminiEnv)) return geminiEnv;
    }
    const env = join(current, '.env');
    if ((await exists(env)) && (!ignoreLocalEnv || current === home)) {
      return env;
    }
    const parent = dirname(current);
    if (parent === current || !parent) {
      if (trusted) {
        const homeGeminiEnv = join(home, '.gemini', '.env');
        if (await exists(homeGeminiEnv)) return homeGeminiEnv;
      }
      const homeEnv = join(home, '.env');
      return (await exists(homeEnv)) ? homeEnv : undefined;
    }
    current = parent;
  }
}

/** The variables the runtime loads from an untrusted workspace's `.env`. */
const GEMINI_UNTRUSTED_ENV_NAMES = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
];

/** The runtime's exclusions where the merged settings name none. */
const GEMINI_DEFAULT_EXCLUDED_ENV_NAMES = [
  'DEBUG',
  'DEBUG_MODE',
  'GEMINI_CLI_IDE_SERVER_STDIO_COMMAND',
  'GEMINI_CLI_IDE_SERVER_STDIO_ARGS',
];

/**
 * gemini-34: the environment a Gemini child decides its sandbox in: the
 * environment it loads its settings in plus each variable of the `.env`
 * file it then loads that the environment lacks, in any letter case on
 * Windows. Where the workspace is untrusted only the authentication names
 * load, sanitized; a project file, one whose path lacks `.gemini`, skips
 * the merged `advanced.excludedEnvVars`. The child sees the overlay as its
 * home, whose `.env` files link to the real ones; the home here is the one
 * the child would have without it. The Cloud Shell setup, which sets only
 * `GOOGLE_CLOUD_PROJECT`, and the `-s`, `--sandbox`, and `--ignore-env`
 * flags, which this adapter never passes, are left out.
 */
async function geminiSandboxEnvironment(
  context: GeminiSettingsOverrideContext,
  merged: Record<string, unknown>,
  trusted: boolean,
): Promise<GeminiChildEnv> {
  let env = context.runtimeEnv;
  const advanced = asRecord(merged.advanced);
  const found = await findGeminiEnvFile(
    context.childCwd,
    env.get('GEMINI_CLI_HOME') || homedir(),
    trusted,
    Boolean(advanced.ignoreLocalEnv),
  );
  if (found === undefined) return env;
  let parsed: Record<string, string>;
  try {
    parsed = parseGeminiDotEnv(
      await readFile(resolve(context.childCwd, found), 'utf8'),
    );
  } catch {
    return env;
  }
  const excluded = (advanced.excludedEnvVars ||
    GEMINI_DEFAULT_EXCLUDED_ENV_NAMES) as { includes(name: string): boolean };
  const project = !found.includes('.gemini');
  try {
    for (const name in parsed) {
      if (!Object.hasOwn(parsed, name)) continue;
      let value = parsed[name]!;
      if (!trusted) {
        if (!GEMINI_UNTRUSTED_ENV_NAMES.includes(name)) continue;
        value = value.replace(/[^a-zA-Z0-9\-_./]/g, '');
      }
      if (project && excluded.includes(name)) continue;
      if (!env.has(name)) env = env.with({ [name]: value });
    }
  } catch {
    // The runtime stops loading where an exclusion setting that is not a
    // list or a string throws.
  }
  return env;
}

/**
 * Whether the Gemini child would start its own sandbox, which confines writes
 * to paths under the home it is given and so cannot follow the overlay's
 * links. The environment the child decides its sandbox in decides when set;
 * otherwise the settings layers do, merged as the runtime merges them, the
 * workspace layer only where the child trusts the workspace. A run with
 * skills settles every reading of the layers (`settle`, gemini-51); any
 * other run counts a system layer of unknown admission and takes the
 * sandbox as requested where any reading requests it (gemini-34).
 */
async function geminiSandboxRequested(
  context: GeminiSettingsOverrideContext,
  userSettings: Record<string, unknown>,
  settle: boolean,
): Promise<boolean> {
  // A child already in a sandbox starts none, whatever its `.env` holds.
  if (context.runtimeEnv.get('SANDBOX')) return false;

  const trusted = geminiTrustCheck(context, geminiRealHome(context));
  const layers = await readGeminiSettingsLayers(context, userSettings);
  const reads: GeminiCoercedSetting[] = [
    'security.folderTrust.enabled',
    'advanced.ignoreLocalEnv',
    'tools.sandbox',
    'tools.sandbox.enabled',
  ];
  const decide = async ({
    systemDefaults,
    user,
    workspace,
    system,
  }: GeminiLayerSettings): Promise<boolean> => {
    // gemini-55: the runtime merges the workspace layer only where it
    // trusts the workspace, which the other layers help decide.
    const merged = mergeGeminiSettings(
      systemDefaults,
      user,
      (await trusted(mergeGeminiSettings(systemDefaults, user, system)))
        ? workspace
        : {},
      system,
    );
    // The runtime loads its `.env` trusting the workspace as these merged
    // settings decide.
    const env = await geminiSandboxEnvironment(
      context,
      merged,
      await trusted(merged),
    );
    if (env.get('SANDBOX')) return false;
    const fromEnv = env.get('GEMINI_SANDBOX')?.toLowerCase().trim();
    if (fromEnv) return fromEnv !== '0' && fromEnv !== 'false';
    return sandboxSettingEnables(asRecord(merged.tools).sandbox);
  };
  if (settle) {
    return settleGeminiLayers(
      layers,
      reads,
      'whether its native sandbox starts',
      decide,
      (left, right) => left === right,
    );
  }
  return (
    await geminiLayerOutcomes(layers, reads, false, decide)
  ).outcomes.some(Boolean);
}

/** Gemini's `$VAR`, `${VAR}`, and `${VAR:-default}` expansion of settings strings. */
function expandGeminiSettingsString(
  value: string,
  env: GeminiChildEnv,
): string {
  return value.replace(
    /\$(?:(\w+)|{([^}]+?)(?::-([^}]*))?})/g,
    (
      match: string,
      bare: string | undefined,
      braced: string | undefined,
      fallback: string | undefined,
    ) => {
      const name = bare || braced || '';
      if (!name) return match;
      const found = env.get(name);
      if (typeof found === 'string') return found;
      return fallback ?? match;
    },
  );
}

/** Gemini's `resolveEnvVarsInObject`: every string at any depth expanded. */
function expandGeminiSettingsValue(
  value: unknown,
  env: GeminiChildEnv,
): unknown {
  if (typeof value === 'string') return expandGeminiSettingsString(value, env);
  if (Array.isArray(value)) {
    return value.map((entry) => expandGeminiSettingsValue(entry, env));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        expandGeminiSettingsValue(entry, env),
      ]),
    );
  }
  return value;
}

/**
 * gemini-34: a settings layer expanded as the runtime loads it, against the
 * environment it loads its settings in. The runtime expands a variable set
 * only for the child, such as `GEMINI_CLI_HOME` naming the overlay or the
 * `NODE_OPTIONS` of its relaunch, to the child's value.
 */
function expandGeminiSettings(
  layer: Record<string, unknown>,
  env: GeminiChildEnv,
): Record<string, unknown> {
  return expandGeminiSettingsValue(layer, env) as Record<string, unknown>;
}

/**
 * gemini-55: Gemini's `normalizePath`, which resolves a path against the
 * child's working directory, turns every backslash into a forward slash, and
 * lowercases the result on macOS and Windows.
 */
function geminiNormalizedPath(path: string, childCwd: string): string {
  const absolute = resolve(childCwd, path).replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? absolute.toLowerCase()
    : absolute;
}

/** Merged settings' `security.folderTrust.enabled`, as the runtime reads it. */
function folderTrustSetting(layer: Record<string, unknown>): unknown {
  return asRecord(asRecord(layer.security).folderTrust).enabled;
}

/**
 * gemini-55: the runtime's own real-path reading of a trust path, which
 * resolves the symbolic links of an existing path and otherwise keeps its
 * spelling, where the C library's realpath also corrects case and Unicode
 * normalization on macOS.
 */
function geminiRuntimeRealPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

const GEMINI_REALPATH_FALLBACK_CODES = new Set([
  'ENOENT',
  'EISDIR',
  'ENAMETOOLONG',
  'ENOTDIR',
]);

/**
 * gemini-55: Gemini's Windows `robustRealpath`: the native real path, which
 * expands 8.3 short names, without an extended-length prefix; for a path
 * that does not resolve, a symbolic link's target taken the same way, or
 * else its parent's real path joined to its name.
 */
function geminiRobustRealpath(path: string, visited: Set<string>): string {
  const key = path.toLowerCase();
  if (visited.has(key)) {
    throw new Error(`Infinite recursion detected in robustRealpath: ${path}`);
  }
  visited.add(key);
  try {
    const resolved = realpathSync.native(path);
    const upper = resolved.toUpperCase();
    if (upper.startsWith('\\\\?\\UNC\\')) return `\\\\${resolved.slice(8)}`;
    if (upper.startsWith('\\\\?\\')) return resolved.slice(4);
    return resolved;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined || !GEMINI_REALPATH_FALLBACK_CODES.has(code)) {
      throw error;
    }
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return geminiRobustRealpath(
          resolve(dirname(path), readlinkSync(path)),
          visited,
        );
      }
    } catch (lstatError) {
      const lstatCode = (lstatError as NodeJS.ErrnoException).code;
      if (
        lstatCode === undefined ||
        !GEMINI_REALPATH_FALLBACK_CODES.has(lstatCode)
      ) {
        throw lstatError;
      }
    }
    const parent = dirname(path);
    if (parent === path) return path;
    return join(geminiRobustRealpath(parent, visited), basename(path));
  }
}

/**
 * gemini-55: Gemini's `resolveToRealPath` of a resolved path, which never
 * starts with `file://`: decoded as a URI component where it decodes, then
 * taken through `robustRealpath`, with any extended-length prefix stripped.
 */
function geminiResolveToRealPath(path: string): string {
  if (path.includes('\0')) throw new Error(`Invalid path: ${path}`);
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // The runtime keeps a path that does not decode.
  }
  const real = geminiRobustRealpath(resolve(decoded), new Set());
  if (
    /^\\\\[?][\\/](?:UNC|unc)[\\/]/.test(real) ||
    /^\/\/[?][\\/](?:UNC|unc)[\\/]/.test(real)
  ) {
    return `\\\\${real.slice(8)}`;
  }
  if (/^\\\\[?][\\/]/.test(real) || /^\/\/[?][\\/]/.test(real)) {
    return real.slice(4);
  }
  return real;
}

/**
 * gemini-55: Gemini's `isSubpath` of two normalized paths, which on Windows
 * first takes both through `resolveToRealPath` where either holds `~`, as an
 * 8.3 short name does, keeping what resolved before any failure.
 */
function isGeminiSubpath(parent: string, child: string): boolean {
  let p = resolve(parent);
  let c = resolve(child);
  if (process.platform === 'win32' && (p.includes('~') || c.includes('~'))) {
    try {
      p = geminiResolveToRealPath(p);
      c = geminiResolveToRealPath(c);
    } catch {
      // The runtime ignores a resolution failure.
    }
  }
  const rel = relative(p, c);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * gemini-55: the directory a Gemini child keeps its runtime state in, moved
 * under `.cache` inside a macOS Seatbelt sandbox.
 */
function geminiRuntimeDir(realHome: string, env: GeminiChildEnv): string {
  return env.get('SANDBOX') === 'sandbox-exec'
    ? join(realHome, '.cache', '.gemini')
    : join(realHome, '.gemini');
}

/**
 * gemini-55: whether a Gemini child would trust the workspace, as its
 * environment, folder-trust setting, and trusted-folders file decide, and so
 * merge the workspace settings.
 */
async function geminiWorkspaceTrusted(
  context: GeminiSettingsOverrideContext,
  realHome: string,
  folderTrust: boolean,
): Promise<boolean> {
  const env = context.runtimeEnv;
  if (
    env.get('GEMINI_RESTRICTED_MODE') === 'true' ||
    env.get('GEMINI_CLI_TRUST_WORKSPACE') === 'false'
  ) {
    return false;
  }
  if (env.get('GEMINI_CLI_TRUST_WORKSPACE') === 'true') return true;
  if (!folderTrust) return true;

  const { childCwd } = context;
  let rules: Record<string, unknown>;
  try {
    const configured = env.get('GEMINI_CLI_TRUSTED_FOLDERS_PATH');
    // The child opens the override verbatim, finding no rules where no file
    // is there.
    const path = configured
      ? await geminiOpenedFile(childCwd, configured)
      : join(geminiRuntimeDir(realHome, env), 'trustedFolders.json');
    rules =
      path === undefined
        ? {}
        : await readGeminiSettingsFile(path, 'trusted folders');
  } catch {
    // Gemini refuses to start on an unreadable trusted-folders file.
    return false;
  }
  // Gemini keys its rules by normalized path, so a later key normalizing to
  // an earlier one replaces that rule's level.
  const levels = new Map<string, unknown>();
  for (const [key, trustLevel] of Object.entries(rules)) {
    if (
      trustLevel !== 'TRUST_FOLDER' &&
      trustLevel !== 'TRUST_PARENT' &&
      trustLevel !== 'DO_NOT_TRUST'
    ) {
      return false;
    }
    levels.set(geminiNormalizedPath(key, childCwd), trustLevel);
  }
  const location = geminiNormalizedPath(
    geminiRuntimeRealPath(childCwd),
    childCwd,
  );
  let longest = -1;
  let level: unknown;
  for (const [rulePath, trustLevel] of levels) {
    const effective =
      trustLevel === 'TRUST_PARENT' ? dirname(rulePath) : rulePath;
    const comparable = geminiNormalizedPath(
      geminiRuntimeRealPath(effective),
      childCwd,
    );
    if (isGeminiSubpath(comparable, location) && rulePath.length > longest) {
      longest = rulePath.length;
      level = trustLevel;
    }
  }
  return level === 'TRUST_FOLDER' || level === 'TRUST_PARENT';
}

/**
 * gemini-55: workspace trust under merged settings' folder-trust setting,
 * which the runtime reads as on where unset or null, each answer read once.
 */
function geminiTrustCheck(
  context: GeminiSettingsOverrideContext,
  realHome: string,
): (merged: Record<string, unknown>) => Promise<boolean> {
  const answers = new Map<boolean, Promise<boolean>>();
  return (merged) => {
    const folderTrust = Boolean(folderTrustSetting(merged) ?? true);
    let answer = answers.get(folderTrust);
    if (answer === undefined) {
      answer = geminiWorkspaceTrusted(context, realHome, folderTrust);
      answers.set(folderTrust, answer);
    }
    return answer;
  };
}

/**
 * gemini-55: the user-tier policy sources a Gemini child loads when no
 * `--policy` is given, which a `--policy` value replaces: the `policyPaths`
 * it merges by union across system defaults, user, trusted workspace, and
 * system settings, each layer evaluated and each system layer counted as
 * gemini-34 reads it, settled as gemini-51 requires, and resolved as it
 * resolves them, or else the real home's policy directory where it exists.
 */
async function geminiRuntimePolicySources(
  context: GeminiSettingsOverrideContext,
): Promise<string[]> {
  const realHome = geminiRealHome(context);
  const trusted = geminiTrustCheck(context, realHome);
  const layers = await readGeminiSettingsLayers(
    context,
    await readOptionalGeminiSettings(
      join(realHome, '.gemini', 'settings.json'),
    ),
  );
  return settleGeminiLayers(
    layers,
    ['security.folderTrust.enabled'],
    'its policy sources',
    async ({ systemDefaults, user, workspace, system }) => {
      const workspaceTrusted = await trusted(
        mergeGeminiSettings(systemDefaults, user, system),
      );

      // With no `--policy`, the child takes the merged `policyPaths`, each
      // through its `resolvePath`, where that list is non-empty, dropping
      // each entry that resolves empty without falling back.
      const merged = mergeGeminiSettings(
        systemDefaults,
        user,
        workspaceTrusted ? workspace : {},
        system,
      ).policyPaths;
      if (Array.isArray(merged) && merged.length > 0) {
        // `resolvePath` splices the child's home as spelled before
        // normalizing.
        const childHome = context.env.get('GEMINI_CLI_HOME') || homedir();
        const sources: string[] = [];
        for (const entry of merged) {
          if (typeof entry !== 'string' || entry.length === 0) continue;
          let expanded = entry;
          if (entry.toLowerCase().startsWith('%userprofile%')) {
            expanded = childHome + entry.slice('%userprofile%'.length);
          } else if (entry === '~' || entry.startsWith('~/')) {
            expanded = childHome + entry.slice(1);
          }
          sources.push(resolve(context.childCwd, normalize(expanded)));
        }
        return sources;
      }

      const userPolicies = join(realHome, '.gemini', 'policies');
      try {
        await stat(userPolicies);
        return [userPolicies];
      } catch {
        return [];
      }
    },
    (left, right) =>
      left.length === right.length &&
      left.every((source, index) => source === right[index]),
  );
}

const POLICY_ARG_PREFIX = '--policy=';

/**
 * gemini-55: Gemini splits every `--policy` value on commas and trims each
 * part, which a settings path or the default policy directory never
 * undergoes, so a path that change would alter cannot be passed.
 */
function assertGeminiPolicyArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (!arg.startsWith(POLICY_ARG_PREFIX)) continue;
    const path = arg.slice(POLICY_ARG_PREFIX.length);
    if (path.includes(',') || path !== path.trim()) {
      throw new Error(
        `Gemini policy path ${JSON.stringify(path)} cannot be passed through --policy, which splits each value on commas and trims every part`,
      );
    }
  }
}

const UNDELIVERED_ALIAS_OVERRIDE: GeminiSettingsOverride = {
  env: {},
  deliversAlias: false,
  cleanup: async () => {},
};

const SKILLS_HOME_REFUSAL = `skills for adapter "${AGENT}" require a working directory different from its user home`;
const SKILLS_SANDBOX_REFUSAL = `skills for adapter "${AGENT}" cannot be delivered while its native sandbox is enabled`;

/**
 * gemini-51: user settings that turn skills off, as the runtime evaluates
 * them (gemini-34), reject a skills run, because turning them on for the run
 * would also load the user's other skill sources; so does a `false` string
 * there, which the runtime makes `false` only where the whole file
 * validates.
 */
function assertGeminiSkillsEnabled(
  userSettings: Record<string, unknown>,
  path: string,
  env: GeminiChildEnv,
): void {
  const enabled = geminiSettingAt(
    expandGeminiSettings(userSettings, env),
    'skills.enabled',
  );
  if (enabled === false) {
    throw new Error(
      `skills for adapter "${AGENT}" cannot be delivered while the Gemini user settings at ${path} set skills.enabled to false`,
    );
  }
  if (coercedGeminiBoolean(enabled) === false) {
    throw new Error(
      `skills for adapter "${AGENT}" cannot be delivered while the Gemini user settings at ${path} set skills.enabled to ${JSON.stringify(enabled)}, a string the runtime coerces to false only where the whole file validates, which this adapter does not check`,
    );
  }
}

/**
 * gemini-51: the run's skills cannot be delivered from a working directory
 * that is the real home, under the native sandbox, or with skills disabled.
 */
async function assertGeminiSkillsContext(
  context: GeminiSettingsOverrideContext,
): Promise<void> {
  const realHome = geminiRealHome(context);
  if (await geminiWorkspaceIsHome(context, realHome)) {
    throw new CapabilityError('workspace-is-home', SKILLS_HOME_REFUSAL);
  }
  const settingsPath = join(realHome, '.gemini', 'settings.json');
  const userSettings = await readGeminiSettingsFile(
    settingsPath,
    'user settings',
  );
  if (await geminiSandboxRequested(context, userSettings, true)) {
    throw new CapabilityError('native-sandbox', SKILLS_SANDBOX_REFUSAL);
  }
  assertGeminiSkillsEnabled(userSettings, settingsPath, context.runtimeEnv);
}

/**
 * gemini-51: drops each user-scope `skills.disabled` entry whose expanded
 * form (gemini-34) names a run skill as Gemini compares skill names, keeping
 * every other parsed value as written, and whether the runtime's validation
 * accepts the file with it.
 */
function enableRunSkills(
  settings: Record<string, unknown>,
  skills: readonly PreparedSkill[],
  env: GeminiChildEnv,
): Record<string, unknown> {
  const section = settings.skills;
  if (typeof section !== 'object' || section === null || Array.isArray(section))
    return settings;
  const names = new Set(skills.map((skill) => skill.name));
  const namesRunSkill = (entry: unknown): boolean =>
    typeof entry === 'string' &&
    names.has(foldGeminiSkillName(expandGeminiSettingsString(entry, env)));
  const rewritten: Record<string, unknown> = { ...section };
  const disabled = rewritten.disabled;
  if (Array.isArray(disabled)) {
    rewritten.disabled = disabled.filter((entry) => !namesRunSkill(entry));
  } else if (namesRunSkill(disabled)) {
    // Gemini reads a lone string as a one-entry list. A colon names no skill,
    // since the runtime replaces each `:` in a skill's name, and, as a
    // string, still fails the runtime's validation.
    rewritten.disabled = ':';
  } else {
    return settings;
  }
  return { ...settings, skills: rewritten };
}

/**
 * gemini-34: delivers an effort alias through a per-run user-settings home,
 * the one settings layer every supported Gemini CLI loads from a path the
 * caller chooses.
 */
async function defaultCreateSettingsOverride(
  settingsConfig: GeminiSettingsConfig,
  givenContext?: GeminiSettingsOverrideContext,
): Promise<GeminiSettingsOverride> {
  const servers = normalizeMcpServers(settingsConfig.mcpServers);
  const hasMcpServers = Object.keys(servers ?? {}).length > 0;
  const skills = settingsConfig.skills ?? [];
  const hasSkills = skills.length > 0;
  if (!settingsConfig.modelAlias && !hasMcpServers && !hasSkills) {
    return NOOP_SETTINGS_OVERRIDE;
  }
  const context =
    givenContext ?? (await geminiSettingsOverrideContext(process.cwd()));

  const realHome = geminiRealHome(context);
  // Gemini reads a workspace that is its home as neither workspace nor
  // project; a separate home would make it load the real settings twice.
  if (await geminiWorkspaceIsHome(context, realHome)) {
    if (hasMcpServers)
      throw new Error(
        'Gemini per-run MCP servers require a working directory different from its user home',
      );
    if (hasSkills) throw new Error(SKILLS_HOME_REFUSAL);
    return UNDELIVERED_ALIAS_OVERRIDE;
  }

  const settingsPath = join(realHome, '.gemini', 'settings.json');
  const userSettings = await readGeminiSettingsFile(
    settingsPath,
    'user settings',
  );
  if (await geminiSandboxRequested(context, userSettings, hasSkills)) {
    if (hasMcpServers)
      throw new Error(
        'Gemini per-run MCP servers cannot be delivered while its native sandbox is enabled',
      );
    if (hasSkills) throw new Error(SKILLS_SANDBOX_REFUSAL);
    return UNDELIVERED_ALIAS_OVERRIDE;
  }
  const env = context.runtimeEnv;
  if (hasSkills) assertGeminiSkillsEnabled(userSettings, settingsPath, env);

  let settings = settingsConfig.modelAlias
    ? mergeGeminiModelAlias(
        userSettings,
        settingsConfig.modelAlias,
        settingsPath,
      )
    : { ...userSettings };
  if (hasMcpServers) {
    const existing =
      settings.mcpServers === undefined
        ? {}
        : jsonObject(settings.mcpServers, `${settingsPath} mcpServers`);
    settings.mcpServers = {
      ...existing,
      ...Object.fromEntries(
        Object.entries(servers!).map(([name, server]) => [
          name,
          server.type === 'stdio'
            ? {
                command: server.command,
                args: [...(server.args ?? [])],
                ...(server.env ? { env: server.env } : {}),
                trust: true,
              }
            : {
                httpUrl: server.url,
                ...(server.headers ? { headers: server.headers } : {}),
                trust: true,
              },
        ]),
      ),
    };
  }
  if (hasSkills) settings = enableRunSkills(settings, skills, env);
  const overlay = await createGeminiHomeOverlay(
    realHome,
    `${JSON.stringify(settings, null, 2)}\n`,
    { skills, signal: context.signal },
  );

  return {
    env: { GEMINI_CLI_HOME: overlay.home },
    ...(hasMcpServers ? { deliversMcp: true } : {}),
    ...(hasSkills ? { deliversSkills: true } : {}),
    cleanup: overlay.close,
  };
}

async function defaultCreatePolicyOverride(
  toolConfig: GeminiToolConfig,
  runtimePolicySources: readonly string[] = [],
): Promise<GeminiPolicyOverride> {
  const policy = buildGeminiPolicyToml(toolConfig.policyRules ?? []);
  if (!policy) return NOOP_POLICY_OVERRIDE;

  const dir = await mkdtemp(join(tmpdir(), 'cligent-gemini-policy-'));
  const filePath = join(dir, 'policy.toml');

  try {
    await writeFile(filePath, policy, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    // gemini-55: `--policy` is an array flag; the runtime's own sources
    // follow the per-run file.
    args: [
      `${POLICY_ARG_PREFIX}${filePath}`,
      ...runtimePolicySources.map((source) => `${POLICY_ARG_PREFIX}${source}`),
    ],
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function mapPermissionsToGeminiToolConfig(
  policy: PermissionPolicy | undefined,
  options?: Pick<AgentOptions, 'allowedTools' | 'disallowedTools' | 'skills'>,
): GeminiToolConfig & { policyRules: GeminiPolicyRule[] } {
  const writablePaths = mapWritablePathsPermission(policy, 'ambient');
  validateGeminiToolNames('allowedTools', options?.allowedTools);
  validateGeminiToolNames('disallowedTools', options?.disallowedTools);

  const allowedListProvided = options?.allowedTools !== undefined;
  // gemini-52: skills need `activate_skill`, which an explicit restriction
  // never gives up for them.
  const skillsRequested =
    Array.isArray(options?.skills) && options.skills.length > 0;
  if (skillsRequested) {
    if (options?.disallowedTools?.includes(ACTIVATE_SKILL_TOOL)) {
      throw new Error(
        `skills for adapter "${AGENT}" cannot be delivered while disallowedTools names ${ACTIVATE_SKILL_TOOL}`,
      );
    }
    if (
      allowedListProvided &&
      !options.allowedTools!.includes(ACTIVATE_SKILL_TOOL)
    ) {
      throw new Error(
        `skills for adapter "${AGENT}" require allowedTools to name ${ACTIVATE_SKILL_TOOL}`,
      );
    }
  }
  const capabilityPolicyApplies =
    policy !== undefined && policy.mode === undefined;
  const normalized = capabilityPolicyApplies
    ? normalizePermissions(policy)
    : undefined;
  const denied = new Set(options?.disallowedTools ?? []);

  if (normalized) {
    for (const capability of Object.keys(
      CAPABILITY_TOOL_GROUPS,
    ) as PermissionCapability[]) {
      if (normalized[capability] !== 'deny') continue;
      for (const tool of CAPABILITY_TOOL_GROUPS[capability]) {
        denied.add(tool);
      }
    }
  }

  const disallowedTools = [...denied].sort();
  const explicitAllowed = [...new Set(options?.allowedTools ?? [])]
    .filter((tool) => !denied.has(tool))
    .sort();
  const policyRules: GeminiPolicyRule[] = [];

  // Gemini 0.50 uses a stable priority sort. Serialize same-priority denies
  // before allows so a deny wins when both target one tool.
  for (const toolName of disallowedTools) {
    policyRules.push({
      toolName,
      decision: 'deny',
      priority: POLICY_PRIORITY.deny,
      interactive: false,
    });
  }

  for (const toolName of explicitAllowed) {
    policyRules.push({
      toolName,
      decision: 'allow',
      priority: POLICY_PRIORITY.explicitAllow,
      interactive: false,
    });
  }

  // gemini-52: an explicit allowlist naming `activate_skill` already allows it.
  const skillRule = skillsRequested && !allowedListProvided;
  if (skillRule) {
    policyRules.push({
      toolName: ACTIVATE_SKILL_TOOL,
      decision: 'allow',
      priority: POLICY_PRIORITY.explicitAllow,
      interactive: false,
    });
  }

  if (allowedListProvided) {
    policyRules.push({
      toolName: '*',
      decision: 'deny',
      priority: POLICY_PRIORITY.explicitAllowCatchAll,
      interactive: false,
    });
  }

  const capabilityAllowed = new Set<string>();
  if (normalized) {
    for (const capability of Object.keys(
      CAPABILITY_TOOL_GROUPS,
    ) as PermissionCapability[]) {
      const level = normalized[capability];
      if (level === 'deny') continue;

      for (const toolName of CAPABILITY_TOOL_GROUPS[capability]) {
        if (denied.has(toolName)) continue;
        if (level === 'allow' && !allowedListProvided) {
          capabilityAllowed.add(toolName);
        }
        policyRules.push({
          toolName,
          decision: level === 'allow' ? 'allow' : 'ask_user',
          priority: POLICY_PRIORITY.capability,
          interactive: false,
        });
      }
    }
  }

  return {
    allowedTools: allowedListProvided
      ? explicitAllowed
      : [...capabilityAllowed].sort(),
    disallowedTools,
    args: [],
    policyRules,
    ...(policy?.mode === 'auto' || policy?.mode === 'bypass'
      ? { approvalMode: 'yolo' as const }
      : {}),
    ...(writablePaths ? { writablePaths } : {}),
    ...(skillRule && policyRules.length === 1
      ? { skillsOnlyPolicy: true }
      : {}),
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
  options: AgentOptions<GeminiEffort> | undefined,
): GeminiCommandConfig {
  assertBuiltInFastModeOption(AGENT, options?.fastMode);
  assertBuiltInSubagentModelOption(AGENT, options?.subagentModel);
  assertBuiltInSubagentEffortOption(
    AGENT,
    options?.subagentModel,
    options?.subagentEffort,
  );
  const toolConfig = mapPermissionsToGeminiToolConfig(options?.permissions, {
    allowedTools: options?.allowedTools,
    disallowedTools: options?.disallowedTools,
    skills: options?.skills,
  });

  const args = ['--output-format', 'stream-json'] as string[];
  const modelAlias = mapEffortToGeminiModelAlias(
    options?.model,
    options?.effort,
  );

  if (modelAlias) {
    args.push(`--model=${modelAlias.alias}`);
  } else if (options?.model) {
    args.push(`--model=${options.model}`);
  }

  if (options?.resume) {
    args.push(`--resume=${options.resume}`);
  }

  // Note: Gemini CLI does not support a turn-limit flag.
  // options.maxTurns is intentionally not forwarded.

  args.push(...toolConfig.args);

  if (toolConfig.approvalMode) {
    args.push('--approval-mode', toolConfig.approvalMode);
  }

  args.push(`--prompt=${prompt}`);

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
  options: AgentOptions<GeminiEffort> | undefined,
  toolConfig: GeminiToolConfig,
  effortAlias: string | undefined,
): {
  model: string;
  reportedModel?: string;
  cwd: string;
  tools: string[];
  capabilities: Record<string, unknown>;
} {
  const sourceTools = asStringArray(sourceEvent?.tools);
  const configuredAllowlist = options?.allowedTools !== undefined;

  const tools = configuredAllowlist
    ? toolConfig.allowedTools
    : sourceTools.length > 0
      ? sourceTools
      : toolConfig.allowedTools.length > 0
        ? toolConfig.allowedTools
        : [];

  const namedModel = asString(sourceEvent?.model);
  // The runtime names this run's effort alias, not a model (gemini-11).
  const reportedModel = namedModel === effortAlias ? undefined : namedModel;

  return {
    model: options?.model ?? namedModel ?? 'unknown',
    ...(reportedModel !== undefined ? { reportedModel } : {}),
    cwd: options?.cwd ?? asString(sourceEvent?.cwd) ?? process.cwd(),
    tools,
    capabilities: {
      toolsKnown:
        configuredAllowlist ||
        sourceTools.length > 0 ||
        toolConfig.allowedTools.length > 0,
      toolsSource: configuredAllowlist
        ? 'configured'
        : sourceTools.length > 0
          ? 'stream'
          : toolConfig.allowedTools.length > 0
            ? 'configured'
            : 'unavailable',
      disallowedTools: toolConfig.disallowedTools,
    },
  };
}

async function assertGeminiBrowserContext(
  options: AgentOptions<GeminiEffort> | undefined,
  admitsSystemSettingsFile: GeminiSystemFileAdmission,
  environmentPlatform: NodeJS.Platform,
): Promise<void> {
  const context = await geminiSettingsOverrideContext(
    options?.cwd ?? process.cwd(),
    { admitsSystemSettingsFile, environmentPlatform },
  );
  const realHome = geminiRealHome(context);
  if (await geminiWorkspaceIsHome(context, realHome)) {
    throw new CapabilityError(
      'workspace-is-home',
      'Gemini per-run MCP servers require a working directory different from its user home',
    );
  }
  const userSettings = await readGeminiSettingsFile(
    join(realHome, '.gemini', 'settings.json'),
    'user settings',
  );
  if (await geminiSandboxRequested(context, userSettings, false)) {
    throw new CapabilityError(
      'native-sandbox',
      'Gemini per-run MCP servers cannot be delivered while its native sandbox is enabled',
    );
  }
}

export class GeminiAdapter implements AgentAdapter<GeminiEffort> {
  readonly agent = AGENT;

  private readonly spawnProcess: SpawnProcessFn;

  private readonly probeAvailability: () => Promise<boolean>;

  private readonly createSettingsOverride: (
    settingsConfig: GeminiSettingsConfig,
    context: GeminiSettingsOverrideContext,
  ) => Promise<GeminiSettingsOverride>;

  private readonly createPolicyOverride: (
    toolConfig: GeminiToolConfig,
    runtimePolicySources?: readonly string[],
  ) => Promise<GeminiPolicyOverride>;

  private readonly createTelemetryCapture: () => Promise<GeminiTelemetryCapture>;

  private readonly admitsSystemSettingsFile: GeminiSystemFileAdmission;

  private readonly environmentPlatform: NodeJS.Platform;

  constructor(deps: GeminiAdapterDeps = {}) {
    this.spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
    this.probeAvailability = deps.probeAvailability ?? defaultProbeAvailability;
    this.createSettingsOverride =
      deps.createSettingsOverride ?? defaultCreateSettingsOverride;
    this.createPolicyOverride =
      deps.createPolicyOverride ?? defaultCreatePolicyOverride;
    this.createTelemetryCapture =
      deps.createTelemetryCapture ?? defaultCreateTelemetryCapture;
    this.admitsSystemSettingsFile =
      deps.admitsSystemSettingsFile ??
      geminiSystemFileAdmission(deps.admissionPlatform ?? process.platform);
    this.environmentPlatform = deps.environmentPlatform ?? process.platform;
  }

  async getCapabilities(options?: Parameters<GeminiAdapter['run']>[1]) {
    const capabilities = await describeCapabilities(
      AGENT,
      async () => {
        mapAgentOptionsToGeminiCommand('', options);
        await assertGeminiBrowserContext(
          options,
          this.admitsSystemSettingsFile,
          this.environmentPlatform,
        );
      },
      options,
    );
    try {
      assertGeminiAttachmentContext(await realpath(tmpdir()));
      return capabilities;
    } catch (error) {
      return Object.freeze({
        ...capabilities,
        attachments: Object.freeze({
          mimeTypes: Object.freeze([] as string[]),
          notes:
            error instanceof Error
              ? error.message
              : 'Gemini attachment staging is unavailable',
        }),
      });
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.probeAvailability();
  }

  async *run(
    prompt: string,
    options?: AgentOptions<GeminiEffort>,
  ): AsyncGenerator<AgentEvent, void, void> {
    const attachmentScope = { cleanup: async () => {} };
    try {
      for await (const event of withMcpResources(options, (scoped) =>
        this.runWithMcpResources(prompt, scoped, attachmentScope),
      )) {
        if (event.type === 'done') await attachmentScope.cleanup();
        yield event;
      }
    } finally {
      await attachmentScope.cleanup();
    }
  }

  private async *runWithMcpResources(
    prompt: string,
    options: AgentOptions<GeminiEffort> | undefined,
    attachmentScope: { cleanup(): Promise<void> },
  ): AsyncGenerator<AgentEvent, void, void> {
    assertBuiltInFastModeOption(AGENT, options?.fastMode);
    assertBuiltInSubagentModelOption(AGENT, options?.subagentModel);
    assertBuiltInSubagentEffortOption(
      AGENT,
      options?.subagentModel,
      options?.subagentEffort,
    );
    // engine-25: `isAvailable()` is not on this path. Cligent.run() reaches
    // the adapter directly, so without this a below-floor CLI is spawned and
    // fails mid-turn — the failure mode this work exists to remove.
    assertRuntimeSupported(
      AGENT_RUNTIME_TARGETS.gemini[0]!,
      `npm install -g ${AGENT_RUNTIME_TARGETS.gemini[0]!.repairSpec}`,
    );
    const resumeSessionId = asString(options?.resume);
    const mapped = mapAgentOptionsToGeminiCommand(prompt, options);

    let processExited = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let closePromise: Promise<CloseResult> | undefined;
    let settingsOverride: GeminiSettingsOverride = NOOP_SETTINGS_OVERRIDE;
    let policyOverride: GeminiPolicyOverride = NOOP_POLICY_OVERRIDE;
    let telemetryCapture: GeminiTelemetryCapture = NOOP_TELEMETRY_CAPTURE;

    const startTime = Date.now();
    let sessionId = resumeSessionId ?? generateSessionId();
    let backendProvidedSessionId = false;
    let doneYielded = false;
    let pendingDone: Omit<DonePayload, 'usage'> | undefined;
    let pendingResultError:
      Extract<AgentEvent, { type: 'error' }>['payload'] | undefined;
    let pendingStreamStats: unknown;
    let initYielded = false;
    let abortRequested = options?.abortSignal?.aborted === true;
    let stderr = '';
    const observedToolUseIds = new Set<string>();

    const onAbort = () => {
      abortRequested = true;
      if (!child || processExited) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore kill errors during shutdown
      }
    };

    const interruptedDonePayload = (): DonePayload => ({
      status: 'interrupted',
      ...doneResumeTokenPayload(
        'interrupted',
        backendProvidedSessionId,
        sessionId,
        resumeSessionId,
      ),
      usage: {
        ...DEFAULT_DONE_USAGE,
        toolUses: observedToolUseIds.size,
      },
      durationMs: Date.now() - startTime,
    });

    if (options?.abortSignal && !options.abortSignal.aborted) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const context = await geminiSettingsOverrideContext(
        mapped.spawnOptions.cwd?.toString() ?? process.cwd(),
        {
          ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
          admitsSystemSettingsFile: this.admitsSystemSettingsFile,
          environmentPlatform: this.environmentPlatform,
        },
      );
      // skills-2, gemini-51: the whole list and its delivery context are
      // checked before attachments are staged or the browser is prepared.
      const skills = await prepareSkills(
        AGENT,
        options?.skills,
        context.cwd,
        options?.abortSignal,
      );
      if (abortRequested || options?.abortSignal?.aborted) {
        throw new Error('Gemini run aborted during skill preparation');
      }
      if (skills.length > 0) await assertGeminiSkillsContext(context);
      // gemini-55: the runtime's own policy sources are settled before
      // attachments are staged or the browser is prepared.
      const runtimePolicySources = mapped.toolConfig.skillsOnlyPolicy
        ? await geminiRuntimePolicySources(context)
        : [];
      const attachmentStage = await prepareGeminiAttachments(
        prompt,
        options?.attachments,
        options?.cwd,
        options?.abortSignal,
      );
      attachmentScope.cleanup = attachmentStage.cleanup;
      mapped.args.splice(
        -1,
        1,
        ...(attachmentStage.directory
          ? [`--include-directories=${attachmentStage.directory}`]
          : []),
        `--prompt=${attachmentStage.prompt}`,
      );
      const requestedMcp = normalizeMcpServers(options?.mcpServers);
      if (
        options?.browser === true ||
        Object.keys(requestedMcp ?? {}).length > 0
      ) {
        await assertGeminiBrowserContext(
          options,
          this.admitsSystemSettingsFile,
          this.environmentPlatform,
        );
      }
      const mcpServers = await prepareMcpServers(options);
      if (abortRequested || options?.abortSignal?.aborted) {
        throw new Error('Gemini run aborted during MCP preparation');
      }
      if (mcpServers !== undefined)
        mapped.settingsConfig.mcpServers = mcpServers;
      if (skills.length > 0) mapped.settingsConfig.skills = skills;
      settingsOverride = await this.createSettingsOverride(
        mapped.settingsConfig,
        context,
      );
      if (
        Object.keys(mcpServers ?? {}).length > 0 &&
        settingsOverride.deliversMcp !== true
      ) {
        throw new Error(
          'Gemini settings override cannot deliver the requested MCP servers',
        );
      }
      if (skills.length > 0 && settingsOverride.deliversSkills !== true) {
        throw new Error(
          'Gemini settings override cannot deliver the requested skills',
        );
      }
      // gemini-7: an alias the override cannot deliver would name no model,
      // so the run sends the concrete model and leaves effort unapplied.
      const modelAlias = mapped.settingsConfig.modelAlias;
      const args =
        modelAlias && settingsOverride.deliversAlias === false
          ? mapped.args.map((arg) =>
              arg === `--model=${modelAlias.alias}`
                ? `--model=${modelAlias.model}`
                : arg,
            )
          : mapped.args;
      policyOverride = await this.createPolicyOverride(
        mapped.toolConfig,
        runtimePolicySources,
      );
      // gemini-55: the per-run file and the runtime's own sources must reach
      // Gemini as the paths they name.
      if (mapped.toolConfig.skillsOnlyPolicy) {
        assertGeminiPolicyArgs(policyOverride.args);
      }
      try {
        telemetryCapture = await this.createTelemetryCapture();
      } catch {
        // Telemetry is supplementary accounting. A capture setup failure must
        // not prevent the coding-agent run itself from proceeding.
      }
      // gemini-56: each variable the adapter sets replaces every variant of
      // its name in letter case on Windows, and that name elsewhere.
      const spawnOptions: SpawnOptionsWithoutStdio = {
        ...mapped.spawnOptions,
        env: context.env
          .with({
            ...(mapped.spawnOptions.env ?? {}),
            ...settingsOverride.env,
            ...telemetryCapture.env,
          })
          .record(),
      };

      if (abortRequested || options?.abortSignal?.aborted) {
        throw new Error('Gemini run aborted during configuration');
      }
      child = this.spawnProcess(
        mapped.command,
        [...args.slice(0, -1), ...policyOverride.args, ...args.slice(-1)],
        spawnOptions,
      );

      const processRef = child;

      closePromise = new Promise<CloseResult>((resolve) => {
        const onClose = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => {
          processExited = true;
          cleanup();
          resolve({ code, signal });
        };

        const onError = (error: Error) => {
          processExited = true;
          cleanup();
          resolve({ code: null, signal: null, error });
        };

        const cleanup = () => {
          processRef.removeListener('close', onClose);
          processRef.removeListener('error', onError);
        };

        processRef.once('close', onClose);
        processRef.once('error', onError);
      });

      if (!processRef.stdout) {
        throw new Error('Gemini CLI process does not expose stdout stream');
      }

      if (processRef.stderr) {
        processRef.stderr.setEncoding('utf8');
        processRef.stderr.on('data', (chunk: string | Buffer) => {
          stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
      }

      if (abortRequested) {
        onAbort();
      }

      for await (const parsed of parseNDJSON(processRef.stdout)) {
        if (!parsed.ok) {
          if (!initYielded) {
            yield createEvent(
              'init',
              AGENT,
              buildInitPayload(
                undefined,
                options,
                mapped.toolConfig,
                mapped.settingsConfig.modelAlias?.alias,
              ),
              sessionId,
            );
            initYielded = true;
          }

          if (!doneYielded && !pendingDone) {
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
        if (pendingDone || doneYielded) continue;
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
              buildInitPayload(
                message,
                options,
                mapped.toolConfig,
                mapped.settingsConfig.modelAlias?.alias,
              ),
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
            buildInitPayload(
              message,
              options,
              mapped.toolConfig,
              mapped.settingsConfig.modelAlias?.alias,
            ),
            sessionId,
          );
          initYielded = true;
        }

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

          observedToolUseIds.add(toolUseId);
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
            const diagMsg =
              errorMsg ||
              `Gemini result error (raw: ${JSON.stringify({ error: message.error, result: message.result, status: message.status })})`;

            pendingResultError = errorMsg
              ? toErrorPayload(message)
              : {
                  code: 'GEMINI_RESULT_ERROR',
                  message: diagMsg,
                  recoverable: false,
                };
          }

          const resultText =
            asString(message.result) ??
            asString(asRecord(message.error).message);

          pendingDone = {
            status: doneStatus,
            result: resultText,
            ...doneResumeTokenPayload(
              doneStatus,
              backendProvidedSessionId,
              sessionId,
              resumeSessionId,
            ),
            durationMs:
              asNumber(message.durationMs) ??
              asNumber(message.duration_ms) ??
              Date.now() - startTime,
          };
          pendingStreamStats = message.stats;
          continue;
        }
      }

      const close = await closePromise;
      if (close.error) throw close.error;

      if (!initYielded) {
        yield createEvent(
          'init',
          AGENT,
          buildInitPayload(
            undefined,
            options,
            mapped.toolConfig,
            mapped.settingsConfig.modelAlias?.alias,
          ),
          sessionId,
        );
        initYielded = true;
      }

      if (abortRequested || options?.abortSignal?.aborted) {
        yield createEvent('done', AGENT, interruptedDonePayload(), sessionId);
        doneYielded = true;
      } else if (pendingDone) {
        let tokens: TokenUsageReport | undefined;
        try {
          tokens = mapTelemetryUsage(
            await telemetryCapture.read(),
            pendingStreamStats,
          );
        } catch {
          // Missing/unreadable telemetry is represented by an absent token
          // report, never by a reconstructed or stream-only estimate.
        }

        if (abortRequested || options?.abortSignal?.aborted) {
          yield createEvent('done', AGENT, interruptedDonePayload(), sessionId);
        } else {
          if (pendingResultError) {
            yield createEvent('error', AGENT, pendingResultError, sessionId);
          }
          yield createEvent(
            'done',
            AGENT,
            {
              ...pendingDone,
              usage: {
                toolUses: observedToolUseIds.size,
                ...(tokens ? { tokens } : {}),
              },
            },
            sessionId,
          );
        }
        doneYielded = true;
      } else if (!doneYielded) {
        const status = mapExitCodeToDoneStatus(close, abortRequested);
        if (status === 'interrupted') {
          yield createEvent('done', AGENT, interruptedDonePayload(), sessionId);
        } else {
          const stderrText = stderr.trim();
          const fallbackMsg =
            stderrText ||
            (status === 'error'
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
                resumeSessionId,
              ),
              ...(fallbackMsg ? { result: fallbackMsg } : {}),
              usage: {
                ...DEFAULT_DONE_USAGE,
                toolUses: observedToolUseIds.size,
              },
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
        }
        doneYielded = true;
      }
    } catch (error) {
      if (!initYielded) {
        yield createEvent(
          'init',
          AGENT,
          buildInitPayload(
            undefined,
            options,
            mapped.toolConfig,
            mapped.settingsConfig.modelAlias?.alias,
          ),
          sessionId,
        );
        initYielded = true;
      }

      if (!doneYielded) {
        if (abortRequested || options?.abortSignal?.aborted) {
          yield createEvent('done', AGENT, interruptedDonePayload(), sessionId);
          doneYielded = true;
          return;
        }

        if (pendingDone) {
          if (pendingResultError) {
            yield createEvent('error', AGENT, pendingResultError, sessionId);
          }
          yield createEvent(
            'done',
            AGENT,
            {
              ...pendingDone,
              usage: {
                toolUses: observedToolUseIds.size,
              },
            },
            sessionId,
          );
          doneYielded = true;
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
            ...doneResumeTokenPayload(
              'error',
              backendProvidedSessionId,
              sessionId,
              resumeSessionId,
            ),
            usage: {
              ...DEFAULT_DONE_USAGE,
              toolUses: observedToolUseIds.size,
            },
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

      const cleanupResults = await Promise.allSettled([
        telemetryCapture.cleanup(),
        policyOverride.cleanup(),
        settingsOverride.cleanup(),
      ]);
      const cleanupErrors = cleanupResults.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (cleanupErrors.length === 1) {
        throw cleanupErrors[0];
      }
      if (cleanupErrors.length > 1) {
        throw new AggregateError(
          cleanupErrors,
          'Failed to clean up Gemini temporary runtime files',
        );
      }
    }
  }
}
