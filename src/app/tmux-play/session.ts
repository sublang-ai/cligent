// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { closeLogStreams, openAppendLogStreams } from '../shared/logs.js';
import {
  isolateOrchestratorFromAgents,
  isOrchestratorInTmux,
  killTmuxSession,
  queryPaneWidthsByTitle,
} from '../shared/tmux.js';
import { playerPaneTitle } from './pane-title.js';
import type {
  Captain,
  RuntimePlayerConfig,
  RunTmuxPlayOptions,
} from './contract.js';
import {
  TMUX_PLAY_CONFIG_SNAPSHOT,
  type CaptainConfig,
  type TmuxPlayConfig,
} from './config.js';
import { createTmuxPresenter, type WidthSource } from './presenter-tmux.js';
import {
  SGR_RESET,
  bold24bitFg,
  presenterPalette,
  type CatppuccinFlavor,
} from './player-colors.js';
import {
  ObserverDispatchError,
  type CaptainReplyRecord,
  type RecordObserver,
  type TmuxPlayRecord,
  type TurnAbortedRecord,
  type TurnFinishedRecord,
} from './records.js';
import { createFollowObserver } from './follow-observer.js';
import { wrapScrollbackSafeOutput } from './scrollback-safe-output.js';
import { createNotificationObserver } from './notification-observer.js';
import { createLayoutObserver } from './layout-observer.js';
import { createTmuxPlayRuntime, type TmuxPlayRuntime } from './runtime.js';
import {
  createTimingObserver,
  type CreateTimingObserverOptions,
  type TimingObserverHandle,
} from './timing-observer.js';
import {
  isKnownPlayerAdapter,
  type PlayerAdapterImports,
  type PlayerConfig,
} from './players.js';
import {
  assertManagedTmuxPlaySessionId,
  TMUX_PLAY_WORK_DIR_OWNER_MARKER,
} from './launcher.js';

export type TmuxPlayRuntimeHandle = Pick<
  TmuxPlayRuntime,
  'abortActiveTurn' | 'dispose' | 'runBossTurn'
>;

export interface ManagedTmuxPlayInitializeContext {
  readonly sessionId: string;
  readonly config: TmuxPlayConfig;
  readonly observers: readonly RecordObserver[];
  readonly cwd?: string;
}

export interface ManagedTmuxPlayTurnContext {
  readonly sessionId: string;
  readonly prompt: string;
}

export interface ManagedTmuxPlayAfterTurnContext extends ManagedTmuxPlayTurnContext {
  readonly replies: readonly CaptainReplyRecord[];
  readonly terminal: ManagedTmuxPlayTerminalRecord;
}

export type ManagedTmuxPlayTerminalRecord =
  TurnFinishedRecord | TurnAbortedRecord;

export interface ManagedTmuxPlayShutdownContext {
  readonly sessionId: string;
  readonly reason: string;
  readonly error?: unknown;
}

/**
 * Lifecycle owned by an embedding session process. Initialization returns an
 * already initialized-or-restored runtime and must register the supplied
 * observers. Turn hooks bracket agent work and transactional reply release.
 */
export interface ManagedTmuxPlayLifecycle {
  initializeRuntime(
    context: ManagedTmuxPlayInitializeContext,
  ): Promise<TmuxPlayRuntimeHandle>;
  beforeNonEmptyTurn(context: ManagedTmuxPlayTurnContext): Promise<void>;
  afterTurn(context: ManagedTmuxPlayAfterTurnContext): Promise<void>;
  shutdown(context: ManagedTmuxPlayShutdownContext): Promise<void>;
}

const READLINE_ESCAPE_CODE_TIMEOUT_MS = 100;
const BRACKETED_PASTE_ENABLE = '\x1b[?2004h';
const BRACKETED_PASTE_DISABLE = '\x1b[?2004l';

interface Keypress {
  readonly name?: string;
  readonly sequence?: string;
}

interface ReadlineLike {
  setPrompt(prompt: string): void;
  prompt(): void;
  on(event: 'line', listener: (line: string) => void): this;
  on(event: 'close', listener: () => void): this;
  close(): void;
}

type ShutdownSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';

interface SignalTarget {
  on(event: ShutdownSignal, listener: () => void): unknown;
  off?(event: ShutdownSignal, listener: () => void): unknown;
  removeListener?(event: ShutdownSignal, listener: () => void): unknown;
}

interface LogCloser {
  end(): unknown;
}

export interface TmuxPlaySessionOptions {
  readonly sessionId: string;
  readonly workDir: string;
  /** @internal Recursive cleanup capability issued only by the launcher. */
  readonly workDirOwnedByLauncher?: boolean;
  readonly cwd?: string;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly adapterImports?: PlayerAdapterImports;
  readonly observers?: readonly RecordObserver[];
  readonly createReadline?: (options: {
    input: Readable;
    output: Writable;
    escapeCodeTimeout: number;
  }) => ReadlineLike;
  readonly createRuntime?: (
    options: RunTmuxPlayOptions,
  ) => Promise<TmuxPlayRuntimeHandle>;
  readonly createTimingObserver?: (
    options: CreateTimingObserverOptions,
  ) => TimingObserverHandle;
  readonly importCaptain?: (specifier: string) => Promise<unknown>;
  readonly killSession?: (sessionName: string) => void;
  readonly removeWorkDir?: (workDir: string) => void;
  readonly signalTarget?: SignalTarget;
  // Width query for player panes (keyed by title-cased player id). Defaults to a
  // tmux query that returns an empty map outside tmux; tests can stub this to
  // pin widths without spawning tmux.
  readonly queryPaneWidths?: (sessionName: string) => Map<string, number>;
  /** @internal Used by runManagedTmuxPlaySession. */
  readonly managedLifecycle?: ManagedTmuxPlayLifecycle;
  /** @internal Used by runManagedTmuxPlaySession. */
  readonly managedReadinessPath?: string;
  /** @internal Used by runManagedTmuxPlaySession. */
  readonly managedInputGatePath?: string;
  /** @internal Used by runManagedTmuxPlaySession. */
  readonly managedInputActivePath?: string;
  /** @internal Used by runManagedTmuxPlaySession. */
  readonly managedShutdownRequestPath?: string;
  /** @internal Used by runManagedTmuxPlaySession. */
  readonly managedShutdownCompletePath?: string;
}

export type ManagedTmuxPlaySessionOptions = Omit<
  TmuxPlaySessionOptions,
  | 'createRuntime'
  | 'importCaptain'
  | 'managedLifecycle'
  | 'managedReadinessPath'
  | 'managedInputGatePath'
  | 'managedInputActivePath'
  | 'managedShutdownRequestPath'
  | 'managedShutdownCompletePath'
  | 'workDirOwnedByLauncher'
> & {
  readonly readinessPath: string;
  readonly inputGatePath: string;
  readonly inputActivePath: string;
  readonly shutdownRequestPath: string;
  readonly shutdownCompletePath: string;
  readonly workDirOwnedByLauncher: boolean;
  readonly lifecycle: ManagedTmuxPlayLifecycle;
};

export class TmuxPlaySession {
  private readonly options: TmuxPlaySessionOptions;
  private readonly doneDeferred = deferred<void>();
  private readonly signalHandlers: Array<{
    readonly event: ShutdownSignal;
    readonly listener: () => void;
  }> = [];
  private readline: ReadlineLike | undefined;
  private runtime: TmuxPlayRuntimeHandle | undefined;
  private logStreams: Map<string, LogCloser> | undefined;
  private timingObserver: TimingObserverHandle | undefined;
  private pending = Promise.resolve();
  private startup = Promise.resolve();
  private shuttingDown = false;
  private playerPaneWidths: Map<string, number> = new Map();
  private resizeTarget: Writable | undefined;
  private resizeListener: (() => void) | undefined;
  private keypressTarget: Readable | undefined;
  private keypressListener:
    ((str: string | undefined, key: Keypress) => void) | undefined;
  private activeBossTurn = false;
  // tmux-play-75: count of Boss turns that have been submitted but not yet finished
  // — the one currently running plus any lines the Boss submitted behind it that
  // queued for the serialized runtime (tmux-play-18). A fresh ready `boss> ` prompt
  // is painted only when this reaches zero, so no spurious prompt appears between
  // consecutive queued turns or amid an active turn's streaming output.
  private pendingTurns = 0;
  // tmux-play-75: the colored `boss> ` prompt string is captured at start so the
  // turn-active suspension can blank the prompt and restore this exact value
  // at turn end. `terminalInput` records whether stdin is a TTY; outside a TTY
  // the readline runs in non-terminal mode (no echo), so the suspension is a
  // no-op per tmux-play-75.
  private bossPrompt = '';
  private terminalInput = false;
  private bracketedPasteEnabled = false;
  private inPaste = false;
  private pasteAwaitingSubmit = false;
  private pasteBuffer: string[] = [];
  private exitPasteCleanup: (() => void) | undefined;
  private presentationGate: ManagedPresentationGate | undefined;
  private acceptingInput = false;
  private readonly preActivationPrompts: string[] = [];
  private shutdownPromise: Promise<void> | undefined;
  private readonly shutdownErrors: unknown[] = [];
  private managedReadinessPublished = false;
  private managedShutdownPoll: ReturnType<typeof setTimeout> | undefined;

  readonly done: Promise<void> = this.doneDeferred.promise;

  constructor(options: TmuxPlaySessionOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const config = await readConfigSnapshot(this.options.workDir);
    const playerIds = config.players.map((player) => player.id);
    const output = this.options.output ?? process.stdout;
    const logStreams = openAppendLogStreams(
      this.options.workDir,
      playerIds,
      (playerId, error) => {
        output.write(`[${playerId}] log write error: ${error.message}\n`);
      },
    );
    this.logStreams = logStreams;

    this.refreshPlayerPaneWidths();
    this.subscribeToResize(output);
    const playerWidths = new Map<string, WidthSource>();
    for (const player of config.players) {
      const title = playerPaneTitle(player.id, player.adapter);
      playerWidths.set(
        player.id,
        () => this.playerPaneWidths.get(title) ?? Number.POSITIVE_INFINITY,
      );
    }
    const playerAdapters = new Map(
      config.players.map((player) => [player.id, player.adapter]),
    );
    // The snapshot carries the launcher-resolved Catppuccin flavor
    // (mocha | latte) per tmux-play-194, so prefix / status / tool SGRs in
    // pane content — including the readline prompt below — match the
    // flavor of the tmux chrome.
    const themeFlavor: CatppuccinFlavor =
      config.theme === 'latte' ? 'latte' : 'mocha';
    const presenter = createTmuxPresenter({
      boss: output,
      players: logStreams,
      bossWidth: () => outputWidth(output),
      playerWidths,
      playerAdapters,
      themeFlavor,
    });
    const timingObserver = (
      this.options.createTimingObserver ?? createTimingObserver
    )({
      sessionName: this.sessionName(),
      captainAdapter: config.captain.adapter,
      players: config.players,
    });
    this.timingObserver = timingObserver;
    timingObserver.refresh();

    // tmux-play-69: return a scrolled-back (copy-mode) pane to its live tail when
    // the session writes new content to it, so streaming output is visible
    // even after a wheel-scroll. Display-only and failure-swallowing like the
    // timing observer; registered after the presenter so a pane's follow runs
    // once the presenter has put the new bytes on it.
    const followObserver = createFollowObserver({
      sessionName: this.sessionName(),
      captainAdapter: config.captain.adapter,
      players: config.players,
    });
    const notificationObserver = createNotificationObserver({
      notifications: config.notifications,
      output,
    });
    // tmux-play-83: reconcile the visible player panes on each accepted
    // `player_view_changed` via a full player-area rebuild. Display-only and
    // failure-swallowing; registered first so its rebuild runs before later
    // records for a newly visible player are presented.
    const layoutObserver = createLayoutObserver({
      sessionName: this.sessionName(),
      workDir: this.options.workDir,
      players: config.players,
      layout: config.layout,
      captainAdapter: config.captain.adapter,
      themeFlavor,
      initialVisible: config.layout.initialVisible,
      onError: (error) =>
        output.write(
          `[layout] visibility update failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        ),
    });

    const observers = [
      layoutObserver,
      presenter,
      followObserver,
      timingObserver,
      notificationObserver,
      ...(this.options.observers ?? []),
    ];
    if (this.options.managedLifecycle) {
      this.presentationGate = new ManagedPresentationGate(observers);
      this.runtime = await this.options.managedLifecycle.initializeRuntime({
        sessionId: this.options.sessionId,
        config,
        observers: [this.presentationGate],
        cwd: this.options.cwd,
      });
      if (this.shuttingDown) return;
    } else {
      const captain = await loadCaptain(
        config.captain.from,
        config.captain.options,
        this.options.importCaptain,
      );
      const createRuntime = this.options.createRuntime ?? createTmuxPlayRuntime;
      this.runtime = await createRuntime({
        captain,
        captainConfig: runtimeCaptain(config.captain),
        players: runtimePlayers(config.players),
        observers,
        cwd: this.options.cwd,
        adapterImports: this.options.adapterImports,
      });
    }

    const input = this.options.input ?? process.stdin;
    this.terminalInput = isTty(input);
    // tmux-play-79: route the readline's redraws through a scrollback-safe wrapper
    // so its per-edit `clearScreenDown` does not scroll the Boss prompt's
    // intermediate edit states into the pane's tmux history. The presenter
    // keeps writing to the raw `output`, so streamed turn output still scrolls
    // into history as before. Only meaningful when output is a TTY (a real tmux
    // pane); a non-terminal readline emits no redraw escapes to rewrite.
    const readlineOutput = isTty(output)
      ? wrapScrollbackSafeOutput(output)
      : output;
    this.readline = (this.options.createReadline ?? createInterface)({
      input,
      output: readlineOutput,
      escapeCodeTimeout: READLINE_ESCAPE_CODE_TIMEOUT_MS,
    });
    // tmux-play-37: color the `boss> ` prefix with the boss role color from
    // the resolved flavor (Mocha `#89b4fa` on dark, Latte `#1e66f5` on
    // light), so the prompt keeps contrast against the user's terminal
    // background. Node ≥18's readline strips ANSI escapes when computing
    // prompt visible width (via getStringWidth), so cursor positioning
    // still treats the prompt as 6 cells wide.
    this.bossPrompt = `${bold24bitFg(
      presenterPalette(themeFlavor).speakerBoss,
    )}boss> ${SGR_RESET}`;
    this.readline.setPrompt(this.bossPrompt);
    this.readline.on('line', (line) => {
      if (!this.acceptingInput) {
        if (this.options.managedLifecycle && !this.shuttingDown) {
          this.routeInputLine(line, (prompt) => {
            this.preActivationPrompts.push(prompt);
          });
        }
        return;
      }
      this.handleLine(line);
    });
    this.readline.on('close', () => {
      void this.shutdown('EOF');
    });
    this.installInputKeypressHandling(input, output);
    if (!this.options.managedLifecycle) {
      this.registerSignal('SIGHUP');
      this.registerSignal('SIGINT');
      this.registerSignal('SIGTERM');
    }
    this.readline.prompt();
    if (this.options.managedReadinessPath) {
      if (this.shuttingDown) return;
      publishManagedReadiness(this.options.managedReadinessPath, {
        status: 'ready',
      });
      this.managedReadinessPublished = true;
      void this.activateManagedInput().catch((error) => {
        void this.shutdown('input activation failure', error);
      });
    } else {
      this.acceptingInput = true;
    }
  }

  async run(): Promise<void> {
    if (this.options.managedLifecycle) {
      // A managed host may receive termination while its durable runtime is
      // still restoring. Register before that await and make shutdown join it.
      this.registerSignal('SIGHUP');
      this.registerSignal('SIGINT');
      this.registerSignal('SIGTERM');
    }
    const startup = this.start();
    this.startup = startup.catch(() => undefined);
    if (this.options.managedLifecycle) {
      this.watchManagedShutdownRequest();
    }
    try {
      await startup;
    } catch (error) {
      if (!this.options.managedLifecycle) throw error;
      if (
        this.options.managedReadinessPath &&
        !this.managedReadinessPublished &&
        !this.shuttingDown
      ) {
        try {
          publishManagedReadiness(this.options.managedReadinessPath, {
            status: 'error',
            message: errorMessage(error),
          });
        } catch {
          // The launcher will also detect that its pane child exited.
        }
      }
      await this.shutdown('startup failure', error);
    }
    await this.done;
  }

  private enqueueLine(line: string): void {
    const prompt = line.trim();
    if (!prompt) {
      // tmux-play-75: an empty / whitespace-only submission paints a fresh ready
      // prompt only while no Boss turn is active or queued; submitted amid a
      // turn it must not repaint `boss> ` over the streaming output.
      if (this.pendingTurns === 0) {
        this.readline?.prompt();
      }
      return;
    }

    this.pendingTurns += 1;
    const operation = this.pending.then(async () => {
      try {
        if (this.shuttingDown) {
          return;
        }
        this.refreshPlayerPaneWidths();
        this.activeBossTurn = true;
        this.suspendPrompt();
        try {
          this.presentationGate?.beginTurn();
          if (this.options.managedLifecycle) {
            await this.options.managedLifecycle.beforeNonEmptyTurn({
              sessionId: this.options.sessionId,
              prompt,
            });
            if (this.shuttingDown) {
              this.presentationGate?.discardReplies();
              return;
            }
          }
          let runtimeFailure: unknown;
          try {
            await this.runtime?.runBossTurn(prompt);
          } catch (error) {
            runtimeFailure = error;
          }
          if (this.options.managedLifecycle && this.presentationGate) {
            const replies = this.presentationGate.bufferedReplies();
            const terminal = this.presentationGate.capturedTerminalRecord();
            if (!terminal && runtimeFailure === undefined) {
              throw new Error(
                'managed tmux-play turn ended without a terminal record',
              );
            }
            if (terminal) {
              try {
                await this.options.managedLifecycle.afterTurn({
                  sessionId: this.options.sessionId,
                  prompt,
                  replies,
                  terminal,
                });
              } catch (settlementFailure) {
                if (runtimeFailure !== undefined) {
                  // The runtime rejection caused this shutdown. Retain a
                  // simultaneous settlement failure for cleanup accounting,
                  // but do not replace the original fenced runtime failure.
                  if (!this.shutdownErrors.includes(runtimeFailure)) {
                    this.shutdownErrors.push(runtimeFailure);
                  }
                  if (!this.shutdownErrors.includes(settlementFailure)) {
                    this.shutdownErrors.push(settlementFailure);
                  }
                  throw runtimeFailure;
                }
                throw settlementFailure;
              }
              if (
                runtimeFailure === undefined &&
                terminal.type === 'turn_finished'
              ) {
                await this.presentationGate.releaseReplies();
              } else {
                this.presentationGate.discardReplies();
              }
            }
          }
          if (runtimeFailure !== undefined) throw runtimeFailure;
        } catch (error) {
          this.presentationGate?.discardReplies();
          if (this.options.managedLifecycle) {
            throw error;
          }
          // Non-observer failures are already emitted as runtime_error
          // records by the runtime and rendered by the tmux presenter.
          // Observer dispatch failures bypass that path because the failing
          // observer is the presenter itself, so we emit the line directly
          // under the tmux-play-39 bracketed-tag grammar.
          if (error instanceof ObserverDispatchError) {
            this.writeOutput(
              `captain> [runtime error] ${errorMessage(error)}\n`,
            );
          }
        }
      } finally {
        // tmux-play-75: this finally runs on every settle path — normal
        // completion, ESC abort, the runtime-error / observer-dispatch
        // branches above, an early shutdown return, or any unexpected throw —
        // so the increment in `enqueueLine` is always balanced. It restores
        // the colored prompt, then paints a fresh ready prompt only once the
        // queue of submitted Boss lines drains (`pendingTurns === 0`): when
        // another line is queued behind this turn the next turn begins under
        // the same suspension, so no spurious `boss> ` appears between
        // consecutive turns. Any type-ahead the Boss buffered surfaces on
        // that final restored prompt.
        this.activeBossTurn = false;
        this.pendingTurns -= 1;
        this.restorePrompt();
        if (this.pendingTurns === 0 && !this.shuttingDown) {
          this.readline?.prompt();
        }
      }
    });
    // Keep the serialization tail fulfilled so one rejected operation cannot
    // strand shutdown while preserving the operation's own rejection below.
    this.pending = operation.catch(() => undefined);
    void operation.catch((error) => {
      if (this.options.managedLifecycle) {
        void this.shutdown('turn failure', error);
        return;
      }
      // Same tmux-play-39 bracketed-tag grammar for the catch-all failure
      // path: bracketed tag carries the kind, message sits outside.
      this.writeOutput(`captain> [runtime error] ${errorMessage(error)}\n`);
    });
  }

  // tmux-play-75: while a Boss turn is active, blank the live readline prompt so
  // any line refresh triggered by Boss type-ahead paints no fresh `boss> `
  // chrome amid the turn's streaming presenter output — which a turn-completion
  // consumer reading the pane would misread as an implicit turn-over signal.
  // The edit buffer is left untouched, so type-ahead (typed or pasted) is
  // preserved per tmux-play-57 / tmux-play-58 and surfaces when restorePrompt re-arms
  // the colored prompt. `readline.pause()` is deliberately not used: pausing
  // the input stream also stops keypress delivery, breaking the ESC handler.
  private suspendPrompt(): void {
    if (!this.terminalInput) {
      return;
    }
    this.readline?.setPrompt('');
  }

  private restorePrompt(): void {
    if (!this.terminalInput) {
      return;
    }
    this.readline?.setPrompt(this.bossPrompt);
  }

  private registerSignal(event: ShutdownSignal): void {
    const target = this.options.signalTarget ?? process;
    const listener = () => {
      void this.shutdown(event);
    };
    target.on(event, listener);
    this.signalHandlers.push({ event, listener });
  }

  private async shutdown(reason: string, failure?: unknown): Promise<void> {
    if (failure !== undefined) {
      recordManagedShutdownPrimaryFailure(this.shutdownErrors, failure);
    }
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.acceptingInput = false;
    this.preActivationPrompts.splice(0);

    const activeTransactions = [this.startup, this.pending] as const;
    this.shutdownPromise = (async () => {
      const errors = this.shutdownErrors;
      // Install the shared shutdown promise before invoking any external or
      // teardown surface: each synchronous throw is recorded and later steps
      // still run, so one defective abort/cleanup hook cannot strand `done`.
      await runShutdownStep(errors, () =>
        this.stopManagedShutdownRequestWatcher(),
      );
      await runShutdownStep(errors, () => this.unregisterSignals());
      await runShutdownStep(errors, () => this.unsubscribeFromResize());
      await runShutdownStep(errors, () => this.removeKeypressListener());
      await runShutdownStep(errors, () => this.disableBracketedPaste());
      await runShutdownStep(errors, () =>
        this.runtime?.abortActiveTurn(reason),
      );
      await runShutdownStep(errors, () => this.readline?.close());
      // Managed hooks can own durable write-ahead and settlement. Never
      // release their lease or dispose the runtime concurrently with a turn.
      const transactionResults = await Promise.allSettled(activeTransactions);
      for (const result of transactionResults) {
        if (result.status === 'rejected') {
          recordManagedShutdownPrimaryFailure(errors, result.reason);
        }
      }
      await runShutdownStep(errors, () => this.runtime?.dispose());
      await runShutdownStep(errors, () =>
        this.options.managedLifecycle?.shutdown({
          sessionId: this.options.sessionId,
          reason,
          ...(errors[0] !== undefined ? { error: errors[0] } : {}),
        }),
      );
      await runShutdownStep(errors, () => this.timingObserver?.dispose());
      await runShutdownStep(errors, () =>
        closeLogStreams(this.logStreams?.values() ?? []),
      );
      await runShutdownStep(errors, () => this.cleanupWorkDir());
      await runShutdownStep(errors, () => {
        if (this.options.managedShutdownCompletePath) {
          publishManagedShutdownComplete(
            this.options.managedShutdownCompletePath,
          );
        }
      });
      await runShutdownStep(errors, () =>
        (this.options.killSession ?? killTmuxSession)(this.sessionName()),
      );

      if (errors.length > 0) {
        this.doneDeferred.reject(managedShutdownFailure(errors));
      } else {
        this.doneDeferred.resolve();
      }
    })();
    return this.shutdownPromise;
  }

  private async activateManagedInput(): Promise<void> {
    const gatePath = this.options.managedInputGatePath;
    const activePath = this.options.managedInputActivePath;
    if (!gatePath || !activePath) {
      throw new Error('managed tmux-play input boundary is incomplete');
    }
    while (!this.shuttingDown) {
      if (existsSync(gatePath)) {
        if (readFileSync(gatePath, 'utf8').trim() !== 'ready') {
          throw new Error(
            'managed tmux-play launcher wrote an invalid input gate',
          );
        }
        if (this.shuttingDown) return;
        this.acceptingInput = true;
        const queued = this.preActivationPrompts.splice(0);
        publishManagedInputActive(activePath);
        for (const prompt of queued) this.enqueueLine(prompt);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  private watchManagedShutdownRequest(): void {
    const requestPath = this.options.managedShutdownRequestPath;
    if (!requestPath) return;
    const poll = (): void => {
      this.managedShutdownPoll = undefined;
      if (this.shuttingDown) return;
      try {
        if (existsSync(requestPath)) {
          if (readFileSync(requestPath, 'utf8').trim() !== 'shutdown') {
            void this.shutdown(
              'managed shutdown request failure',
              new Error(
                'managed tmux-play launcher wrote an invalid shutdown request',
              ),
            );
          } else {
            void this.shutdown('embedding shutdown request');
          }
          return;
        }
      } catch (error) {
        void this.shutdown('managed shutdown request failure', error);
        return;
      }
      this.managedShutdownPoll = setTimeout(poll, 10);
    };
    poll();
  }

  private stopManagedShutdownRequestWatcher(): void {
    if (this.managedShutdownPoll !== undefined) {
      clearTimeout(this.managedShutdownPoll);
      this.managedShutdownPoll = undefined;
    }
  }

  private cleanupWorkDir(): void {
    const markerPath = join(
      this.options.workDir,
      TMUX_PLAY_WORK_DIR_OWNER_MARKER,
    );
    if (
      this.options.workDirOwnedByLauncher === true &&
      existsSync(markerPath) &&
      readFileSync(markerPath, 'utf8') === this.options.sessionId
    ) {
      (this.options.removeWorkDir ?? defaultRemoveWorkDir)(
        this.options.workDir,
      );
    }
  }

  private unregisterSignals(): void {
    const target = this.options.signalTarget ?? process;
    for (const { event, listener } of this.signalHandlers.splice(0)) {
      if (target.off) {
        target.off(event, listener);
      } else {
        target.removeListener?.(event, listener);
      }
    }
  }

  private sessionName(): string {
    return `tmux-play-${this.options.sessionId}`;
  }

  private writeOutput(value: string): void {
    (this.options.output ?? process.stdout).write(value);
  }

  private handleLine(line: string): void {
    this.routeInputLine(line, (prompt) => this.enqueueLine(prompt));
  }

  private routeInputLine(line: string, submit: (prompt: string) => void): void {
    if (this.inPaste) {
      this.pasteBuffer.push(line);
      return;
    }
    if (this.pasteAwaitingSubmit) {
      submit(this.flushPastedPrompt(line));
      return;
    }
    submit(line);
  }

  private flushPastedPrompt(line: string): string {
    const prompt =
      line.length > 0
        ? [...this.pasteBuffer, line].join('\n')
        : this.pasteBuffer.join('\n');
    this.pasteBuffer = [];
    this.pasteAwaitingSubmit = false;
    return prompt;
  }

  private installInputKeypressHandling(
    input: Readable,
    output: Writable,
  ): void {
    if (!isTty(input)) {
      return;
    }

    emitKeypressEvents(
      input,
      this.readline as unknown as Parameters<typeof emitKeypressEvents>[1],
    );
    const listener = (_str: string | undefined, key: Keypress): void => {
      if (this.bracketedPasteEnabled && key.name === 'paste-start') {
        this.inPaste = true;
        this.pasteAwaitingSubmit = false;
        this.pasteBuffer = [];
        return;
      }
      if (this.bracketedPasteEnabled && key.name === 'paste-end') {
        this.inPaste = false;
        this.pasteAwaitingSubmit = true;
        return;
      }
      if (key.name !== 'escape' || key.sequence !== '\x1b') {
        return;
      }
      if (!this.activeBossTurn || this.shuttingDown) {
        return;
      }
      this.runtime?.abortActiveTurn('ESC');
    };
    input.on('keypress', listener);
    this.keypressTarget = input;
    this.keypressListener = listener;

    if (isTty(output)) {
      output.write(BRACKETED_PASTE_ENABLE);
      this.bracketedPasteEnabled = true;
      this.exitPasteCleanup = () => {
        this.writeBracketedPasteDisable();
      };
      process.on('exit', this.exitPasteCleanup);
    }
  }

  private removeKeypressListener(): void {
    if (!this.keypressTarget || !this.keypressListener) {
      return;
    }
    const target = this.keypressTarget;
    const listener = this.keypressListener;
    if (typeof target.off === 'function') {
      target.off('keypress', listener);
    } else if (typeof target.removeListener === 'function') {
      target.removeListener('keypress', listener);
    }
    this.keypressTarget = undefined;
    this.keypressListener = undefined;
    this.inPaste = false;
    this.pasteAwaitingSubmit = false;
    this.pasteBuffer = [];
  }

  private disableBracketedPaste(): void {
    if (this.exitPasteCleanup) {
      process.off('exit', this.exitPasteCleanup);
      this.exitPasteCleanup = undefined;
    }
    this.writeBracketedPasteDisable();
  }

  private writeBracketedPasteDisable(): void {
    if (!this.bracketedPasteEnabled) {
      return;
    }
    (this.options.output ?? process.stdout).write(BRACKETED_PASTE_DISABLE);
    this.bracketedPasteEnabled = false;
  }

  // tmux is only reachable when this process runs inside a pane; outside tmux
  // (e.g., unit tests) the query is skipped and players fall back to no soft-wrap.
  private refreshPlayerPaneWidths(): void {
    const query = this.options.queryPaneWidths ?? defaultQueryPaneWidths;
    this.playerPaneWidths = query(this.sessionName());
  }

  // tmux's client-resized / after-resize-window hooks resize every pane in the
  // session, which causes Node to surface a 'resize' event on the captain
  // pane's stdout. Re-query player widths then so mid-turn streaming wraps at
  // the current pane size instead of the size captured at turn start.
  private subscribeToResize(output: Writable): void {
    if (typeof output.on !== 'function') {
      return;
    }
    const listener = (): void => {
      this.refreshPlayerPaneWidths();
    };
    output.on('resize', listener);
    this.resizeTarget = output;
    this.resizeListener = listener;
  }

  private unsubscribeFromResize(): void {
    if (!this.resizeTarget || !this.resizeListener) {
      return;
    }
    const target = this.resizeTarget;
    const listener = this.resizeListener;
    if (typeof target.off === 'function') {
      target.off('resize', listener);
    } else if (typeof target.removeListener === 'function') {
      target.removeListener('resize', listener);
    }
    this.resizeTarget = undefined;
    this.resizeListener = undefined;
  }
}

class ManagedPresentationGate implements RecordObserver {
  private readonly observers: readonly RecordObserver[];
  private replies: CaptainReplyRecord[] = [];
  private terminal: ManagedTmuxPlayTerminalRecord | undefined;

  constructor(observers: readonly RecordObserver[]) {
    this.observers = observers;
  }

  async onRecord(record: TmuxPlayRecord): Promise<void> {
    if (record.type === 'captain_reply') {
      this.replies.push(Object.freeze({ ...record }));
      return;
    }
    if (record.type === 'turn_finished' || record.type === 'turn_aborted') {
      this.terminal = Object.freeze({ ...record });
    }
    await this.dispatch(record);
  }

  beginTurn(): void {
    if (this.replies.length > 0 || this.terminal) {
      throw new Error('managed tmux-play reply buffer was not settled');
    }
  }

  bufferedReplies(): readonly CaptainReplyRecord[] {
    return Object.freeze([...this.replies]);
  }

  capturedTerminalRecord(): ManagedTmuxPlayTerminalRecord | undefined {
    return this.terminal;
  }

  async releaseReplies(): Promise<void> {
    for (const reply of this.replies) {
      await this.dispatch(reply);
    }
    this.replies = [];
    this.terminal = undefined;
  }

  discardReplies(): void {
    this.replies = [];
    this.terminal = undefined;
  }

  private async dispatch(record: TmuxPlayRecord): Promise<void> {
    for (const observer of this.observers) {
      await observer.onRecord(record);
    }
  }
}

function defaultQueryPaneWidths(sessionName: string): Map<string, number> {
  // tmux-play-74: the orchestrator scrubs TMUX from process.env to sandbox player agents
  // (see isolateOrchestratorFromAgents), so consult the pinned tmux env rather
  // than process.env.TMUX directly — otherwise pane-width queries would no-op
  // for the whole run.
  if (!isOrchestratorInTmux()) {
    return new Map();
  }
  return queryPaneWidthsByTitle(sessionName);
}

function outputWidth(output: Writable): number {
  const columns = (output as { columns?: unknown }).columns;
  if (typeof columns === 'number' && Number.isFinite(columns) && columns > 0) {
    return columns;
  }
  return Number.POSITIVE_INFINITY;
}

function isTty(stream: Readable | Writable): boolean {
  return (stream as { isTTY?: unknown }).isTTY === true;
}

export async function runTmuxPlaySession(
  options: TmuxPlaySessionOptions,
): Promise<void> {
  // tmux-play-74: public embedders can enter session mode without passing
  // through the CLI dispatcher. Isolate at the construction boundary so
  // every runtime and adapter inherits the scrubbed agent environment.
  isolateOrchestratorFromAgents();
  await new TmuxPlaySession(options).run();
}

/**
 * Run the interactive pane process under an embedding host's transactional
 * lifecycle. The readiness marker is published only after the supplied
 * runtime has initialized or restored and input handling is installed.
 */
export async function runManagedTmuxPlaySession(
  options: ManagedTmuxPlaySessionOptions,
): Promise<void> {
  assertManagedTmuxPlaySessionId(options.sessionId);
  isolateOrchestratorFromAgents();
  const {
    lifecycle,
    readinessPath,
    inputGatePath,
    inputActivePath,
    shutdownRequestPath,
    shutdownCompletePath,
    workDirOwnedByLauncher,
    ...sessionOptions
  } = options;
  await new TmuxPlaySession({
    ...sessionOptions,
    managedLifecycle: lifecycle,
    managedReadinessPath: readinessPath,
    managedInputGatePath: inputGatePath,
    managedInputActivePath: inputActivePath,
    managedShutdownRequestPath: shutdownRequestPath,
    managedShutdownCompletePath: shutdownCompletePath,
    workDirOwnedByLauncher,
  }).run();
}

function publishManagedReadiness(
  path: string,
  value:
    | { readonly status: 'ready' }
    | {
        readonly status: 'error';
        readonly message: string;
      },
): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function publishManagedInputActive(path: string): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, 'active\n', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function publishManagedShutdownComplete(path: string): void {
  // Detached activation deliberately closes the launcher's coordination
  // boundary. Signals and EOF still run the managed lifecycle, but there is
  // no outer request waiter to acknowledge after that point.
  if (!existsSync(dirname(path))) return;
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, 'complete\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export async function readConfigSnapshot(
  workDir: string,
): Promise<TmuxPlayConfig> {
  const path = join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT);
  return JSON.parse(await readFile(path, 'utf8')) as TmuxPlayConfig;
}

async function loadCaptain(
  specifier: string,
  options: unknown,
  importCaptain = defaultImportCaptain,
): Promise<Captain> {
  const mod = await importCaptain(specifier);
  const factory = (mod as { default?: unknown }).default;
  if (typeof factory !== 'function') {
    throw new Error(
      `Captain module ${specifier} must export a default factory`,
    );
  }
  return (await (factory as (options: unknown) => Captain | Promise<Captain>)(
    options,
  )) as Captain;
}

async function defaultImportCaptain(specifier: string): Promise<unknown> {
  return import(specifier);
}

function defaultRemoveWorkDir(workDir: string): void {
  rmSync(workDir, { recursive: true, force: true });
}

async function runShutdownStep(
  errors: unknown[],
  step: () => void | Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    recordManagedShutdownCleanupFailure(errors, error);
  }
}

function recordManagedShutdownPrimaryFailure(
  errors: unknown[],
  error: unknown,
): void {
  if (!errors.some((recorded) => Object.is(recorded, error))) {
    errors.push(error);
  }
}

function recordManagedShutdownCleanupFailure(
  errors: unknown[],
  error: unknown,
): void {
  if (error instanceof AggregateError && error.errors.length > 0) {
    for (const nested of error.errors) {
      recordManagedShutdownCleanupFailure(errors, nested);
    }
    return;
  }
  recordManagedShutdownPrimaryFailure(errors, error);
}

function managedShutdownFailure(errors: readonly unknown[]): unknown {
  if (errors.length === 1) return errors[0];
  return new AggregateError(
    errors,
    `managed tmux-play shutdown failed: ${errors.map(errorMessage).join('; ')}`,
  );
}

function runtimeCaptain(
  captain: CaptainConfig,
): RunTmuxPlayOptions['captainConfig'] {
  return {
    adapter: captain.adapter,
    model: captain.model,
    instruction: captain.instruction,
    permissions: captain.permissions,
    effort: captain.effort,
  } as RunTmuxPlayOptions['captainConfig'];
}

function runtimePlayers(
  players: readonly PlayerConfig[],
): RuntimePlayerConfig[] {
  return players.map(runtimePlayer);
}

function runtimePlayer(player: PlayerConfig): RuntimePlayerConfig {
  if (!isKnownPlayerAdapter(player.adapter)) {
    throw new Error(
      `Unknown adapter "${player.adapter}" for player "${player.id}"`,
    );
  }

  return {
    id: player.id,
    adapter: player.adapter,
    model: player.model,
    instruction: player.instruction,
    permissions: player.permissions,
    effort: player.effort,
  } as RuntimePlayerConfig;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
