// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { Cligent } from '../../cligent.js';
import type {
  CligentEvent,
  DonePayload,
  Effort,
  ErrorPayload,
  GeminiEffort,
  OpenCodeEffort,
  PermissionPolicy,
  TextDeltaPayload,
  TextPayload,
} from '../../types.js';
import { getEffortSupport } from '../../effort.js';
import { normalizeWritablePaths } from '../../permissions.js';
import { createPermissionPolicyReset } from '../../internal/permission-reset.js';
import { mapPermissionsToClaudeOptions } from '../../adapters/claude-code.js';
import { mapPermissionsToCodexOptions } from '../../adapters/codex.js';
import {
  mapEffortToGeminiModelAlias,
  mapPermissionsToGeminiToolConfig,
} from '../../adapters/gemini.js';
import { mapPermissionsToKimiOptions } from '../../adapters/kimi.js';
import {
  mapEffortToOpenCodeVariant,
  mapPermissionsToOpenCodeOptions,
} from '../../adapters/opencode.js';
import {
  AgentCallSettingsError,
  type AgentCallSettings,
  type BossTurn,
  type CallCaptainOptions,
  type CallPlayerOptions,
  type Captain,
  type CaptainContext,
  type CaptainRunResult,
  type CaptainSession,
  type CaptainTelemetry,
  type PlayerHandle,
  type PlayerRunResult,
  type RecordVisibility,
  type RunStatus,
  type RunTmuxPlayOptions,
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
  createRuntimePlayerCligent,
  resolveRuntimePlayers,
  type ResolvedPlayer,
} from './players.js';

interface ActiveTurn {
  readonly turn: BossTurn;
  readonly controller: AbortController;
  // tmux-play-22: settlement signals for the callPlayer / callCaptain calls this
  // turn admitted, joined before its terminal record dispatches.
  readonly admittedCalls: Set<Promise<void>>;
  // tmux-play-91: true once the runtime has resumed from handleBossTurn. Closing
  // admission is a state of the turn, not the end of it: the turn stays
  // reachable so ESC, an external signal, and disposal can still abort the
  // calls it already admitted, which is what bounds the join below.
  admissionClosed: boolean;
}

interface RunCligentCallOptions {
  readonly cligent: Cligent;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly instruction?: string;
  readonly permissions?: PermissionPolicy;
  readonly resetPermissionPolicy?: boolean;
  readonly signal: AbortSignal;
  readonly resume?: string | false;
  readonly allowedTools?: readonly string[];
  readonly emitEvent: (event: CligentEvent) => Promise<void>;
}

interface CligentCallResult {
  readonly status: RunStatus;
  readonly resumeToken?: string;
  readonly finalText?: string;
  readonly error?: string;
}

interface ConfiguredAgentCallSettings {
  readonly model?: string;
  readonly effort?: Effort;
  readonly instruction?: string;
  readonly permissions?: PermissionPolicy;
}

interface EffectiveAgentCallSettings extends ConfiguredAgentCallSettings {
  readonly explicit: boolean;
  readonly modelUsesProviderDefault: boolean;
  readonly effortUsesProviderDefault: boolean;
  readonly resetPermissionPolicy: boolean;
}

export class TmuxPlayRuntime {
  private readonly captain: Captain;
  private readonly captainCligent: Cligent;
  private readonly captainSettings: ConfiguredAgentCallSettings;
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
    this.captainSettings = {
      model: options.captainConfig.model,
      effort: options.captainConfig.effort,
      instruction: options.captainConfig.instruction,
      permissions: options.captainConfig.permissions,
    };
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
    const active: ActiveTurn = {
      turn,
      controller,
      admittedCalls: new Set(),
      admissionClosed: false,
    };
    this.activeTurn = active;

    try {
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
      } finally {
        // tmux-play-91 / tmux-play-22: the Captain run is the turn's scope, so
        // admission closes the instant the runtime holds control again —
        // whatever the outcome, and before the runtime takes any action of
        // its own. Closing it here rather than on each path below is what
        // keeps the boundary honest: the failure path's own
        // `controller.abort` runs abort listeners synchronously, and a
        // listener calling a context surface must find it already closed.
        // Every turn-scoped surface then rejects, so the admitted set cannot
        // grow while it is joined and a call the Captain never awaited still
        // emits its whole sequence ahead of the terminal record. The turn
        // itself stays active: abortActiveTurn needs its controller to bound
        // that join, and session-scoped emissions keep carrying its id until
        // the fence.
        active.admissionClosed = true;
      }

      await this.joinAdmittedCalls(active);
      await this.dispatcher.drain();

      // tmux-play-91 / tmux-play-21 / tmux-play-81 / tmux-play-97: fence the turn before its
      // terminal record is enqueued. Records enqueued earlier keep their
      // place ahead of it, and from here session-scoped emissions stamp the
      // null turn lane.
      this.fenceActiveTurn(turn.id);
      if (controller.signal.aborted) {
        await this.emit({
          ...makeRecordBase('turn_aborted', turn.id),
          reason: abortReason(controller.signal),
        });
      } else {
        await this.emit(makeRecordBase('turn_finished', turn.id));
      }
    } catch (error) {
      // Admission is already closed by the finally above, so the abort
      // listeners this fires synchronously cannot slip a call in behind the
      // failed run. The failure path dispatches the terminal turn_aborted
      // via handleRuntimeFailure — join before it, like the success path, so
      // a call the failed turn admitted still lands ahead of that record.
      // The abort bounds that join: every admitted call's Cligent run is
      // bound to this controller's signal.
      controller.abort(errorMessage(error));
      await this.joinAdmittedCalls(active);
      this.fenceActiveTurn(turn.id);
      await this.handleRuntimeFailure(turn.id, error);
      throw error;
    } finally {
      if (this.activeTurn?.turn.id === turn.id) {
        this.activeTurn = undefined;
      }
    }
  }

  // tmux-play-22: register a call the turn just admitted and return its release.
  // The turn-scope gate ran first, so the active turn is this call's turn,
  // and both run in one synchronous segment: passing the gate means being
  // admitted. The tracked promise resolves and never rejects, so the runtime
  // attaches no handler to the caller's own Promise — a fire-and-forget call
  // that fails stays exactly as unhandled as it is without this tracking,
  // and joining it cannot alter the turn's outcome.
  private admitCall(): () => void {
    const active = this.activeTurn;
    if (!active) {
      return () => {};
    }
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    active.admittedCalls.add(settled);
    return () => {
      active.admittedCalls.delete(settled);
      release();
    };
  }

  // tmux-play-22 / tmux-play-24: wait for the calls this turn admitted, so their
  // player_prompt → player_event* → player_finished (captain_prompt →
  // captain_event* → captain_finished) sequences dispatch before the terminal
  // record — including when the Captain never awaited the call and let
  // handleBossTurn return. One pass suffices: the caller fences before
  // joining, so a call presented from here on is rejected by the turn-scope
  // gate instead of joining the set being awaited.
  private async joinAdmittedCalls(active: ActiveTurn): Promise<void> {
    if (active.admittedCalls.size > 0) {
      await Promise.all([...active.admittedCalls]);
    }
  }

  private createContext(turn: BossTurn, signal: AbortSignal): CaptainContext {
    return {
      signal,
      players: this.playerHandles,
      // tmux-play-16 / tmux-play-91: turn-scoped calls carry this turn's id
      // and reject once admission closes, so no call's records can trail its
      // terminal record. tmux-play-22 permits a Captain to start a call without
      // awaiting it, so every surface here is `handled`: the runtime owns the
      // failure of any call whose settlement it owns.
      callPlayer: (playerId, prompt, options) =>
        handled(this.callPlayer(turn, signal, playerId, prompt, options)),
      callCaptain: (prompt, options) =>
        handled(this.callCaptain(turn, signal, prompt, options)),
      // tmux-play-97: a turn-scoped conversational reply carries this turn's id.
      emitReply: (text) => handled(this.emitTurnReply(turn, text)),
      // tmux-play-81: a turn-scoped call carries this turn's id.
      setVisiblePlayers: (playerIds) =>
        handled(this.setContextVisiblePlayers(turn, playerIds)),
    };
  }

  private async callPlayer(
    turn: BossTurn,
    signal: AbortSignal,
    playerId: string,
    prompt: string,
    options?: CallPlayerOptions,
  ): Promise<PlayerRunResult> {
    const scopeError =
      this.sessionEmissionError() ?? this.turnScopeError(turn, 'player calls');
    if (scopeError) {
      throw scopeError;
    }
    const player = this.playersById.get(playerId);
    if (!player) {
      throw new Error(`Unknown player: ${playerId}`);
    }
    const resume = selectAgentCallResume(player.cligent, options?.resume);
    const settings = resolveAgentCallSettings(
      player.adapter,
      {
        model: player.model,
        effort: player.effort,
        instruction: player.instruction,
        permissions: player.permissions,
      },
      options?.settings,
      resume,
    );

    const release = this.admitCall();
    try {
      await this.emit({
        ...makeRecordBase('player_prompt', turn.id),
        playerId,
        prompt,
      });

      const call = await runCligentCall({
        cligent: player.cligent,
        prompt,
        model: settings.model,
        effort: settings.effort,
        instruction: settings.instruction,
        permissions: settings.permissions,
        resetPermissionPolicy: settings.resetPermissionPolicy,
        signal,
        resume,
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
    } finally {
      release();
    }
  }

  private async callCaptain(
    turn: BossTurn,
    signal: AbortSignal,
    prompt: string,
    options?: CallCaptainOptions,
  ): Promise<CaptainRunResult> {
    const scopeError =
      this.sessionEmissionError() ?? this.turnScopeError(turn, 'captain calls');
    if (scopeError) {
      throw scopeError;
    }
    // Resolve once and stamp every record this call emits. A 'hidden' tag
    // lets the tmux presenter skip Boss-pane output while non-presenter
    // observers keep the full trace; the returned result is unaffected.
    const visibility: RecordVisibility = options?.visibility ?? 'visible';
    const resume = selectAgentCallResume(
      this.captainCligent,
      options?.resume,
    );
    const settings = resolveAgentCallSettings(
      this.captainCligent.agentType,
      this.captainSettings,
      options?.settings,
      resume,
    );

    const release = this.admitCall();
    try {
      await this.emit({
        ...makeRecordBase('captain_prompt', turn.id),
        prompt,
        visibility,
      });

      const call = await runCligentCall({
        cligent: this.captainCligent,
        prompt,
        model: settings.model,
        effort: settings.effort,
        instruction: settings.instruction,
        permissions: settings.permissions,
        resetPermissionPolicy: settings.resetPermissionPolicy,
        signal,
        resume,
        ...(options?.allowedTools !== undefined
          ? { allowedTools: options.allowedTools }
          : {}),
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
        ...(call.resumeToken ? { resumeToken: call.resumeToken } : {}),
        finalText: call.finalText,
        error: call.error,
      };

      await this.emit({
        ...makeRecordBase('captain_finished', turn.id),
        result,
        visibility,
      });
      return result;
    } finally {
      release();
    }
  }

  private emit(record: Parameters<RecordDispatcher['emit']>[0]): Promise<void> {
    return this.dispatcher.emit(record);
  }

  // tmux-play-97: turn-scoped counterpart of emitSessionStatus. Where the status
  // lane is session-scoped (nullable turn id, open until shutdown), a
  // conversational reply belongs to the turn that produced it: the record
  // always carries the context turn's id, and — through the shared turn-scope
  // gate, rejecting before any record is emitted — a stashed context used
  // after its turn ended (or after session shutdown) rejects instead of
  // emitting an out-of-turn record.
  private emitTurnReply(turn: BossTurn, text: string): Promise<void> {
    const error =
      this.sessionEmissionError() ??
      this.turnScopeError(turn, 'captain reply emissions');
    if (error) {
      return Promise.reject(error);
    }
    return this.dispatcher.emit({
      ...makeRecordBase('captain_reply', turn.id),
      text,
    });
  }

  // tmux-play-91 / tmux-play-81 / tmux-play-97: the single turn-scope gate every
  // turn-scoped CaptainContext surface (callPlayer, callCaptain,
  // setVisiblePlayers, emitReply) checks before emitting anything. It rejects
  // on either half of the turn's end: once admission closes, so nothing joins
  // the set being awaited; and once fenceActiveTurn invalidates the turn
  // before its terminal record is enqueued, which covers a stashed context
  // used during or after terminal dispatch — including from an observer
  // handling the terminal record — and during any later turn.
  private turnScopeError(turn: BossTurn, surface: string): Error | undefined {
    const active = this.activeTurn;
    if (active?.turn.id !== turn.id || active.admissionClosed) {
      return new Error(
        `tmux-play ${surface} are turn-scoped: the originating turn is no longer active`,
      );
    }
    return undefined;
  }

  // tmux-play-91 / tmux-play-81 / tmux-play-97: called ahead of a turn's terminal record
  // on the ordered dispatch path — the last thing before it on the completed
  // path, before the runtime_error handleRuntimeFailure emits on the failure
  // one — the one fence behind every turn-scoped surface. Invalidating the
  // active turn here makes
  // late callPlayer / callCaptain / setVisiblePlayers / emitReply calls
  // reject via the turn-scope gate, and moves late session-scoped emitStatus
  // / emitTelemetry / setVisiblePlayers onto the ordering-legal null turn
  // lane per tmux-play-21. Records enqueued before the fence keep their place
  // ahead of the terminal record on the FIFO dispatch chain.
  private fenceActiveTurn(turnId: number): void {
    if (this.activeTurn?.turn.id === turnId) {
      this.activeTurn = undefined;
    }
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

  // tmux-play-81 / tmux-play-82: validate the requested visible set and, when valid,
  // emit exactly one `player_view_changed` on the ordered, awaited dispatch
  // path. The runtime validates and emits only; pane reconciliation is the
  // tmux-play-83 layout observer's job. Validation throwing here rejects the
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

  // tmux-play-81: the turn-scoped CaptainContext variant. The turn-scope gate
  // rejects a stashed context — after the fence or during a later turn —
  // before validation, so no player_view_changed can trail the turn's
  // terminal record or misattribute a closed turn's id.
  private async setContextVisiblePlayers(
    turn: BossTurn,
    playerIds: readonly string[],
  ): Promise<void> {
    const error =
      this.sessionEmissionError() ??
      this.turnScopeError(turn, 'context setVisiblePlayers calls');
    if (error) {
      throw error;
    }
    await this.setVisiblePlayers(playerIds, turn.id);
  }

  private async setSessionVisiblePlayers(
    playerIds: readonly string[],
  ): Promise<void> {
    const error = this.sessionEmissionError();
    if (error) {
      throw error;
    }
    // tmux-play-21 / tmux-play-81: a session-scoped call carries the active turn id
    // when a turn is in flight, otherwise `null`.
    await this.setVisiblePlayers(playerIds, this.activeTurn?.turn.id ?? null);
  }

  private validatedVisiblePlayerIds(playerIds: readonly string[]): string[] {
    if (playerIds.length === 0 && this.playerHandles.length > 0) {
      throw new Error(
        'setVisiblePlayers may be empty only when the configured players roster is empty',
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

/**
 * tmux-play-22: marks a turn-scoped surface's rejection as observed.
 *
 * Starting a call without awaiting it is a supported style, and the runtime
 * both admits and joins such a call — so it owns that call's failure too. An
 * unobserved rejection here would terminate the host before the turn could
 * unwind, which is a defect of the runtime's contract rather than the
 * Captain's code. The *original* promise is returned, so a Captain that does
 * await still receives the rejection, and one that never looks changes
 * nothing about its turn's outcome. `RecordDispatcher.emit` applies the same
 * guard to the emission promise it owns.
 */
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
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
  const players = await resolveRuntimePlayers(options.players, {
    cwd: options.cwd,
    adapterImports: options.adapterImports,
  });
  const captainCligent = await createRuntimePlayerCligent(
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
      model: options.model,
      effort: options.effort,
      permissions: options.permissions,
      ...(options.resetPermissionPolicy
        ? { permissions: createPermissionPolicyReset() }
        : {}),
      ...(options.resume !== undefined ? { resume: options.resume } : {}),
      ...(options.allowedTools !== undefined
        ? { allowedTools: [...options.allowedTools] }
        : {}),
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

function resolveAgentCallSettings(
  adapter: string,
  configured: ConfiguredAgentCallSettings,
  supplied: AgentCallSettings | undefined,
  resume: string | false,
): EffectiveAgentCallSettings {
  if (supplied === undefined) {
    return {
      ...configured,
      explicit: false,
      modelUsesProviderDefault: false,
      effortUsesProviderDefault: false,
      resetPermissionPolicy: false,
    };
  }

  try {
    const snapshot = snapshotAgentCallSettings(supplied);
    const modelUsesProviderDefault = snapshot.model.kind === 'provider-default';
    const effortUsesProviderDefault =
      snapshot.effort.kind === 'provider-default';
    const settings: EffectiveAgentCallSettings = {
      model: snapshot.model.kind === 'value' ? snapshot.model.value : undefined,
      effort:
        snapshot.effort.kind === 'value' ? snapshot.effort.value : undefined,
      instruction: snapshot.instruction,
      permissions: snapshot.permissions,
      explicit: true,
      modelUsesProviderDefault,
      effortUsesProviderDefault,
      resetPermissionPolicy: false,
    };

    assertCompleteSettingsEnforceable(adapter, settings, resume);
    return withProviderPermissionReset(adapter, settings, resume);
  } catch (cause) {
    throw new AgentCallSettingsError(errorMessage(cause), cause);
  }
}

function withProviderPermissionReset(
  adapter: string,
  settings: EffectiveAgentCallSettings,
  resume: string | false,
): EffectiveAgentCallSettings {
  if (
    adapter !== 'opencode' ||
    settings.permissions !== undefined ||
    !isResumedCall(resume)
  ) {
    return settings;
  }
  return { ...settings, resetPermissionPolicy: true };
}

function snapshotAgentCallSettings(
  supplied: AgentCallSettings,
): AgentCallSettings {
  const fields = ownDataFields(supplied, 'tmux-play call settings');
  if (!fields) {
    throw new TypeError('tmux-play call settings must be a plain object');
  }
  const unknown = Object.keys(fields).filter(
    (key) =>
      key !== 'model' &&
      key !== 'effort' &&
      key !== 'instruction' &&
      key !== 'permissions',
  );
  if (unknown.length > 0) {
    throw new TypeError(
      `tmux-play call settings contain unknown field "${unknown[0]}"`,
    );
  }
  const model = snapshotTuningSelection('model', fields.model);
  const effort = snapshotTuningSelection(
    'effort',
    fields.effort,
  ) as AgentCallSettings['effort'];
  const instruction = fields.instruction;
  if (instruction !== undefined && typeof instruction !== 'string') {
    throw new TypeError('tmux-play call settings instruction must be a string');
  }
  const permissions = snapshotPermissionPolicy(fields.permissions);
  return Object.freeze({
    model,
    effort,
    ...(instruction !== undefined ? { instruction } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
  });
}

function snapshotTuningSelection(
  field: 'model' | 'effort',
  selection: unknown,
): AgentCallSettings[typeof field] {
  const fields = ownDataFields(selection, `tmux-play call settings ${field}`);
  if (!fields) {
    throw new TypeError(
      `tmux-play call settings ${field} must be a tuning selection`,
    );
  }
  if (fields.kind === 'provider-default') {
    if (Object.keys(fields).length !== 1) {
      throw new TypeError(
        `tmux-play call settings ${field} provider-default selection must not carry a value`,
      );
    }
    return Object.freeze({ kind: 'provider-default' });
  }
  if (
    fields.kind === 'value' &&
    typeof fields.value === 'string' &&
    fields.value.length > 0 &&
    Object.keys(fields).every((key) => key === 'kind' || key === 'value')
  ) {
    return Object.freeze({ kind: 'value', value: fields.value });
  }
  throw new TypeError(
    `tmux-play call settings ${field} must select a non-empty value or provider-default`,
  );
}

function assertCompleteSettingsEnforceable(
  adapter: string,
  settings: EffectiveAgentCallSettings,
  resume: string | false,
): void {
  if (
    (adapter === 'claude' || adapter === 'claude-code') &&
    isResumedCall(resume) &&
    settings.modelUsesProviderDefault
  ) {
    throw new Error(
      'Claude cannot restore the provider-default model on a resumed session',
    );
  }
  if (
    adapter === 'kimi' &&
    isResumedCall(resume) &&
    (settings.modelUsesProviderDefault ||
      settings.effortUsesProviderDefault ||
      settings.permissions === undefined)
  ) {
    throw new Error(
      'Kimi cannot restore provider-default model, effort, or permissions on a resumed session',
    );
  }
  if (
    adapter === 'opencode' &&
    isResumedCall(resume) &&
    settings.modelUsesProviderDefault
  ) {
    throw new Error(
      'OpenCode cannot restore the provider-default model on a resumed session',
    );
  }

  assertPermissionsEnforceable(adapter, settings.permissions);

  if (settings.effort === undefined) return;
  const support = getEffortSupport(
    adapter === 'claude' ? 'claude-code' : adapter,
  );
  if (!support?.values.includes(settings.effort)) {
    throw new Error(
      `Unsupported ${adapter} effort "${settings.effort}" in tmux-play call settings`,
    );
  }

  if (adapter === 'gemini') {
    if (
      !mapEffortToGeminiModelAlias(
        settings.model,
        settings.effort as GeminiEffort,
      )
    ) {
      throw new Error(
        'Gemini requires a supported concrete model to enforce a concrete per-call effort',
      );
    }
  }
  if (adapter === 'opencode') {
    if (
      !mapEffortToOpenCodeVariant(
        settings.model,
        settings.effort as OpenCodeEffort,
      )
    ) {
      throw new Error(
        'OpenCode requires a supported provider/model to enforce a concrete per-call effort',
      );
    }
  }
}

function assertPermissionsEnforceable(
  adapter: string,
  permissions: PermissionPolicy | undefined,
): void {
  switch (adapter) {
    case 'claude':
    case 'claude-code':
      mapPermissionsToClaudeOptions(permissions);
      return;
    case 'codex':
      mapPermissionsToCodexOptions(permissions);
      return;
    case 'gemini':
      mapPermissionsToGeminiToolConfig(permissions);
      return;
    case 'kimi':
      mapPermissionsToKimiOptions(permissions);
      return;
    case 'opencode':
      mapPermissionsToOpenCodeOptions(permissions);
      return;
  }
}

function selectAgentCallResume(
  cligent: Cligent,
  resume: string | false | undefined,
): string | false {
  // Prompt-record dispatch is asynchronous and observers may reenter a call
  // before the preceding terminal event updates this Cligent's stored token.
  // Pin one selection now so preflight and provider execution cannot disagree.
  return resume === undefined ? (cligent.resumeToken ?? false) : resume;
}

function isResumedCall(resume: string | false): boolean {
  return typeof resume === 'string' && resume.length > 0;
}

function ownDataFields(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    throw new TypeError(`${path} must not contain symbol fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) {
      throw new TypeError(`${path}.${key} must be enumerable`);
    }
    if (!('value' in descriptor)) {
      throw new TypeError(`${path}.${key} must not be an accessor`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotPermissionPolicy(
  value: unknown,
): PermissionPolicy | undefined {
  if (value === undefined) return undefined;
  const fields = ownDataFields(value, 'tmux-play call settings permissions');
  if (!fields) {
    throw new TypeError(
      'tmux-play call settings permissions must be a plain object',
    );
  }
  const allowed = new Set([
    'mode',
    'fileWrite',
    'shellExecute',
    'networkAccess',
    'writablePaths',
  ]);
  const unknown = Object.keys(fields).find((key) => !allowed.has(key));
  if (unknown) {
    throw new TypeError(
      `tmux-play call settings permissions contain unknown field "${unknown}"`,
    );
  }
  const permission = fields as PermissionPolicy;
  const mode = optionalEnum(
    permission.mode,
    ['auto', 'bypass'],
    'tmux-play call settings permissions.mode',
  );
  const fileWrite = optionalEnum(
    permission.fileWrite,
    ['allow', 'ask', 'deny'],
    'tmux-play call settings permissions.fileWrite',
  );
  const shellExecute = optionalEnum(
    permission.shellExecute,
    ['allow', 'ask', 'deny'],
    'tmux-play call settings permissions.shellExecute',
  );
  const networkAccess = optionalEnum(
    permission.networkAccess,
    ['allow', 'ask', 'deny'],
    'tmux-play call settings permissions.networkAccess',
  );
  const writablePathSnapshot = snapshotDenseStringArray(
    permission.writablePaths,
    'tmux-play call settings permissions.writablePaths',
  );
  const writablePaths = normalizeWritablePaths(
    writablePathSnapshot,
    'tmux-play call settings permissions.writablePaths',
  );
  return Object.freeze({
    ...(mode !== undefined ? { mode } : {}),
    ...(fileWrite !== undefined ? { fileWrite } : {}),
    ...(shellExecute !== undefined ? { shellExecute } : {}),
    ...(networkAccess !== undefined ? { networkAccess } : {}),
    ...(permission.writablePaths !== undefined
      ? { writablePaths: Object.freeze(writablePaths) as string[] }
      : {}),
  });
}

function optionalEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new TypeError(`${path} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

function snapshotDenseStringArray(
  value: unknown,
  path: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${path} must be an ordinary array`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} must not contain symbol fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const unknown = Object.keys(descriptors).find(
    (key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key),
  );
  if (unknown) {
    throw new TypeError(`${path} contains unknown field "${unknown}"`);
  }
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    throw new TypeError(`${path} must have a data length`);
  }
  const snapshot: string[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) {
      throw new TypeError(`${path} must be dense`);
    }
    if (!('value' in descriptor)) {
      throw new TypeError(`${path}[${index}] must not be an accessor`);
    }
    if (typeof descriptor.value !== 'string') {
      throw new TypeError(`${path}[${index}] must be a string`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function composePrompt(
  instruction: string | undefined,
  prompt: string,
): string {
  return instruction ? `${instruction}\n\n${prompt}` : prompt;
}

function captureText(event: CligentEvent, textParts: string[]): void {
  if (event.type === 'text') {
    // A `text` event carries one whole message. When terminal `done` brings
    // no result and finalText falls back to the captured parts, gluing whole
    // messages corrupts line-oriented final responses (a trailing
    // `Commit: <id>` line stops starting a line), so each complete message
    // begins on its own line. Deltas stay unseparated: they are fragments of
    // one message.
    if (textParts.length > 0 && !textParts[textParts.length - 1].endsWith('\n')) {
      textParts.push('\n');
    }
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
