// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  closeLogStreams,
  openAppendLogStreams,
} from '../shared/logs.js';
import {
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
  type TmuxPlayConfig,
} from './config.js';
import { createTmuxPresenter, type WidthSource } from './presenter-tmux.js';
import {
  SGR_RESET,
  bold24bitFg,
  presenterPalette,
  type CatppuccinFlavor,
} from './player-colors.js';
import { ObserverDispatchError, type RecordObserver } from './records.js';
import { createFollowObserver } from './follow-observer.js';
import { wrapScrollbackSafeOutput } from './scrollback-safe-output.js';
import { createNotificationObserver } from './notification-observer.js';
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
import { TMUX_PLAY_SESSION_MARKER } from './launcher.js';

type RuntimeHandle = Pick<
  TmuxPlayRuntime,
  'abortActiveTurn' | 'dispose' | 'runBossTurn'
>;

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

interface SignalTarget {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off?(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener?(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

interface LogCloser {
  end(): unknown;
}

export interface TmuxPlaySessionOptions {
  readonly sessionId: string;
  readonly workDir: string;
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
  ) => Promise<RuntimeHandle>;
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
}

export class TmuxPlaySession {
  private readonly options: TmuxPlaySessionOptions;
  private readonly doneDeferred = deferred<void>();
  private readonly signalHandlers: Array<{
    readonly event: 'SIGINT' | 'SIGTERM';
    readonly listener: () => void;
  }> = [];
  private readline: ReadlineLike | undefined;
  private runtime: RuntimeHandle | undefined;
  private logStreams: Map<string, LogCloser> | undefined;
  private timingObserver: TimingObserverHandle | undefined;
  private pending = Promise.resolve();
  private shuttingDown = false;
  private playerPaneWidths: Map<string, number> = new Map();
  private resizeTarget: Writable | undefined;
  private resizeListener: (() => void) | undefined;
  private keypressTarget: Readable | undefined;
  private keypressListener: ((
    str: string | undefined,
    key: Keypress,
  ) => void) | undefined;
  private activeBossTurn = false;
  // TMUX-075: count of Boss turns that have been submitted but not yet finished
  // — the one currently running plus any lines the Boss submitted behind it that
  // queued for the serialized runtime (TMUX-018). A fresh ready `boss> ` prompt
  // is painted only when this reaches zero, so no spurious prompt appears between
  // consecutive queued turns or amid an active turn's streaming output.
  private pendingTurns = 0;
  // TMUX-075: the colored `boss> ` prompt string is captured at start so the
  // turn-active suspension can blank the prompt and restore this exact value
  // at turn end. `terminalInput` records whether stdin is a TTY; outside a TTY
  // the readline runs in non-terminal mode (no echo), so the suspension is a
  // no-op per TMUX-075.
  private bossPrompt = '';
  private terminalInput = false;
  private bracketedPasteEnabled = false;
  private inPaste = false;
  private pasteAwaitingSubmit = false;
  private pasteBuffer: string[] = [];
  private exitPasteCleanup: (() => void) | undefined;

  readonly done: Promise<void> = this.doneDeferred.promise;

  constructor(options: TmuxPlaySessionOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const config = await readConfigSnapshot(this.options.workDir);
    const captain = await loadCaptain(
      config.captain.from,
      config.captain.options,
      this.options.importCaptain,
    );
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
      playerWidths.set(player.id, () =>
        this.playerPaneWidths.get(title) ?? Number.POSITIVE_INFINITY,
      );
    }
    const playerAdapters = new Map(
      config.players.map((player) => [player.id, player.adapter]),
    );
    // The snapshot carries the launcher-resolved Catppuccin flavor
    // (mocha | latte) per TMUX-047, so prefix / status / tool SGRs in
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

    // TMUX-069: return a scrolled-back (copy-mode) pane to its live tail when
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

    const createRuntime = this.options.createRuntime ?? createTmuxPlayRuntime;
    this.runtime = await createRuntime({
      captain,
      captainConfig: {
        adapter: config.captain.adapter,
        model: config.captain.model,
        instruction: config.captain.instruction,
        permissions: config.captain.permissions,
        reasoningEffort: config.captain.reasoningEffort,
      },
      players: runtimePlayers(config.players),
      observers: [
        presenter,
        followObserver,
        timingObserver,
        notificationObserver,
        ...(this.options.observers ?? []),
      ],
      cwd: this.options.cwd,
      adapterImports: this.options.adapterImports,
    });

    const input = this.options.input ?? process.stdin;
    this.terminalInput = isTty(input);
    // TMUX-079: route the readline's redraws through a scrollback-safe wrapper
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
    // TMUX-038: color the `boss> ` prefix with the boss role color from
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
      this.handleLine(line);
    });
    this.readline.on('close', () => {
      void this.shutdown('EOF');
    });
    this.installInputKeypressHandling(input, output);
    this.registerSignal('SIGINT');
    this.registerSignal('SIGTERM');
    this.readline.prompt();
  }

  async run(): Promise<void> {
    await this.start();
    await this.done;
  }

  private enqueueLine(line: string): void {
    const prompt = line.trim();
    if (!prompt) {
      // TMUX-075: an empty / whitespace-only submission paints a fresh ready
      // prompt only while no Boss turn is active or queued; submitted amid a
      // turn it must not repaint `boss> ` over the streaming output.
      if (this.pendingTurns === 0) {
        this.readline?.prompt();
      }
      return;
    }

    this.pendingTurns += 1;
    this.pending = this.pending
      .then(async () => {
        try {
          if (this.shuttingDown) {
            return;
          }
          this.refreshPlayerPaneWidths();
          this.activeBossTurn = true;
          this.suspendPrompt();
          try {
            await this.runtime?.runBossTurn(prompt);
          } catch (error) {
            // Non-observer failures are already emitted as runtime_error
            // records by the runtime and rendered by the tmux presenter.
            // Observer dispatch failures bypass that path because the failing
            // observer is the presenter itself, so we emit the line directly
            // under the TMUX-039 bracketed-tag grammar.
            if (error instanceof ObserverDispatchError) {
              this.writeOutput(
                `captain> [runtime error] ${errorMessage(error)}\n`,
              );
            }
          }
        } finally {
          // TMUX-075: this finally runs on every settle path — normal
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
      })
      .catch((error) => {
        // Same TMUX-039 bracketed-tag grammar for the catch-all failure
        // path: bracketed tag carries the kind, message sits outside.
        this.writeOutput(
          `captain> [runtime error] ${errorMessage(error)}\n`,
        );
      });
  }

  // TMUX-075: while a Boss turn is active, blank the live readline prompt so
  // any line refresh triggered by Boss type-ahead paints no fresh `boss> `
  // chrome amid the turn's streaming presenter output — which a turn-completion
  // consumer reading the pane would misread as an implicit turn-over signal.
  // The edit buffer is left untouched, so type-ahead (typed or pasted) is
  // preserved per TMUX-057 / TMUX-058 and surfaces when restorePrompt re-arms
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

  private registerSignal(event: 'SIGINT' | 'SIGTERM'): void {
    const target = this.options.signalTarget ?? process;
    const listener = () => {
      void this.shutdown(event);
      this.readline?.close();
    };
    target.on(event, listener);
    this.signalHandlers.push({ event, listener });
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.unregisterSignals();
    this.unsubscribeFromResize();
    this.removeKeypressListener();
    this.disableBracketedPaste();
    this.runtime?.abortActiveTurn(reason);

    const errors: unknown[] = [];
    await runShutdownStep(errors, () => this.runtime?.dispose());
    await runShutdownStep(errors, () => this.timingObserver?.dispose());
    await runShutdownStep(errors, () =>
      closeLogStreams(this.logStreams?.values() ?? []),
    );
    await runShutdownStep(errors, () => this.cleanupWorkDir());
    await runShutdownStep(errors, () =>
      (this.options.killSession ?? killTmuxSession)(this.sessionName()),
    );

    if (errors.length > 0) {
      this.doneDeferred.reject(errors[0]);
    } else {
      this.doneDeferred.resolve();
    }

  }

  private cleanupWorkDir(): void {
    const markerPath = join(this.options.workDir, TMUX_PLAY_SESSION_MARKER);
    if (existsSync(markerPath)) {
      (this.options.removeWorkDir ?? defaultRemoveWorkDir)(this.options.workDir);
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
    if (this.inPaste) {
      this.pasteBuffer.push(line);
      return;
    }
    if (this.pasteAwaitingSubmit) {
      this.enqueueLine(this.flushPastedPrompt(line));
      return;
    }
    this.enqueueLine(line);
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

  private installInputKeypressHandling(input: Readable, output: Writable): void {
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

function defaultQueryPaneWidths(sessionName: string): Map<string, number> {
  // TMUX-074: the orchestrator scrubs TMUX from process.env to sandbox player agents
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
  await new TmuxPlaySession(options).run();
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
    throw new Error(`Captain module ${specifier} must export a default factory`);
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
    errors.push(error);
  }
}

function runtimePlayers(players: readonly PlayerConfig[]): RuntimePlayerConfig[] {
  return players.map((player) => {
    if (!isKnownPlayerAdapter(player.adapter)) {
      throw new Error(`Unknown adapter "${player.adapter}" for player "${player.id}"`);
    }
    return {
      id: player.id,
      adapter: player.adapter,
      model: player.model,
      instruction: player.instruction,
      permissions: player.permissions,
      reasoningEffort: player.reasoningEffort,
    };
  });
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
