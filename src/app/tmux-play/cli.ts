#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';
import {
  launchTmuxPlay,
  tmuxPlayThemeDiagnostics,
  type LaunchTmuxPlayOptions,
  type TmuxPlayThemeDiagnosticsOptions,
} from './launcher.js';
import {
  runTmuxPlaySession,
  type TmuxPlaySessionOptions,
} from './session.js';

type Output = Pick<Writable, 'write'>;

export interface RunTmuxPlayCliOptions {
  readonly argv?: readonly string[];
  readonly stdout?: Output;
  readonly stderr?: Output;
  readonly selfBin?: string;
  readonly launch?: (options: LaunchTmuxPlayOptions) => Promise<unknown>;
  readonly themeDiagnostics?: (
    options: TmuxPlayThemeDiagnosticsOptions,
  ) => Promise<Awaited<ReturnType<typeof tmuxPlayThemeDiagnostics>>>;
  readonly runSession?: (options: TmuxPlaySessionOptions) => Promise<void>;
}

export async function runTmuxPlayCli(
  options: RunTmuxPlayCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const argv = options.argv ?? process.argv.slice(2);

  try {
    const { values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        config: { type: 'string' },
        cwd: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        session: { type: 'string' },
        'theme-diagnostics': { type: 'boolean' },
        'work-dir': { type: 'string' },
      },
      strict: true,
    });

    if (values.help) {
      stdout.write(usage());
      return 0;
    }

    if (values['theme-diagnostics']) {
      if (values.session) {
        throw new Error('--theme-diagnostics is only valid in launcher mode');
      }
      if (values['work-dir']) {
        throw new Error('--work-dir is only valid with --session');
      }
      const diagnostics = await (
        options.themeDiagnostics ?? tmuxPlayThemeDiagnostics
      )({
        configPath: values.config,
        cwd: values.cwd,
        ...(options.stdout ? { stdout } : {}),
        ...(options.stderr ? { stderr } : {}),
      });
      stdout.write(formatThemeDiagnostics(diagnostics));
      return 0;
    }

    if (values.session) {
      const workDir = validateSessionOptions(values);
      await (options.runSession ?? runTmuxPlaySession)({
        sessionId: values.session,
        workDir,
        cwd: values.cwd,
      });
      return 0;
    }

    if (values['work-dir']) {
      throw new Error('--work-dir is only valid with --session');
    }

    const launchOptions: LaunchTmuxPlayOptions = {
      configPath: values.config,
      cwd: values.cwd,
      selfBin: options.selfBin ?? process.argv[1],
      ...(options.stdout ? { stdout } : {}),
      ...(options.stderr ? { stderr } : {}),
    };

    await (options.launch ?? launchTmuxPlay)(launchOptions);
    return 0;
  } catch (error) {
    stderr.write(`Error: ${errorMessage(error)}\n`);
    return 1;
  }
}

function validateSessionOptions(values: {
  readonly config?: string;
  readonly session?: string;
  readonly 'work-dir'?: string;
}): string {
  if (values.config) {
    throw new Error('--config is only valid in launcher mode');
  }
  const workDir = values['work-dir'];
  if (!workDir) {
    throw new Error('--work-dir is required in session mode');
  }
  validateWorkDir(workDir);
  return workDir;
}

function validateWorkDir(workDir: string): void {
  if (!existsSync(workDir) || !statSync(workDir).isDirectory()) {
    throw new Error(
      `work dir does not exist or is not a directory: ${workDir}`,
    );
  }
  try {
    accessSync(workDir, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`work dir is not writable: ${workDir}`);
  }
}

function usage(): string {
  return [
    'Usage:',
    '  tmux-play [--config <path>] [--cwd <path>]',
    '  tmux-play --theme-diagnostics [--config <path>] [--cwd <path>]',
    '  tmux-play --session <id> --work-dir <path> [--cwd <path>]',
    '',
  ].join('\n');
}

function formatThemeDiagnostics(
  diagnostics: Awaited<ReturnType<typeof tmuxPlayThemeDiagnostics>>,
): string {
  const lines = [
    `selected: ${diagnostics.selected}`,
    `reason: ${diagnostics.reason}`,
  ];
  if (diagnostics.rawOsc11Reply) {
    lines.push(`rawOsc11Reply: ${JSON.stringify(diagnostics.rawOsc11Reply)}`);
  }
  return `${lines.join('\n')}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @internal Exported for tests; not part of the tmux-play public API.
 */
export function isCliEntry(
  argv1 = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (!argv1) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  process.exitCode = await runTmuxPlayCli();
}
