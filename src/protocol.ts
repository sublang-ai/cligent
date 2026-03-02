// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AgentType, AgentEvent } from './types.js';
import { createEvent } from './events.js';

export function safeReturn(gen: AsyncGenerator<AgentEvent, void, void>): void {
  try {
    gen.return(undefined as never).catch(() => {});
  } catch {
    // swallow synchronous cleanup errors
  }
}

export function raceAbort(
  promise: Promise<IteratorResult<AgentEvent, void>>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<AgentEvent, void>> {
  if (!signal || signal.aborted) {
    if (signal?.aborted) {
      promise.catch(() => {}); // suppress unhandled rejection on orphaned promise
      return Promise.resolve({ done: true, value: undefined });
    }
    return promise;
  }
  return Promise.race([
    promise,
    new Promise<IteratorResult<AgentEvent, void>>((resolve) => {
      const onAbort = () => resolve({ done: true, value: undefined });
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        () => signal.removeEventListener('abort', onAbort),
        () => signal.removeEventListener('abort', onAbort),
      );
    }),
  ]);
}

export function makeSynthDone(
  agent: AgentType,
  status: 'error' | 'interrupted',
  sessionId: string,
  startTime: number,
): AgentEvent {
  return createEvent(
    'done',
    agent,
    {
      status,
      usage: { inputTokens: 0, outputTokens: 0, toolUses: 0 },
      durationMs: Date.now() - startTime,
    },
    sessionId,
  );
}

export function makeSynthError(
  agent: AgentType,
  code: string,
  message: string,
  sessionId: string,
): AgentEvent {
  return createEvent(
    'error',
    agent,
    { code, message, recoverable: false },
    sessionId,
  );
}
