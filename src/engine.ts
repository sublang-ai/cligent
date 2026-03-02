// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type {
  AgentType,
  AgentEvent,
  AgentAdapter,
  AgentOptions,
} from './types.js';
import { generateSessionId } from './events.js';
import { safeReturn, raceAbort, makeSynthDone, makeSynthError } from './protocol.js';
import type { AdapterRegistry } from './registry.js';

export interface ParallelTask {
  adapter: AgentAdapter;
  prompt: string;
  options?: AgentOptions;
}

export async function* runAgent(
  agent: AgentType,
  prompt: string,
  options: AgentOptions | undefined,
  registry: AdapterRegistry,
): AsyncGenerator<AgentEvent, void, void> {
  const adapter = registry.get(agent);
  if (!adapter) {
    throw new Error(`No adapter registered for agent: ${agent}`);
  }

  const sessionId = generateSessionId();
  const startTime = Date.now();
  const signal = options?.abortSignal;

  // Short-circuit on pre-aborted signal — never call adapter.run()
  if (signal?.aborted) {
    yield makeSynthDone(agent, 'interrupted', sessionId, startTime);
    return;
  }

  let lastSessionId = sessionId;
  const gen = adapter.run(prompt, options);
  let doneYielded = false;

  try {
    while (true) {
      let result: IteratorResult<AgentEvent, void>;
      try {
        result = await raceAbort(gen.next(), signal);
      } catch (err) {
        // Adapter threw
        if (!doneYielded) {
          const msg = err instanceof Error ? err.message : String(err);
          yield makeSynthError(agent, 'ADAPTER_ERROR', msg, lastSessionId);
          yield makeSynthDone(agent, 'error', lastSessionId, startTime);
        }
        safeReturn(gen);
        return;
      }

      // Check abort after awaiting
      if (signal?.aborted) {
        if (!doneYielded) {
          yield makeSynthDone(agent, 'interrupted', lastSessionId, startTime);
        }
        safeReturn(gen);
        return;
      }

      if (result.done) {
        // Generator exhausted
        if (!doneYielded) {
          yield makeSynthError(
            agent,
            'MISSING_DONE',
            'Protocol violation: adapter completed without terminal event',
            lastSessionId,
          );
          yield makeSynthDone(agent, 'error', lastSessionId, startTime);
        }
        return;
      }

      const event = result.value;

      if (doneYielded) {
        // Suppress all post-done events
        continue;
      }

      lastSessionId = event.sessionId;
      yield event;

      if (event.type === 'done') {
        doneYielded = true;
        safeReturn(gen);
        return;
      }
    }
  } finally {
    // Ensure generator is cleaned up
    if (!doneYielded) {
      safeReturn(gen);
    }
  }
}

interface AdapterState {
  gen: AsyncGenerator<AgentEvent, void, void>;
  agent: AgentType;
  startTime: number;
  sessionId: string;
  doneYielded: boolean;
}

interface RaceResult {
  index: number;
  result?: IteratorResult<AgentEvent, void>;
  error?: unknown;
  isError: boolean;
}

export async function* runParallel(
  tasks: ParallelTask[],
): AsyncGenerator<AgentEvent, void, void> {
  if (tasks.length === 0) return;

  // Short-circuit on pre-aborted signal — never call adapter.run()
  if (tasks.some((t) => t.options?.abortSignal?.aborted)) {
    for (const task of tasks) {
      yield makeSynthDone(
        task.adapter.agent,
        'interrupted',
        generateSessionId(),
        Date.now(),
      );
    }
    return;
  }

  const states: (AdapterState | null)[] = tasks.map((task) => ({
    gen: task.adapter.run(task.prompt, task.options),
    agent: task.adapter.agent,
    startTime: Date.now(),
    sessionId: generateSessionId(),
    doneYielded: false,
  }));

  const pending = new Map<number, Promise<RaceResult>>();

  function scheduleNext(index: number): void {
    const state = states[index];
    if (!state) return;
    pending.set(
      index,
      state.gen.next().then(
        (result) => ({ index, result, isError: false }),
        (error: unknown) => ({ index, error, isError: true }),
      ),
    );
  }

  // Collect all abort signals and build a single abort promise
  const signals = tasks
    .map((t) => t.options?.abortSignal)
    .filter((s): s is AbortSignal => s !== undefined);

  const abortSentinel: RaceResult = { index: -1, isError: false };
  let resolveAbort: (() => void) | undefined;
  const abortPromise = new Promise<RaceResult>((resolve) => {
    resolveAbort = () => resolve(abortSentinel);
  });

  const abortCleanups: (() => void)[] = [];

  for (const signal of signals) {
    const onAbort = () => resolveAbort?.();
    signal.addEventListener('abort', onAbort, { once: true });
    abortCleanups.push(() => signal.removeEventListener('abort', onAbort));
  }

  function yieldInterruptedAndCleanup(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const state of states) {
      if (state && !state.doneYielded) {
        events.push(
          makeSynthDone(
            state.agent,
            'interrupted',
            state.sessionId,
            state.startTime,
          ),
        );
        state.doneYielded = true;
        safeReturn(state.gen);
      }
    }
    return events;
  }

  // Start initial promises
  for (let i = 0; i < states.length; i++) {
    scheduleNext(i);
  }

  try {
    while (pending.size > 0) {
      const raceResult = await Promise.race([...pending.values(), abortPromise]);

      if (raceResult === abortSentinel) {
        for (const evt of yieldInterruptedAndCleanup()) yield evt;
        return;
      }

      const { index } = raceResult;
      pending.delete(index);
      const state = states[index]!;

      if (raceResult.isError) {
        // Adapter threw
        if (!state.doneYielded) {
          const msg =
            raceResult.error instanceof Error
              ? raceResult.error.message
              : String(raceResult.error);
          yield makeSynthError(
            state.agent,
            'ADAPTER_ERROR',
            msg,
            state.sessionId,
          );
          yield makeSynthDone(
            state.agent,
            'error',
            state.sessionId,
            state.startTime,
          );
          state.doneYielded = true;
        }
        safeReturn(state.gen);
        states[index] = null;
        continue;
      }

      const result = raceResult.result!;
      if (result.done) {
        // Generator exhausted
        if (!state.doneYielded) {
          yield makeSynthError(
            state.agent,
            'MISSING_DONE',
            'Protocol violation: adapter completed without terminal event',
            state.sessionId,
          );
          yield makeSynthDone(
            state.agent,
            'error',
            state.sessionId,
            state.startTime,
          );
          state.doneYielded = true;
        }
        states[index] = null;
        continue;
      }

      const event = result.value;

      if (state.doneYielded) {
        // Suppress post-done events
        scheduleNext(index);
        continue;
      }

      state.sessionId = event.sessionId;
      yield event;

      if (event.type === 'done') {
        state.doneYielded = true;
        safeReturn(state.gen);
        states[index] = null;
        continue;
      }

      scheduleNext(index);
    }
  } finally {
    for (const cleanup of abortCleanups) cleanup();
    for (const state of states) {
      if (state) safeReturn(state.gen);
    }
  }
}
