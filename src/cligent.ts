// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  CligentEvent,
  CligentOptions,
  DonePayload,
  PermissionPolicy,
  RunOptions,
} from './types.js';
import { safeReturn, raceAbort, makeSynthDone, makeSynthError } from './protocol.js';
import { generateSessionId } from './events.js';

export interface CligentParallelTask {
  agent: Cligent;
  prompt: string;
  overrides?: RunOptions;
}

function injectRole(event: AgentEvent, role: string | undefined): CligentEvent {
  if (role === undefined) return event as CligentEvent;
  return { ...event, role };
}

function resolveResume(
  override: string | false | undefined,
  storedToken: string | undefined,
): string | undefined {
  if (override === false) return undefined;
  if (typeof override === 'string') return override;
  return storedToken;
}

function mergePermissions(
  defaults: PermissionPolicy | undefined,
  overrides: PermissionPolicy | undefined,
): PermissionPolicy | undefined {
  if (!defaults && !overrides) return undefined;
  if (!defaults) return overrides;
  if (!overrides) return defaults;
  return { ...defaults, ...overrides };
}

function mergeOptions(
  defaults: CligentOptions,
  overrides: RunOptions | undefined,
): { merged: RunOptions; role: string | undefined } {
  if (!overrides) {
    return {
      merged: { ...defaults },
      role: defaults.role,
    };
  }

  const merged: RunOptions = {
    cwd: overrides.cwd ?? defaults.cwd,
    model: overrides.model ?? defaults.model,
    permissions: mergePermissions(defaults.permissions, overrides.permissions),
    maxTurns: overrides.maxTurns ?? defaults.maxTurns,
    maxBudgetUsd: overrides.maxBudgetUsd ?? defaults.maxBudgetUsd,
    allowedTools: overrides.allowedTools ?? defaults.allowedTools,
    disallowedTools: overrides.disallowedTools ?? defaults.disallowedTools,
    abortSignal: overrides.abortSignal,
    resume: overrides.resume,
  };

  return {
    merged,
    role: defaults.role,
  };
}

export class Cligent {
  private readonly adapter: AgentAdapter;
  private readonly defaults: CligentOptions;
  private _resumeToken: string | undefined = undefined;
  private _running = false;

  constructor(adapter: AgentAdapter, options?: CligentOptions) {
    this.adapter = adapter;
    this.defaults = options ?? {};
  }

  get agentType(): string {
    return this.adapter.agent;
  }

  get role(): string | undefined {
    return this.defaults.role;
  }

  get resumeToken(): string | undefined {
    return this._resumeToken;
  }

  async *run(
    prompt: string,
    overrides?: RunOptions,
  ): AsyncGenerator<CligentEvent, void, void> {
    if (this._running) {
      throw new Error('Cligent.run() is already active on this instance');
    }

    this._running = true;
    const { merged, role } = mergeOptions(this.defaults, overrides);

    const resume = resolveResume(merged.resume, this._resumeToken);

    const agentOptions: AgentOptions = {
      cwd: merged.cwd,
      model: merged.model,
      permissions: merged.permissions,
      maxTurns: merged.maxTurns,
      maxBudgetUsd: merged.maxBudgetUsd,
      allowedTools: merged.allowedTools,
      disallowedTools: merged.disallowedTools,
      abortSignal: merged.abortSignal,
      resume,
    };

    const agent = this.adapter.agent;
    const sessionId = generateSessionId();
    const startTime = Date.now();
    const signal = agentOptions.abortSignal;

    try {
      // Pre-abort short-circuit (ENG-009)
      if (signal?.aborted) {
        yield injectRole(
          makeSynthDone(agent, 'interrupted', sessionId, startTime),
          role,
        );
        return;
      }

      let lastSessionId = sessionId;
      const gen = this.adapter.run(prompt, agentOptions);
      let doneYielded = false;

      try {
        while (true) {
          let result: IteratorResult<AgentEvent, void>;
          try {
            result = await raceAbort(gen.next(), signal);
          } catch (err) {
            // Adapter threw (ENG-008)
            if (!doneYielded) {
              const msg = err instanceof Error ? err.message : String(err);
              yield injectRole(
                makeSynthError(agent, 'ADAPTER_ERROR', msg, lastSessionId),
                role,
              );
              yield injectRole(
                makeSynthDone(agent, 'error', lastSessionId, startTime),
                role,
              );
              doneYielded = true;
              this.captureResumeToken(undefined);
            }
            safeReturn(gen);
            return;
          }

          // Abort after awaiting (ENG-009)
          if (signal?.aborted) {
            if (!doneYielded) {
              yield injectRole(
                makeSynthDone(agent, 'interrupted', lastSessionId, startTime),
                role,
              );
              doneYielded = true;
            }
            safeReturn(gen);
            return;
          }

          if (result.done) {
            // Generator exhausted without done (ENG-012)
            if (!doneYielded) {
              yield injectRole(
                makeSynthError(
                  agent,
                  'MISSING_DONE',
                  'Protocol violation: adapter completed without terminal event',
                  lastSessionId,
                ),
                role,
              );
              yield injectRole(
                makeSynthDone(agent, 'error', lastSessionId, startTime),
                role,
              );
              doneYielded = true;
              this.captureResumeToken(undefined);
            }
            return;
          }

          const event = result.value;

          // Post-done suppression (ENG-010)
          if (doneYielded) {
            continue;
          }

          lastSessionId = event.sessionId;
          yield injectRole(event, role);

          if (event.type === 'done') {
            doneYielded = true;
            // Capture resume token from adapter's done payload (ENG-005)
            const payload = event.payload as DonePayload;
            this.captureResumeToken(payload.resumeToken);
            safeReturn(gen);
            return;
          }
        }
      } finally {
        if (!doneYielded) {
          safeReturn(gen);
        }
      }
    } finally {
      this._running = false;
    }
  }

  static async *parallel(
    tasks: CligentParallelTask[],
  ): AsyncGenerator<CligentEvent, void, void> {
    if (tasks.length === 0) return;

    interface StreamState {
      gen: AsyncGenerator<CligentEvent, void, void>;
      index: number;
    }

    const states: (StreamState | null)[] = tasks.map((task, index) => ({
      gen: task.agent.run(task.prompt, task.overrides),
      index,
    }));

    const pending = new Map<number, Promise<{ index: number; result?: IteratorResult<CligentEvent, void>; error?: unknown; isError: boolean }>>();

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

    for (let i = 0; i < states.length; i++) {
      scheduleNext(i);
    }

    try {
      while (pending.size > 0) {
        const raceResult = await Promise.race([...pending.values()]);
        const { index } = raceResult;
        pending.delete(index);

        if (raceResult.isError) {
          // run() normally handles its own errors, but if the generator
          // itself throws (e.g. single-flight), yield synthetic error + done
          // so the caller sees every task complete (ENG-015).
          const task = tasks[index];
          const agentName = task.agent.agentType;
          const taskRole = task.agent.role;
          const sid = generateSessionId();
          const msg = raceResult.error instanceof Error
            ? raceResult.error.message
            : String(raceResult.error);
          yield injectRole(makeSynthError(agentName, 'PARALLEL_TASK_ERROR', msg, sid), taskRole);
          yield injectRole(makeSynthDone(agentName, 'error', sid, Date.now()), taskRole);
          states[index] = null;
          continue;
        }

        const result = raceResult.result!;
        if (result.done) {
          states[index] = null;
          continue;
        }

        yield result.value;
        scheduleNext(index);
      }
    } finally {
      for (const state of states) {
        if (state) {
          try {
            state.gen.return(undefined as never).catch(() => {});
          } catch {
            // swallow cleanup errors
          }
        }
      }
    }
  }

  private captureResumeToken(token: string | undefined): void {
    this._resumeToken = token;
  }
}
