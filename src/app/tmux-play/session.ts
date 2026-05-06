// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  closeLogStreams,
  openAppendLogStreams,
} from '../shared/logs.js';
import { killTmuxSession } from '../shared/tmux.js';
import type {
  Captain,
  RuntimeRoleConfig,
  RunTmuxPlayOptions,
} from './contract.js';
import {
  TMUX_PLAY_CONFIG_SNAPSHOT,
  type TmuxPlayConfig,
} from './config.js';
import { createTmuxPresenter } from './presenter-tmux.js';
import { ObserverDispatchError, type RecordObserver } from './records.js';
import { createTmuxPlayRuntime, type TmuxPlayRuntime } from './runtime.js';
import {
  isKnownRoleAdapter,
  type RoleAdapterImports,
  type RoleConfig,
} from './roles.js';
import { TMUX_PLAY_SESSION_MARKER } from './launcher.js';

type RuntimeHandle = Pick<
  TmuxPlayRuntime,
  'abortActiveTurn' | 'dispose' | 'runBossTurn'
>;

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
  readonly adapterImports?: RoleAdapterImports;
  readonly observers?: readonly RecordObserver[];
  readonly createReadline?: (options: {
    input: Readable;
    output: Writable;
  }) => ReadlineLike;
  readonly createRuntime?: (
    options: RunTmuxPlayOptions,
  ) => Promise<RuntimeHandle>;
  readonly importCaptain?: (specifier: string) => Promise<unknown>;
  readonly killSession?: (sessionName: string) => void;
  readonly removeWorkDir?: (workDir: string) => void;
  readonly signalTarget?: SignalTarget;
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
  private pending = Promise.resolve();
  private shuttingDown = false;

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
    const roleIds = config.roles.map((role) => role.id);
    const output = this.options.output ?? process.stdout;
    const logStreams = openAppendLogStreams(
      this.options.workDir,
      roleIds,
      (roleId, error) => {
        output.write(`[${roleId}] log write error: ${error.message}\n`);
      },
    );
    this.logStreams = logStreams;

    const presenter = createTmuxPresenter({
      boss: output,
      roles: logStreams,
    });
    const createRuntime = this.options.createRuntime ?? createTmuxPlayRuntime;
    this.runtime = await createRuntime({
      captain,
      captainConfig: {
        adapter: config.captain.adapter,
        model: config.captain.model,
        instruction: config.captain.instruction,
      },
      roles: runtimeRoles(config.roles),
      observers: [presenter, ...(this.options.observers ?? [])],
      cwd: this.options.cwd,
      adapterImports: this.options.adapterImports,
    });

    this.readline = (this.options.createReadline ?? createInterface)({
      input: this.options.input ?? process.stdin,
      output,
    });
    this.readline.setPrompt('boss> ');
    this.readline.on('line', (line) => {
      this.enqueueLine(line);
    });
    this.readline.on('close', () => {
      void this.shutdown('EOF');
    });
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
      this.readline?.prompt();
      return;
    }

    this.pending = this.pending
      .then(async () => {
        if (this.shuttingDown) {
          return;
        }
        try {
          await this.runtime?.runBossTurn(prompt);
        } catch (error) {
          // Non-observer failures are already emitted as runtime_error records
          // by the runtime and rendered by the tmux presenter.
          if (error instanceof ObserverDispatchError) {
            this.writeOutput(
              `captain> [runtime error: ${errorMessage(error)}]\n`,
            );
          }
        } finally {
          if (!this.shuttingDown) {
            this.readline?.prompt();
          }
        }
      })
      .catch((error) => {
        this.writeOutput(
          `captain> [runtime error: ${errorMessage(error)}]\n`,
        );
      });
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
    this.runtime?.abortActiveTurn(reason);

    const errors: unknown[] = [];
    await runShutdownStep(errors, () => this.runtime?.dispose());
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

function runtimeRoles(roles: readonly RoleConfig[]): RuntimeRoleConfig[] {
  return roles.map((role) => {
    if (!isKnownRoleAdapter(role.adapter)) {
      throw new Error(`Unknown adapter "${role.adapter}" for role "${role.id}"`);
    }
    return {
      id: role.id,
      adapter: role.adapter,
      model: role.model,
      instruction: role.instruction,
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
