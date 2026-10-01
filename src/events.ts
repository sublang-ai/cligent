// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';

import type {
  AgentType,
  AgentEvent,
  BaseEvent,
  InitPayload,
  TextPayload,
  TextDeltaPayload,
  MediaPayload,
  ThinkingPayload,
  ErrorPayload,
  PermissionRequestPayload,
  ToolUsePayload,
  ToolResultPayload,
  DonePayload,
} from './types.js';

export interface AgentEventMap {
  init: InitPayload;
  text: TextPayload;
  text_delta: TextDeltaPayload;
  media: MediaPayload;
  thinking: ThinkingPayload;
  error: ErrorPayload;
  permission_request: PermissionRequestPayload;
  tool_use: ToolUsePayload;
  tool_result: ToolResultPayload;
  done: DonePayload;
}

export function generateSessionId(): string {
  return randomUUID();
}

export function createEvent<T extends keyof AgentEventMap>(
  type: T,
  agent: AgentType,
  payload: AgentEventMap[T],
  sessionId?: string,
): BaseEvent & { type: T; payload: AgentEventMap[T] };
export function createEvent(
  type: `${string}:${string}`,
  agent: AgentType,
  payload: unknown,
  sessionId?: string,
): BaseEvent & { type: `${string}:${string}`; payload: unknown };
export function createEvent(
  type: string,
  agent: AgentType,
  payload: unknown,
  sessionId?: string,
): AgentEvent {
  return {
    type,
    agent,
    timestamp: Date.now(),
    sessionId: sessionId ?? generateSessionId(),
    payload,
  } as AgentEvent;
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.type === 'string' &&
    typeof obj.agent === 'string' &&
    typeof obj.timestamp === 'number' &&
    typeof obj.sessionId === 'string' &&
    'payload' in obj
  );
}
