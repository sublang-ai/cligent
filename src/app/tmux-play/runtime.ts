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
  CallCaptainOptions,
  CallPlayerOptions,
  Captain,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  CaptainTelemetry,
  PlayerHandle,
  PlayerRunResult,
  RecordVisibility,
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
  createPlayerCligent,
  resolvePlayers,
  type ResolvedPlayer,
} from './players.js';

interface ActiveTurn {
  readonly turn: BossTurn;
  readonly controller: AbortController;
}

interface RunCligentCallOptions {
  readonly cligent: Cligent;
  readonly prompt: string;
  readonly instruction?: string;
  readonly signal: AbortSignal;
  readonly resume?: string | false;
  readonly emitEvent: (event: CligentEvent) => Promise<void>;
}

interface CligentCallResult {
  readonly status: RunStatus;
  readonly resumeToken?: string;
  readonly finalText?: string;
  readonly error?: string;
}

export class TmuxPlayRuntime {
  private readonly captain: Captain;
  private readonly captainCligent: Cligent;
  private readonly captainInstruction: string | undefined;
  private readonly playerHandles: readonly PlayerHandle[];
  private readonly playersById: ReadonlyMap<string, ResolvedPlayer>;
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
  private disposePromise: Promise<void> | undefined;
  private captainPrepared = false;
  private captainDisposed = false;
  private sessionEmissionsClosed = false;

  constructor(
    options: RunTmuxPlayOptions,
    players: readonly ResolvedPlayer[],
    captainCligent: Cligent,
  ) {
    this.captain = options.captain;
    this.captainCligent = captainCligent;
    this.captainInstruction = options.captainConfig.instruction;
    this.playerHandles = players.map((player) => ({
      id: player.id,
      adapter: player.adapter,
      model: player.model,
    }));
    this.playersById = new Map(players.map((player) => [player.id, player]));
    this.externalSignal = options.signal;
    this.session = {
      signal: this.sessionController.signal,
      players: this.playerHandles,
      emitStatus: (message, data) => this.emitSessionStatus(message, data),
      emitTelemetry: (event) => this.emitSessionTelemetry(event),
      setVisiblePlayers: (playerIds) =>
        this.setSessionVisiblePlayers(playerIds),
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
      const failures: unknown[] = [error];
      try {
        await this.emitRuntimeError(null, error);
      } catch (reportingError) {
        collectFailure(failures, reportingError);
      }
      try {
        await this.dispose();
      } catch (cleanupError) {
        collectFailure(failures, cleanupError);
      }
      throwFailures(failures, 'tmux-play initialization failed');
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

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposed = true;
      // Install the shared promise before any abort listener can re-enter
      // dispose() synchronously from performDispose().
      this.disposePromise = Promise.resolve().then(() => this.performDispose());
    }
    return this.disposePromise;
  }

  private async performDispose(): Promise<void> {
    const failures: unknown[] = [];
    this.abortActiveTurn('runtime disposed');
    try {
      this.removeExternalAbort?.();
    } catch (error) {
      collectFailure(failures, error);
    }

    try {
      await this.turnTail;
    } catch {
      // The original runBossTurn caller observes the turn failure.
    }

    let dispatchFailureBeforePrepare: unknown;
    try {
      await this.dispatcher.drain();
    } catch (error) {
      // Preserve the legacy handling for an earlier dispatcher failure. A
      // new failure caused by prepareDispose is still surfaced below.
      dispatchFailureBeforePrepare = error;
    }

    try {
      await this.prepareCaptain();
    } catch (error) {
      collectFailure(failures, error);
      if (!(error instanceof ObserverDispatchError)) {
        try {
          await this.emitRuntimeError(null, error);
        } catch (reportingError) {
          collectFailure(failures, reportingError);
        }
      }
    }

    try {
      await this.shutdownSessionEmissions();
    } catch (error) {
      // A caller may also observe this dispatcher failure, but teardown
      // retains a new pre-close failure so it is never silent.
      if (!Object.is(error, dispatchFailureBeforePrepare)) {
        collectFailure(failures, error);
      }
    }

    try {
      await this.disposeCaptain();
    } catch (error) {
      collectFailure(failures, error);
    } finally {
      this.detachObservers();
    }

    if (failures.length > 0) {
      throwFailures(failures, 'tmux-play disposal failed');
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
      players: this.playerHandles,
      callPlayer: (playerId, prompt, options) =>
        this.callPlayer(turn, signal, playerId, prompt, options),
      callCaptain: (prompt, options) =>
        this.callCaptain(turn, signal, prompt, options),
      // TMUX-081: a turn-scoped call carries this turn's id.
      setVisiblePlayers: (playerIds) =>
        this.setVisiblePlayers(playerIds, turn.id),
    };
  }

  private async callPlayer(
    turn: BossTurn,
    signal: AbortSignal,
    playerId: string,
    prompt: string,
    options?: CallPlayerOptions,
  ): Promise<PlayerRunResult> {
    const player = this.playersById.get(playerId);
    if (!player) {
      throw new Error(`Unknown player: ${playerId}`);
    }

    await this.emit({
      ...makeRecordBase('player_prompt', turn.id),
      playerId,
      prompt,
    });

    const call = await runCligentCall({
      cligent: player.cligent,
      prompt,
      instruction: player.instruction,
      signal,
      ...(options?.resume !== undefined ? { resume: options.resume } : {}),
      emitEvent: (event) =>
        this.emit({
          ...makeRecordBase('player_event', turn.id, event.timestamp),
          playerId,
          event,
        }),
    });
    const result: PlayerRunResult = {
      status: call.status,
      playerId,
      turnId: turn.id,
      ...(call.resumeToken ? { resumeToken: call.resumeToken } : {}),
      finalText: call.finalText,
      error: call.error,
    };

    await this.emit({
      ...makeRecordBase('player_finished', turn.id),
      playerId,
      result,
    });
    return result;
  }

  private async callCaptain(
    turn: BossTurn,
    signal: AbortSignal,
    prompt: string,
    options?: CallCaptainOptions,
  ): Promise<CaptainRunResult> {
    // Resolve once and stamp every record this call emits. A 'hidden' tag
    // lets the tmux presenter skip Boss-pane output while non-presenter
    // observers keep the full trace; the returned result is unaffected.
    const visibility: RecordVisibility = options?.visibility ?? 'visible';

    await this.emit({
      ...makeRecordBase('captain_prompt', turn.id),
      prompt,
      visibility,
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
          visibility,
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
      visibility,
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

  // TMUX-081 / TMUX-082: validate the requested visible set and, when valid,
  // emit exactly one `player_view_changed` on the ordered, awaited dispatch
  // path. The runtime validates and emits only; pane reconciliation is the
  // TMUX-083 layout observer's job. Validation throwing here rejects the
  // returned Promise before any record is emitted, so a rejected call leaves
  // the layout observer's tracked visible set unchanged.
  private async setVisiblePlayers(
    playerIds: readonly string[],
    turnId: number | null,
  ): Promise<void> {
    const visiblePlayerIds = this.validatedVisiblePlayerIds(playerIds);
    await this.dispatcher.emit({
      ...makeRecordBase('player_view_changed', turnId),
      visiblePlayerIds,
    });
  }

  private async setSessionVisiblePlayers(
    playerIds: readonly string[],
  ): Promise<void> {
    const error = this.sessionEmissionError();
    if (error) {
      throw error;
    }
    // TMUX-021 / TMUX-081: a session-scoped call carries the active turn id
    // when a turn is in flight, otherwise `null`.
    await this.setVisiblePlayers(playerIds, this.activeTurn?.turn.id ?? null);
  }

  private validatedVisiblePlayerIds(playerIds: readonly string[]): string[] {
    if (playerIds.length === 0) {
      throw new Error(
        'setVisiblePlayers requires at least one player id: tmux-play has no zero-player visible layout',
      );
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of playerIds) {
      if (!this.playersById.has(id)) {
        throw new Error(`setVisiblePlayers: unknown player id "${id}"`);
      }
      if (seen.has(id)) {
        throw new Error(`setVisiblePlayers: duplicate player id "${id}"`);
      }
      seen.add(id);
      result.push(id);
    }
    return result;
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

  private async prepareCaptain(): Promise<void> {
    if (!this.captainPrepared) {
      this.captainPrepared = true;
      await this.captain.prepareDispose?.();
    }
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

function collectFailure(failures: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      collectFailure(failures, nested);
    }
    return;
  }
  if (!failures.some((failure) => Object.is(failure, error))) {
    failures.push(error);
  }
}

function throwFailures(failures: readonly unknown[], context: string): never {
  if (failures.length === 1) {
    throw failures[0];
  }
  throw new AggregateError(
    failures,
    `${context}: ${failures.map(errorMessage).join('; ')}`,
  );
}

export async function createTmuxPlayRuntime(
  options: RunTmuxPlayOptions,
): Promise<TmuxPlayRuntime> {
  const players = await resolvePlayers(options.players, {
    cwd: options.cwd,
    adapterImports: options.adapterImports,
  });
  const captainCligent = await createPlayerCligent(
    options.captainConfig.adapter,
    {
      cwd: options.cwd,
      model: options.captainConfig.model,
      role: 'captain',
      permissions: options.captainConfig.permissions,
      effort: options.captainConfig.effort,
      adapterImports: options.adapterImports,
    },
  );
  const runtime = new TmuxPlayRuntime(options, players, captainCligent);
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
      ...(options.resume !== undefined ? { resume: options.resume } : {}),
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
    ...(donePayload?.resumeToken
      ? { resumeToken: donePayload.resumeToken }
      : {}),
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
