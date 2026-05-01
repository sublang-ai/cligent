// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { Cligent } from '../../cligent.js';
import type {
  CligentEvent,
  DonePayload,
  ErrorPayload,
  TextDeltaPayload,
  TextPayload,
} from '../../types.js';
import type {
  BossTurn,
  Captain,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  CaptainTelemetry,
  RoleHandle,
  RoleRunResult,
  RunStatus,
  RunTmuxPlayOptions,
} from './contract.js';
import {
  ObserverDispatchError,
  RecordDispatcher,
  makeRecordBase,
  telemetryRecord,
  type RecordObserver,
  type RuntimeErrorRecord,
} from './records.js';
import {
  createRoleCligent,
  resolveRoles,
  type ResolvedRole,
} from './roles.js';

interface ActiveTurn {
  readonly turn: BossTurn;
  readonly controller: AbortController;
}

interface RunCligentCallOptions {
  readonly cligent: Cligent;
  readonly prompt: string;
  readonly instruction?: string;
  readonly signal: AbortSignal;
  readonly emitEvent: (event: CligentEvent) => Promise<void>;
}

interface CligentCallResult {
  readonly status: RunStatus;
  readonly finalText?: string;
  readonly error?: string;
}

export class TmuxPlayRuntime {
  private readonly captain: Captain;
  private readonly captainCligent: Cligent;
  private readonly captainInstruction: string | undefined;
  private readonly roleHandles: readonly RoleHandle[];
  private readonly rolesById: ReadonlyMap<string, ResolvedRole>;
  private readonly sessionController = new AbortController();
  private readonly session: CaptainSession;
  private readonly dispatcher = new RecordDispatcher();
  private readonly externalSignal: AbortSignal | undefined;
  private readonly removeExternalAbort: (() => void) | undefined;
  private readonly removeObservers: (() => void)[] = [];
  private nextTurnId = 1;
  private turnTail: Promise<void> = Promise.resolve();
  private activeTurn: ActiveTurn | undefined = undefined;
  private disposed = false;
  private captainDisposed = false;
  private sessionEmissionsClosed = false;

  constructor(
    options: RunTmuxPlayOptions,
    roles: readonly ResolvedRole[],
    captainCligent: Cligent,
  ) {
    this.captain = options.captain;
    this.captainCligent = captainCligent;
    this.captainInstruction = options.captainConfig.instruction;
    this.roleHandles = roles.map((role) => ({
      id: role.id,
      adapter: role.adapter,
      model: role.model,
    }));
    this.rolesById = new Map(roles.map((role) => [role.id, role]));
    this.externalSignal = options.signal;
    this.session = {
      signal: this.sessionController.signal,
      roles: this.roleHandles,
      emitStatus: (message, data) => this.emitSessionStatus(message, data),
      emitTelemetry: (event) => this.emitSessionTelemetry(event),
    };

    for (const observer of options.observers ?? []) {
      this.removeObservers.push(this.dispatcher.addObserver(observer));
    }

    if (this.externalSignal) {
      const onAbort = () =>
        this.abortActiveTurn(abortReason(this.externalSignal));
      this.externalSignal.addEventListener('abort', onAbort, { once: true });
      this.removeExternalAbort = () =>
        this.externalSignal?.removeEventListener('abort', onAbort);
    }
  }

  addObserver(observer: RecordObserver): () => void {
    const remove = this.dispatcher.addObserver(observer);
    this.removeObservers.push(remove);
    return () => {
      remove();
      const index = this.removeObservers.indexOf(remove);
      if (index !== -1) {
        this.removeObservers.splice(index, 1);
      }
    };
  }

  async initialize(): Promise<void> {
    try {
      await this.captain.init?.(this.session);
    } catch (error) {
      await this.emitRuntimeError(null, error);
      await this.shutdownSessionEmissions();
      await this.disposeCaptain();
      this.detachObservers();
      throw error;
    }
  }

  abortActiveTurn(reason = 'aborted'): void {
    if (!this.activeTurn?.controller.signal.aborted) {
      this.activeTurn?.controller.abort(reason);
    }
  }

  runBossTurn(prompt: string): Promise<void> {
    const result = this.turnTail.then(() => this.runTurn(prompt));
    this.turnTail = result.catch(() => {
      // Keep later queued turns reachable; callers still receive rejection.
    });
    return result;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abortActiveTurn('runtime disposed');
    this.removeExternalAbort?.();

    try {
      await this.turnTail;
    } catch {
      // The original runBossTurn caller observes the turn failure.
    }

    try {
      await this.shutdownSessionEmissions();
    } catch {
      // The active turn caller observes dispatcher failures. Cleanup still
      // needs to release Captain resources and detach observers.
    }

    try {
      await this.disposeCaptain();
    } finally {
      this.detachObservers();
    }
  }

  private async runTurn(prompt: string): Promise<void> {
    if (this.disposed) {
      throw new Error('tmux-play runtime is disposed');
    }

    const turn: BossTurn = {
      id: this.nextTurnId++,
      prompt,
      timestamp: Date.now(),
    };
    const controller = new AbortController();
    if (this.externalSignal?.aborted) {
      controller.abort(abortReason(this.externalSignal));
    }
    this.activeTurn = { turn, controller };

    try {
      await this.emit({
        ...makeRecordBase('turn_started', turn.id, turn.timestamp),
        turn,
      });

      if (!controller.signal.aborted) {
        await this.captain.handleBossTurn(
          turn,
          this.createContext(turn, controller.signal),
        );
      }

      await this.dispatcher.drain();

      if (controller.signal.aborted) {
        await this.emit({
          ...makeRecordBase('turn_aborted', turn.id),
          reason: abortReason(controller.signal),
        });
      } else {
        await this.emit(makeRecordBase('turn_finished', turn.id));
      }
    } catch (error) {
      controller.abort(errorMessage(error));
      await this.handleRuntimeFailure(turn.id, error);
      throw error;
    } finally {
      if (this.activeTurn?.turn.id === turn.id) {
        this.activeTurn = undefined;
      }
    }
  }

  private createContext(turn: BossTurn, signal: AbortSignal): CaptainContext {
    return {
      signal,
      roles: this.roleHandles,
      callRole: (roleId, prompt) => this.callRole(turn, signal, roleId, prompt),
      callCaptain: (prompt) => this.callCaptain(turn, signal, prompt),
    };
  }

  private async callRole(
    turn: BossTurn,
    signal: AbortSignal,
    roleId: string,
    prompt: string,
  ): Promise<RoleRunResult> {
    const role = this.rolesById.get(roleId);
    if (!role) {
      throw new Error(`Unknown role: ${roleId}`);
    }

    await this.emit({
      ...makeRecordBase('role_prompt', turn.id),
      roleId,
      prompt,
    });

    const call = await runCligentCall({
      cligent: role.cligent,
      prompt,
      instruction: role.instruction,
      signal,
      emitEvent: (event) =>
        this.emit({
          ...makeRecordBase('role_event', turn.id, event.timestamp),
          roleId,
          event,
        }),
    });
    const result: RoleRunResult = {
      status: call.status,
      roleId,
      turnId: turn.id,
      finalText: call.finalText,
      error: call.error,
    };

    await this.emit({
      ...makeRecordBase('role_finished', turn.id),
      roleId,
      result,
    });
    return result;
  }

  private async callCaptain(
    turn: BossTurn,
    signal: AbortSignal,
    prompt: string,
  ): Promise<CaptainRunResult> {
    await this.emit({
      ...makeRecordBase('captain_prompt', turn.id),
      prompt,
    });

    const call = await runCligentCall({
      cligent: this.captainCligent,
      prompt,
      instruction: this.captainInstruction,
      signal,
      emitEvent: (event) =>
        this.emit({
          ...makeRecordBase('captain_event', turn.id, event.timestamp),
          event,
        }),
    });
    const result: CaptainRunResult = {
      status: call.status,
      turnId: turn.id,
      finalText: call.finalText,
      error: call.error,
    };

    await this.emit({
      ...makeRecordBase('captain_finished', turn.id),
      result,
    });
    return result;
  }

  private emit(record: Parameters<RecordDispatcher['emit']>[0]): Promise<void> {
    return this.dispatcher.emit(record);
  }

  private emitSessionStatus(
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const error = this.sessionEmissionError();
    if (error) {
      return Promise.reject(error);
    }
    return this.dispatcher.emitStatus({
      ...makeRecordBase('captain_status', this.activeTurn?.turn.id ?? null),
      message,
      data,
    });
  }

  private emitSessionTelemetry(event: CaptainTelemetry): Promise<void> {
    const error = this.sessionEmissionError();
    if (error) {
      return Promise.reject(error);
    }
    return this.dispatcher.emitTelemetry(
      telemetryRecord(event, this.activeTurn?.turn.id ?? null),
    );
  }

  private sessionEmissionError(): Error | undefined {
    if (this.sessionEmissionsClosed || this.sessionController.signal.aborted) {
      return new Error('tmux-play session emissions are closed');
    }
    return undefined;
  }

  private async handleRuntimeFailure(
    turnId: number,
    error: unknown,
  ): Promise<void> {
    if (!(error instanceof ObserverDispatchError)) {
      await this.emitRuntimeError(turnId, error);
      await this.dispatcher.drain();
      await this.dispatcher.emit({
        ...makeRecordBase('turn_aborted', turnId),
        reason: errorMessage(error),
      });
    }
  }

  private async emitRuntimeError(
    turnId: number | null,
    error: unknown,
  ): Promise<void> {
    const runtimeError: RuntimeErrorRecord = {
      ...makeRecordBase('runtime_error', turnId),
      message: errorMessage(error),
    };
    await this.dispatcher.emit(runtimeError);
    await this.dispatcher.drain();
  }

  private async shutdownSessionEmissions(): Promise<void> {
    if (!this.sessionController.signal.aborted) {
      this.sessionController.abort('runtime disposed');
    }
    this.sessionEmissionsClosed = true;
    await this.dispatcher.drain();
  }

  private async disposeCaptain(): Promise<void> {
    if (!this.captainDisposed) {
      this.captainDisposed = true;
      await this.captain.dispose?.();
    }
  }

  private detachObservers(): void {
    for (const remove of this.removeObservers.splice(0)) {
      remove();
    }
  }
}

export async function createTmuxPlayRuntime(
  options: RunTmuxPlayOptions,
): Promise<TmuxPlayRuntime> {
  const roles = await resolveRoles(options.roles, {
    cwd: options.cwd,
    adapterImports: options.adapterImports,
  });
  const captainCligent = await createRoleCligent(options.captainConfig.adapter, {
    cwd: options.cwd,
    model: options.captainConfig.model,
    role: 'captain',
    adapterImports: options.adapterImports,
  });
  const runtime = new TmuxPlayRuntime(options, roles, captainCligent);
  await runtime.initialize();
  return runtime;
}

async function runCligentCall(
  options: RunCligentCallOptions,
): Promise<CligentCallResult> {
  const gen = options.cligent.run(
    composePrompt(options.instruction, options.prompt),
    {
      abortSignal: options.signal,
    },
  );
  const textParts: string[] = [];
  let donePayload: DonePayload | undefined;
  let lastError: string | undefined;
  let completed = false;

  try {
    while (true) {
      let next: IteratorResult<CligentEvent, void>;
      try {
        next = await gen.next();
      } catch (error) {
        return {
          status: options.signal.aborted ? 'aborted' : 'error',
          error: errorMessage(error),
        };
      }

      if (next.done) {
        completed = true;
        break;
      }

      const event = next.value;
      captureText(event, textParts);
      if (event.type === 'error') {
        lastError = (event.payload as ErrorPayload).message;
      }
      if (event.type === 'done') {
        donePayload = event.payload as DonePayload;
      }
      await options.emitEvent(event);
    }
  } finally {
    if (!completed) {
      try {
        await gen.return(undefined as never);
      } catch {
        // The caller already has the original failure path.
      }
    }
  }

  const status = donePayload ? runStatus(donePayload.status) : 'error';
  const finalText =
    donePayload?.result ??
    (textParts.length > 0 ? textParts.join('') : undefined);
  const error =
    status === 'error'
      ? (donePayload?.result ?? lastError ?? 'Agent run failed')
      : undefined;

  return {
    status,
    finalText,
    error,
  };
}

function composePrompt(instruction: string | undefined, prompt: string): string {
  return instruction ? `${instruction}\n\n${prompt}` : prompt;
}

function captureText(event: CligentEvent, textParts: string[]): void {
  if (event.type === 'text') {
    textParts.push((event.payload as TextPayload).content);
  } else if (event.type === 'text_delta') {
    textParts.push((event.payload as TextDeltaPayload).delta);
  }
}

function runStatus(status: DonePayload['status']): RunStatus {
  if (status === 'success') {
    return 'ok';
  }
  if (status === 'interrupted') {
    return 'aborted';
  }
  return 'error';
}

function abortReason(signal: AbortSignal | undefined): string {
  if (!signal?.aborted) {
    return 'aborted';
  }
  return errorMessage(signal.reason ?? 'aborted');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
