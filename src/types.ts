// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { Effort } from './effort.js';

export type {
  ClaudeEffort,
  CodexEffort,
  Effort,
  GeminiEffort,
  KimiEffort,
  OpenCodeEffort,
  PortableEffort,
} from './effort.js';

export type AgentEventType =
  | 'init'
  | 'text'
  | 'text_delta'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'error'
  | 'permission_request'
  | 'done';

export type AgentType =
  'claude-code' | 'codex' | 'gemini' | 'kimi' | 'opencode' | (string & {});

export interface BaseEvent {
  type: AgentEventType | (string & {});
  agent: AgentType;
  timestamp: number;
  sessionId: string;
  metadata?: Record<string, unknown>;
}

export interface InitPayload {
  model: string;
  cwd: string;
  tools: string[];
  capabilities?: Record<string, unknown>;
}

export interface TextPayload {
  content: string;
}

export interface TextDeltaPayload {
  delta: string;
}

export interface ThinkingPayload {
  summary: string;
}

export interface ErrorPayload {
  code?: string;
  message: string;
  recoverable: boolean;
}

export interface PermissionRequestPayload {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  reason?: string;
}

export interface ToolUsePayload {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  description?: string;
}

export interface ToolResultPayload {
  toolUseId: string;
  toolName: string;
  status: 'success' | 'error' | 'denied';
  output: unknown;
  durationMs?: number;
}

export type UsageCoverage = 'complete' | 'partial';

/** Inclusive input-token accounting for one measured scope. */
export interface InputTokenUsage {
  /** All input tokens, including every reported cache tier. */
  total: number;
  /** Input tokens that were neither cache reads nor cache writes. */
  uncached?: number;
  /** Input tokens served from a prompt cache. */
  cacheRead?: number;
  /** Input tokens written into a prompt cache. */
  cacheWrite?: number;
}

/** Inclusive output-token accounting for one measured scope. */
export interface OutputTokenUsage {
  /** All model-generated output, including reasoning or thinking. */
  total: number;
  /** Model-visible output excluding reasoning or thinking. */
  visible?: number;
  /** Reasoning or thinking tokens included in `total`. */
  reasoning?: number;
}

/**
 * Authentic inclusive token totals plus any exact subsets the runtime
 * exposes. An absent detail is unreported; a present zero is measured.
 */
export interface TokenUsage {
  input: InputTokenUsage;
  output: OutputTokenUsage;
}

export type UsageCostSource =
  | 'agent-estimate'
  | 'provider-reported'
  | 'account-estimate';

/** Cost reported by an upstream runtime. Cligent never computes this value. */
export interface UsageCost {
  amount: number;
  currency: 'USD';
  source: UsageCostSource;
}

/** A non-token rate-card unit reported by the runtime. */
export interface PricedUsageUnit {
  name: string;
  quantity: number;
}

/**
 * One rate-card group of a run's work per DR-014. A caller combines these
 * authentic dimensions with the applicable price table; Cligent does not
 * assume that tokens alone capture every billed unit or modifier.
 */
export interface UsageRecord {
  /**
   * Rate-card key as the runtime named it. Absent when the runtime does not
   * report which model ran — never a placeholder such as `'unknown'`.
   */
  model?: string;
  /** Rate-card family, where the runtime distinguishes one. */
  provider?: string;
  /**
   * API requests this record covers. `1` means a context-length pricing tier
   * is determinable from `tokens`; a greater value means it is not, because
   * tiers are selected per request and these counts are a sum.
   */
  requests?: number;
  /** Inclusive totals and exact subsets for this rate-card group. */
  tokens: TokenUsage;
  /** Cost reported by the runtime for this group, where available. */
  cost?: UsageCost;
  /** Separately priced non-token units, where the runtime reports them. */
  pricedUnits?: PricedUsageUnit[];
}

/** Token accounting observed for one `AgentAdapter.run()` invocation. */
export interface TokenUsageReport {
  /** Whether the report covers every model request caused by the invocation. */
  coverage: UsageCoverage;
  /** Inclusive totals for the requests this report covers. */
  totals: TokenUsage;
  /** Optional rate-card decomposition of those same totals. */
  records?: UsageRecord[];
}

export interface DoneUsage {
  /** Unique tool calls independently observed during the invocation. */
  toolUses: number;
  /** Omitted when authentic token accounting is unavailable. */
  tokens?: TokenUsageReport;
  /** Whole-invocation cost reported by the runtime, where available. */
  cost?: UsageCost;
}

export interface DonePayload {
  status: 'success' | 'error' | 'interrupted' | 'max_turns' | 'max_budget';
  result?: string;
  resumeToken?: string;
  usage: DoneUsage;
  durationMs: number;
}

export type AgentEvent =
  | (BaseEvent & { type: 'init'; payload: InitPayload })
  | (BaseEvent & { type: 'text'; payload: TextPayload })
  | (BaseEvent & { type: 'text_delta'; payload: TextDeltaPayload })
  | (BaseEvent & { type: 'tool_use'; payload: ToolUsePayload })
  | (BaseEvent & { type: 'tool_result'; payload: ToolResultPayload })
  | (BaseEvent & { type: 'thinking'; payload: ThinkingPayload })
  | (BaseEvent & { type: 'error'; payload: ErrorPayload })
  | (BaseEvent & {
      type: 'permission_request';
      payload: PermissionRequestPayload;
    })
  | (BaseEvent & { type: 'done'; payload: DonePayload })
  | (BaseEvent & { type: `${string}:${string}`; payload: unknown });

export type PermissionLevel = 'allow' | 'ask' | 'deny';
export type PermissionCapability =
  'fileWrite' | 'shellExecute' | 'networkAccess';
export type WritablePathsEnforcement = 'profile' | 'sandbox' | 'ambient';

export interface WritablePathsPermissionMapping {
  paths: string[];
  enforcement: WritablePathsEnforcement;
}

export interface PermissionPolicy {
  /**
   * Session-wide automation posture per ENG-021. When set, it selects the
   * adapter's automation-posture knob: `'auto'` maps to the adapter/provider's
   * native automation, whose protection and approval semantics are
   * adapter-specific, and `'bypass'` maps to unchecked bypass where supported
   * (other adapters reject it at mapping time). Where the SDK models local
   * capability rules independently, explicitly supplied
   * `fileWrite` / `shellExecute` / `networkAccess` levels may compose with
   * `mode`; otherwise `mode` takes precedence. When unset, those levels derive
   * the effective posture as before.
   */
  mode?: 'auto' | 'bypass';
  fileWrite?: PermissionLevel;
  shellExecute?: PermissionLevel;
  networkAccess?: PermissionLevel;
  /**
   * Additional workspace-relative subpaths that should be writable for local
   * execution after adapter-specific validation and mapping.
   */
  writablePaths?: string[];
}

export interface AgentAdapter<E extends string = Effort> {
  readonly agent: AgentType;

  run(
    prompt: string,
    options?: AgentOptions<E>,
  ): AsyncGenerator<AgentEvent, void, void>;

  isAvailable(): Promise<boolean>;
}

export interface AgentOptions<E extends string = Effort> {
  cwd?: string;
  model?: string;
  permissions?: PermissionPolicy;
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: E;
  resume?: string;
  abortSignal?: AbortSignal;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export type CligentEvent = AgentEvent & { role?: string };

export interface CligentOptions<E extends string = Effort> {
  role?: string;
  cwd?: string;
  model?: string;
  permissions?: PermissionPolicy;
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: E;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface RunOptions<E extends string = Effort> extends Omit<
  CligentOptions<E>,
  'role'
> {
  abortSignal?: AbortSignal;
  resume?: string | false;
}
