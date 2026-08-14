// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AgentType, AgentEvent, DonePayload } from './types.js';
import { createEvent } from './events.js';

export const ABORT_DONE_GRACE_MS = 500;

type PendingOrSettledNext =
  | Promise<IteratorResult<AgentEvent, void>>
  | IteratorResult<AgentEvent, void>;

export interface AbortDrainNextResult {
  result: IteratorResult<AgentEvent, void>;
  abortDone?: AgentEvent;
  aborted: boolean;
}

type SynthDoneExtra = Partial<
  Pick<DonePayload, 'resumeToken' | 'result'>
> & {
  toolUses?: number;
};

export function recordObservedToolUse(
  toolUseIds: Set<string>,
  event: AgentEvent,
): void {
  if (event.type !== 'tool_use') return;
  const toolUseId = (event.payload as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === 'string') {
    toolUseIds.add(toolUseId);
  }
}

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

export async function nextWithAbortDrain(
  gen: AsyncGenerator<AgentEvent, void, void>,
  signal: AbortSignal | undefined,
): Promise<AbortDrainNextResult> {
  const nextResult = gen.next();
  const result = await raceAbort(nextResult, signal);
  const aborted =
    signal?.aborted === true &&
    (result.done || result.value.type !== 'done');

  if (!aborted) {
    return { result, aborted: false };
  }

  return {
    result,
    aborted: true,
    abortDone: await readAdapterDoneAfterAbort(
      gen,
      result.done ? nextResult : result,
    ),
  };
}

async function readAdapterDoneAfterAbort(
  gen: AsyncGenerator<AgentEvent, void, void>,
  first: PendingOrSettledNext,
  timeoutMs = ABORT_DONE_GRACE_MS,
): Promise<AgentEvent | undefined> {
  const deadline = Date.now() + timeoutMs;
  let next = first;

  while (true) {
    const result = isSettledNext(next)
      ? next
      : await waitForNextBeforeDeadline(next, deadline);

    if (!result) {
      return undefined;
    }
    if (result.done) {
      return undefined;
    }
    if (result.value.type === 'done') {
      return result.value;
    }
    next = gen.next();
  }
}

function isSettledNext(
  value: PendingOrSettledNext,
): value is IteratorResult<AgentEvent, void> {
  return typeof value === 'object' && value !== null && 'done' in value;
}

async function waitForNextBeforeDeadline(
  promise: Promise<IteratorResult<AgentEvent, void>>,
  deadline: number,
): Promise<IteratorResult<AgentEvent, void> | undefined> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    promise.catch(() => {});
    return undefined;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), remainingMs);
    });
    const result = await Promise.race([promise, timeoutPromise]);
    if (!result) {
      promise.catch(() => {});
    }
    return result;
  } catch {
    // Adapter abort errors still map to synthesized interrupted done.
    return undefined;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function makeSynthDone(
  agent: AgentType,
  status: 'error' | 'interrupted',
  sessionId: string,
  startTime: number,
  extra?: SynthDoneExtra,
): AgentEvent {
  const { toolUses = 0, ...doneExtra } = extra ?? {};
  return createEvent(
    'done',
    agent,
    {
      status,
      ...doneExtra,
      usage: {
        toolUses,
      },
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
