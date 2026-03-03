// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

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
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | (string & {});

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
  | (BaseEvent & { type: 'permission_request'; payload: PermissionRequestPayload })
  | (BaseEvent & { type: 'done'; payload: DonePayload })
  | (BaseEvent & { type: `${string}:${string}`; payload: unknown });

export type PermissionLevel = 'allow' | 'ask' | 'deny';

export interface PermissionPolicy {
  fileWrite?: PermissionLevel;
  shellExecute?: PermissionLevel;
  networkAccess?: PermissionLevel;
}

export interface AgentAdapter {
  readonly agent: AgentType;

  run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void>;

  isAvailable(): Promise<boolean>;
}

export interface AgentOptions {
  cwd?: string;
  model?: string;
  permissions?: PermissionPolicy;
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
  abortSignal?: AbortSignal;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export type CligentEvent = AgentEvent & { role?: string };

export interface CligentOptions {
  role?: string;
  cwd?: string;
  model?: string;
  permissions?: PermissionPolicy;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface RunOptions extends Omit<CligentOptions, 'role'> {
  abortSignal?: AbortSignal;
  resume?: string | false;
}
