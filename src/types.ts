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

export interface DonePayload {
  status: 'success' | 'error' | 'interrupted' | 'max_turns' | 'max_budget';
  result?: string;
  resumeToken?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    toolUses: number;
    totalCostUsd?: number;
  };
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
